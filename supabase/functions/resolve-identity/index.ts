import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callAI, readEnv } from "../_shared/ai.ts";
import {
  discoverEventOnWeb,
  findUsernamesOnWeb,
  type DiscoverEventRequest,
  type UsernameSearchRequest,
} from "./googleSearch.ts";
import {
  searchUscfByName,
  fetchUscfMember,
  findMemberId,
  buildOnlineGraphForMember,
  type UscfMember,
  type UscfSearchRow,
  type OnlineSection,
} from "./uscf.ts";
import {
  findSchoolForPlayer,
  fetchSchoolRoster,
  fetchChesscomFriends,
} from "./school.ts";
import {
  handleMemberSearch,
  handleMemberPreview,
  handleFideSearch,
  handleResolvedHandles,
  handleClaimHandle,
  handleOptOut,
  memberSearchRateLimited,
} from "./anchor.ts";
import { getEventPlatform, putEventPlatform } from "../_shared/identityStore.ts";
import type { SchoolLookupRequest } from "../../../src/lib/identity/schoolTypes.ts";

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

// ---------------------------------------------------------------------------
// Wall-clock budgets. THE fix for the "boots, logs the query, then shutdown
// with no response" failure: a graph build for a very active player (hundreds
// of online events → hundreds of throttled MUIR calls) used to run until it
// overran the Supabase edge function's own wall-clock limit, at which point the
// isolate was KILLED mid-build — so the function returned nothing and the client
// hung. Now the build is handed an internal deadline comfortably under that
// platform limit; when it's hit we return the anchor identities plus whatever
// partial graph was gathered, flagged `partial:true`, so the client always gets
// a response and degrades gracefully instead of hanging. Override via env for a
// project on a plan with a different wall-clock ceiling.
const RESOLVE_BUDGET_MS = Math.max(10_000, Number(readEnv("RESOLVE_BUDGET_MS")) || 55_000);
const EXPAND_BUDGET_MS = Math.max(10_000, Number(readEnv("EXPAND_BUDGET_MS")) || 45_000);

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

/** Big payloads (a tournament graph is easily several hundred KB of JSON) are
 *  gzipped when the caller accepts it — less bandwidth, faster client parse
 *  start. Small payloads skip the compression overhead. Content-Encoding is
 *  set explicitly, so fetch() on every client decompresses transparently. */
const GZIP_MIN_BYTES = 4096;

