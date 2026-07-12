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
import type { OnlinePlatform } from "../schoolTypes";
import {
  runSchoolResolution,
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
 *  usernames, member expansion) runGraphTraversal always wires in. The budget
 *  comes from the school engine's per-mate allowance — we stay slightly under
 *  it so the traversal winds down and returns before the engine's outer
 *  timeout would drop a late result. Traversal chatter stays out of the
 *  detective UI. */
async function resolveUscfIdentity(
  req: { uscfId: string; name: string; rating?: number; budgetMs?: number },
  signal?: AbortSignal
): Promise<{ platform: OnlinePlatform; username: string; confidence: number } | null> {
  const graph = await expandMemberGraph(req.uscfId, signal);
  if (!graph?.graphTraversalReady || !graph.onlineEvents.length) return null;
  const traversal = await runGraphTraversal(graph, {
    targetName: graph.rootName || req.name,
    targetRating: req.rating,
    signal,
    budgetMs: Math.max(30_000, (req.budgetMs ?? 120_000) - 10_000),
    log: () => {},
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
      findSchoolmates: (school, state, source, schoolCode) => fetchSchoolmates(school, state, source, schoolCode, opts.signal),
      findUsernames: (req) => findUsernameCandidates(req, opts.signal),
      fetchFriends: (platform, username) => fetchFriends(platform, username, opts.signal),
      findUscfId: (req) => findUscfMemberId(req, opts.signal),
      resolveUscfIdentity: (req) => resolveUscfIdentity(req, opts.signal),
    },
  });
}
