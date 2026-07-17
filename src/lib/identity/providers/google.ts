// ============================================================================
// Provider: Web / AI reasoning  — server-backed via resolve-identity edge function
//
// This is the "detective" provider. Server-side, the edge function runs an AI
// reasoning pass (Anthropic) over the user's clues plus whatever the other
// server sources returned, and proposes candidate identities together with the
// online usernames most worth verifying. We expose it under the "google" file
// name to match the planned provider layout, but it reasons rather than scrapes
// search results directly — more robust and policy-friendly than brittle SERP
// scraping, and the suggested handles are then *verified* against the real
// Lichess / Chess.com APIs by the resolver before we trust them.
// ============================================================================

import { makeEdgeProvider } from "./edgeClient";

export const googleProvider = makeEdgeProvider({
  name: "ai-web",
  label: "Web & AI reasoning",
  source: "ai",
  liveLabel: "Cross-referencing the web and reasoning over the clues…",
});
