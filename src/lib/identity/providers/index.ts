// ============================================================================
// Provider registry
//
// The single ordered list of data sources the resolver consults. Adding a new
// source is intentionally a one-line change here — implement a Provider, import
// it, append it. Order is cosmetic (it shapes the live narration sequence); the
// resolver runs them concurrently.
// ============================================================================

import type { Provider } from "../types";
import { uscfProvider } from "./uscf";
import { fideProvider } from "./fide";
import { chesscomProvider } from "./chesscom";
import { lichessProvider } from "./lichess";
import { googleProvider } from "./google";
import { chessResultsProvider } from "./chessresults";
import { uscfGraphProvider } from "./uscfGraph";

/** Fast, always-run providers (direct lookups + AI + server sources). */
export const PROVIDERS: Provider[] = [
  uscfProvider,
  fideProvider,
  lichessProvider,
  chesscomProvider,
  googleProvider,
  chessResultsProvider,
];

/**
 * Deep, expensive providers run as a *second phase* only when the fast phase
 * didn't confidently find the player — this keeps easy searches quick and
 * reserves the tournament-graph traversal for the hard cases that need it.
 */
export const DEEP_PROVIDERS: Provider[] = [uscfGraphProvider];

export {
  uscfProvider,
  fideProvider,
  chesscomProvider,
  lichessProvider,
  googleProvider,
  chessResultsProvider,
  uscfGraphProvider,
};
