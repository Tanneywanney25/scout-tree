import { Chess } from "chess.js";
import type { MoveAnalysis, GameAnalysis } from "./engineAnalysis";
import { getGamePhase } from "./engineAnalysis";

export type WeaknessCategory = 
  | 'hanging_material'
  | 'missed_tactics'
  | 'pawn_structure'
  | 'piece_placement'
  | 'time_pressure'
  | 'endgame_conversion'
  | 'endgame_defense'
  | 'opening_mistakes'
  | 'positional';

export type WeaknessSeverity = 'high' | 'medium' | 'low';

export interface CategorizedMistake {
  category: WeaknessCategory;
  move: MoveAnalysis;
  gameIndex: number;
  description: string;
}

export interface WeaknessSummary {
  category: WeaknessCategory;
  label: string;
  count: number;
  severity: WeaknessSeverity;
  avgEvalLoss: number;
  examples: CategorizedMistake[];
  recommendation: string;
  icon: string;
}

export interface WeaknessReport {
  totalMistakes: number;
  totalBlunders: number;
  totalInaccuracies: number;
  weaknesses: WeaknessSummary[];
  gameCount: number;
}

// Category labels and icons
const categoryMeta: Record<WeaknessCategory, { label: string; icon: string }> = {
  hanging_material: { label: 'Hanging Material', icon: '♟️' },
  missed_tactics: { label: 'Missed Tactics', icon: '⚔️' },
  pawn_structure: { label: 'Pawn Structure', icon: '♙' },
  piece_placement: { label: 'Piece Placement', icon: '♘' },
  time_pressure: { label: 'Time Pressure', icon: '⏱️' },
  endgame_conversion: { label: 'Endgame Conversion', icon: '👑' },
  endgame_defense: { label: 'Endgame Defense', icon: '🛡️' },
  opening_mistakes: { label: 'Opening Mistakes', icon: '📖' },
  positional: { label: 'Positional Errors', icon: '🎯' },
};

// Training recommendations per category
const recommendations: Record<WeaknessCategory, string> = {
  hanging_material: 'Practice piece safety puzzles. Before each move, ask "Is any of my pieces undefended?"',
  missed_tactics: 'Solve tactical puzzles daily on Lichess or Chess.com. Focus on pattern recognition.',
  pawn_structure: 'Study pawn structure principles. Avoid doubled, isolated, and backward pawns without compensation.',
  piece_placement: 'Study piece activity and coordination. Ensure your pieces work together and have good squares.',
  time_pressure: 'Practice with increment. Develop a pre-move routine to save time in familiar positions.',
  endgame_conversion: 'Study basic endgame techniques (Lucena, Philidor). Practice converting winning positions.',
  endgame_defense: 'Learn defensive endgame techniques. Study fortress positions and stalemate tricks.',
  opening_mistakes: 'Review opening principles: control center, develop pieces, castle early. Study your repertoire.',
  positional: 'Study positional concepts: weak squares, outposts, piece coordination, and long-term planning.',
};

// Detect if a move resulted in hanging material
function isHangingMaterial(fenBefore: string, fenAfter: string, evalLoss: number): boolean {
  if (evalLoss < 200) return false; // At least 2 pawns worth
  
  try {
    const chessBefore = new Chess(fenBefore);
    const chessAfter = new Chess(fenAfter);
    
    // Count material before and after
    const countMaterial = (fen: string): number => {
      const board = fen.split(' ')[0];
      let material = 0;
      for (const char of board) {
        const piece = char.toLowerCase();
        if (piece === 'q') material += 9;
        else if (piece === 'r') material += 5;
        else if (piece === 'b' || piece === 'n') material += 3;
        else if (piece === 'p') material += 1;
      }
      return material;
    };
    
    const materialBefore = countMaterial(fenBefore);
    const materialAfter = countMaterial(fenAfter);
    
    // If material dropped significantly, likely hanging piece
    return materialBefore - materialAfter >= 2;
  } catch {
    return false;
  }
}

// Detect pawn structure damage
function isPawnStructureDamage(move: MoveAnalysis): boolean {
  // Check if move involves pawn and resulted in inaccuracy+
  if (!move.move.match(/^[a-h]/)) return false; // Not a pawn move
  
  // Check for doubled pawns or isolated pawn creation
  const evalLoss = Math.abs(move.evalLoss);
  return evalLoss >= 50 && evalLoss < 200;
}

// Detect if the player missed a tactic
function isMissedTactic(move: MoveAnalysis): boolean {
  // If best move had much better eval and eval loss is high
  const evalLoss = Math.abs(move.evalLoss);
  
  // Missed tactics usually show as large eval swings where best move was clearly winning
  if (evalLoss >= 150) {
    // Check if best move was capturing or checking
    const bestMove = move.bestMove.toLowerCase();
    if (bestMove.includes('x') || bestMove.includes('+') || bestMove.includes('#')) {
      return true;
    }
    // Also consider if there was a big eval swing suggesting missed opportunity
    return evalLoss >= 300;
  }
  return false;
}

