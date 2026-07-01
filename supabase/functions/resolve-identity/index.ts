import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callAI } from "../_shared/ai.ts";
import {
  searchUscfByName,
  fetchUscfMember,
  fetchUscfTournaments,
  fetchCrosstableOpponents,
  mapLimit,
  type UscfMember,
  type UscfSearchRow,
} from "./uscf.ts";

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
// USCF deep search: name → member detail (all ratings incl. online) →
// tournament history → online-event crosstables → opponents. Builds the
// tournament graph the client traverses. All wrapped so failure degrades to
// "no USCF data" rather than breaking the search.
// ---------------------------------------------------------------------------

interface GraphOpponent {
  uscfId: string;
  name: string;
  rating?: number;
}
interface GraphEvent {
  eventId: string;
  name: string;
  date?: string;
  platformGuess?: string;
  opponents: GraphOpponent[];
}
interface TournamentGraph {
  rootUscfId: string;
  rootName: string;
  rootState?: string;
  onlineEvents: GraphEvent[];
}

const RATING_KEY_LABEL: Record<string, string> = {
  regular: "USCF Regular",
  quick: "USCF Quick",
  blitz: "USCF Blitz",
  onlineRegular: "USCF Online Regular",
  onlineQuick: "USCF Online Quick",
  onlineBlitz: "USCF Online Blitz",
  correspondence: "USCF Correspondence",
};

/** Rank raw search rows against the query (name similarity + rating + state). */
function rankRows(rows: UscfSearchRow[], query: PlayerQuery): UscfSearchRow[] {
  const qName = query.name.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const score = (r: UscfSearchRow): number => {
    let s = 0;
    const rn = r.name.toLowerCase();
    const qTokens = qName.split(/\s+/).filter(Boolean);
    for (const t of qTokens) if (rn.includes(t)) s += 2;
    if (query.approxRating && r.rating) s += Math.max(0, 2 - Math.abs(query.approxRating - r.rating) / 200);
    if (query.state && r.state && query.state.toUpperCase() === r.state.toUpperCase()) s += 2;
    if (r.rating) s += 0.2; // prefer rated members over unrated homonyms
    return s;
  };
  return [...rows].sort((a, b) => score(b) - score(a));
}

function memberToCandidate(m: UscfMember, query: PlayerQuery): EdgeIdentityCandidate {
  const ratings: Record<string, number> = {};
  for (const [k, v] of Object.entries(m.ratings)) {
    if (typeof v === "number") ratings[RATING_KEY_LABEL[k] || k] = v;
  }
  const estimatedRating =
    m.ratings.regular ?? m.ratings.onlineRegular ?? m.ratings.quick ?? m.ratings.blitz ?? m.ratings.onlineBlitz;
  const onlineNote = m.hasOnline
    ? ` Has online USCF ratings (played online-rated events)${m.ratings.onlineRegular ? ` — Online Regular ${m.ratings.onlineRegular}` : ""}.`
    : "";
  return {
    source: "uscf",
    name: m.name,
    federation: "USCF",
    country: "US",
    state: m.state ?? query.state,
    uscfId: m.id,
    fideId: m.fideId,
    estimatedRating,
    ratings: Object.keys(ratings).length ? ratings : undefined,
    reasoning: `US Chess member #${m.id} (${m.name})${estimatedRating ? `, ~${estimatedRating} USCF` : ""}.${onlineNote}`,
  };
}

async function deepUscfSearch(
  query: PlayerQuery,
  wantGraph: boolean
): Promise<{ candidates: EdgeIdentityCandidate[]; graph: TournamentGraph | null; debug: Record<string, unknown> }> {
  const debug: Record<string, unknown> = {};
  let members: UscfMember[] = [];

  try {
    if (query.uscfId && /\d{6,}/.test(query.uscfId)) {
      const mem = await fetchUscfMember(query.uscfId.replace(/\D/g, ""));
      if (mem) members = [mem];
      debug.byId = !!mem;
    } else {
      const rows = await searchUscfByName(query.name, query.state);
      debug.searchCount = rows.length;
      debug.searchRows = rows.slice(0, 6);
      const top = rankRows(rows, query).slice(0, 3);
      members = (await mapLimit(top, 3, (r) => fetchUscfMember(r.id))).filter((x): x is UscfMember => !!x);
    }
  } catch (e) {
    debug.error = String(e);
  }

  debug.members = members.map((m) => ({ id: m.id, name: m.name, state: m.state, ratings: m.ratings, hasOnline: m.hasOnline }));
  const candidates = members.map((m) => memberToCandidate(m, query));

  // Tournament graph for the strongest match (only when the caller wants it).
  let graph: TournamentGraph | null = null;
  if (wantGraph && members.length) {
    try {
      const best = members[0];
      const events = await fetchUscfTournaments(best.id);
      debug.eventCount = events.length;
      const online = events.filter((e) => e.online).slice(0, 4);
      debug.onlineEventCount = online.length;
      const withOpponents = await mapLimit(online, 3, async (e) => ({
        event: e,
        opponents: await fetchCrosstableOpponents(e.eventId, best.id),
      }));
      graph = {
        rootUscfId: best.id,
        rootName: best.name,
        rootState: best.state,
        onlineEvents: withOpponents.map(({ event, opponents }) => ({
          eventId: event.eventId,
          name: event.name,
          date: event.date,
          platformGuess: event.platformGuess,
          opponents: opponents.slice(0, 20),
        })),
      };
      debug.graphOpponents = graph.onlineEvents.reduce((n, e) => n + e.opponents.length, 0);
    } catch (e) {
      debug.graphError = String(e);
    }
  }

  return { candidates, graph, debug };
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

// Normalise a model-supplied platform string to a fetchable platform, or drop
// it. Gemini commonly returns "Chess.com" / "lichess.org" / "Twitch"; we only
// keep handles we can actually pull games from.
function normalizePlatform(p: unknown): Platform | undefined {
  if (typeof p !== "string") return undefined;
  const s = p.toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("lichess")) return "lichess";
  if (s.includes("chesscom") || s === "chess") return "chesscom";
  return undefined;
}

