// ============================================================================
// Provider: Chess-Results / tournament discovery  — server-backed
//
// chess-results.com and similar event sites host pairings, sections and results
// for both over-the-board and online tournaments. Scraped server-side, this
// slice ties a player to specific events (and, via the secret tournament-graph
// traversal, to opponents whose online accounts are easier to find). It reads
// the "chessresults" slice of the shared edge response.
// ============================================================================

import { makeEdgeProvider } from "./edgeClient";

export const chessResultsProvider = makeEdgeProvider({
  name: "chessresults",
  label: "Chess-Results & tournaments",
  source: "chessresults",
  // Only worth running when there is a tournament/event angle to chase.
  enabled: (q) => !!(q.tournamentName || q.uscfId || q.fideId || q.club || q.school),
  liveLabel: "Searching tournament pairings & archived events…",
});
