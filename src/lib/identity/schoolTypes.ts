// ============================================================================
// School-based identity resolution — shared shapes
//
// The tournament-graph engine resolves a player by tracing the online USCF
// events they actually played. A player with ZERO online USCF history (a purely
// over-the-board junior, say) leaves that engine nothing to trace. For them we
// fall back to a *social* route: find the player's SCHOOL, resolve other players
// from that same school (whose handles the engine can already discover), and
// identify the target as the account socially connected to that cohort —
// corroborated by rating, location and (decisively) a federation-ID cross-check.
//
// These types are the contract between:
//   • the server-side school-affiliation sources (NWSRS / state associations /
//     registration platforms / LinkedIn / web — they need a server for CORS and
//     an AI/search key), and
//   • the client-side crawler + ranker in schoolResolver.ts (which walks the
//     CORS-friendly Chess.com / Lichess public APIs directly).
//
// Kept free of any Supabase/browser import so the engine runs in the browser,
// the Node CLI harness and tests alike — the same discipline as graphTypes.ts.
// ============================================================================

export type OnlinePlatform = "chesscom" | "lichess";

/** Where a school affiliation came from, roughly in descending trust. */
export type SchoolSource =
  | "nwsrs" // NW scholastic rating DB (WA/OR/ID/BC) — richest, ID encodes school
  | "wscf" // Wisconsin scholastic rating system
  | "cxr" // Chess Express Ratings (OK/AR/KS/MO/TX)
  | "state-assoc" // a state chess association results archive
  | "registration" // an entry-list / registration platform (KingRegistration…)
  | "linkedin" // a public LinkedIn profile / indexed snippet
  | "web"; // general web/AI-search cross-reference

/** One school the resolver believes the target is (or was) affiliated with. */
export interface SchoolAffiliation {
  /** School name as the source names it ("Skyline High School"). */
  school: string;
  /** State the source ties the school to (must be sanity-checked vs USCF/FIDE). */
  state?: string;
  city?: string;
  source: SchoolSource;
  /** Which adapter produced this affiliation ("nwsrs", "wscf", "cxr",
   *  "il-ihsa", …) — the roster lookup routes back to the same source. */
  sourceId?: string;
  /** Human label for logs/UI ("Chess Ratings NorthWest (NWSRS)"). */
  sourceLabel: string;
  /** The page that made the connection, when known. */
  sourceUrl?: string;
  /** 0..1 — how strongly this single source ties the target to the school. */
  confidence: number;
  /** Regional scholastic ID the source assigned the target (e.g. NWSRS id). */
  regionalId?: string;
  /** The school CODE the regional ID encodes (NWSRS: leading letters of the id). */
  schoolCode?: string;
  /** Grade/age when the source has it. */
  grade?: string;
  note?: string;
}

/** Another player at the same school — the cohort we resolve to online handles
 *  and whose social graph we intersect to find the target. */
export interface Schoolmate {
  name: string;
  /** Regional/USCF rating the roster carries, if any (helps prioritise the
   *  more-serious, more-likely-online-active players). */
  rating?: number;
  regionalId?: string;
  grade?: string;
  state?: string;
  /** Handles already known for this schoolmate (rare — most must be discovered). */
  knownUsernames?: { platform: OnlinePlatform; username: string }[];
  /** Which source listed them ("nwsrs-school-report"). */
  source: string;
}

/** What the server was asked to find a school for. */
export interface SchoolLookupRequest {
  name: string;
  state?: string;
  city?: string;
  uscfId?: string;
  uscfRating?: number;
  fideId?: string;
}

/** Server response for a school-affiliation lookup. */
export interface SchoolLookupResult {
  affiliations: SchoolAffiliation[];
  notes: string[];
  /** True when at least one source actually ran (vs. no key / all unreachable). */
  available: boolean;
}

/** Server response for a school-roster lookup. */
export interface SchoolRosterResult {
  schoolmates: Schoolmate[];
  notes: string[];
  available: boolean;
}
