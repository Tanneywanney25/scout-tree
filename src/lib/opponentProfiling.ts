import { Chess } from "chess.js";
import type { GameData } from "./chessApi";

export type PlayingStyle = 'activist' | 'pragmatist' | 'reflector' | 'theoretician';
export type MentalStrength = 'resilient' | 'steady' | 'fragile';

export interface TimeManagementStats {
  timeTroubleGames: number; // Games with <30 seconds at move 35+
  timeTroubleRate: number; // Percentage
  avgMovesInTimeControl: number; // How many moves before time scramble
  fastMoveRate: number; // Percentage of moves made very quickly (<5s conceptually)
  timeTroubleWinRate: number; // Win rate when in time trouble
}

export interface RatingsByTimeControl {
  bullet?: number;
  blitz?: number;
  rapid?: number;
  classical?: number;
}

export interface MentalGameStats {
  comebackRate: number; // Rate of winning from losing positions
  collapseRate: number; // Rate of losing from winning positions
  drawHoldRate: number; // Rate of holding worse positions to draws
  mentalStrength: MentalStrength;
}

export interface GameLengthStats {
  avgGameLength: number;
  shortGames: number; // <25 moves
  mediumGames: number; // 25-50 moves
  longGames: number; // >50 moves
  prefersEndgame: boolean;
}

export interface OpeningStyleStats {
  mainlineDeviation: number; // How early they deviate from theory
  openingDiversity: number; // Number of different openings played
  gambitsPlayed: number;
  solidOpenings: number;
}

export interface OpponentProfile {
  username: string;
  gamesAnalyzed: number;
  playingStyle: PlayingStyle;
  styleDescription: string;
  styleConfidence: number; // 0-100
  timeManagement: TimeManagementStats;
  ratingsByTimeControl: RatingsByTimeControl;
  mentalGame: MentalGameStats;
  gameLength: GameLengthStats;
  openingStyle: OpeningStyleStats;
  keyInsights: string[];
  exploitableWeaknesses: string[];
}

// Parse clock data from PGN [%clk H:MM:SS] format
// Matches both Lichess {[%clk 0:05:00]} and Chess.com [%clk 0:00:30.1] formats
function parseClockFromPgn(pgn: string): number[] {
  const clocks: number[] = [];
  // Updated regex to handle optional curly braces and decimal seconds
  const clockRegex = /\[%clk\s*(\d+):(\d+):(\d+(?:\.\d+)?)\]/g;
  let match;
  
  while ((match = clockRegex.exec(pgn)) !== null) {
    const hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const seconds = parseFloat(match[3]); // parseFloat for decimal seconds
    clocks.push(hours * 3600 + minutes * 60 + seconds);
  }
  
  return clocks;
}

// Detect time trouble (less than 30 seconds remaining after move 35)
function detectTimeTrouble(clocks: number[], playerColor: 'white' | 'black'): boolean {
  // Player's clocks are at even indices (0, 2, 4...) for white, odd for black
  const startIndex = playerColor === 'white' ? 0 : 1;
  
  // Check clocks after move 35 (ply 70 for white, 71 for black approximately)
  for (let i = startIndex; i < clocks.length; i += 2) {
    const moveNumber = Math.floor(i / 2) + 1;
    if (moveNumber >= 35 && clocks[i] < 30) {
      return true;
    }
  }
  return false;
}

// Determine playing style from game characteristics
function classifyPlayingStyle(
  openingDiversity: number,
  avgGameLength: number,
  gambitsRate: number,
  endgamePreference: boolean
): { style: PlayingStyle; description: string; confidence: number } {
  let style: PlayingStyle;
  let description: string;
  let confidence = 70; // Base confidence
  
  // Activist: Aggressive, plays gambits, shorter games, variety of openings
  // Pragmatist: Practical, adapts to opponent, medium game length
  // Reflector: Defensive, prefers endgames, long games, solid openings
  // Theoretician: Deep opening knowledge, mainline play, high opening diversity awareness
  
  if (gambitsRate > 0.15 && avgGameLength < 40) {
    style = 'activist';
    description = 'Aggressive player who seeks early initiative. Plays gambits and prefers tactical complications.';
    confidence = Math.min(95, confidence + gambitsRate * 100);
  } else if (endgamePreference && avgGameLength > 50) {
    style = 'reflector';
    description = 'Defensive player who excels in long games. Prefers to outmaneuver opponents in the endgame.';
    confidence = Math.min(95, confidence + (avgGameLength - 50) / 2);
  } else if (openingDiversity > 5) {
    style = 'theoretician';
    description = 'Well-prepared player with deep opening knowledge. Likely studies theory extensively.';
    confidence = Math.min(95, confidence + openingDiversity * 2);
  } else {
    style = 'pragmatist';
    description = 'Practical player who adapts to the position. Makes decisions based on concrete calculation.';
  }
  
  return { style, description, confidence };
}

