// ============================================================================
// Shared client for the `resolve-identity` Supabase edge function.
//
// USCF, FIDE, web/AI reasoning and chess-results discovery all require
// server-side fetching (CORS / HTML scraping / an API key for the AI pass), so
// they live in one Deno edge function. The four "server" providers below each
// read their own slice of a single, memoized response — so we make at most one
// network round-trip per search even though four providers consume it.
//
// Everything degrades gracefully: if the function isn't deployed, has no AI key,
// or the user is offline, this returns `{ available: false, candidates: [] }`
// and the providers simply contribute nothing.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";
import type { Evidence, PartialIdentity, PlayerQuery, Platform, Federation, Provider } from "../types";
import type { GraphEvent, TournamentGraph, EventPlatformInfo, UsernameSearchRequest, UsernameCandidate } from "../graphTypes";
import type { SchoolAffiliation, SchoolLookupRequest, Schoolmate, OnlinePlatform } from "../schoolTypes";
import { nameSimilarity, nameMatchWeight, ratingMatchWeight } from "../confidence";

// Graph shapes live in ../graphTypes (shared with the engine); re-export for
// existing importers.
export type {
  GraphGame,
  GraphPlayer,
  GraphEvent,
  TournamentGraph,
  EventPlatformInfo,
  UsernameSearchRequest,
  UsernameCandidate,
} from "../graphTypes";

/**
 * Invoke the resolve-identity edge function with a hard client-side timeout.
 * `supabase.functions.invoke` accepts no AbortSignal, and a hung request would
 * otherwise freeze the traversal loop silently for minutes — the #1 cause of
 * the search appearing to "pause and glitch out". On timeout we resolve null
 * and the caller degrades gracefully.
 */
