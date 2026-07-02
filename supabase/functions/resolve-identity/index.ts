import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callAI, callAIWithSearch } from "../_shared/ai.ts";
import {
  searchUscfByName,
  fetchUscfMember,
  buildOnlineGraphForMember,
  type UscfMember,
  type UscfSearchRow,
  type OnlineSection,
} from "./uscf.ts";

// ============================================================================
// Edge function: resolve-identity
//
// The server-side half of ScoutTree's Identity Resolution Engine. The browser
// can talk to Lichess/Chess.com directly (CORS-friendly), but the US Chess
// ratings API (MUIR, ratings-api.uschess.org) sends no CORS headers and any
// "reasoning over the open web" needs a server. This function:
//
//   1. resolves the player against the US Chess member database (by ID or by a
//      fuzzy name search), reading real ratings incl. the Online systems, and
//   2. builds the **tournament graph** — every online-rated section the player
//      appeared in, with the full crosstable (each opponent's USCF ID, colour
//      and round). This is the mesh the client traverses to discover the
//      player's online usernames.
//   3. runs an AI reasoning pass that turns loose clues into candidate
//      identities + the online usernames most worth verifying (a fast fallback).
//
// It always returns 200 with a structured body. Response shape (consumed by
// src/lib/identity/providers/edgeClient.ts):
//   { available, sources[], candidates[], notes[], tournamentGraph, graphTraversalReady }
//
// An "expand" call — { expandMemberId: "<uscfId>" } — returns just the graph for
// that member, letting the client recurse into an opponent's own online history.
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
// Tournament graph (shared shape with the client). Each online event carries
// the full section roster; every player carries their round-by-round games so
// the client can walk the mesh (target → opponents → their online games).
// ---------------------------------------------------------------------------

interface GraphGame {
  round: number;
  color: "white" | "black" | "unknown";
  outcome: string;
  opponentUscfId: string;
  opponentName: string;
}
interface GraphPlayer {
  uscfId: string;
  name: string;
  rating?: number;
  isTarget?: boolean;
  games: GraphGame[];
}
interface GraphEvent {
  eventId: string;
  name: string;
  sectionName?: string;
  startDate?: string;
  endDate?: string;
  ratingSystem: string;
  timeControl?: string;
  roundCount?: number;
  isBlitz?: boolean;
  platformGuess?: string;
  players: GraphPlayer[];
}
interface TournamentGraph {
  rootUscfId: string;
  rootName: string;
  rootState?: string;
  onlineEvents: GraphEvent[];
  graphTraversalReady: boolean;
}

const RATING_KEY_LABEL: Record<string, string> = {
  regular: "USCF Regular",
  quick: "USCF Quick",
  blitz: "USCF Blitz",
  onlineRegular: "USCF Online Regular",
  onlineQuick: "USCF Online Quick",
  onlineBlitz: "USCF Online Blitz",
};

// ---------------------------------------------------------------------------
// Member ranking + candidate mapping
// ---------------------------------------------------------------------------

/** Rank member rows against the query (name tokens + state + online + rating). */
function rankMembers(rows: UscfSearchRow[], query: PlayerQuery): UscfSearchRow[] {
  const qName = query.name.toLowerCase().replace(/[^a-z ]/g, " ").trim();
  const qTokens = qName.split(/\s+/).filter(Boolean);
  const score = (r: UscfSearchRow): number => {
    let s = 0;
    const rn = r.name.toLowerCase();
    for (const t of qTokens) if (rn.includes(t)) s += 2;
    if (query.state && r.state && query.state.toUpperCase() === r.state.toUpperCase()) s += 2;
    if (query.approxRating && r.rating) s += Math.max(0, 2 - Math.abs(query.approxRating - r.rating) / 200);
    if (r.hasOnline) s += 1.5; // players with online history are what we can traverse
    if (r.rating) s += 0.3; // prefer rated members over unrated homonyms
    if (r.status && /expired|inactive/i.test(r.status)) s -= 0.5;
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
    ? ` Has online US Chess ratings${m.ratings.onlineRegular ? ` (Online Regular ${m.ratings.onlineRegular})` : ""} — traversable online tournament history.`
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
    title: m.title,
    reasoning: `US Chess member #${m.id} (${m.name})${estimatedRating ? `, ~${estimatedRating} USCF` : ""}.${onlineNote}`,
  };
}

/** Resolve the query to member records (by ID, else fuzzy name search). */
async function resolveMembers(query: PlayerQuery): Promise<{ members: UscfMember[]; debug: Record<string, unknown> }> {
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
      debug.searchRows = rows.slice(0, 6).map((r) => ({ id: r.id, name: r.name, state: r.state, rating: r.rating, hasOnline: r.hasOnline }));
      // Search rows already carry full member data (ratings/state/online), so no
      // per-row detail fetch is needed — just rank and keep the top few.
      members = rankMembers(rows, query).slice(0, 4);
    }
  } catch (e) {
    debug.error = String(e);
  }
  return { members, debug };
}