function sanitizeCandidate(c: Record<string, unknown>): EdgeIdentityCandidate {
  const allowedSources = ["uscf", "fide", "ai", "chessresults"];
  const source = (typeof c.source === "string" && allowedSources.includes(c.source) ? c.source : "ai") as EdgeIdentityCandidate["source"];
  const suggested = Array.isArray(c.suggestedUsernames)
    ? (c.suggestedUsernames as unknown[])
        .map((u) => {
          const o = u as Record<string, unknown>;
          const platform = normalizePlatform(o.platform);
          const username = typeof o.username === "string" ? o.username.trim().replace(/^@/, "") : "";
          return platform && username ? { platform, username } : null;
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
    const debugMode = body?.debug === true;
    // Only chase the (slower) tournament graph when it's plausibly a US player.
    const wantGraph =
      body?.graph !== false &&
      (query.federation === "USCF" || !!query.uscfId || !!query.state || !query.federation);
    if (!query.name || !query.name.trim()) {
      return new Response(JSON.stringify({ available: false, candidates: [], sources: [], notes: ["Missing name."] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[resolve-identity] query:", JSON.stringify({ name: query.name, fed: query.federation, state: query.state }));

    const sources: string[] = [];
    const notes: string[] = [];

    // 1. Server-side USCF deep search + tournament graph (never fatal).
    const { candidates: uscfCandidates, graph, debug } = await deepUscfSearch(query, wantGraph);
    if (uscfCandidates.length) {
      sources.push("uscf");
      notes.push(`US Chess: ${uscfCandidates.length} member match(es).`);
    }
    if (graph && graph.onlineEvents.length) {
      const opps = graph.onlineEvents.reduce((n, e) => n + e.opponents.length, 0);
      notes.push(`Tournament graph: ${graph.onlineEvents.length} online event(s), ${opps} opponents to traverse.`);
    }

    // 2. AI reasoning pass — refines USCF hits and proposes usernames.
    const ai = await callAI(
      "You are an expert chess identity-resolution analyst. You convert sparse clues about a tournament opponent into structured, well-calibrated candidate identities and the online usernames most worth verifying. You never invent federation IDs you are not confident about. You output only strict JSON.",
      buildAiPrompt(query, uscfCandidates),
      2048
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

    // Merge: prefer real USCF records first (they carry verified IDs/ratings),
    // then AI candidates the USCF pass didn't already cover (dedupe by ID/name).
    const candidates: EdgeIdentityCandidate[] = [...uscfCandidates];
    for (const a of aiCandidates) {
      const dup = candidates.some(
        (c) =>
          (c.uscfId && a.uscfId && c.uscfId.replace(/\D/g, "") === a.uscfId.replace(/\D/g, "")) ||
          c.name.toLowerCase() === a.name.toLowerCase()
      );
      if (dup) {
        // Fold the AI's suggested usernames onto the matching USCF record.
        const target = candidates.find(
          (c) =>
            (c.uscfId && a.uscfId && c.uscfId.replace(/\D/g, "") === a.uscfId.replace(/\D/g, "")) ||
            c.name.toLowerCase() === a.name.toLowerCase()
        );
        if (target && a.suggestedUsernames?.length) {
          target.suggestedUsernames = [...(target.suggestedUsernames || []), ...a.suggestedUsernames].slice(0, 10);
        }
      } else {
        candidates.push(a);
      }
    }

    const available = candidates.length > 0;
    const payload: Record<string, unknown> = { available, sources, candidates, notes, tournamentGraph: graph };
    if (debugMode) payload.debug = debug;
    return new Response(JSON.stringify(payload), {
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