// Calculate mental game statistics using capture-based heuristics
function analyzeMentalGame(
  games: GameData[],
  username: string
): MentalGameStats {
  let potentialComebacks = 0;
  let actualComebacks = 0;
  let potentialCollapses = 0;
  let actualCollapses = 0;
  let potentialDrawHolds = 0;
  let actualDrawHolds = 0;
  
  console.log('[OPPONENT-PROFILE] analyzeMentalGame for', username, 'with', games.length, 'games');
  
  for (const game of games) {
    const isWhite = game.white.toLowerCase() === username.toLowerCase();
    const won = (game.winner === 'white' && isWhite) || (game.winner === 'black' && !isWhite);
    const lost = (game.winner === 'black' && isWhite) || (game.winner === 'white' && !isWhite);
    const drew = !game.winner;
    
    try {
      const chess = new Chess();
      chess.loadPgn(game.pgn);
      const moves = chess.history({ verbose: true });
      
      // Count material swings via piece captures in early/mid game
      let capturesByPlayer = 0;
      let capturesByOpponent = 0;
      const midGameEnd = Math.min(moves.length, 40); // First 40 ply
      
      for (let i = 0; i < midGameEnd; i++) {
        const move = moves[i];
        if (move.captured) {
          const isPlayerMove = (isWhite && i % 2 === 0) || (!isWhite && i % 2 === 1);
          if (isPlayerMove) capturesByPlayer++;
          else capturesByOpponent++;
        }
      }
      
      // Determine early advantage/disadvantage based on captures
      const earlyDisadvantage = capturesByOpponent > capturesByPlayer + 1;
      const earlyAdvantage = capturesByPlayer > capturesByOpponent + 1;
      
      if (earlyDisadvantage) {
        potentialComebacks++;
        if (won) actualComebacks++;
      }
      
      if (earlyAdvantage) {
        potentialCollapses++;
        if (lost) actualCollapses++;
        if (drew) {
          potentialDrawHolds++;
          actualDrawHolds++;
        }
      }
      
    } catch {
      continue;
    }
  }
  
  const comebackRate = potentialComebacks > 0 
    ? Math.round((actualComebacks / potentialComebacks) * 100) 
    : 0;
  const collapseRate = potentialCollapses > 0 
    ? Math.round((actualCollapses / potentialCollapses) * 100) 
    : 0;
  const drawHoldRate = potentialDrawHolds > 0 
    ? Math.round((actualDrawHolds / potentialDrawHolds) * 100) 
    : 0;
  
  console.log('[OPPONENT-PROFILE] Mental game stats:', {
    potentialComebacks, actualComebacks, comebackRate,
    potentialCollapses, actualCollapses, collapseRate,
    potentialDrawHolds, actualDrawHolds, drawHoldRate
  });
  
  // Classify mental strength
  let mentalStrength: MentalStrength;
  if (comebackRate > 30 && collapseRate < 20) {
    mentalStrength = 'resilient';
  } else if (collapseRate > 35) {
    mentalStrength = 'fragile';
  } else {
    mentalStrength = 'steady';
  }
  
  return {
    comebackRate,
    collapseRate,
    drawHoldRate,
    mentalStrength,
  };
}

// Analyze game lengths
function analyzeGameLengths(games: GameData[], username: string): GameLengthStats {
  let totalLength = 0;
  let shortGames = 0;
  let mediumGames = 0;
  let longGames = 0;
  let validGames = 0;
  
  for (const game of games) {
    try {
      const chess = new Chess();
      chess.loadPgn(game.pgn);
      const moveCount = chess.history().length / 2; // Full moves
      
      totalLength += moveCount;
      validGames++;
      
      if (moveCount < 25) shortGames++;
      else if (moveCount <= 50) mediumGames++;
      else longGames++;
    } catch {
      continue;
    }
  }
  
  const avgGameLength = validGames > 0 ? totalLength / validGames : 0;
  
  return {
    avgGameLength: Math.round(avgGameLength),
    shortGames,
    mediumGames,
    longGames,
    prefersEndgame: longGames > shortGames,
  };
}

