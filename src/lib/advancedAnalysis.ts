import { generateStructureStats, type StructureReport } from "./structureStats";
import { generateEndgameStats, type EndgameReport } from "./endgameStats";
import { generateOpponentProfile, type OpponentProfile } from "./opponentProfiling";
import { StockfishEngine, type GameAnalysis } from "./engineAnalysis";
import { generateWeaknessReport, type WeaknessReport } from "./weaknessDetection";
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
  weaknessReport: WeaknessReport | null;
  gamesAnalyzed: number;
  engineGamesAnalyzed: number;
  engineError?: string | null;
}

export interface RunOptions {
  onProgress?: (percent: number, processed: number, total: number) => void;
  /** Called with partial results as phases complete, so the UI can update live. */
  onPartial?: (partial: AdvancedAnalysisResult) => void;
  signal?: { aborted: boolean };
  maxGames?: number;
  timeCapMs?: number;
  /** Run the (slow) engine weakness phase after the fast client-side phase. */
  engine?: boolean;
  maxEngineGames?: number;
  engineDepth?: number;
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
 * Run the advanced analyses over as many games as possible.
 *
 * Phase 1 (fast, always): opponent profile, pawn structures, endgames over up
 * to `maxGames` games, in chunks with yields so the progress ring fills
 * gradually.
 *
 * Phase 2 (slow, optional `engine`): Stockfish weakness analysis over as many
 * games as fit within `timeCapMs`. It's fully guarded — if the engine can't
 * load it's skipped and the phase-1 results stand. Partial results stream out
 * via `onPartial`.
 */
export async function runAdvancedAnalysis(
  games: AdvancedStoredGame[],
  username: string,
  {
    onProgress,
    onPartial,
    signal,
    maxGames = 300,
    timeCapMs = 150_000,
    engine = false,
    maxEngineGames = 30,
    engineDepth = 12,
  }: RunOptions = {}
): Promise<AdvancedAnalysisResult> {
  const start = Date.now();
  const subset = games.slice(0, maxGames);
  const total = subset.length;

  const result: AdvancedAnalysisResult = {
    profile: null,
    structureReport: null,
    endgameReport: null,
    weaknessReport: null,
    gamesAnalyzed: 0,
    engineGamesAnalyzed: 0,
    engineError: null,
  };

  if (total === 0) {
    onProgress?.(100, 0, 0);
    return result;
  }

  // Phase 1 — fast client-side analyses. Maps to 0–20% when an engine phase
  // follows, otherwise the full 0–100%.
  const p1Max = engine ? 20 : 100;
  const chunk = Math.max(5, Math.ceil(total / 12));
  let processed = 0;

  while (processed < total) {
    if (signal?.aborted) break;
    processed = Math.min(total, processed + chunk);
    const slice = subset.slice(0, processed);
    result.structureReport = generateStructureStats(slice, username);
    result.endgameReport = generateEndgameStats(slice, username);
    result.profile = generateOpponentProfile(toGameData(slice), username);
    result.gamesAnalyzed = processed;
    onProgress?.((processed / total) * p1Max, processed, total);
    onPartial?.({ ...result });
    await new Promise((r) => setTimeout(r, 0));
  }

  if (!engine || signal?.aborted) {
    onProgress?.(engine ? 20 : 100, processed, total);
    return result;
  }

  // Phase 2 — engine weakness analysis (best effort, time-capped).
  try {
    const eng = new StockfishEngine();
    await eng.init();

    const engineSubset = subset.slice(0, maxEngineGames);
    const analyses: { analysis: GameAnalysis; gameIndex: number }[] = [];

    for (let i = 0; i < engineSubset.length; i++) {
      if (signal?.aborted) break;
      if (Date.now() - start > timeCapMs) break;
      try {
        const a = await eng.analyzeGame(engineSubset[i].pgn, engineDepth);
        analyses.push({ analysis: a, gameIndex: i });
        result.engineGamesAnalyzed = analyses.length;
        result.weaknessReport = generateWeaknessReport(analyses);
      } catch (e) {
        console.warn("[ADVANCED] engine game failed:", e);
      }
      const byTime = Math.min(1, (Date.now() - start) / timeCapMs);
      const byGames = (i + 1) / engineSubset.length;
      onProgress?.(20 + Math.max(byTime, byGames) * 80, processed, total);
      onPartial?.({ ...result });
      await new Promise((r) => setTimeout(r, 0));
    }
    eng.terminate();
  } catch (e) {
    result.engineError = e instanceof Error ? e.message : "Engine unavailable";
    console.warn("[ADVANCED] engine phase skipped:", result.engineError);
  }

  onProgress?.(100, processed, total);
  return result;
}
