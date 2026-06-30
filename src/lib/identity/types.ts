// ============================================================================
// ScoutTree — Identity Resolution Engine: core types
//
// The engine turns whatever a user knows about an opponent ("a name plus a few
// optional hints") into one or more *resolved identities*, each carrying the
// online accounts (Chess.com / Lichess / ...) we are confident belong to that
// person, with a transparent, evidence-backed confidence score.
//
// Design goals:
//   • Provider-based — every data source is an isolated, swappable Provider.
//   • Probabilistic — nothing is ever "certain"; every clue is Evidence that
//     nudges confidence up or down.
//   • Explainable — the UI must be able to say *why* we believe a match.
// ============================================================================

/** Chess federations / rating bodies the engine understands. */
export type Federation = "USCF" | "FIDE" | "LICHESS" | "CHESSCOM" | "OTHER";

/** Online platforms we can discover an account on. */
export type Platform = "lichess" | "chesscom" | "chesskid" | "icc" | "other";

/** Color a player had in a referenced tournament game, when known. */
export type GameColor = "white" | "black" | "unknown";

// ---------------------------------------------------------------------------
// Query — everything the user knows. Only `name` is required.
// ---------------------------------------------------------------------------

export interface PlayerQuery {
  /** Required. The opponent's name as the user knows it. */
  name: string;

  // --- broad optional context ---
  approxRating?: number;
  federation?: Federation;
  country?: string; // ISO-2 ("US") or free text — normalised downstream
  state?: string; // US state / province
  club?: string;
  school?: string;
  ageOrGrade?: string;

  // --- known identifiers (huge confidence boosters when present) ---
  uscfId?: string;
  fideId?: string;
  /** Free-text hint such as "username starts with chess..." */
  usernameHint?: string;

  // --- tournament context ---
  tournamentName?: string;
  tournamentRound?: string;
  tournamentSection?: string;
  tournamentBoard?: string;
  tournamentColor?: GameColor;

  /** Free-form "anything else you know" box — fed to the AI as raw evidence. */
  additionalDetails?: string;
}

// ---------------------------------------------------------------------------
// Evidence — the atomic unit of belief.
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | "name-match"
  | "rating-match"
  | "federation-match"
  | "country-match"
  | "state-match"
  | "school-match"
  | "club-match"
  | "uscf-id-match"
  | "fide-id-match"
  | "tournament-overlap"
  | "shared-opponent"
  | "username-hint"
  | "activity-recency"
  | "title-match"
  | "ai-inference"
  | "account-verified"
  | "cross-reference"
  | "other";

/**
 * A single piece of evidence. `weight` is a signed log-odds contribution:
 * positive raises confidence, negative lowers it. Magnitudes are roughly:
 *   ~0.4 weak · ~1.0 moderate · ~2.0 strong · ~4.0 near-decisive (an exact ID).
 */
export interface Evidence {
  kind: EvidenceKind;
  /** Signed log-odds contribution to confidence. */
  weight: number;
  /** Human-readable, shown verbatim in the UI ("Name matches: John Smith"). */
  label: string;
  /** Which provider produced this evidence. */
  source: string;
}

// ---------------------------------------------------------------------------
// Discovered account — a candidate online presence for an identity.
// ---------------------------------------------------------------------------

export interface DiscoveredAccount {
  platform: Platform;
  username: string;
  /** Display/real name on the account, if the platform exposes one. */
  displayName?: string;
  title?: string; // GM, IM, FM, NM, ...
  rating?: number;
  /** Per-format ratings when available, e.g. { blitz: 1850, rapid: 1900 }. */
  ratings?: Record<string, number>;
  country?: string;
  gamesFound?: number;
  lastActive?: string; // ISO date or human string
  profileUrl: string;
  /** Whether we successfully hit the platform API and confirmed it exists. */
  verified: boolean;
  /** 0..1 — confidence that this account belongs to the resolved identity. */
  confidence: number;
  evidence: Evidence[];
}

// ---------------------------------------------------------------------------
// Resolved identity — a real person + their discovered accounts.
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
  /** Stable id for React keys / selection. */
  id: string;
  name: string;
  federation?: Federation;
  country?: string;
  state?: string;
  uscfId?: string;
  fideId?: string;
  /** Best single rating estimate, and where it came from. */
  estimatedRating?: number;
  estimatedRatingSource?: string;
  /** All ratings we found, by system ("USCF Regular", "FIDE", "Lichess blitz"). */
  ratings?: Record<string, number>;
  title?: string;

  /** Online accounts attributed to this person, strongest first. */
  accounts: DiscoveredAccount[];

  /** 0..1 overall confidence that this identity matches the user's query. */
  confidence: number;
  /** Identity-level evidence (the real-world match, not per-account). */
  evidence: Evidence[];
  /** One or two plain-English sentences explaining the match. */
  reasoning: string;

  /** Distinct providers that contributed to this identity. */
  sources: string[];
}

// ---------------------------------------------------------------------------
// Provider contract — every data source implements this.
// ---------------------------------------------------------------------------

/** Live progress channel a provider can narrate into during a search. */
export interface ProviderContext {
  query: PlayerQuery;
  signal?: AbortSignal;
  /** Narrate a step ("Searching US Chess…") for the live UI. */
  log: (message: string) => void;
}

/** Raw output of a single provider before cross-provider merging. */
export interface ProviderResult {
  provider: string;
  /** Candidate real-world identities this provider believes exist. */
  identities: PartialIdentity[];
  /** Candidate online accounts (may be unattributed until merge). */
  accounts: DiscoveredAccount[];
  /** Provider-level notes surfaced to the UI / logs. */
  notes?: string[];
  /** True when the provider could not run (offline, not deployed, blocked). */
  unavailable?: boolean;
}

/** Loose identity hint emitted by a provider, merged into ResolvedIdentity. */
export interface PartialIdentity {
  name: string;
  federation?: Federation;
  country?: string;
  state?: string;
  uscfId?: string;
  fideId?: string;
  estimatedRating?: number;
  ratings?: Record<string, number>;
  title?: string;
  /** Usernames this provider suggests verifying, e.g. AI guesses. */
  suggestedAccounts?: { platform: Platform; username: string }[];
  evidence: Evidence[];
  reasoning?: string;
  source: string;
}

export interface Provider {
  /** Stable machine name, e.g. "lichess". */
  name: string;
  /** Human label for the live UI, e.g. "Lichess". */
  label: string;
  /** Whether this provider should run for the given query. */
  enabled: (query: PlayerQuery) => boolean;
  run: (ctx: ProviderContext) => Promise<ProviderResult>;
}

// ---------------------------------------------------------------------------
// Resolution result — what the page renders.
// ---------------------------------------------------------------------------

export interface ResolutionResult {
  query: PlayerQuery;
  identities: ResolvedIdentity[];
  /** Providers that ran, with availability, for transparency in the UI. */
  providerStatus: { name: string; label: string; available: boolean; notes?: string[] }[];
  /** Total wall-clock time, ms. */
  elapsedMs: number;
}

/** A single narrated step in the full-screen "AI detective" experience. */
export interface SearchEvent {
  id: number;
  message: string;
  /** Optional provider that emitted it (drives icons/grouping). */
  provider?: string;
  /** "running" → spinner, "done" → check, "info" → neutral. */
  status: "running" | "done" | "info";
  timestamp: number;
}
