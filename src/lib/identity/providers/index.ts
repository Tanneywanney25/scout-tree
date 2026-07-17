// ============================================================================
// Provider registry
//
// Three tiers, reflecting how much we trust each discovery route:
//
//   PROVIDERS (anchors)      — real-world identity sources (US Chess, FIDE,
//                              AI reasoning, tournament archives). They tell us
//                              WHO the person is; they never pick usernames.
//   DEEP_PROVIDERS           — the tournament-graph traversal: the PRIMARY way
//                              usernames are discovered, by tracing the
//                              player's actual USCF online events.
//   NAME_FALLBACK_PROVIDERS  — Lichess/Chess.com search by name. The extreme
//                              last resort: it finds namesakes ("the wrong
//                              John Smith") far too easily, so the resolver
//                              only runs it after every tournament avenue has
//                              been exhausted, and caps what it can claim.
//
// Adding a new source stays a one-line change: implement a Provider, import
// it, append it to the right tier.
// ============================================================================

import type { Provider } from "../types";
import { uscfProvider } from "./uscf";
import { fideProvider } from "./fide";
import { chesscomProvider } from "./chesscom";
import { lichessProvider } from "./lichess";
import { googleProvider } from "./google";
import { chessResultsProvider } from "./chessresults";
import { uscfGraphProvider } from "./uscfGraph";

/** Anchor providers — always run first, concurrently. */
export const PROVIDERS: Provider[] = [
  uscfProvider,
  fideProvider,
  googleProvider,
  chessResultsProvider,
];

/** The tournament-graph traversal (primary username discovery). */
export const DEEP_PROVIDERS: Provider[] = [uscfGraphProvider];

/** Name-based platform search — last resort only. */
export const NAME_FALLBACK_PROVIDERS: Provider[] = [lichessProvider, chesscomProvider];

export {
  uscfProvider,
  fideProvider,
  chesscomProvider,
  lichessProvider,
  googleProvider,
  chessResultsProvider,
  uscfGraphProvider,
};
