import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callAI } from "../_shared/ai.ts";

// ============================================================================
// Edge function: resolve-identity
//
// The server-side half of ScoutTree's Identity Resolution Engine. The browser
// can talk to Lichess/Chess.com directly (CORS-friendly), but USCF/FIDE pages
// and any real "reasoning over the open web" need a server. This function:
//
//   1. makes a best-effort, never-fatal attempt at the public US Chess member
//      search (and a direct MSA lookup when a USCF ID is supplied), and
//   2. runs an AI reasoning pass (Anthropic via _shared/ai.ts) that turns the
//      user's loose clues into structured candidate identities + the online
//      usernames most worth verifying.
//
// It always returns 200 with a structured body; the client treats an empty
// candidate list (or `available: false`) as "this source contributed nothing"
// and still produces results from the direct Lichess/Chess.com providers.
//
// Response shape (consumed by src/lib/identity/providers/edgeClient.ts):
//   { available: boolean, sources: string[], candidates: EdgeIdentityCandidate[], notes: string[] }
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Platform = "lichess" | "chesscom" | "chesskid" | "icc" | "other";

interface PlayerQuery {
  name: string;
  approxRating?: number;
  federation?: string;
  country?: string;
  state?: string;
  club?: string;
  school?: string;
  ageOrGrade?: string;
  uscfId?: string;
  fideId?: string;
  usernameHint?: string;
  tournamentName?: string;
  tournamentRound?: string;
  tournamentSection?: string;
  tournamentBoard?: string;
  tournamentColor?: string;
  additionalDetails?: string;
}

interface EdgeIdentityCandidate {
  source: "uscf" | "fide" | "ai" | "chessresults";
  name: string;
  federation?: string;
  country?: string;
  state?: string;
  uscfId?: string;
  fideId?: string;
  estimatedRating?: number;
  ratings?: Record<string, number>;
  title?: string;
  suggestedUsernames?: { platform: Platform; username: string }[];
  reasoning?: string;
  confidenceHint?: number;
  tournaments?: string[];
}

// ---------------------------------------------------------------------------
// Best-effort US Chess MSA lookup. Public, key-less, HTML. Wrapped so any
// failure (markup change, network, rate limit) degrades to "no USCF candidate"
// rather than breaking the whole search.
// ---------------------------------------------------------------------------

async function uscfLookup(query: PlayerQuery): Promise<EdgeIdentityCandidate[]> {
  const out: EdgeIdentityCandidate[] = [];
  try {
    // Direct member-detail page when an ID is known — the most reliable path.
    if (query.uscfId && /\d{6,}/.test(query.uscfId)) {
      const id = query.uscfId.replace(/\D/g, "");
      const res = await fetch(`https://www.uschess.org/msa/MbrDtlMain.php?${id}`, {
        headers: { "User-Agent": "ScoutTree/1.0" },
      });
      if (res.ok) {
        const html = await res.text();
        const parsed = parseMsaDetail(html, id);
        if (parsed) out.push(parsed);
      }
      return out;
    }

    // Name search via the classic player-search datapage. Best-effort parse.
    const nameParam = encodeURIComponent(query.name.trim());
    const res = await fetch(
      `https://www.uschess.org/datapage/player-search.php?name=${nameParam}&mode=Find`,
      { headers: { "User-Agent": "ScoutTree/1.0" } }
    );
    if (!res.ok) return out;
    const html = await res.text();
    // Rows look like: <a href="MbrDtlMain.php?12345678">12345678: LAST, FIRST</a> ... rating ... state
    const rowRe = /MbrDtlMain\.php\?(\d{6,})">[^<]*?(\d{6,})?:?\s*([A-Z][^<]+)</g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = rowRe.exec(html)) && count < 5) {
      const id = m[1];
      const rawName = (m[3] || "").trim().replace(/\s+/g, " ");
      const name = toFirstLast(rawName);
      out.push({
        source: "uscf",
        name,
        federation: "USCF",
        uscfId: id,
        state: query.state,
        country: "US",
        reasoning: `US Chess member #${id} (${rawName}) matched the name search.`,
      });
      count++;
    }
  } catch (_e) {
    // swallow — best-effort only
  }
  return out;
}