async function jsonMaybeGzip(payload: unknown, acceptEncoding: string | null): Promise<Response> {
  const body = JSON.stringify(payload);
  const gzipOk = /\bgzip\b/i.test(acceptEncoding || "");
  if (!gzipOk || body.length < GZIP_MIN_BYTES || typeof CompressionStream === "undefined") {
    return new Response(body, { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  try {
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = await new Response(stream).arrayBuffer();
    return new Response(compressed, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        Vary: "Accept-Encoding",
      },
    });
  } catch {
    return new Response(body, { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

/** Expand: build just the tournament graph for a specific USCF member ID.
 *  Memoized per member for the life of the (warm) instance: the pivot stage
 *  expands dozens of opponents and several browser clients can ask about the
 *  same member — each rebuild costs a full MUIR walk (events + sections +
 *  standings). Crosstables of 2020-era events never change; a short TTL only
 *  bounds memory. Failures are not memoized. */
const expandMemo = new Map<string, { at: number; payload: { available: boolean; tournamentGraph: unknown; graphTraversalReady: boolean; partial?: boolean } }>();
const EXPAND_MEMO_TTL_MS = 15 * 60_000;

async function handleExpand(memberId: string, acceptEncoding: string | null): Promise<Response> {
  const t0 = Date.now();
  const clean = memberId.replace(/\D/g, "");
  const hit = clean ? expandMemo.get(clean) : undefined;
  if (hit && Date.now() - hit.at < EXPAND_MEMO_TTL_MS) return jsonMaybeGzip(hit.payload, acceptEncoding);
  const member = clean ? await fetchUscfMember(clean) : null;
  if (!member) return json({ available: false, tournamentGraph: null, graphTraversalReady: false });
  let truncated = false;
  const sections = await buildOnlineGraphForMember(member, {
    deadlineMs: t0 + EXPAND_BUDGET_MS,
    onTruncated: () => {
      truncated = true;
    },
  });
  const graph = sectionsToGraph(member, sections);
  const payload = { available: true, tournamentGraph: graph, graphTraversalReady: graph.graphTraversalReady, partial: truncated };
  // Only memoize a COMPLETE build — a partial (budget-truncated) graph must be
  // retryable, and by then the warm MUIR cache makes the rebuild cheap.
  if (!truncated) {
    expandMemo.set(clean, { at: Date.now(), payload });
    if (expandMemo.size > 200) {
      // Bound memory on a long-lived instance: drop the stalest half.
      const entries = [...expandMemo.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [k] of entries.slice(0, 100)) expandMemo.delete(k);
    }
  }
  console.log(
    "[resolve-identity] expand:",
    JSON.stringify({ memberId: clean, sections: sections.length, ms: Date.now() - t0, partial: truncated })
  );
  return jsonMaybeGzip(payload, acceptEncoding);
}

// ---------------------------------------------------------------------------
// Discover: web-search the flyer/TLA/announcement of a USCF online event to
// learn which platform hosted it — and ideally the exact tournament page
// (Chess.com tournament slug / Lichess swiss or arena id), whose public API
// then hands the client the full participant roster. Logic in googleSearch.ts.
// ---------------------------------------------------------------------------

/** Resolve the platform that best summarises a discovery payload — the AI sets
 *  `platform` directly, but an answer that only found tournament links still
 *  implies its platform, and that is what makes the row's `platform` column
 *  useful. Mirrors the client's platformFromInfo so a cache hit and a fresh
 *  answer agree. */
function summarisePlatform(info: {
  platform?: string;
  chesscomSlugs?: string[];
  lichessSwissIds?: string[];
  lichessArenaIds?: string[];
}): string {
  if (info.platform && info.platform !== "unknown") return info.platform;
  if (info.chesscomSlugs?.length) return "chesscom";
  if (info.lichessSwissIds?.length || info.lichessArenaIds?.length) return "lichess";
  return "unknown";
}

async function handleDiscoverEvent(ev: DiscoverEventRequest): Promise<Response> {
  const eventId = (ev.eventId || "").trim();

  // Persistent cache first: which platform hosted this event is immutable and
  // shared across every search, so a hit turns the 2-4s grounded AI web-search
  // into an instant DB read. Only known USCF event ids may hit the cache.
  if (eventId) {
    const cached = await getEventPlatform(eventId);
    if (cached) {
      const info =
        cached.info && typeof cached.info === "object"
          ? (cached.info as Record<string, unknown>)
          : { platform: cached.platform };
      console.log("[resolve-identity] discoverEvent (cache hit):", JSON.stringify({ eventId, name: ev.name, platform: cached.platform }));
      return json({ available: true, cached: true, ...info });
    }
  }

  const info = await discoverEventOnWeb(ev);
  if (!info) return json({ available: false });
  console.log("[resolve-identity] discoverEvent:", JSON.stringify({ eventId, name: ev.name, ...info }));

  // Persist for the next search that touches this event (fire-and-forget — the
  // discovery answer never depends on the write landing). Stored with the full
  // payload so a hit reproduces the roster shortcut's tournament links too.
  // Guard: a shaky, link-less, low-confidence guess is NOT locked in for a year
  // — a cached wrong platform would steer the event to the wrong site's API on
  // every future search. Concrete tournament links, or a confidence the AI
  // didn't flag as weak, are safe to cache.
  const hasLinks = !!(info.chesscomSlugs?.length || info.lichessSwissIds?.length || info.lichessArenaIds?.length);
  const confidentEnough = info.confidence === undefined || info.confidence >= 0.4;
  if (eventId && (hasLinks || confidentEnough)) {
    void putEventPlatform(eventId, summarisePlatform(info), info, "web_search");
  }

  return json({
    available: true,
    platform: info.platform,
    chesscomSlugs: info.chesscomSlugs,
    lichessSwissIds: info.lichessSwissIds,
    lichessArenaIds: info.lichessArenaIds,
    confidence: info.confidence,
    note: info.note,
  });
}

// ---------------------------------------------------------------------------
// Find-username: Google-index search for a specific person's Lichess/Chess.com
// handles (the query ladder lives in googleSearch.ts). This replaces platform
// name search as the way the traversal engine resolves tournament players —
// candidates are verified client-side against real games in the event window.
// ---------------------------------------------------------------------------

async function handleFindUsername(body: Record<string, unknown>): Promise<Response> {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ available: false, candidates: [] });

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const req: UsernameSearchRequest = {
    name,
    state: str(body.state),
    city: str(body.city),
    clubOrSchool: str(body.clubOrSchool),
    uscfRating: typeof body.uscfRating === "number" && isFinite(body.uscfRating) ? body.uscfRating : undefined,
    fideId: str(body.fideId),
    eventName: str(body.eventName),
    eventDate: str(body.eventDate),
    platforms: Array.isArray(body.platforms)
      ? (body.platforms.filter((p) => p === "chesscom" || p === "lichess") as ("chesscom" | "lichess")[])
      : undefined,
    knownUsernames: Array.isArray(body.knownUsernames)
      ? (body.knownUsernames.filter((u) => typeof u === "string") as string[]).slice(0, 4)
      : undefined,
  };

  const result = await findUsernamesOnWeb(req, (m) => console.log("[resolve-identity] findUsername:", m));
  console.log(
    "[resolve-identity] findUsername:",
    JSON.stringify({ name, backend: result.backend, found: result.candidates.length, quotaExhausted: result.quotaExhausted ?? false })
  );
  return json({
    available: result.backend !== "none",
    candidates: result.candidates,
    backend: result.backend,
    note: result.note,
    // True when the empty answer means "search quota exhausted", NOT "the
    // index has no match" — clients must not cache this as a definitive miss.
    quotaExhausted: result.quotaExhausted ?? false,
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // --- Health check (monitoring): a cheap liveness/config probe that does NO
    //     MUIR or AI work, so an uptime monitor can tell the function is booting
    //     and serving without spending discovery-grade time/quota. -------------
    if (body?.health === true || body?.ping === true) {
      const aiConfigured =
        !!((readEnv("AI_PROXY_BASE_URL") && readEnv("AI_PROXY_API_KEY")) ||
          readEnv("GEMINI_API_KEY") ||
          readEnv("GOOGLE_API_KEY") ||
          readEnv("ANTHROPIC_API_KEY"));
      const storeConfigured = !!(
        (readEnv("SUPABASE_URL") || readEnv("VITE_SUPABASE_URL")) &&
        (readEnv("SUPABASE_SERVICE_ROLE_KEY") || readEnv("SUPABASE_SERVICE_KEY") || readEnv("SUPABASE_SECRET_KEY"))
      );
      return json({
        ok: true,
        service: "resolve-identity",
        time: new Date().toISOString(),
        resolveBudgetMs: RESOLVE_BUDGET_MS,
        expandBudgetMs: EXPAND_BUDGET_MS,
        aiConfigured,
        muirCacheConfigured: storeConfigured,
      });
    }

    // --- Anchor-phase modes (the FAST half of the anchor → discovery split) --
    // memberSearch powers the live picker: no graph build, no AI, one cached
    // MUIR search. Rate-limited per client because it fires while typing.
    if (body?.memberSearch && typeof body.memberSearch === "object") {
      const clientKey =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        req.headers.get("cf-connecting-ip") ||
        "anon";
      if (memberSearchRateLimited(clientKey)) {
        return json({ available: false, hits: [], rateLimited: true });
      }
      return json(await handleMemberSearch(body.memberSearch as Record<string, unknown>));
    }
    if (body?.memberPreview && typeof body.memberPreview === "object") {
      return json(await handleMemberPreview(body.memberPreview as Record<string, unknown>));
    }
    if (body?.fideSearch && typeof body.fideSearch === "object") {
      return json(await handleFideSearch(body.fideSearch as Record<string, unknown>));
    }
    if (body?.resolvedHandles && typeof body.resolvedHandles === "object") {
      return json(await handleResolvedHandles(body.resolvedHandles as Record<string, unknown>));
    }
    if (body?.claimHandle && typeof body.claimHandle === "object") {
      return json(await handleClaimHandle(body.claimHandle as Record<string, unknown>));
    }
    if (body?.optOut && typeof body.optOut === "object") {
      return json(await handleOptOut(body.optOut as Record<string, unknown>));
    }

    // --- Expand mode (client recursion into an opponent's online history) ----
    if (typeof body?.expandMemberId === "string" && body.expandMemberId.trim()) {
      return await handleExpand(body.expandMemberId, req.headers.get("accept-encoding"));
    }

    // --- Discover mode (web/flyer search: which platform hosted this event) --
    if (body?.discoverEvent && typeof body.discoverEvent === "object") {
      return await handleDiscoverEvent(body.discoverEvent as DiscoverEventRequest);
    }

    // --- Find-username mode (Google-index search for a person's handles) -----
    if (body?.findUsername && typeof body.findUsername === "object") {
      return await handleFindUsername(body.findUsername as Record<string, unknown>);
    }

    // --- USCF-ID lookup mode (name + state → member ID; the school resolver's
    //     bridge from a roster name to the ID-based identity engine) ----------
    if (body?.findUscfId && typeof body.findUscfId === "object") {
      const r = body.findUscfId as { firstName?: string; lastName?: string; state?: string; rating?: number };
      const firstName = typeof r.firstName === "string" ? r.firstName.trim() : "";
      const lastName = typeof r.lastName === "string" ? r.lastName.trim() : "";
      if (!firstName || !lastName) return json({ available: false, uscfId: null });
      const found = await findMemberId(
        firstName,
        lastName,
        typeof r.state === "string" && r.state.trim() ? r.state.trim() : undefined,
        typeof r.rating === "number" && isFinite(r.rating) ? r.rating : undefined
      );
      console.log(
        "[resolve-identity] findUscfId:",
        JSON.stringify({ name: `${firstName} ${lastName}`, state: r.state, uscfId: found?.uscfId ?? null })
      );
      return json(found ? { available: true, uscfId: found.uscfId, rating: found.rating } : { available: true, uscfId: null });
    }

    // --- School-affiliation mode (NWSRS / state assns / registration / web) --
    if (body?.findSchool && typeof body.findSchool === "object") {
      const req = body.findSchool as SchoolLookupRequest;
      if (!req.name || !String(req.name).trim()) return json({ available: false, affiliations: [], notes: ["Missing name."] });
      const result = await findSchoolForPlayer(req, (m) => console.log("[resolve-identity] findSchool:", m));
      console.log("[resolve-identity] findSchool:", JSON.stringify({ name: req.name, schools: result.affiliations.map((a) => a.school) }));
      return json(result);
    }

    // --- School-roster mode (a school's schoolmates) -------------------------
    if (body?.schoolRoster && typeof body.schoolRoster === "object") {
      const r = body.schoolRoster as { school?: string; schoolCode?: string; state?: string; source?: string; sourceId?: string };
      if (!r.school || !String(r.school).trim()) return json({ available: false, schoolmates: [], notes: ["Missing school."] });
      const result = await fetchSchoolRoster(r.school, r.schoolCode, r.state, r.source, r.sourceId, (m) => console.log("[resolve-identity] schoolRoster:", m));
      return json(result);
    }

    // --- Friends mode (chess.com member-public friends; needs a session) -----
    if (typeof body?.chesscomFriends === "string" && body.chesscomFriends.trim()) {
      const friends = await fetchChesscomFriends(body.chesscomFriends.trim(), (m) => console.log("[resolve-identity] friends:", m));
      return json({ available: true, friends });
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
    const timings: Record<string, number> = {};
    const t0 = Date.now();

    // 1. Resolve US Chess member(s) + build the tournament graph for the best
    //    online-capable candidate. Never fatal.
    const { members, debug } = await resolveMembers(query);
    timings.uscfResolve = Date.now() - t0;
    const uscfCandidates = members.map((m) => memberToCandidate(m, query));
    if (uscfCandidates.length) {
      sources.push("uscf");
      notes.push(`US Chess: ${uscfCandidates.length} member match(es).`);
    }

    // 2. The tournament-graph build (dozens of throttled MUIR calls) and the
    //    AI reasoning pass (5-10s of model latency) are independent — run them
    //    CONCURRENTLY. Sequential ordering here used to delay the client's
    //    traversal start by the AI pass's full latency on every search.
    const tGraph = Date.now();
    let graphTruncated = false;
    const graphPromise: Promise<TournamentGraph | null> = (async () => {
      if (!wantGraph || !members.length) return null;
      // Prefer the highest-ranked member that actually has online ratings.
      const target = members.find((m) => m.hasOnline) || members[0];
      try {
        const sections = await buildOnlineGraphForMember(target, {
          deadlineMs: t0 + RESOLVE_BUDGET_MS,
          onTruncated: () => {
            graphTruncated = true;
          },
        });
        const g = sectionsToGraph(target, sections);
        debug.onlineSectionCount = sections.length;
        debug.graphOpponents = g.onlineEvents.reduce((n, e) => n + e.players.length, 0);
        if (g.onlineEvents.length) {
          const games = g.onlineEvents.reduce(
            (n, e) => n + (e.players.find((p) => p.isTarget)?.games.length || 0),
            0
          );
          notes.push(
            `Tournament graph: ${g.onlineEvents.length} online section(s), ${games} of the player's online games to trace.`
          );
        }
        return g;
      } catch (e) {
        debug.graphError = String(e);
        return null;
      }
    })();

    const tAi = Date.now();
    const aiPromise = callAI(
      "You are an expert chess identity-resolution analyst. You convert sparse clues about a tournament opponent into structured, well-calibrated candidate identities and the online usernames most worth verifying. You never invent federation IDs you are not confident about. You output only strict JSON.",
      buildAiPrompt(query, uscfCandidates),
      2048
    ).then((r) => {
      timings.ai = Date.now() - tAi;
      return r;
    });
    const graph = await graphPromise;
    timings.graphBuild = Date.now() - tGraph;
    const graphTraversalReady = !!graph?.graphTraversalReady;
    if (graphTruncated) {
      notes.push(
        "Tournament graph hit the time budget and is PARTIAL — the anchor identity is solid; re-run to continue building the graph (cached sections make the retry fast)."
      );
    }

    const ai = await aiPromise;
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
    timings.total = Date.now() - t0;
    console.log(
      "[resolve-identity] timings:",
      JSON.stringify({
        name: query.name,
        ...timings,
        sections: graph?.onlineEvents.length ?? 0,
        candidates: candidates.length,
        partial: graphTruncated,
      })
    );
    const payload: Record<string, unknown> = {
      available,
      sources,
      candidates,
      notes,
      tournamentGraph: graph,
      graphTraversalReady,
      // True when the graph build was cut short by the wall-clock budget: the
      // graph is usable but INCOMPLETE, and a retry (warm cache) can finish it.
      partial: graphTruncated,
      timings,
    };
    if (debugMode) payload.debug = debug;
    return jsonMaybeGzip(payload, req.headers.get("accept-encoding"));
  } catch (error) {
    console.error("[resolve-identity] Error:", error);
    return json({ available: false, candidates: [], sources: [], notes: ["Server error."], graphTraversalReady: false });
  }
});