function sectionsToGraph(member: UscfMember, sections: OnlineSection[]): TournamentGraph {
  const onlineEvents: GraphEvent[] = sections.map((s) => ({
    eventId: s.eventId,
    name: s.name,
    sectionName: s.sectionName,
    startDate: s.startDate,
    endDate: s.endDate,
    ratingSystem: s.ratingSystem,
    timeControl: s.timeControl,
    roundCount: s.roundCount,
    isBlitz: s.isBlitz,
    platformGuess: s.platformGuess,
    players: s.players.map((p) => ({
      uscfId: p.uscfId,
      name: p.name,
      rating: p.rating,
      isTarget: p.isTarget,
      games: p.games,
    })),
  }));
  return {
    rootUscfId: member.id,
    rootName: member.name,
    rootState: member.state,
    onlineEvents,
    graphTraversalReady: onlineEvents.length > 0,
  };
}

// ---------------------------------------------------------------------------
// AI reasoning pass — the "detective". Turns clues into structured candidates.
// (Unchanged fast fallback: used when the tournament graph doesn't find a match.)
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

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Expand: build just the tournament graph for a specific USCF member ID. */
async function handleExpand(memberId: string): Promise<Response> {
  const clean = memberId.replace(/\D/g, "");
  const member = clean ? await fetchUscfMember(clean) : null;
  if (!member) return json({ available: false, tournamentGraph: null, graphTraversalReady: false });
  const sections = await buildOnlineGraphForMember(member);
  const graph = sectionsToGraph(member, sections);
  return json({ available: true, tournamentGraph: graph, graphTraversalReady: graph.graphTraversalReady });
}

// ---------------------------------------------------------------------------
// Discover: web-search the flyer/TLA/announcement of a USCF online event to
// learn which platform hosted it — and ideally the exact tournament page
// (Chess.com tournament slug / Lichess swiss or arena id), whose public API
// then hands the client the full participant roster.
// ---------------------------------------------------------------------------

interface DiscoverEventBody {
  name?: string;
  sectionName?: string;
  startDate?: string;
  endDate?: string;
  ratingSystem?: string;
  timeControl?: string;
}

const CHESSCOM_TOURNAMENT_RE = /(?:api\.)?chess\.com\/(?:pub\/tournament|(?:play\/)?tournament(?:\/live)?)\/([a-z0-9][a-z0-9-]{2,120})/gi;
const LICHESS_SWISS_RE = /lichess\.org\/(?:api\/)?swiss\/([a-zA-Z0-9]{8})/g;
const LICHESS_ARENA_RE = /lichess\.org\/(?:api\/)?tournament\/([a-zA-Z0-9]{8})/g;

function collectMatches(re: RegExp, text: string): string[] {
  const out = new Set<string>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.size < 5) out.add(m[1]);
  return Array.from(out);
}

