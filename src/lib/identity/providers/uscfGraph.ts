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
  findUsernameCandidates,
  type TournamentGraph,
} from "./edgeClient";
import {
  runGraphTraversal as runEngine,
  type OnlinePlatform,
  type TraversalOptions,
  type TraversalResult,
} from "../uscfGraphEngine";
import { getSharedTraversalCaches, cacheIdentity } from "../cache";

export type { TraversalOptions, TraversalResult } from "../uscfGraphEngine";

/** Run the traversal with the app's server-backed hooks pre-wired.
 *
 * Every traversal launched through here — the main search's AND each
 * schoolmate trace the school resolver runs — shares ONE session-wide set of
 * fetch caches (profile verifies, game windows, Chess.com months, Google
 * candidates). Schoolmates' tournament graphs overlap heavily, so the second
 * and later traces mostly hit cache instead of the network. A confirmed
 * root-member handle is also recorded in the resolved-identity store so later
 * lookups (the school fast path) skip the traversal entirely.
 *
 * SAFETY GUARD: `seedMappings` is a TEST-ONLY affordance (pre-seed known
 * member→handle pairs to validate pairing/target-reveal without live
 * discovery). This wrapper is the app's production entry point — the browser
 * resolver calls it, and its opts are built from the user's PlayerQuery, which
 * has no such field. We nonetheless strip `seedMappings` here so that even a
 * future mis-wiring cannot inject seeds through the production path: the ONLY
 * way to seed is to bypass this wrapper and call the engine directly, which
 * only the offline CLI harness (scripts/trace-entry.ts) does. */
export async function runGraphTraversal(graph: TournamentGraph, opts: TraversalOptions): Promise<TraversalResult> {
  const { seedMappings: _testOnlySeeds, ...safe } = opts;
  const result = await runEngine(graph, {
    ...safe,
    shared: opts.shared ?? getSharedTraversalCaches(),
    hooks: {
      discoverPlatform: (ev) => discoverEventPlatform(ev, opts.signal),
      expandMember: (memberId) => expandMemberGraph(memberId, opts.signal),
      findUsernames: (req) => findUsernameCandidates(req, opts.signal),
      ...(opts.hooks || {}),
    },
  });
  const best = result.accounts.find((a) => a.platform === "chesscom" || a.platform === "lichess");
  if (best && graph.rootUscfId) {
    cacheIdentity(graph.rootUscfId, {
      platform: best.platform as OnlinePlatform,
      username: best.username,
      confidence: best.confidence,
    });
  }
  return result;
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
