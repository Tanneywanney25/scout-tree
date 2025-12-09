import { 
  PawnStructureType, 
  PAWN_STRUCTURES, 
  analyzeGameStructures,
  PawnStructure 
} from './pawnStructures';

export interface StructureGameResult {
  structure: PawnStructureType;
  won: boolean;
  lost: boolean;
  drew: boolean;
  exampleFen?: string;
}

export interface StructureStats {
  type: PawnStructureType;
  structure: PawnStructure;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  performanceRating: 'strong' | 'neutral' | 'weak';
  examplePositions: string[];
}

export interface StructureReport {
  stats: StructureStats[];
  weakestStructures: StructureStats[];
  strongestStructures: StructureStats[];
  totalGamesAnalyzed: number;
}

interface StoredGame {
  pgn: string;
  white: string;
  black: string;
  result: string;
  date?: string;
}

// Parse game result
function parseResult(result: string): { whiteWon: boolean; blackWon: boolean; draw: boolean } {
  if (result === '1-0') return { whiteWon: true, blackWon: false, draw: false };
  if (result === '0-1') return { whiteWon: false, blackWon: true, draw: false };
  return { whiteWon: false, blackWon: false, draw: true };
}

// Analyze multiple games and generate structure statistics
export function generateStructureStats(
  games: StoredGame[],
  targetUsername: string,
  onProgress?: (current: number, total: number) => void
): StructureReport {
  const structureResults = new Map<PawnStructureType, {
    wins: number;
    losses: number;
    draws: number;
    positions: string[];
  }>();

  // Initialize all structure types
  for (const type of Object.keys(PAWN_STRUCTURES) as PawnStructureType[]) {
    structureResults.set(type, { wins: 0, losses: 0, draws: 0, positions: [] });
  }

  const targetLower = targetUsername.toLowerCase();

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    
    if (onProgress) {
      onProgress(i + 1, games.length);
    }

    const isWhite = game.white.toLowerCase() === targetLower;
    const isBlack = game.black.toLowerCase() === targetLower;
    
    if (!isWhite && !isBlack) continue;

    const { whiteWon, blackWon, draw } = parseResult(game.result);
    const playerWon = (isWhite && whiteWon) || (isBlack && blackWon);
    const playerLost = (isWhite && blackWon) || (isBlack && whiteWon);

    try {
      const { structures, positions } = analyzeGameStructures(game.pgn);

      for (const [type, count] of structures.entries()) {
        if (count > 0) {
          const stats = structureResults.get(type)!;
          
          if (playerWon) stats.wins++;
          else if (playerLost) stats.losses++;
          else if (draw) stats.draws++;

          // Add example positions
          const examplePositions = positions.get(type) || [];
          for (const pos of examplePositions) {
            if (stats.positions.length < 3 && !stats.positions.includes(pos)) {
              stats.positions.push(pos);
            }
          }
        }
      }
    } catch (e) {
      console.error('Error processing game:', e);
    }
  }

  // Convert to stats array
  const stats: StructureStats[] = [];

  for (const [type, results] of structureResults.entries()) {
    const gamesPlayed = results.wins + results.losses + results.draws;
    
    if (gamesPlayed === 0) continue;

    const winRate = gamesPlayed > 0 ? results.wins / gamesPlayed : 0;
    
    let performanceRating: 'strong' | 'neutral' | 'weak';
    if (winRate >= 0.6) performanceRating = 'strong';
    else if (winRate <= 0.4) performanceRating = 'weak';
    else performanceRating = 'neutral';

    stats.push({
      type,
      structure: PAWN_STRUCTURES[type],
      gamesPlayed,
      wins: results.wins,
      losses: results.losses,
      draws: results.draws,
      winRate,
      performanceRating,
      examplePositions: results.positions
    });
  }

  // Sort by games played
  stats.sort((a, b) => b.gamesPlayed - a.gamesPlayed);

  // Filter structures with at least 2 games for meaningful stats
  const meaningfulStats = stats.filter(s => s.gamesPlayed >= 2);

  // Get weakest and strongest (excluding 'unknown')
  const validStats = meaningfulStats.filter(s => s.type !== 'unknown');
  
  const weakestStructures = [...validStats]
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, 3);

  const strongestStructures = [...validStats]
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 3);

  return {
    stats: meaningfulStats,
    weakestStructures,
    strongestStructures,
    totalGamesAnalyzed: games.length
  };
}

// Get strategic recommendations based on weak structures
export function getStructureRecommendations(weakStructures: StructureStats[]): string[] {
  const recommendations: string[] = [];

  for (const stats of weakStructures) {
    const structure = stats.structure;
    recommendations.push(
      `Against ${structure.label} (${Math.round(stats.winRate * 100)}% win rate): ${structure.strategicPlans[0]}`
    );
  }

  return recommendations;
}