function parseMsaDetail(html: string, id: string): EdgeIdentityCandidate | null {
  try {
    const nameMatch = html.match(/<b>\s*(\d{6,}):\s*([^<]+)<\/b>/);
    const rawName = nameMatch ? nameMatch[2].trim() : "";
    const name = rawName ? toFirstLast(rawName) : "Unknown";
    const stateMatch = html.match(/State[^<]*<\/td>\s*<td[^>]*>\s*([A-Z]{2})/i);
    const regMatch = html.match(/Regular\s*Rating[\s\S]*?(\d{3,4})/i);
    const fideMatch = html.match(/FIDE\s*ID[^<]*<\/td>\s*<td[^>]*>\s*(\d{6,})/i);
    const ratings: Record<string, number> = {};
    if (regMatch) ratings["USCF Regular"] = parseInt(regMatch[1], 10);
    return {
      source: "uscf",
      name,
      federation: "USCF",
      uscfId: id,
      state: stateMatch ? stateMatch[1] : undefined,
      country: "US",
      fideId: fideMatch ? fideMatch[1] : undefined,
      estimatedRating: regMatch ? parseInt(regMatch[1], 10) : undefined,
      ratings: Object.keys(ratings).length ? ratings : undefined,
      reasoning: `US Chess member detail #${id}.`,
    };
  } catch {
    return null;
  }
}

/** "LAST, FIRST MIDDLE" → "First Middle Last" (title-cased). */
function toFirstLast(raw: string): string {
  const titleCase = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  if (raw.includes(",")) {
    const [last, rest] = raw.split(",");
    return titleCase(`${rest} ${last}`.replace(/\s+/g, " "));
  }
  return titleCase(raw);
}

// ---------------------------------------------------------------------------
// AI reasoning pass — the "detective". Turns clues into structured candidates.
// ---------------------------------------------------------------------------

function buildAiPrompt(query: PlayerQuery, priorCandidates: EdgeIdentityCandidate[]): string {
  const clues: string[] = [`Name: ${query.name}`];
  const add = (label: string, v?: string | number) => {
    if (v !== undefined && v !== null && `${v}`.trim() !== "") clues.push(`${label}: ${v}`);
  };
  add("Approx rating", query.approxRating);
  add("Federation", query.federation);
  add("Country", query.country);
  add("State/Province", query.state);
  add("Club", query.club);
  add("School", query.school);
  add("Age/Grade", query.ageOrGrade);
  add("USCF ID", query.uscfId);
  add("FIDE ID", query.fideId);
  add("Username hint", query.usernameHint);
  add("Tournament", query.tournamentName);
  add("Round", query.tournamentRound);
  add("Section", query.tournamentSection);
  add("Board", query.tournamentBoard);
  add("Color", query.tournamentColor);
  add("Additional details", query.additionalDetails);

  const priorBlock = priorCandidates.length
    ? `\n\nServer lookups already found these records (treat as high-trust evidence; refine and attach likely online usernames):\n${JSON.stringify(
        priorCandidates,
        null,
        2
      )}`
    : "";

  return `A chess player is trying to scout a tournament opponent but may not know the opponent's online usernames. Use the clues to identify the most likely real person/people and the online accounts worth checking.

CLUES:
${clues.join("\n")}${priorBlock}

Return STRICT JSON — an array (max 3) of candidate identities, most likely first. Each item:
{
  "source": "ai" | "uscf" | "fide" | "chessresults",
  "name": "Full Name",
  "federation": "USCF" | "FIDE" | "LICHESS" | "CHESSCOM" | "OTHER" (optional),
  "country": "ISO-2 like US" (optional),
  "state": "2-letter US state" (optional),
  "uscfId": "digits" (only if genuinely known/confident),
  "fideId": "digits" (only if genuinely known/confident),
  "estimatedRating": number (optional),
  "ratings": { "label": number } (optional),
  "title": "GM/IM/FM/..." (optional),
  "suggestedUsernames": [ { "platform": "lichess" | "chesscom", "username": "handle" } ],
  "reasoning": "one or two sentences on why this person and these handles",
  "confidenceHint": 0.0-1.0,
  "tournaments": ["event names tying them to the clues"] (optional)
}

Rules:
- Propose the 3-8 MOST plausible usernames to verify across lichess and chess.com, derived from the name and any username hint (e.g. firstlast, first_last, flast, name+year). Do NOT fabricate IDs you don't actually know — omit uscfId/fideId unless confident.
- Prefer real, well-known players when the clues clearly point to one; otherwise reason generically from the name.
- Output ONLY the JSON array, no prose, no markdown fences.`;
}