// Analyze opening patterns
function analyzeOpeningStyle(games: GameData[], username: string): OpeningStyleStats {
  const openings = new Set<string>();
  let gambits = 0;
  let solidOpenings = 0;
  let totalDeviationPly = 0;
  let gamesWithOpening = 0;
  
  const gambitPatterns = ['gambit', 'sacrifice', 'danish', 'evans', 'king\'s', 'benko', 'latvian', 'smith-morra'];
  const solidPatterns = ['caro-kann', 'slav', 'berlin', 'petrov', 'london', 'french', 'qgd', 'symmetrical'];
  
  for (const game of games) {
    let openingId: string | null = null;
    let openingLower: string = '';
    
    // Try to get opening from game data first
    if (game.opening) {
      openingId = game.opening.split(':')[0];
      openingLower = game.opening.toLowerCase();
    } else {
      // Fallback: derive opening from first 6 moves of PGN
      try {
        const chess = new Chess();
        chess.loadPgn(game.pgn);
        const moves = chess.history();
        if (moves.length >= 2) {
          openingId = moves.slice(0, Math.min(6, moves.length)).join(' ');
          openingLower = openingId.toLowerCase();
        }
      } catch {
        continue;
      }
    }
    
    if (openingId) {
      openings.add(openingId);
      gamesWithOpening++;
      
      if (gambitPatterns.some(p => openingLower.includes(p))) {
        gambits++;
      }
      if (solidPatterns.some(p => openingLower.includes(p))) {
        solidOpenings++;
      }
      
      // Estimate deviation point from opening name (heuristic)
      if (openingLower.includes('variation')) {
        totalDeviationPly += 10;
      } else if (openingLower.includes('defense') || openingLower.includes('opening')) {
        totalDeviationPly += 6;
      } else {
        totalDeviationPly += 4;
      }
    }
  }
  
  return {
    mainlineDeviation: gamesWithOpening > 0 ? Math.round(totalDeviationPly / gamesWithOpening) : 5,
    openingDiversity: openings.size,
    gambitsPlayed: gambits,
    solidOpenings,
  };
}

// Generate key insights based on profile
function generateInsights(profile: Partial<OpponentProfile>): string[] {
  const insights: string[] = [];
  
  // Time management insights
  if (profile.timeManagement) {
    if (profile.timeManagement.timeTroubleRate > 30) {
      insights.push(`⏱️ Gets into time trouble in ${profile.timeManagement.timeTroubleRate}% of games - slow them down with complex positions`);
    }
    if (profile.timeManagement.timeTroubleWinRate < 30) {
      insights.push(`🎯 Only wins ${profile.timeManagement.timeTroubleWinRate}% when in time trouble - push for complications late in game`);
    }
  }
  
  // Mental game insights
  if (profile.mentalGame) {
    if (profile.mentalGame.collapseRate > 20) {
      insights.push(`💥 Collapses from winning positions ${profile.mentalGame.collapseRate}% of the time - stay solid and wait for mistakes`);
    }
    if (profile.mentalGame.comebackRate > 25) {
      insights.push(`⚠️ Dangerous when losing - wins ${profile.mentalGame.comebackRate}% of losing positions - finish games cleanly`);
    }
  }
  
  // Playing style insights
  if (profile.playingStyle === 'activist') {
    insights.push(`⚔️ Aggressive player - consider solid, defensive setups to neutralize their initiative`);
  } else if (profile.playingStyle === 'reflector') {
    insights.push(`🐢 Defensive player - push for early complications before they reach their preferred endgame`);
  }
  
  // Game length insights
  if (profile.gameLength) {
    if (profile.gameLength.shortGames > profile.gameLength.longGames * 2) {
      insights.push(`⚡ Prefers quick games - prepare for tactical battles in the opening`);
    }
  }
  
  return insights.slice(0, 5); // Return top 5 insights
}

