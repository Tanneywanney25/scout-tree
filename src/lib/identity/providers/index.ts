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

export const PROVIDERS: Provider[] = [
  uscfProvider,
  fideProvider,
  lichessProvider,
  chesscomProvider,
  googleProvider,
  chessResultsProvider,
];

export {
  uscfProvider,
  fideProvider,
  chesscomProvider,
  lichessProvider,
  googleProvider,
  chessResultsProvider,
};
