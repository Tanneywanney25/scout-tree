// ============================================================================
// Provider: FIDE  — server-backed via resolve-identity edge function
//
// FIDE profile pages (ratings.fide.com) are scraped server-side. This provider
// reads the FIDE slice of the shared edge response and contributes federation,
// FIDE ID, title and standard/rapid/blitz rating evidence.
// ============================================================================

import { makeEdgeProvider } from "./edgeClient";

export const fideProvider = makeEdgeProvider({
  name: "fide",
  label: "FIDE",
  source: "fide",
  liveLabel: "Searching FIDE international ratings…",
});