// Categorize a single mistake
function categorizeMistake(
  move: MoveAnalysis,
  gameIndex: number
): CategorizedMistake | null {
  // Only categorize inaccuracies, mistakes, and blunders
  if (!['inaccuracy', 'mistake', 'blunder'].includes(move.classification)) {
    return null;
  }

  const phase = getGamePhase(move.fenBefore, move.moveNumber);
  const evalLoss = Math.abs(move.evalLoss);
  
  let category: WeaknessCategory;
  let description: string;
  
  // Determine category based on various factors
  if (isHangingMaterial(move.fenBefore, move.fen, evalLoss)) {
    category = 'hanging_material';
    description = `Left material hanging with ${move.move}, losing ~${Math.round(evalLoss / 100)} pawns worth`;
  } else if (isMissedTactic(move)) {
    category = 'missed_tactics';
    description = `Missed tactical opportunity. Best was ${move.bestMove}`;
  } else if (phase === 'opening' && move.moveNumber <= 12) {
    category = 'opening_mistakes';
    description = `Opening inaccuracy on move ${move.moveNumber} with ${move.move}`;
  } else if (phase === 'endgame') {
    // Determine if conversion or defense issue
    const wasWinning = move.evalBefore > 200;
    if (wasWinning) {
      category = 'endgame_conversion';
      description = `Failed to convert winning endgame with ${move.move}`;
    } else {
      category = 'endgame_defense';
      description = `Defensive error in endgame with ${move.move}`;
    }
  } else if (isPawnStructureDamage(move)) {
    category = 'pawn_structure';
    description = `Damaged pawn structure with ${move.move}`;
  } else if (evalLoss < 150) {
    category = 'positional';
    description = `Positional inaccuracy with ${move.move}`;
  } else {
    category = 'piece_placement';
    description = `Poor piece placement with ${move.move}`;
  }

  return {
    category,
    move,
    gameIndex,
    description,
  };
}

// Generate weakness report from multiple game analyses
export function generateWeaknessReport(
  analyses: { analysis: GameAnalysis; gameIndex: number }[]
): WeaknessReport {
  const categorizedMistakes: CategorizedMistake[] = [];
  let totalMistakes = 0;
  let totalBlunders = 0;
  let totalInaccuracies = 0;

  // Process all games
  for (const { analysis, gameIndex } of analyses) {
    totalMistakes += analysis.mistakes;
    totalBlunders += analysis.blunders;
    totalInaccuracies += analysis.inaccuracies;

    // Categorize each mistake
    for (const move of analysis.moves) {
      const categorized = categorizeMistake(move, gameIndex);
      if (categorized) {
        categorizedMistakes.push(categorized);
      }
    }
  }

  // Group by category
  const byCategory = new Map<WeaknessCategory, CategorizedMistake[]>();
  for (const mistake of categorizedMistakes) {
    const existing = byCategory.get(mistake.category) || [];
    existing.push(mistake);
    byCategory.set(mistake.category, existing);
  }

  // Generate summaries sorted by frequency
  const weaknesses: WeaknessSummary[] = [];
  for (const [category, mistakes] of byCategory.entries()) {
    const avgEvalLoss = mistakes.reduce((sum, m) => sum + Math.abs(m.move.evalLoss), 0) / mistakes.length;
    
    // Determine severity based on count and avg eval loss
    let severity: WeaknessSeverity;
    if (mistakes.length >= 5 || avgEvalLoss >= 300) {
      severity = 'high';
    } else if (mistakes.length >= 3 || avgEvalLoss >= 150) {
      severity = 'medium';
    } else {
      severity = 'low';
    }

    // Take top 3 examples (worst eval losses)
    const sortedMistakes = [...mistakes].sort((a, b) => 
      Math.abs(b.move.evalLoss) - Math.abs(a.move.evalLoss)
    );

    weaknesses.push({
      category,
      label: categoryMeta[category].label,
      icon: categoryMeta[category].icon,
      count: mistakes.length,
      severity,
      avgEvalLoss: Math.round(avgEvalLoss),
      examples: sortedMistakes.slice(0, 3),
      recommendation: recommendations[category],
    });
  }

  // Sort by count (most common first), then by severity
  weaknesses.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[a.severity] - severityOrder[b.severity];
    }
    return b.count - a.count;
  });

  return {
    totalMistakes,
    totalBlunders,
    totalInaccuracies,
    weaknesses,
    gameCount: analyses.length,
  };
}

// Get color class for severity
export function getSeverityColor(severity: WeaknessSeverity): string {
  switch (severity) {
    case 'high': return 'text-red-400 bg-red-500/20 border-red-500/50';
    case 'medium': return 'text-orange-400 bg-orange-500/20 border-orange-500/50';
    case 'low': return 'text-yellow-400 bg-yellow-500/20 border-yellow-500/50';
  }
}