function extractJsonArray(text: string): EdgeIdentityCandidate[] {
  if (!text) return [];
  let s = text.trim();
  // Strip markdown fences if present.
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((c) => c && typeof c.name === "string")
      .slice(0, 3)
      .map((c) => sanitizeCandidate(c));
  } catch {
    return [];
  }
}

function sanitizeCandidate(c: Record<string, unknown>): EdgeIdentityCandidate {
  const allowedSources = ["uscf", "fide", "ai", "chessresults"];
  const source = (typeof c.source === "string" && allowedSources.includes(c.source) ? c.source : "ai") as EdgeIdentityCandidate["source"];
  const suggested = Array.isArray(c.suggestedUsernames)
    ? (c.suggestedUsernames as unknown[])
        .map((u) => {
          const o = u as Record<string, unknown>;
          const platform = o.platform === "lichess" || o.platform === "chesscom" ? o.platform : undefined;
          const username = typeof o.username === "string" ? o.username.trim() : "";
          return platform && username ? { platform: platform as Platform, username } : null;
        })
        .filter((x): x is { platform: Platform; username: string } => !!x)
        .slice(0, 10)
    : undefined;

  const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  return {
    source,
    name: String(c.name).trim(),
    federation: str(c.federation),
    country: str(c.country),
    state: str(c.state),
    uscfId: str(c.uscfId),
    fideId: str(c.fideId),
    estimatedRating: num(c.estimatedRating),
    ratings: c.ratings && typeof c.ratings === "object" ? (c.ratings as Record<string, number>) : undefined,
    title: str(c.title),
    suggestedUsernames: suggested,
    reasoning: str(c.reasoning),
    confidenceHint: num(c.confidenceHint),
    tournaments: Array.isArray(c.tournaments) ? (c.tournaments as string[]).filter((t) => typeof t === "string").slice(0, 5) : undefined,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const query: PlayerQuery = body?.query || {};
    if (!query.name || !query.name.trim()) {
      return new Response(JSON.stringify({ available: false, candidates: [], sources: [], notes: ["Missing name."] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[resolve-identity] query:", JSON.stringify({ name: query.name, fed: query.federation, state: query.state }));

    const sources: string[] = [];
    const notes: string[] = [];

    // 1. Server-side USCF best-effort (never fatal).
    const uscfCandidates = await uscfLookup(query);
    if (uscfCandidates.length) {
      sources.push("uscf");
      notes.push(`US Chess: ${uscfCandidates.length} record(s).`);
    }

    // 2. AI reasoning pass — refines USCF hits and proposes usernames.
    const ai = await callAI(
      "You are an expert chess identity-resolution analyst. You convert sparse clues about a tournament opponent into structured, well-calibrated candidate identities and the online usernames most worth verifying. You never invent federation IDs you are not confident about. You output only strict JSON.",
      buildAiPrompt(query, uscfCandidates),
      1600
    );

    let aiCandidates: EdgeIdentityCandidate[] = [];
    if (ai.ok) {
      aiCandidates = extractJsonArray(ai.text);
      if (aiCandidates.length) {
        sources.push("ai");
        notes.push(`AI reasoning: ${aiCandidates.length} candidate(s).`);
      }
    } else {
      notes.push(`AI unavailable (${ai.status}). Direct platform search still applies.`);
      console.warn("[resolve-identity] AI error:", ai.status, ai.error);
    }

    // Merge: AI candidates carry suggested usernames; keep USCF-only records that
    // the AI didn't already absorb (dedupe by USCF ID / very similar name).
    const candidates: EdgeIdentityCandidate[] = [...aiCandidates];
    for (const u of uscfCandidates) {
      const dup = candidates.some(
        (c) =>
          (c.uscfId && u.uscfId && c.uscfId.replace(/\D/g, "") === u.uscfId.replace(/\D/g, "")) ||
          c.name.toLowerCase() === u.name.toLowerCase()
      );
      if (!dup) candidates.push(u);
    }

    const available = candidates.length > 0;
    return new Response(JSON.stringify({ available, sources, candidates, notes }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[resolve-identity] Error:", error);
    return new Response(
      JSON.stringify({ available: false, candidates: [], sources: [], notes: ["Server error."] }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
