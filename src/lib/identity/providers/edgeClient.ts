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
import { nameSimilarity, nameMatchWeight, ratingMatchWeight } from "../confidence";

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

/** One game a section player played (colour is "unknown" for most online events). */
export interface GraphGame {
  round: number;
  color: "white" | "black" | "unknown";
  outcome: string;
  opponentUscfId: string;
  opponentName: string;
}
/** A player in an online section, with their round-by-round games. */
export interface GraphPlayer {
  uscfId: string;
  name: string;
  rating?: number;
  isTarget?: boolean;
  games: GraphGame[];
}
/** One online-rated section the scouted player appeared in (a full crosstable). */
export interface GraphEvent {
  eventId: string;
  name: string;
  sectionName?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;
  ratingSystem: string; // OR / OQ / OB
  timeControl?: string;
  roundCount?: number;
  isBlitz?: boolean;
  platformGuess?: string;
  players: GraphPlayer[];
}
export interface TournamentGraph {
  rootUscfId: string;
  rootName: string;
  rootState?: string;
  onlineEvents: GraphEvent[];
  graphTraversalReady: boolean;
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
    try {
      const { data, error } = await supabase.functions.invoke("resolve-identity", {
        body: { query },
      });
      if (error || !data) {
        // Most common cause: the edge function isn't deployed yet (or has no AI
        // key). The detective degrades to Lichess/Chess.com — surface why.
        console.warn(
          "[identity] resolve-identity edge function unavailable — AI/USCF/FIDE sources are off. " +
            "Deploy it (`supabase functions deploy resolve-identity`) and set GEMINI_API_KEY. Detail:",
          error?.message || "no data returned"
        );
        return EMPTY;
      }
      const candidates = Array.isArray(data.candidates) ? (data.candidates as EdgeIdentityCandidate[]) : [];
      const tournamentGraph = (data.tournamentGraph as TournamentGraph | null) ?? null;
      return {
        available: data.available !== false,
        candidates,
        sources: Array.isArray(data.sources) ? data.sources : [],
        notes: Array.isArray(data.notes) ? data.notes : [],
        tournamentGraph,
        graphTraversalReady: data.graphTraversalReady === true || !!tournamentGraph?.graphTraversalReady,
      };
    } catch {
      // Function not deployed / network blocked / aborted — degrade silently.
      return EMPTY;
    }
  })();

  cache.set(key, promise);
  // Don't cache forever; allow a retry on the next distinct search session.
  promise.finally(() => setTimeout(() => cache.delete(key), 60_000));
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
    try {
      const { data, error } = await supabase.functions.invoke("resolve-identity", {
        body: { expandMemberId: id },
      });
      if (error || !data) return null;
      return (data.tournamentGraph as TournamentGraph | null) ?? null;
    } catch {
      return null;
    }
  })();

  expandCache.set(id, promise);
  promise.finally(() => setTimeout(() => expandCache.delete(id), 120_000));
  return promise;
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
