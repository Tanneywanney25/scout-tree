// ============================================================================
// School-based resolver — thin wrapper that wires the app's server-backed hooks
// into the dependency-light social-graph engine (../schoolResolver).
//
// The engine walks the CORS-friendly Chess.com / Lichess public APIs itself
// (archives, clubs, verification). The two things it can't do from the browser
// come in as hooks fulfilled by the resolve-identity edge function:
//   • findSchool     — NWSRS / state assns / registration / LinkedIn / web
//   • findSchoolmates— a school's roster
//   • findUsernames  — Google-index name→handle discovery (shared with the
//                      tournament-graph engine)
//   • fetchFriends   — chess.com's member-public friends list (needs a session)
//
// Same shape as providers/uscfGraph.ts.
// ============================================================================

import {
  findSchoolAffiliation,
  fetchSchoolmates,
  fetchFriends,
  findUsernameCandidates,
} from "./edgeClient";
import {
  runSchoolResolution,
  type SchoolResolverInput,
  type SchoolResolverOptions,
  type SchoolResolverResult,
} from "../schoolResolver";

export type { SchoolResolverInput, SchoolResolverResult } from "../schoolResolver";

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
      findSchoolmates: (school, state, source) => fetchSchoolmates(school, state, source, opts.signal),
      findUsernames: (req) => findUsernameCandidates(req, opts.signal),
      fetchFriends: (platform, username) => fetchFriends(platform, username, opts.signal),
    },
  });
}
