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
