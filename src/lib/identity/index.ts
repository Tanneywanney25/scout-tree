// ============================================================================
// Identity Resolution Engine — public surface
//
// Import from "@/lib/identity" everywhere in the app. Internals (providers,
// verify, confidence math) stay encapsulated behind this barrel.
// ============================================================================

export * from "./types";
export { resolveIdentity, type ResolveOptions } from "./resolver";
export {
  confidenceLevel,
  confidencePercent,
  type ConfidenceLevel,
} from "./confidence";
export { PROVIDERS } from "./providers";
export {
  buildHandoff,
  writeHandoff,
  readHandoff,
  clearHandoff,
  FIND_PLAYER_HANDOFF_KEY,
  type ScoutIdentity,
  type ScoutHandoff,
} from "./handoff";