async function invokeEdge(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      supabase.functions.invoke("resolve-identity", { body }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!result) {
      console.warn("[identity] resolve-identity call timed out after", timeoutMs, "ms:", Object.keys(body)[0]);
      return null;
    }
    const { data, error } = result as { data: Record<string, unknown> | null; error: { message?: string } | null };
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One real-world identity candidate proposed by a server source. */
export interface EdgeIdentityCandidate {
  source: "uscf" | "fide" | "ai" | "chessresults";
  name: string;
  federation?: Federation;
  country?: string;
  state?: string;
  uscfId?: string;
  fideId?: string;
  estimatedRating?: number;
  ratings?: Record<string, number>;
  title?: string;
  /** Online handles the server suggests we verify. */
  suggestedUsernames?: { platform: Platform; username: string }[];
  /** Plain-English explanation the AI produced for this candidate. */
  reasoning?: string;
  /** Optional 0..1 self-assessed confidence from the AI. */
  confidenceHint?: number;
  /** Tournament/event names tying the player to the query, when found. */
  tournaments?: string[];
}

export interface EdgeResponse {
  available: boolean;
  candidates: EdgeIdentityCandidate[];
  /** Which server sources actually returned something. */
  sources: string[];
  notes?: string[];
  /** USCF tournament graph for the opponent-traversal engine. */
  tournamentGraph?: TournamentGraph | null;
  /** True when the graph has at least one online section worth traversing. */
  graphTraversalReady?: boolean;
}

const EMPTY: EdgeResponse = {
  available: false,
  candidates: [],
  sources: [],
  notes: [],
  tournamentGraph: null,
  graphTraversalReady: false,
};

// Memoize per query so the four server providers share one invocation.
const cache = new Map<string, Promise<EdgeResponse>>();

function keyFor(query: PlayerQuery): string {
  return JSON.stringify(query);
}

export function fetchEdgeIdentity(query: PlayerQuery, signal?: AbortSignal): Promise<EdgeResponse> {
  const key = keyFor(query);
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = (async (): Promise<EdgeResponse> => {
    // The graph build behind this call can legitimately run for minutes on an
    // active player (it walks the member's whole online-era event history).
    // The old 150s client timeout was the single biggest trace-killer in the
    // browser: it silently discarded a nearly-finished build AND the anchor
    // identities with it. One in-flight retry covers a flaky first attempt.
    let data = await invokeEdge({ query }, 480_000);
    if (!data && !signal?.aborted) data = await invokeEdge({ query }, 480_000);
    if (!data) {
      // Most common cause: the edge function isn't deployed yet (or has no AI
      // key). The detective degrades to Lichess/Chess.com — surface why.
      console.warn(
        "[identity] resolve-identity edge function unavailable — AI/USCF/FIDE sources are off. " +
          "Deploy it (`supabase functions deploy resolve-identity`) and set GEMINI_API_KEY."
      );
      return EMPTY;
    }
    const candidates = Array.isArray(data.candidates) ? (data.candidates as EdgeIdentityCandidate[]) : [];
    const tournamentGraph = (data.tournamentGraph as TournamentGraph | null) ?? null;
    return {
      available: data.available !== false,
      candidates,
      sources: Array.isArray(data.sources) ? (data.sources as string[]) : [],
      notes: Array.isArray(data.notes) ? (data.notes as string[]) : [],
      tournamentGraph,
      graphTraversalReady: data.graphTraversalReady === true || !!tournamentGraph?.graphTraversalReady,
    };
  })();

  cache.set(key, promise);
  // A FAILURE must never be remembered as "this player has no data" — evict it
  // immediately so the next caller retries. A real response is kept long
  // enough to cover the whole traversal that consumes it (the old 60s eviction
  // could force a full multi-minute graph rebuild MID-RUN).
  promise.then(
    (r) => {
      if (r === EMPTY) cache.delete(key);
      else setTimeout(() => cache.delete(key), 15 * 60_000);
    },
    () => cache.delete(key)
  );
  return promise;
}

/** The tournament graph from the (memoized) edge response, or null. */
export async function getTournamentGraph(query: PlayerQuery, signal?: AbortSignal): Promise<TournamentGraph | null> {
  const res = await fetchEdgeIdentity(query, signal);
  return res.tournamentGraph ?? null;
}

// Memoize expand-by-member calls so recursion into the same opponent (reached
// via several section-mates) hits the server only once.
const expandCache = new Map<string, Promise<TournamentGraph | null>>();

/**
 * Fetch just the online tournament graph for a specific USCF member ID. Lets the
 * client recurse into an opponent's *own* online history (depth-2) when the
 * root player's direct opponents don't yield a match. The US Chess API is not
 * CORS-accessible, so this necessarily round-trips through the edge function.
 */
export function expandMemberGraph(memberId: string, signal?: AbortSignal): Promise<TournamentGraph | null> {
  const id = memberId.replace(/\D/g, "");
  if (!id) return Promise.resolve(null);
  const existing = expandCache.get(id);
  if (existing) return existing;

  const promise = (async (): Promise<TournamentGraph | null> => {
    const data = await invokeEdge({ expandMemberId: id }, 300_000);
    if (!data) return null;
    return (data.tournamentGraph as TournamentGraph | null) ?? null;
  })();

  expandCache.set(id, promise);
  // Keep real graphs for the rest of the pivot stage (the same opponent is
  // reached through several section-mates); never remember a failed call.
  promise.then(
    (g) => {
      if (g === null) expandCache.delete(id);
      else setTimeout(() => expandCache.delete(id), 10 * 60_000);
    },
    () => expandCache.delete(id)
  );
  return promise;
}

// Memoize flyer/web discovery per event — the answer never changes mid-search.
const discoverCache = new Map<string, Promise<EventPlatformInfo | null>>();

/**
 * Ask the edge function to web-search the flyer/TLA/announcement of a USCF
 * online event and report which platform hosted it — ideally with the exact
 * Chess.com tournament slug or Lichess swiss/arena id (whose public APIs then
 * hand the traversal engine the full participant roster).
 */
export function discoverEventPlatform(ev: GraphEvent, signal?: AbortSignal): Promise<EventPlatformInfo | null> {
  const existing = discoverCache.get(ev.eventId);
  if (existing) return existing;

  const promise = (async (): Promise<EventPlatformInfo | null> => {
    const data = await invokeEdge(
      {
        discoverEvent: {
          name: ev.name,
          sectionName: ev.sectionName,
          startDate: ev.startDate,
          endDate: ev.endDate,
          ratingSystem: ev.ratingSystem,
          timeControl: ev.timeControl,
        },
      },
      90_000
    );
    if (!data || data.available === false) return null;
    const info: EventPlatformInfo = {
      platform: data.platform as EventPlatformInfo["platform"],
      chesscomSlugs: Array.isArray(data.chesscomSlugs) ? (data.chesscomSlugs as string[]) : undefined,
      lichessSwissIds: Array.isArray(data.lichessSwissIds) ? (data.lichessSwissIds as string[]) : undefined,
      lichessArenaIds: Array.isArray(data.lichessArenaIds) ? (data.lichessArenaIds as string[]) : undefined,
      confidence: typeof data.confidence === "number" ? data.confidence : undefined,
      note: typeof data.note === "string" ? data.note : undefined,
    };
    return info.platform || info.chesscomSlugs?.length || info.lichessSwissIds?.length || info.lichessArenaIds?.length ? info : null;
  })();

  discoverCache.set(ev.eventId, promise);
  promise.finally(() => setTimeout(() => discoverCache.delete(ev.eventId), 300_000));
  return promise;
}

// ---------------------------------------------------------------------------
// Google-index username discovery (edge `findUsername` mode)
// ---------------------------------------------------------------------------

// Memoize per person+context — the traversal asks about the same member from
// several events. Kept for the whole session; the answer doesn't change.
const usernameCache = new Map<string, Promise<UsernameCandidate[]>>();

// Space the Google-search calls out (they fan out to Google/an AI web search).
// This is pacing to avoid being blocked, NOT a cap — every request still runs.
let usernameNextSlot = 0;
async function usernameThrottle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, usernameNextSlot - now);
  usernameNextSlot = Math.max(now, usernameNextSlot) + 400;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/**
 * Ask the edge function to find a person's Lichess/Chess.com usernames via the
 * Google index (site:-restricted query ladder; see the edge implementation).
 * Returns LEADS — the caller must verify each against real platform data
 * (account exists, games in the tournament window, rating/country sanity).
 */
