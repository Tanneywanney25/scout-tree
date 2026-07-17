// ============================================================================
// USCF tournament-graph shapes — shared between the edge client (which receives
// them from the resolve-identity function) and the traversal engine (which
// walks them). Kept free of any Supabase/browser imports so the engine can run
// anywhere fetch exists (browser, Node CLI harness, tests).
// ============================================================================

/** One game a section player played (colour is "Unknown" for most online events). */
export interface GraphGame {
  round: number;
  color: "white" | "black" | "unknown";
  outcome: string;
  opponentUscfId: string;
  opponentName: string;
}

/** A player in an online section, with their round-by-round games. */
export interface GraphPlayer {
  uscfId: string;
  name: string;
  rating?: number;
  /** The player's USCF state of record (MUIR stateRep) — lets candidate
   *  profiles be location-checked for EVERY section player, not just the target. */
  state?: string;
  isTarget?: boolean;
  games: GraphGame[];
}

/** One online-rated section the scouted player appeared in (a full crosstable). */
export interface GraphEvent {
  eventId: string;
  name: string;
  sectionName?: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;
  ratingSystem: string; // OR / OQ / OB
  timeControl?: string;
  roundCount?: number;
  isBlitz?: boolean;
  platformGuess?: string;
  players: GraphPlayer[];
}

export interface TournamentGraph {
  rootUscfId: string;
  rootName: string;
  rootState?: string;
  onlineEvents: GraphEvent[];
  graphTraversalReady: boolean;
}

/**
 * A Google-index username search request (served by the resolve-identity edge
 * function's `findUsername` mode). This is THE way tournament players' handles
 * are discovered from their names — the platforms' own name search finds the
 * wrong homonym far too easily, so it is only ever a last resort.
 */
export interface UsernameSearchRequest {
  name: string;
  state?: string;
  city?: string;
  clubOrSchool?: string;
  uscfRating?: number;
  fideId?: string;
  /** USCF event context — sharpens queries and helps disambiguation. */
  eventName?: string;
  eventDate?: string;
  platforms?: ("chesscom" | "lichess")[];
  /** Handles this person already uses elsewhere (username reuse). */
  knownUsernames?: string[];
}

/** One handle the Google index tied to the person — a LEAD to verify, never
 *  an identification by itself. */
export interface UsernameCandidate {
  platform: "chesscom" | "lichess";
  username: string;
  /** Indexed page that made the name↔handle connection. */
  sourceUrl?: string;
  note?: string;
}

/**
 * What a web/flyer search learned about where a USCF online event was hosted.
 * Produced server-side (AI + web search over TLAs/flyers/club announcements)
 * and consumed by the traversal engine to focus its platform work — ideally
 * with the exact Chess.com tournament slug or Lichess swiss/arena id, whose
 * public APIs hand back the full participant roster.
 */
export interface EventPlatformInfo {
  platform?: "chesscom" | "lichess" | "chesskid" | "icc" | "unknown";
  /** Chess.com tournament slugs (api.chess.com/pub/tournament/{slug}). */
  chesscomSlugs?: string[];
  /** Lichess swiss ids (lichess.org/api/swiss/{id}/results). */
  lichessSwissIds?: string[];
  /** Lichess arena ids (lichess.org/api/tournament/{id}/results). */
  lichessArenaIds?: string[];
  confidence?: number;
  note?: string;
}
