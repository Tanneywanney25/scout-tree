// ============================================================================
// Identity Resolution Engine — public surface
//
// Import from "@/lib/identity" everywhere in the app. Internals (providers,
// verify, confidence math) stay encapsulated behind this barrel.
// ============================================================================

export * from "./types";
export {
  resolveIdentity,
  resolveAnchor,
  discoverAccounts,
  type ResolveOptions,
  type DiscoverOptions,
  type ConfirmedAnchor,
  type AnchorResult,
} from "./resolver";
export {
  confidenceLevel,
  confidencePercent,
  type ConfidenceLevel,
} from "./confidence";
export { PROVIDERS } from "./providers";
export {
  buildHandoff,
  buildAnchorHandoff,
  writeHandoff,
  readHandoff,
  clearHandoff,
  FIND_PLAYER_HANDOFF_KEY,
  type ScoutIdentity,
  type ScoutHandoff,
  type AnchorHandoffInput,
} from "./handoff";
// Anchor-phase client surface (the fast, free half of the split): live member
// search, the AnchorCard preview, FIDE lookup, and the resolved-handles moat.
export {
  searchUscfMembers,
  fetchMemberPreview,
  searchFidePlayers,
  fetchResolvedHandles,
  storeResolvedHandle,
  requestOptOut,
  type MemberSearchHit,
  type MemberSearchResult,
  type MemberPreview,
  type FidePlayerHit,
  type CachedResolvedHandle,
} from "./providers/edgeClient";
