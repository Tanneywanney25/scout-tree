// ============================================================================
// Identity → Scout handoff
//
// Once an identity is confirmed on /find-player, we reuse the *existing* scout
// pipeline rather than duplicating the fetch/analyse/serialise logic. This
// module defines the serialisable contract passed via sessionStorage:
//
//   /find-player  →  writeHandoff()  →  /scout (auto-runs)  →  /report/:id
//
// The Report page reads the embedded ScoutIdentity to render its identity header
// (confidence, evidence, verified accounts, open-profile buttons).
// ============================================================================

import type { DiscoveredAccount, Platform, ResolvedIdentity } from "./types";

/** Platforms the existing scout pipeline can actually fetch games from. */
const FETCHABLE: Platform[] = ["lichess", "chesscom"];

/** Serialisable summary of a resolved identity, embedded in the scout report. */
export interface ScoutIdentity {
  /** Primary account username — this becomes the report's :id.
   *  Empty for an anchor-only handoff (the user types it on /scout). */
  username: string;
  /** True when the user confirmed the PERSON but no account was discovered —
   *  the identity header still renders; the username comes from the user. */
  anchorOnly?: boolean;
  name: string;
  federation?: string;
  country?: string;
  state?: string;
  uscfId?: string;
  fideId?: string;
  estimatedRating?: number;
  estimatedRatingSource?: string;
  title?: string;
  confidence: number;
  reasoning: string;
  sources: string[];
  evidence: { label: string; weight: number }[];
  accounts: {
    platform: Platform;
    username: string;
    profileUrl: string;
    confidence: number;
    rating?: number;
  }[];
}

export interface ScoutHandoff {
  platform: Platform;
  username: string;
  /** Optional second account on the other platform, merged into one report. */
  secondPlatform?: Platform;
  secondUsername?: string;
  /** Color the user will play (opponent plays the opposite). Defaults to white. */
  color: "white" | "black";
  /** Absent for a bare Door-3 handoff (user typed a handle, no identity claim). */
  identity?: ScoutIdentity;
  timestamp: number;
}

/**
 * Door 3: the user already knows the handle. Straight to /scout with the form
 * prefilled — no identity claim attached (nothing has been verified).
 */
export function buildDirectHandleHandoff(
  platform: Platform,
  username: string,
  color: "white" | "black" = "white"
): ScoutHandoff {
  return { platform, username: username.trim().replace(/^@/, ""), color, timestamp: Date.now() };
}

export const FIND_PLAYER_HANDOFF_KEY = "findPlayerHandoff";

/**
 * Build a handoff from a resolved identity + the accounts the user selected.
 * Returns null when none of the chosen accounts are on a fetchable platform.
 */
export function buildHandoff(
  identity: ResolvedIdentity,
  chosenAccounts: DiscoveredAccount[],
  color: "white" | "black" = "white"
): ScoutHandoff | null {
  const fetchable = chosenAccounts
    .filter((a) => FETCHABLE.includes(a.platform))
    .sort((a, b) => b.confidence - a.confidence);
  if (fetchable.length === 0) return null;

  const primary = fetchable[0];
  // Second account = strongest chosen account on a different platform.
  const second = fetchable.find((a) => a.platform !== primary.platform);

  const summary: ScoutIdentity = {
    username: primary.username,
    name: identity.name,
    federation: identity.federation,
    country: identity.country,
    state: identity.state,
    uscfId: identity.uscfId,
    fideId: identity.fideId,
    estimatedRating: identity.estimatedRating,
    estimatedRatingSource: identity.estimatedRatingSource,
    title: identity.title,
    confidence: identity.confidence,
    reasoning: identity.reasoning,
    sources: identity.sources,
    evidence: identity.evidence.map((e) => ({ label: e.label, weight: e.weight })),
    // Show every discovered account in the report header, not just chosen ones.
    accounts: identity.accounts.map((a) => ({
      platform: a.platform,
      username: a.username,
      profileUrl: a.profileUrl,
      confidence: a.confidence,
      rating: a.rating,
    })),
  };

  return {
    platform: primary.platform,
    username: primary.username,
    secondPlatform: second?.platform,
    secondUsername: second?.username,
    color,
    identity: summary,
    timestamp: Date.now(),
  };
}

/** What buildAnchorHandoff needs to know about the confirmed person. */
export interface AnchorHandoffInput {
  name: string;
  uscfId: string;
  state?: string;
  fideId?: string;
  estimatedRating?: number;
  ratings?: Record<string, number>;
  title?: string;
}

/**
 * Build an ANCHOR-ONLY handoff: the user confirmed the person (name, IDs,
 * ratings) but no online account was discovered or chosen. /scout renders the
 * identity header and the user supplies the username — every "failed" search
 * still ends in a usable outcome instead of a dead end.
 */
export function buildAnchorHandoff(anchor: AnchorHandoffInput, color: "white" | "black" = "white"): ScoutHandoff {
  const summary: ScoutIdentity = {
    username: "",
    anchorOnly: true,
    name: anchor.name,
    federation: "USCF",
    country: "US",
    state: anchor.state,
    uscfId: anchor.uscfId,
    fideId: anchor.fideId,
    estimatedRating: anchor.estimatedRating,
    estimatedRatingSource: anchor.estimatedRating ? "USCF" : undefined,
    title: anchor.title,
    // The human picked this member from the official database — the PERSON is
    // as confirmed as it gets. (Says nothing about any account.)
    confidence: 0.95,
    reasoning: `Identity confirmed from the US Chess member database (member #${anchor.uscfId}).`,
    sources: ["uscf"],
    evidence: [{ label: "Confirmed by you from the US Chess member database", weight: 4.0 }],
    accounts: [],
  };
  return {
    platform: "chesscom",
    username: "",
    color,
    identity: summary,
    timestamp: Date.now(),
  };
}

export function writeHandoff(handoff: ScoutHandoff): void {
  try {
    sessionStorage.setItem(FIND_PLAYER_HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    /* sessionStorage may be full/blocked — caller can fall back to manual nav */
  }
}

export function readHandoff(maxAgeMs = 600_000): ScoutHandoff | null {
  try {
    const raw = sessionStorage.getItem(FIND_PLAYER_HANDOFF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScoutHandoff;
    if (!parsed?.platform) return null;
    // Anchor-only handoffs legitimately carry no username (the user types it).
    if (!parsed.username && !parsed.identity?.anchorOnly) return null;
    if (Date.now() - (parsed.timestamp || 0) > maxAgeMs) {
      clearHandoff();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearHandoff(): void {
  try {
    sessionStorage.removeItem(FIND_PLAYER_HANDOFF_KEY);
  } catch {
    /* ignore */
  }
}
