// ============================================================================
// Provider: US Chess (USCF)  — server-backed via resolve-identity edge function
//
// USCF's MSA rating pages are server-rendered HTML and not CORS-accessible from
// the browser, so the actual lookup happens server-side. This provider reads the
// USCF slice of the shared edge response and contributes real-world identity
// evidence: USCF ID, state, federation and ratings (Regular / Quick / Blitz and
// the Online OR/OQ/OB systems introduced during the 2020 online-play era).
// ============================================================================

import { makeEdgeProvider } from "./edgeClient";

export const uscfProvider = makeEdgeProvider({
  name: "uscf",
  label: "US Chess",
  source: "uscf",
  liveLabel: "Searching US Chess ratings & tournament history…",
});
