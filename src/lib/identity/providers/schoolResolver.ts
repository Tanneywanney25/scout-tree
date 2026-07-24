// ============================================================================
// School-based resolver — thin wrapper that wires the app's server-backed hooks
// into the dependency-light social-graph engine (../schoolResolver).
//
// The engine walks the CORS-friendly Chess.com / Lichess public APIs itself
// (archives, clubs, verification). The things it can't do from the browser
// come in as hooks fulfilled by the resolve-identity edge function:
//   • findSchool     — NWSRS / state assns / registration / LinkedIn / web
//   • findSchoolmates— a school's roster
//   • findUscfId     — name+state → USCF member ID (public MUIR ratings search;
//                      no CORS headers, hence the edge round-trip)
//   • findUsernames  — Google-index name→handle discovery (shared with the
//                      tournament-graph engine; the fallback route)
//   • fetchFriends   — chess.com's member-public friends list (needs a session)
// plus resolveUscfIdentity, which runs entirely client-side: the schoolmate's
// own online tournament graph (fetched through the edge's expand mode) handed
// to the same tournament-graph traversal the main search uses.
//
// Same shape as providers/uscfGraph.ts.
// ============================================================================

import {
  findSchoolAffiliation,
  fetchSchoolmates,
  fetchFriends,
  findUsernameCandidates,
  findUscfMemberId,
  expandMemberGraph,
} from "./edgeClient";
import { runGraphTraversal } from "./uscfGraph";
import { getCachedIdentity } from "../cache";
import type { OnlinePlatform } from "../schoolTypes";
import {
  runSchoolResolution,
  hasTraceableOnlineHistory,
  type SchoolResolverInput,
  type SchoolResolverOptions,
  type SchoolResolverResult,
} from "../schoolResolver";

export type { SchoolResolverInput, SchoolResolverResult } from "../schoolResolver";

/** A schoolmate's USCF ID → their best online handle, exactly the way the main
 *  engine resolves a target from a USCF ID: fetch the member's own online
 *  tournament graph (the edge builds it with the SAME generous section/event
 *  limits as a main-search target) and run the tournament-graph traversal over
 *  it, with the same edge-backed discovery hooks (flyer search, Google-index
 *  usernames, member expansion) runGraphTraversal always wires in. NO time
 *  budget — like the main search, the trace runs until the mate's graph is
 *  exhausted (fixed budgets kept killing traces that were seconds from an
 *  answer); the abort signal is the only external stop. Traversal chatter
 *  stays out of the detective UI. */
async function resolveUscfIdentity(
  req: { uscfId: string; name: string; rating?: number; stopWhen?: () => boolean; onActivity?: () => void },
  signal?: AbortSignal,
  conductor?: SchoolResolverOptions["conductor"]
): Promise<{ platform: OnlinePlatform; username: string; confidence: number } | null> {
  // Search-wide fast path: a member the engine already resolved (this search,
  // a sibling schoolmate trace, or an earlier search this session) costs
  // nothing — runGraphTraversal records every confirmed root handle.
  const cached = getCachedIdentity(req.uscfId);
  if (cached) return cached;
  const graph = await expandMemberGraph(req.uscfId, signal);
  if (!graph?.graphTraversalReady || !graph.onlineEvents.length) return null;
  // A mate whose entire online footprint is on platforms with no public API
  // (ICC / ChessKid) has nothing the engine can trace — every direct event
  // dead-ends and only the expensive opponent-pivot is left, not worth the
  // minutes for one anchor. Skip immediately; a mate with ANY traceable event
  // still gets the full trace below.
  if (!hasTraceableOnlineHistory(graph.onlineEvents)) return null;
  const traversal = await runGraphTraversal(graph, {
    targetName: graph.rootName || req.name,
    targetRating: req.rating,
    signal,
    // Cooperative stand-down: once the school phase has enough anchors, an
    // in-flight mate trace winds down instead of grinding to exhaustion.
    stopWhen: req.stopWhen,
    // Traversal chatter stays out of the detective UI, but every line pings
    // the conductor's stall detector as a sign of life — that's how it tells
    // a healthy grinding trace from a wedged one.
    log: () => req.onActivity?.(),
    conductor,
  });
  const best = [...traversal.accounts]
    .filter((a) => a.platform === "chesscom" || a.platform === "lichess")
    .sort((a, b) => b.confidence - a.confidence)[0];
  return best ? { platform: best.platform as OnlinePlatform, username: best.username, confidence: best.confidence } : null;
}

/** Run the school-based social-graph resolution with the app's edge hooks
 *  pre-wired. `seedSchoolmates` (a TEST/DEV affordance) is stripped here so the
 *  production path can never inject handles — only the offline CLI harness may. */
export function runSchoolResolver(
  input: SchoolResolverInput,
  opts: Omit<SchoolResolverOptions, "hooks">
): Promise<SchoolResolverResult> {
  const { seedSchoolmates: _testOnly, ...safeInput } = input;
  return runSchoolResolution(safeInput, {
    ...opts,
    hooks: {
      findSchool: (req) => findSchoolAffiliation(req, opts.signal),
      findSchoolmates: (school, state, source, schoolCode, sourceId) =>
        fetchSchoolmates(school, state, source, schoolCode, sourceId, opts.signal),
      findUsernames: (req) => findUsernameCandidates(req, opts.signal),
      fetchFriends: (platform, username) => fetchFriends(platform, username, opts.signal),
      findUscfId: (req) => findUscfMemberId(req, opts.signal),
      resolveUscfIdentity: (req) => resolveUscfIdentity(req, opts.signal, opts.conductor),
    },
  });
}
