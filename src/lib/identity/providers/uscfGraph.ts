// ============================================================================
// USCF tournament-graph provider — thin wrapper around the traversal engine
//
// The engine itself (../uscfGraphEngine) is dependency-light so it can run in
// the browser, the CLI harness or tests. This wrapper is where the browser app
// wires in the server-backed hooks:
//   • discoverPlatform — edge web/flyer search ("which platform hosted this
//     USCF event?", ideally with the exact tournament slug / swiss id)
//   • expandMember     — edge MUIR fetch of an opponent's own online graph,
//     enabling the deep recursion phase
// ============================================================================

import type { Provider, PartialIdentity, Platform } from "../types";
import {
  getTournamentGraph,
  discoverEventPlatform,
  expandMemberGraph,
  type TournamentGraph,
} from "./edgeClient";
import {
  runGraphTraversal as runEngine,
  type TraversalOptions,
  type TraversalResult,
} from "../uscfGraphEngine";

export type { TraversalOptions, TraversalResult } from "../uscfGraphEngine";

/** Run the traversal with the app's server-backed hooks pre-wired. */
export function runGraphTraversal(graph: TournamentGraph, opts: TraversalOptions): Promise<TraversalResult> {
  return runEngine(graph, {
    ...opts,
    hooks: {
      discoverPlatform: (ev) => discoverEventPlatform(ev, opts.signal),
      expandMember: (memberId) => expandMemberGraph(memberId, opts.signal),
      ...(opts.hooks || {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Provider wrapper (kept for DEEP_PROVIDERS registration and any direct use).
// The resolver calls runGraphTraversal directly to make traversal the
// *primary* discovery path.
// ---------------------------------------------------------------------------

export const uscfGraphProvider: Provider = {
  name: "uscf-graph",
  label: "Tournament graph",
  enabled: () => true,
  async run({ query, signal, log }) {
    const graph = await getTournamentGraph(query, signal).catch(() => null);
    if (!graph || !graph.graphTraversalReady || graph.onlineEvents.length === 0) {
      return {
        provider: "uscf-graph",
        identities: [],
        accounts: [],
        unavailable: true,
        notes: ["No online tournament graph to traverse."],
      };
    }

    const { accounts, notes } = await runGraphTraversal(graph, {
      targetName: graph.rootName || query.name,
      targetRating: query.approxRating,
      targetFideId: query.fideId,
      signal,
      log,
    });

    const identities: PartialIdentity[] = accounts.length
      ? [
          {
            name: accounts[0].displayName || graph.rootName || query.name,
            estimatedRating: accounts[0].rating,
            suggestedAccounts: accounts.map((a) => ({ platform: a.platform as Platform, username: a.username })),
            evidence: accounts[0].evidence,
            reasoning: "Discovered by tracing tournament opponents' online games (tournament-graph traversal).",
            source: "chessresults",
          },
        ]
      : [];

    return { provider: "uscf-graph", identities, accounts, notes };
  },
};