// Generate exploitable weaknesses
function generateWeaknesses(profile: Partial<OpponentProfile>): string[] {
  const weaknesses: string[] = [];
  
  if (profile.timeManagement?.timeTroubleRate && profile.timeManagement.timeTroubleRate > 25) {
    weaknesses.push('Time management - likely to blunder in time pressure');
  }
  
  if (profile.mentalGame?.collapseRate && profile.mentalGame.collapseRate > 20) {
    weaknesses.push('Psychological - prone to collapse when ahead');
  }
  
  if (profile.mentalGame?.mentalStrength === 'fragile') {
    weaknesses.push('Mental resilience - struggles to maintain composure');
  }
  
  if (profile.gameLength?.prefersEndgame === false && profile.gameLength?.shortGames > 0) {
    weaknesses.push('Endgame technique - try to simplify to technical positions');
  }
  
  if (profile.openingStyle?.openingDiversity && profile.openingStyle.openingDiversity < 3) {
    weaknesses.push('Limited repertoire - prepare specific anti-systems');
  }
  
  return weaknesses.slice(0, 4);
}

// Main function to generate complete opponent profile
export function generateOpponentProfile(
  games: GameData[],
  username: string
): OpponentProfile {
  console.log('[OPPONENT-PROFILE] Generating profile for:', username);
  console.log('[OPPONENT-PROFILE] Total games received:', games.length);
  
  // Analyze time management
  let timeTroubleGames = 0;
  let timeTroubleWins = 0;
  let gamesWithClocks = 0;
  
  for (const game of games) {
    const clocks = parseClockFromPgn(game.pgn);
    if (clocks.length > 0) {
      gamesWithClocks++;
      const isWhite = game.white.toLowerCase() === username.toLowerCase();
      const inTimeTrouble = detectTimeTrouble(clocks, isWhite ? 'white' : 'black');
      
      if (inTimeTrouble) {
        timeTroubleGames++;
        const won = (game.winner === 'white' && isWhite) || (game.winner === 'black' && !isWhite);
        if (won) timeTroubleWins++;
      }
    }
  }
  
  console.log('[OPPONENT-PROFILE] Games with clock data:', gamesWithClocks, '/', games.length);
  console.log('[OPPONENT-PROFILE] Time trouble games:', timeTroubleGames);
  
  const timeManagement: TimeManagementStats = {
    timeTroubleGames,
    timeTroubleRate: gamesWithClocks > 0 ? Math.round((timeTroubleGames / gamesWithClocks) * 100) : 0,
    avgMovesInTimeControl: 35, // Placeholder - would need deeper analysis
    fastMoveRate: 0, // Placeholder
    timeTroubleWinRate: timeTroubleGames > 0 ? Math.round((timeTroubleWins / timeTroubleGames) * 100) : 0,
  };
  
  // Analyze game lengths
  const gameLength = analyzeGameLengths(games, username);
  
  // Analyze opening style
  const openingStyle = analyzeOpeningStyle(games, username);
  
  // Analyze mental game
  const mentalGame = analyzeMentalGame(games, username);
  
  // Classify playing style
  const gambitsRate = games.length > 0 ? openingStyle.gambitsPlayed / games.length : 0;
  const { style, description, confidence } = classifyPlayingStyle(
    openingStyle.openingDiversity,
    gameLength.avgGameLength,
    gambitsRate,
    gameLength.prefersEndgame
  );
  
  // Build partial profile for insight generation
  const partialProfile = {
    timeManagement,
    mentalGame,
    gameLength,
    playingStyle: style,
    openingStyle,
  };
  
  return {
    username,
    gamesAnalyzed: games.length,
    playingStyle: style,
    styleDescription: description,
    styleConfidence: Math.round(confidence),
    timeManagement,
    ratingsByTimeControl: {}, // Would need API data
    mentalGame,
    gameLength,
    openingStyle,
    keyInsights: generateInsights(partialProfile),
    exploitableWeaknesses: generateWeaknesses(partialProfile),
  };
}

// Get style color for UI
export function getStyleColor(style: PlayingStyle): string {
  switch (style) {
    case 'activist': return 'text-red-400 bg-red-500/20 border-red-500/50';
    case 'pragmatist': return 'text-blue-400 bg-blue-500/20 border-blue-500/50';
    case 'reflector': return 'text-green-400 bg-green-500/20 border-green-500/50';
    case 'theoretician': return 'text-purple-400 bg-purple-500/20 border-purple-500/50';
  }
}

// Get mental strength color
export function getMentalStrengthColor(strength: MentalStrength): string {
  switch (strength) {
    case 'resilient': return 'text-green-400 bg-green-500/20 border-green-500/50';
    case 'steady': return 'text-blue-400 bg-blue-500/20 border-blue-500/50';
    case 'fragile': return 'text-red-400 bg-red-500/20 border-red-500/50';
  }
}
