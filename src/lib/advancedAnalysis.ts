import { generateStructureStats, type StructureReport } from "./structureStats";
import { generateEndgameStats, type EndgameReport } from "./endgameStats";
import { generateOpponentProfile, type OpponentProfile } from "./opponentProfiling";
import type { GameData } from "./chessApi";

export interface AdvancedStoredGame {
  pgn: string;
  white: string;
  black: string;
  result: string;
  opening?: string;
  timeControl?: string;
}

export interface AdvancedAnalysisResult {
  profile: OpponentProfile | null;
  structureReport: StructureReport | null;
  endgameReport: EndgameReport | null;
  gamesAnalyzed: number;
}

export interface RunOptions {
  onProgress?: (percent: number, processed: number, total: number) => void;
  signal?: { aborted: boolean };
  maxGames?: number;
  timeCapMs?: number;
}

function toGameData(games: AdvancedStoredGame[]): GameData[] {
  return games.map((g) => ({
    pgn: g.pgn,
    white: g.white,
    black: g.black,
    winner: g.result === "1-0" ? "white" : g.result === "0-1" ? "black" : undefined,
    opening: g.opening,
    timeControl: g.timeControl,
  }));
}

/**
 * Run the client-side advanced analyses (opponent profile, pawn structures,
 * endgames) over as many games as possible.
 *
 * The work is done in chunks with a yield between each so the UI stays
 * responsive and the progress ring fills gradually. It stops at `maxGames` or
 * when `timeCapMs` is exceeded, whichever comes first, and can be aborted via
 * `signal`. Partial results from the games processed so far are always returned.
 */
export async function runAdvancedAnalysis(
  games: AdvancedStoredGame[],
  username: string,
  { onProgress, signal, maxGames = 300, timeCapMs = 150_000 }: RunOptions = {}
): Promise<AdvancedAnalysisResult> {
  const subset = games.slice(0, maxGames);
  const total = subset.length;

  let profile: OpponentProfile | null = null;
  let structureReport: StructureReport | null = null;
  let endgameReport: EndgameReport | null = null;
  let processed = 0;

  if (total === 0) {
    onProgress?.(100, 0, 0);
    return { profile, structureReport, endgameReport, gamesAnalyzed: 0 };
  }

  // ~12 incremental updates so the ring advances smoothly without recomputing
  // on every single game.
  const chunk = Math.max(5, Math.ceil(total / 12));
  const start = Date.now();

  while (processed < total) {
    if (signal?.aborted) break;
    if (Date.now() - start > timeCapMs) break;

    processed = Math.min(total, processed + chunk);
    const slice = subset.slice(0, processed);

    // Recompute on the cumulative slice so partial results are always valid.
    structureReport = generateStructureStats(slice, username);
    endgameReport = generateEndgameStats(slice, username);
    profile = generateOpponentProfile(toGameData(slice), username);

    onProgress?.((processed / total) * 100, processed, total);

    // Yield to the event loop so the UI can paint and stay interactive.
    await new Promise((r) => setTimeout(r, 0));
  }

  return { profile, structureReport, endgameReport, gamesAnalyzed: processed };
}