export function findUsernameCandidates(req: UsernameSearchRequest, signal?: AbortSignal): Promise<UsernameCandidate[]> {
  const name = (req.name || "").trim();
  if (!name) return Promise.resolve([]);
  const key = JSON.stringify([name.toLowerCase(), req.state, req.uscfRating, req.eventName, [...(req.platforms || [])].sort()]);
  const existing = usernameCache.get(key);
  if (existing) return existing;

  // A timed-out/failed call must not poison the session cache: "[] because
  // the request died" and "[] because the index has nothing" are different
  // answers, and the old code remembered both forever.
  let requestFailed = false;
  const promise = (async (): Promise<UsernameCandidate[]> => {
    if (signal?.aborted) return [];
    await usernameThrottle();
    if (signal?.aborted) return [];
    const data = await invokeEdge({ findUsername: req }, 180_000);
    if (!data) {
      requestFailed = true;
      return [];
    }
    if (data.available === false || !Array.isArray(data.candidates)) return [];
    return (data.candidates as UsernameCandidate[])
      .filter((c) => c && (c.platform === "chesscom" || c.platform === "lichess") && typeof c.username === "string")
      .slice(0, 40);
  })();

  usernameCache.set(key, promise);
  void promise.then(() => {
    if (requestFailed && usernameCache.get(key) === promise) usernameCache.delete(key);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// USCF name→ID lookup (edge `findUscfId` mode). The school resolver's bridge
// from a roster name to the ID-based identity engine: scholastic rosters print
// names and ratings, never USCF IDs. Same public MUIR ratings search the main
// engine uses — it just isn't CORS-accessible, hence the edge round-trip.
// Memoized per person for the session.
// ---------------------------------------------------------------------------

export interface UscfIdLookup {
  firstName: string;
  lastName: string;
  state?: string;
  rating?: number;
}

const uscfIdCache = new Map<string, Promise<{ uscfId: string; rating?: number } | null>>();
export function findUscfMemberId(
  req: UscfIdLookup,
  signal?: AbortSignal
): Promise<{ uscfId: string; rating?: number } | null> {
  const key = JSON.stringify([req.firstName.toLowerCase(), req.lastName.toLowerCase(), req.state, req.rating]);
  const existing = uscfIdCache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<{ uscfId: string; rating?: number } | null> => {
    if (signal?.aborted) return null;
    const data = await invokeEdge({ findUscfId: req }, 30_000);
    if (!data || data.available === false || typeof data.uscfId !== "string" || !data.uscfId) return null;
    return { uscfId: data.uscfId, rating: typeof data.rating === "number" ? data.rating : undefined };
  })();
  uscfIdCache.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// School-based fallback: the edge is where school-affiliation sources (NWSRS /
// state associations / registration platforms / LinkedIn / web — all needing
// server-side fetch or an AI/search key) and the authenticated chess.com
// friends list live. Each is memoized per key for the session.
// ---------------------------------------------------------------------------

const schoolCache = new Map<string, Promise<SchoolAffiliation[]>>();
export function findSchoolAffiliation(req: SchoolLookupRequest, signal?: AbortSignal): Promise<SchoolAffiliation[]> {
  const key = JSON.stringify([req.name.toLowerCase(), req.state, req.uscfId]);
  const existing = schoolCache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<SchoolAffiliation[]> => {
    if (signal?.aborted) return [];
    const data = await invokeEdge({ findSchool: req }, 90_000);
    if (!data || data.available === false || !Array.isArray(data.affiliations)) return [];
    return data.affiliations as SchoolAffiliation[];
  })();
  schoolCache.set(key, promise);
  return promise;
}

const rosterCache = new Map<string, Promise<Schoolmate[]>>();
export function fetchSchoolmates(school: string, state?: string, source?: string, schoolCode?: string, sourceId?: string, signal?: AbortSignal): Promise<Schoolmate[]> {
  const key = JSON.stringify([school.toLowerCase(), state, source, schoolCode, sourceId]);
  const existing = rosterCache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<Schoolmate[]> => {
    if (signal?.aborted) return [];
    const data = await invokeEdge({ schoolRoster: { school, schoolCode, state, source, sourceId } }, 60_000);
    if (!data || data.available === false || !Array.isArray(data.schoolmates)) return [];
    return data.schoolmates as Schoolmate[];
  })();
  rosterCache.set(key, promise);
  return promise;
}

// Chess.com friends are member-public but the endpoint needs an authenticated
// session (fetched server-side). Lichess has no equivalent list, so the crawler
// only asks for chess.com friends; a lichess request resolves to [].
const friendsCache = new Map<string, Promise<string[]>>();
export function fetchFriends(platform: OnlinePlatform, username: string, signal?: AbortSignal): Promise<string[]> {
  if (platform !== "chesscom") return Promise.resolve([]);
  const key = `chesscom:${username.toLowerCase()}`;
  const existing = friendsCache.get(key);
  if (existing) return existing;
  const promise = (async (): Promise<string[]> => {
    if (signal?.aborted) return [];
    // The server now paginates the full friends list (was a single top-friends
    // page), so allow for a few sequential page fetches instead of one.
    const data = await invokeEdge({ chesscomFriends: username }, 60_000);
    if (!data || !Array.isArray(data.friends)) return [];
    return data.friends as string[];
  })();
  friendsCache.set(key, promise);
  return promise;
}

// ---------------------------------------------------------------------------
// Anchor-phase modes (the FAST half of the anchor → discovery split). These
// power the member picker and the AnchorCard — no graph build, no AI, so they
// answer in well under a second and never spend discovery-grade money.
// ---------------------------------------------------------------------------

/** One live picker row from MUIR (the edge's memberSearch mode). */
export interface MemberSearchHit {
  uscfId: string;
  name: string;
  state?: string;
  rating?: number;
  ratings: Partial<Record<"regular" | "quick" | "blitz" | "onlineRegular" | "onlineQuick" | "onlineBlitz", number>>;
  hasOnline: boolean;
  fideId?: string;
  title?: string;
  expiration?: string;
}

export interface MemberSearchResult {
  hits: MemberSearchHit[];
  /** True when the server refused this call (per-client rate limit). */
  rateLimited?: boolean;
  /** False when the edge function itself was unreachable. */
  available: boolean;
}

/** Live member search for the picker. Debouncing is the CALLER's job. */
export async function searchUscfMembers(
  req: { name: string; state?: string; limit?: number },
  signal?: AbortSignal
): Promise<MemberSearchResult> {
  if (signal?.aborted || !req.name || req.name.trim().length < 2) return { hits: [], available: true };
  const data = await invokeEdge({ memberSearch: { name: req.name.trim(), state: req.state, limit: req.limit } }, 12_000);
  if (!data) return { hits: [], available: false };
  return {
    hits: Array.isArray(data.hits) ? (data.hits as MemberSearchHit[]) : [],
    rateLimited: data.rateLimited === true,
    available: data.available !== false || data.rateLimited === true,
  };
}

/** A handle already confirmed for this member in the resolved_handles moat. */
export interface CachedResolvedHandle {
  uscfId?: string;
  platform: Platform;
  username: string;
  confidence: number;
  source: string;
  verifiedAt?: string;
  evidence?: { kind: string; weight: number; label: string; source: string }[];
}

/** The AnchorCard payload (the edge's memberPreview mode). */
export interface MemberPreview {
  available: boolean;
  member?: MemberSearchHit & { status?: string };
  onlineEventsNamed?: number;
  pandemicEraEvents?: number;
  eventsSince2020?: number;
  latestEventDate?: string;
  optedOut?: boolean;
  resolvedHandles?: CachedResolvedHandle[];
}

const previewCache = new Map<string, Promise<MemberPreview>>();

export function fetchMemberPreview(uscfId: string, signal?: AbortSignal): Promise<MemberPreview> {
  const id = uscfId.replace(/\D/g, "");
  if (!id) return Promise.resolve({ available: false });
  const existing = previewCache.get(id);
  if (existing) return existing;
  const promise = (async (): Promise<MemberPreview> => {
    if (signal?.aborted) return { available: false };
    const data = await invokeEdge({ memberPreview: { uscfId: id } }, 25_000);
    if (!data || data.available === false) return { available: false };
    return data as unknown as MemberPreview;
  })();
  previewCache.set(id, promise);
  // Never remember a failure; keep real previews for a few minutes.
  promise.then(
    (p) => {
      if (!p.available) previewCache.delete(id);
      else setTimeout(() => previewCache.delete(id), 5 * 60_000);
    },
    () => previewCache.delete(id)
  );
  return promise;
}

/** One FIDE registry row (the edge's fideSearch mode, served via Lichess). */
export interface FidePlayerHit {
  fideId: string;
  name: string;
  federation?: string;
  title?: string;
  year?: number;
  standard?: number;
  rapid?: number;
  blitz?: number;
}

export async function searchFidePlayers(name: string, signal?: AbortSignal): Promise<FidePlayerHit[]> {
  if (signal?.aborted || !name || name.trim().length < 3) return [];
  const data = await invokeEdge({ fideSearch: { name: name.trim() } }, 15_000);
  if (!data || data.available === false || !Array.isArray(data.hits)) return [];
  return data.hits as FidePlayerHit[];
}

/** Cache-first read over the moat: instantly answers a repeat lookup. */
export async function fetchResolvedHandles(uscfIds: string[], signal?: AbortSignal): Promise<CachedResolvedHandle[]> {
  const clean = uscfIds.map((s) => s.replace(/\D/g, "")).filter(Boolean);
  if (signal?.aborted || !clean.length) return [];
  const data = await invokeEdge({ resolvedHandles: { uscfIds: clean } }, 12_000);
  if (!data || !Array.isArray(data.handles)) return [];
  return (data.handles as CachedResolvedHandle[]).filter(
    (h) => h && typeof h.username === "string" && typeof h.platform === "string"
  );
}

/** Write a confirmed resolution (or a user correction) into the moat.
 *  Fire-and-forget: the hunt result never depends on the write landing. */
export async function storeResolvedHandle(row: {
  uscfId: string;
  platform: Platform;
  username: string;
  confidence: number;
  evidence?: { kind: string; weight: number; label: string; source: string }[];
  source: "engine" | "user-correction" | "claim";
}): Promise<boolean> {
  const data = await invokeEdge({ claimHandle: row }, 12_000);
  return data?.stored === true;
}

/** Record a do-not-resolve request (the privacy opt-out). */
export async function requestOptOut(row: {
  uscfId?: string;
  platform?: string;
  username?: string;
  note?: string;
}): Promise<boolean> {
  const data = await invokeEdge({ optOut: row }, 12_000);
  return data?.stored === true;
}

/** Convert a server candidate into a scored PartialIdentity for the resolver. */
export function edgeCandidateToPartial(cand: EdgeIdentityCandidate, query: PlayerQuery): PartialIdentity {
  const evidence: Evidence[] = [];
  const source = cand.source;

  const sim = nameSimilarity(query.name, cand.name);
  evidence.push({
    kind: "name-match",
    weight: nameMatchWeight(sim),
    label: `${source.toUpperCase()} record name "${cand.name}" ${sim >= 0.8 ? "matches" : "is similar to"} "${query.name}"`,
    source,
  });

  if (query.uscfId && cand.uscfId && query.uscfId.replace(/\D/g, "") === cand.uscfId.replace(/\D/g, "")) {
    evidence.push({ kind: "uscf-id-match", weight: 4.0, label: `USCF ID ${cand.uscfId} matches exactly`, source });
  } else if (cand.uscfId) {
    evidence.push({ kind: "uscf-id-match", weight: 0.4, label: `USCF ID ${cand.uscfId} on record`, source });
  }
  if (query.fideId && cand.fideId && query.fideId.replace(/\D/g, "") === cand.fideId.replace(/\D/g, "")) {
    evidence.push({ kind: "fide-id-match", weight: 4.0, label: `FIDE ID ${cand.fideId} matches exactly`, source });
  } else if (cand.fideId) {
    evidence.push({ kind: "fide-id-match", weight: 0.4, label: `FIDE ID ${cand.fideId} on record`, source });
  }
  if (query.state && cand.state && query.state.trim().toLowerCase() === cand.state.trim().toLowerCase()) {
    evidence.push({ kind: "state-match", weight: 1.0, label: `State matches (${cand.state})`, source });
  }
  if (query.federation && cand.federation && query.federation === cand.federation) {
    evidence.push({ kind: "federation-match", weight: 0.6, label: `Federation matches (${cand.federation})`, source });
  }
  if (query.approxRating && cand.estimatedRating) {
    evidence.push({
      kind: "rating-match",
      weight: ratingMatchWeight(query.approxRating, cand.estimatedRating),
      label: `${source.toUpperCase()} rating ${cand.estimatedRating} vs expected ~${query.approxRating}`,
      source,
    });
  }
  if (cand.tournaments?.length) {
    evidence.push({
      kind: "tournament-overlap",
      weight: query.tournamentName ? 1.4 : 0.5,
      label: `Tournament history: ${cand.tournaments.slice(0, 2).join(", ")}`,
      source,
    });
  }
  if (typeof cand.confidenceHint === "number") {
    // Map the AI's own 0..1 confidence to a modest log-odds nudge.
    const nudge = (cand.confidenceHint - 0.5) * 1.6;
    evidence.push({ kind: "ai-inference", weight: nudge, label: `AI assessment: ${Math.round(cand.confidenceHint * 100)}% likely`, source });
  }

  return {
    name: cand.name,
    federation: cand.federation,
    country: cand.country,
    state: cand.state,
    uscfId: cand.uscfId,
    fideId: cand.fideId,
    estimatedRating: cand.estimatedRating,
    ratings: cand.ratings,
    title: cand.title,
    suggestedAccounts: cand.suggestedUsernames,
    evidence,
    reasoning: cand.reasoning,
    source,
  };
}

/**
 * Build a thin Provider that surfaces one server source's slice of the shared
 * edge response. Keeps each file in providers/ focused while making a single
 * network call. `liveLabel` narrates the step in the detective UI.
 */
export function makeEdgeProvider(opts: {
  name: string;
  label: string;
  source: EdgeIdentityCandidate["source"];
  liveLabel: string;
  enabled?: (q: PlayerQuery) => boolean;
}): Provider {
  return {
    name: opts.name,
    label: opts.label,
    enabled: opts.enabled ?? (() => true),
    async run({ query, signal, log }) {
      log(opts.liveLabel);
      const res = await fetchEdgeIdentity(query, signal);
      if (!res.available) {
        return {
          provider: opts.name,
          identities: [],
          accounts: [],
          unavailable: true,
          notes: ["Server lookup unavailable."],
        };
      }
      const mine = res.candidates.filter((c) => c.source === opts.source);
      const identities = mine.map((c) => edgeCandidateToPartial(c, query));
      return {
        provider: opts.name,
        identities,
        accounts: [],
        notes: mine.length ? [`${mine.length} ${opts.label} candidate(s).`] : [`No ${opts.label} match.`],
      };
    },
  };
}
