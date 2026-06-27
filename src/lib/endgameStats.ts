import { EndgameType, ENDGAME_TYPES, analyzeGameEndgame, EndgameInfo } from './endgameDetection';

export interface EndgameResult {
  type: EndgameType;
  won: boolean;
  lost: boolean;
  drew: boolean;
  wasWinning: boolean; // Did player have winning position entering endgame?
  exampleFen?: string;
}

export interface EndgameStats {
  type: EndgameType;
  info: EndgameInfo;
  gamesReached: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  // Conversion tracking
  winningPositions: number; // Times entered endgame with advantage
  converted: number; // Times converted winning position to win
  conversionRate: number;
  // Performance
  performanceRating: 'excellent' | 'good' | 'average' | 'poor';
  examplePositions: string[];
}

export interface EndgameReport {
  stats: EndgameStats[];
  bestEndgames: EndgameStats[];
  worstEndgames: EndgameStats[];
  totalEndgamesReached: number;
  overallConversionRate: number;
}

interface StoredGame {
  pgn: string;
  white: string;
  black: string;
  result: string;
  date?: string;
}

function parseResult(result: string): { whiteWon: boolean; blackWon: boolean; draw: boolean } {
  if (result === '1-0') return { whiteWon: true, blackWon: false, draw: false };
  if (result === '0-1') return { whiteWon: false, blackWon: true, draw: false };
  return { whiteWon: false, blackWon: false, draw: true };
}

// Simple evaluation based on material (rough estimate)
function evaluateMaterial(fen: string, playerIsWhite: boolean): number {
  const pieceValues: Record<string, number> = { 'q': 9, 'r': 5, 'b': 3, 'n': 3, 'p': 1 };
  let whiteScore = 0;
  let blackScore = 0;
  
  const position = fen.split(' ')[0];
  for (const char of position) {
    const lowerChar = char.toLowerCase();
    if (pieceValues[lowerChar]) {
      if (char === char.toUpperCase()) {
        whiteScore += pieceValues[lowerChar];
      } else {
        blackScore += pieceValues[lowerChar];
      }
    }
  }
  
  const diff = whiteScore - blackScore;
  return playerIsWhite ? diff : -diff;
}

export function generateEndgameStats(
  games: StoredGame[],
  targetUsername: string,
  onProgress?: (current: number, total: number) => void
): EndgameReport {
  const endgameResults = new Map<EndgameType, {
    wins: number;
    losses: number;
    draws: number;
    winningPositions: number;
    converted: number;
    positions: string[];
  }>();

  // Initialize all endgame types
  for (const type of Object.keys(ENDGAME_TYPES) as EndgameType[]) {
    endgameResults.set(type, { 
      wins: 0, losses: 0, draws: 0, 
      winningPositions: 0, converted: 0,
      positions: [] 
    });
  }

  const targetLower = targetUsername.toLowerCase();
  let totalEndgames = 0;
  let totalWinningPositions = 0;
  let totalConverted = 0;

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
      const endgameAnalysis = analyzeGameEndgame(game.pgn);
      
      if (endgameAnalysis.reachedEndgame && endgameAnalysis.endgameType) {
        totalEndgames++;
        const stats = endgameResults.get(endgameAnalysis.endgameType)!;
        
        if (playerWon) stats.wins++;
        else if (playerLost) stats.losses++;
        else if (draw) stats.draws++;

        // Check if player was winning when entering endgame
        if (endgameAnalysis.endgameFen) {
          const materialAdvantage = evaluateMaterial(endgameAnalysis.endgameFen, isWhite);
          const wasWinning = materialAdvantage >= 2; // At least 2 pawns up
          
          if (wasWinning) {
            stats.winningPositions++;
            totalWinningPositions++;
            if (playerWon) {
              stats.converted++;
              totalConverted++;
            }
          }

          // Store example position
          if (stats.positions.length < 3) {
            stats.positions.push(endgameAnalysis.endgameFen);
          }
        }
      }
    } catch (e) {
      console.error('Error processing game endgame:', e);
    }
  }

  // Convert to stats array
  const stats: EndgameStats[] = [];

  for (const [type, results] of endgameResults.entries()) {
    const gamesReached = results.wins + results.losses + results.draws;
    
    if (gamesReached === 0) continue;

    const winRate = gamesReached > 0 ? results.wins / gamesReached : 0;
    const conversionRate = results.winningPositions > 0 
      ? results.converted / results.winningPositions 
      : 0;
    
    let performanceRating: 'excellent' | 'good' | 'average' | 'poor';
    if (winRate >= 0.7) performanceRating = 'excellent';
    else if (winRate >= 0.5) performanceRating = 'good';
    else if (winRate >= 0.35) performanceRating = 'average';
    else performanceRating = 'poor';

    stats.push({
      type,
      info: ENDGAME_TYPES[type],
      gamesReached,
      wins: results.wins,
      losses: results.losses,
      draws: results.draws,
      winRate,
      winningPositions: results.winningPositions,
      converted: results.converted,
      conversionRate,
      performanceRating,
      examplePositions: results.positions
    });
  }

  // Sort by games reached
  stats.sort((a, b) => b.gamesReached - a.gamesReached);

  // Filter for meaningful stats (at least 2 games)
  const meaningfulStats = stats.filter(s => s.gamesReached >= 2);
  const validStats = meaningfulStats.filter(s => s.type !== 'unknown' && s.type !== 'complex');

  const bestEndgames = [...validStats]
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 3);

  const worstEndgames = [...validStats]
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, 3);

  return {
    stats: meaningfulStats,
    bestEndgames,
    worstEndgames,
    totalEndgamesReached: totalEndgames,
    overallConversionRate: totalWinningPositions > 0 ? totalConverted / totalWinningPositions : 0
  };
}