async function handleDiscoverEvent(ev: DiscoverEventBody): Promise<Response> {
  const name = (ev.name || "").trim();
  if (!name) return json({ available: false });

  const lines = [
    `Name: ${name}`,
    ev.sectionName ? `Section: ${ev.sectionName}` : "",
    ev.startDate ? `Dates: ${ev.startDate}${ev.endDate && ev.endDate !== ev.startDate ? ` to ${ev.endDate}` : ""}` : "",
    ev.ratingSystem ? `US Chess rating system: ${ev.ratingSystem} (online-rated)` : "",
    ev.timeControl ? `Time control: ${ev.timeControl}` : "",
  ].filter(Boolean);

  const prompt = `A US Chess (USCF) rated ONLINE tournament needs to be located on the web. Figure out which platform hosted the games — chess.com, lichess, chesskid or ICC — and if at all possible find the EXACT tournament page.

EVENT:
${lines.join("\n")}

Search for the event's flyer, TLA (Tournament Life Announcement), club announcement/website, or results page. USCF online events (mostly 2020-2021) almost always say "played on Chess.com" or "hosted on lichess.org", and often link the tournament directly (chess.com/tournament/..., lichess.org/swiss/... or lichess.org/tournament/...). Organiser/club names inside the event name are strong search terms.

Return STRICT JSON only (no prose, no markdown fences):
{"platform":"chesscom"|"lichess"|"chesskid"|"icc"|"unknown","urls":["any tournament/flyer URLs found"],"confidence":0.0-1.0,"note":"one short sentence on what you found"}`;

  const ai = await callAIWithSearch(
    "You are a research assistant locating where US Chess online-rated tournaments were hosted. You search the web, answer only from what you find, and output strict JSON.",
    prompt,
    1200
  );
  if (!ai.ok) return json({ available: false, note: ai.error });

  // Parse the JSON answer, but also regex-scan the WHOLE response for platform
  // URLs — grounded answers sometimes cite links outside the JSON.
  let platform: string | undefined;
  let confidence: number | undefined;
  let note: string | undefined;
  let urlText = ai.text;
  try {
    const s = ai.text.replace(/```(?:json)?/gi, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(s.slice(start, end + 1));
      if (typeof parsed.platform === "string") {
        const p = parsed.platform.toLowerCase().replace(/[^a-z]/g, "");
        if (["chesscom", "lichess", "chesskid", "icc"].includes(p)) platform = p;
      }
      if (typeof parsed.confidence === "number") confidence = Math.max(0, Math.min(1, parsed.confidence));
      if (typeof parsed.note === "string") note = parsed.note.slice(0, 300);
      if (Array.isArray(parsed.urls)) urlText += "\n" + parsed.urls.filter((u: unknown) => typeof u === "string").join("\n");
    }
  } catch {
    /* fall through to regex-only parsing */
  }

  const chesscomSlugs = collectMatches(CHESSCOM_TOURNAMENT_RE, urlText);
  const lichessSwissIds = collectMatches(LICHESS_SWISS_RE, urlText);
  const lichessArenaIds = collectMatches(LICHESS_ARENA_RE, urlText);
  if (!platform) {
    if (chesscomSlugs.length && !lichessSwissIds.length && !lichessArenaIds.length) platform = "chesscom";
    else if (!chesscomSlugs.length && (lichessSwissIds.length || lichessArenaIds.length)) platform = "lichess";
  }

  console.log(
    "[resolve-identity] discoverEvent:",
    JSON.stringify({ name, platform, chesscomSlugs, lichessSwissIds, lichessArenaIds, confidence })
  );
  return json({
    available: !!(platform || chesscomSlugs.length || lichessSwissIds.length || lichessArenaIds.length),
    platform,
    chesscomSlugs,
    lichessSwissIds,
    lichessArenaIds,
    confidence,
    note,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // --- Expand mode (client recursion into an opponent's online history) ----
    if (typeof body?.expandMemberId === "string" && body.expandMemberId.trim()) {
      return await handleExpand(body.expandMemberId);
    }

    // --- Discover mode (web/flyer search: which platform hosted this event) --
    if (body?.discoverEvent && typeof body.discoverEvent === "object") {
      return await handleDiscoverEvent(body.discoverEvent as DiscoverEventBody);
    }

    const query: PlayerQuery = body?.query || {};
    const debugMode = body?.debug === true;
    const wantGraph = body?.graph !== false;
    if (!query.name || !query.name.trim()) {
      return json({ available: false, candidates: [], sources: [], notes: ["Missing name."], graphTraversalReady: false });
    }

    console.log("[resolve-identity] query:", JSON.stringify({ name: query.name, fed: query.federation, state: query.state }));

    const sources: string[] = [];
    const notes: string[] = [];

    // 1. Resolve US Chess member(s) + build the tournament graph for the best
    //    online-capable candidate. Never fatal.
    const { members, debug } = await resolveMembers(query);
    const uscfCandidates = members.map((m) => memberToCandidate(m, query));
    if (uscfCandidates.length) {
      sources.push("uscf");
      notes.push(`US Chess: ${uscfCandidates.length} member match(es).`);
    }

    let graph: TournamentGraph | null = null;
    if (wantGraph && members.length) {
      // Prefer the highest-ranked member that actually has online ratings.
      const target = members.find((m) => m.hasOnline) || members[0];
      try {
        const sections = await buildOnlineGraphForMember(target);
        graph = sectionsToGraph(target, sections);
        debug.onlineSectionCount = sections.length;
        debug.graphOpponents = graph.onlineEvents.reduce((n, e) => n + e.players.length, 0);
        if (graph.onlineEvents.length) {
          const games = graph.onlineEvents.reduce(
            (n, e) => n + (e.players.find((p) => p.isTarget)?.games.length || 0),
            0
          );
          notes.push(
            `Tournament graph: ${graph.onlineEvents.length} online section(s), ${games} of the player's online games to trace.`
          );
        }
      } catch (e) {
        debug.graphError = String(e);
      }
    }
    const graphTraversalReady = !!graph?.graphTraversalReady;

    // 2. AI reasoning pass — refines USCF hits and proposes usernames (fallback).
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

    // Merge: prefer real USCF records first, then AI candidates the USCF pass
    // didn't already cover (dedupe by ID/name).
    const candidates: EdgeIdentityCandidate[] = [...uscfCandidates];
    for (const a of aiCandidates) {
      const target = candidates.find(
        (c) =>
          (c.uscfId && a.uscfId && c.uscfId.replace(/\D/g, "") === a.uscfId.replace(/\D/g, "")) ||
          c.name.toLowerCase() === a.name.toLowerCase()
      );
      if (target) {
        if (a.suggestedUsernames?.length) {
          target.suggestedUsernames = [...(target.suggestedUsernames || []), ...a.suggestedUsernames].slice(0, 10);
        }
      } else {
        candidates.push(a);
      }
    }

    const available = candidates.length > 0;
    const payload: Record<string, unknown> = {
      available,
      sources,
      candidates,
      notes,
      tournamentGraph: graph,
      graphTraversalReady,
    };
    if (debugMode) payload.debug = debug;
    return json(payload);
  } catch (error) {
    console.error("[resolve-identity] Error:", error);
    return json({ available: false, candidates: [], sources: [], notes: ["Server error."], graphTraversalReady: false });
  }
});
