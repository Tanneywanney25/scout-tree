import { Chess, PieceSymbol } from 'chess.js';

export type EndgameType = 
  | 'king_pawn'           // K+P vs K
  | 'rook_endgame'        // R+P vs R+P
  | 'rook_vs_pawns'       // R vs pawns
  | 'queen_endgame'       // Q+P vs Q+P
  | 'bishop_endgame'      // B+P vs B+P (same color)
  | 'opposite_bishops'    // B vs B (opposite colors)
  | 'knight_endgame'      // N+P vs N+P
  | 'bishop_vs_knight'    // B vs N
  | 'rook_vs_minor'       // R vs B or N
  | 'queen_vs_rook'       // Q vs R+piece
  | 'two_rooks'           // RR vs RR
  | 'minor_piece'         // Minor piece endings
  | 'complex'             // Multiple piece types
  | 'pawn_race'           // Only kings and pawns
  | 'tablebase'           // 6 pieces or fewer (theoretical)
  | 'unknown';

export interface EndgameInfo {
  type: EndgameType;
  label: string;
  description: string;
  keyTechniques: string[];
  commonMistakes: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  icon: string;
}

export const ENDGAME_TYPES: Record<EndgameType, EndgameInfo> = {
  king_pawn: {
    type: 'king_pawn',
    label: 'King & Pawn',
    description: 'Pure king and pawn endings',
    keyTechniques: [
      'Opposition (direct, distant, diagonal)',
      'Square of the pawn rule',
      'Key squares concept',
      'Breakthrough combinations'
    ],
    commonMistakes: [
      'Losing the opposition at critical moment',
      'Not calculating pawn races accurately',
      'Missing stalemate tricks'
    ],
    difficulty: 'medium',
    icon: '♔'
  },
  rook_endgame: {
    type: 'rook_endgame',
    label: 'Rook Endgame',
    description: 'Rook(s) and pawns vs rook(s) and pawns',
    keyTechniques: [
      'Lucena position (building the bridge)',
      'Philidor position (3rd rank defense)',
      'Active rook placement',
      'Cutting off the king'
    ],
    commonMistakes: [
      'Passive rook placement',
      'Not activating the king',
      'Missing tactical draws'
    ],
    difficulty: 'hard',
    icon: '♖'
  },
  rook_vs_pawns: {
    type: 'rook_vs_pawns',
    label: 'Rook vs Pawns',
    description: 'Rook fighting against passed pawns',
    keyTechniques: [
      'Attacking pawns from behind',
      'Using checks to gain tempo',
      'Cutting off the enemy king'
    ],
    commonMistakes: [
      'Allowing pawns to advance too far',
      'Poor rook positioning',
      'Not using king actively'
    ],
    difficulty: 'medium',
    icon: '♖'
  },
  queen_endgame: {
    type: 'queen_endgame',
    label: 'Queen Endgame',
    description: 'Queen(s) and pawns',
    keyTechniques: [
      'Perpetual check patterns',
      'Queen centralization',
      'Using pawns as shields',
      'Creating passed pawns'
    ],
    commonMistakes: [
      'Allowing perpetual check',
      'Queen getting trapped',
      'Ignoring back rank threats'
    ],
    difficulty: 'hard',
    icon: '♕'
  },
  bishop_endgame: {
    type: 'bishop_endgame',
    label: 'Same-Color Bishops',
    description: 'Bishops on same colored squares',
    keyTechniques: [
      'Controlling diagonals',
      'Creating passed pawns on opposite wing',
      'King activity is crucial'
    ],
    commonMistakes: [
      'Allowing bishop to be passive',
      'Not using the "wrong color" advantage',
      'Poor pawn structure'
    ],
    difficulty: 'medium',
    icon: '♗'
  },
  opposite_bishops: {
    type: 'opposite_bishops',
    label: 'Opposite-Color Bishops',
    description: 'Bishops on different colored squares',
    keyTechniques: [
      'Creating passed pawns on both wings',
      'Fortress concepts',
      'Blockading passed pawns'
    ],
    commonMistakes: [
      'Overestimating winning chances',
      'Not recognizing fortress positions',
      'Pawns on wrong color squares'
    ],
    difficulty: 'medium',
    icon: '♗'
  },
  knight_endgame: {
    type: 'knight_endgame',
    label: 'Knight Endgame',
    description: 'Knight(s) and pawns',
    keyTechniques: [
      'Outpost squares for knights',
      'Knight forks and tactics',
      'Zugzwang positions'
    ],
    commonMistakes: [
      'Knight stuck on rim',
      'Missing tactical knight moves',
      'Poor pawn structure with knights'
    ],
    difficulty: 'medium',
    icon: '♘'
  },
  bishop_vs_knight: {
    type: 'bishop_vs_knight',
    label: 'Bishop vs Knight',
    description: 'Bishop and pawns vs knight and pawns',
    keyTechniques: [
      'Open positions favor bishop',
      'Closed positions favor knight',
      'Placing pawns on right color'
    ],
    commonMistakes: [
      'Wrong pawn color with bishop',
      'Allowing knight to find outposts',
      'Not opening position for bishop'
    ],
    difficulty: 'medium',
    icon: '♗♘'
  },
  rook_vs_minor: {
    type: 'rook_vs_minor',
    label: 'Rook vs Minor Piece',
    description: 'Rook vs bishop or knight (with pawns)',
    keyTechniques: [
      'Exchange advantage technique',
      'Cutting off the king',
      'Creating passed pawns'
    ],
    commonMistakes: [
      'Allowing fortress',
      'Not activating the rook',
      'Missing tactical draws'
    ],
    difficulty: 'hard',
    icon: '♖'
  },
  queen_vs_rook: {
    type: 'queen_vs_rook',
    label: 'Queen vs Rook',
    description: 'Queen vs rook (possibly with pieces)',
    keyTechniques: [
      'Winning the rook with checks',
      'Avoiding perpetual',
      'Third rank defense (for rook side)'
    ],
    commonMistakes: [
      'Allowing fortress',
      'Getting into perpetual',
      'Overextending'
    ],
    difficulty: 'hard',
    icon: '♕'
  },
  two_rooks: {
    type: 'two_rooks',
    label: 'Double Rook Endgame',
    description: 'Two rooks each with pawns',
    keyTechniques: [
      'Doubling rooks on open files',
      '7th rank domination',
      'Coordinating rooks'
    ],
    commonMistakes: [
      'Rooks not coordinated',
      'Missing back rank threats',
      'Passive defense'
    ],
    difficulty: 'hard',
    icon: '♖♖'
  },
  minor_piece: {
    type: 'minor_piece',
    label: 'Minor Piece Endgame',
    description: 'Multiple minor pieces and pawns',
    keyTechniques: [
      'Piece coordination',
      'Creating weaknesses',
      'Using the bishop pair'
    ],
    commonMistakes: [
      'Poor piece placement',
      'Missing tactical blows',
      'Wrong exchanges'
    ],
    difficulty: 'medium',
    icon: '♗♘'
  },
  complex: {
    type: 'complex',
    label: 'Complex Endgame',
    description: 'Multiple piece types remaining',
    keyTechniques: [
      'Simplification to winning ending',
      'Piece activity over material',
      'Creating passed pawns'
    ],
    commonMistakes: [
      'Wrong exchanges',
      'Passive play',
      'Missing tactics'
    ],
    difficulty: 'hard',
    icon: '♕♖'
  },
  pawn_race: {
    type: 'pawn_race',
    label: 'Pawn Race',
    description: 'Kings and pawns racing to promote',
    keyTechniques: [
      'Counting tempi accurately',
      'Shouldering the opponent king',
      'Creating passed pawns'
    ],
    commonMistakes: [
      'Miscounting the race',
      'Wrong king move',
      'Missing breakthrough'
    ],
    difficulty: 'easy',
    icon: '♙'
  },
  tablebase: {
    type: 'tablebase',
    label: 'Tablebase Position',
    description: '6 or fewer pieces (theoretically solved)',
    keyTechniques: [
      'Know theoretical wins/draws',
      'Technique over calculation',
      'Common patterns'
    ],
    commonMistakes: [
      'Not knowing the theory',
      'Missing 50-move rule',
      'Wrong technique'
    ],
    difficulty: 'easy',
    icon: '📊'
  },
  unknown: {
    type: 'unknown',
    label: 'Other Endgame',
    description: 'Unusual piece configuration',
    keyTechniques: [
      'General endgame principles',
      'King activity',
      'Pawn play'
    ],
    commonMistakes: [
      'Passive play',
      'Missing tactics'
    ],
    difficulty: 'medium',
    icon: '❓'
  }
};

interface MaterialCount {
  queens: number;
  rooks: number;
  bishops: number;
  knights: number;
  pawns: number;
  lightBishop: boolean;
  darkBishop: boolean;
}

function countMaterial(fen: string): { white: MaterialCount; black: MaterialCount } {
  const chess = new Chess(fen);
  const board = chess.board();
  
  const white: MaterialCount = { queens: 0, rooks: 0, bishops: 0, knights: 0, pawns: 0, lightBishop: false, darkBishop: false };
  const black: MaterialCount = { queens: 0, rooks: 0, bishops: 0, knights: 0, pawns: 0, lightBishop: false, darkBishop: false };

  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = board[rank][file];
      if (!piece) continue;
      
      const count = piece.color === 'w' ? white : black;
      const isLightSquare = (rank + file) % 2 === 1;
      
      switch (piece.type) {
        case 'q': count.queens++; break;
        case 'r': count.rooks++; break;
        case 'b': 
          count.bishops++;
          if (isLightSquare) count.lightBishop = true;
          else count.darkBishop = true;
          break;
        case 'n': count.knights++; break;
        case 'p': count.pawns++; break;
      }
    }
  }

  return { white, black };
}

function getTotalPieces(m: MaterialCount): number {
  return m.queens + m.rooks + m.bishops + m.knights;
}

function isEndgame(white: MaterialCount, black: MaterialCount): boolean {
  const totalPieces = getTotalPieces(white) + getTotalPieces(black);
  const totalQueens = white.queens + black.queens;
  
  // Endgame if: no queens and few pieces, OR one queen max and minimal other pieces
  if (totalQueens === 0 && totalPieces <= 6) return true;
  if (totalQueens <= 1 && totalPieces <= 4) return true;
  if (totalPieces <= 4) return true;
  
  return false;
}

export function detectEndgameType(fen: string): EndgameType | null {
  try {
    const { white, black } = countMaterial(fen);
    
    if (!isEndgame(white, black)) {
      return null; // Not an endgame yet
    }

    const wPieces = getTotalPieces(white);
    const bPieces = getTotalPieces(black);
    const totalPieces = wPieces + bPieces;
    const totalPawns = white.pawns + black.pawns;

    // Tablebase positions (6 or fewer total pieces including kings)
    if (totalPieces + totalPawns + 2 <= 6) {
      return 'tablebase';
    }

    // Pure king and pawn endings
    if (totalPieces === 0 && totalPawns > 0) {
      return totalPawns <= 2 ? 'king_pawn' : 'pawn_race';
    }

    // Queen endgames
    if (white.queens + black.queens > 0 && white.rooks + black.rooks === 0) {
      if (white.bishops + black.bishops + white.knights + black.knights === 0) {
        return 'queen_endgame';
      }
      if (white.rooks + black.rooks > 0) {
        return 'queen_vs_rook';
      }
    }

    // Rook endgames
    if (white.rooks > 0 || black.rooks > 0) {
      const totalRooks = white.rooks + black.rooks;
      const totalMinors = white.bishops + black.bishops + white.knights + black.knights;
      
      if (totalMinors === 0 && white.queens + black.queens === 0) {
        if (totalRooks >= 2 && white.rooks > 0 && black.rooks > 0) {
          return totalRooks >= 4 ? 'two_rooks' : 'rook_endgame';
        }
        if (totalRooks === 1) {
          return totalPawns > 0 ? 'rook_vs_pawns' : 'rook_endgame';
        }
        return 'rook_endgame';
      }
      
      if (totalMinors > 0 && totalRooks === 1) {
        return 'rook_vs_minor';
      }
    }

    // Bishop endgames
    if (white.bishops > 0 || black.bishops > 0) {
      if (white.knights + black.knights === 0 && white.rooks + black.rooks === 0 && white.queens + black.queens === 0) {
        // Check for opposite colored bishops
        if (white.bishops === 1 && black.bishops === 1) {
          const whiteLightBishop = white.lightBishop;
          const blackLightBishop = black.lightBishop;
          if (whiteLightBishop !== blackLightBishop) {
            return 'opposite_bishops';
          }
        }
        return 'bishop_endgame';
      }
    }

    // Knight endgames
    if (white.knights > 0 || black.knights > 0) {
      if (white.bishops + black.bishops === 0 && white.rooks + black.rooks === 0 && white.queens + black.queens === 0) {
        return 'knight_endgame';
      }
    }

    // Bishop vs Knight
    if ((white.bishops > 0 && black.knights > 0 && white.knights === 0 && black.bishops === 0) ||
        (black.bishops > 0 && white.knights > 0 && black.knights === 0 && white.bishops === 0)) {
      if (white.rooks + black.rooks === 0 && white.queens + black.queens === 0) {
        return 'bishop_vs_knight';
      }
    }

    // Minor piece endings
    const totalMinors = white.bishops + black.bishops + white.knights + black.knights;
    if (totalMinors > 0 && white.rooks + black.rooks === 0 && white.queens + black.queens === 0) {
      return 'minor_piece';
    }

    // Complex endgames
    if (totalPieces > 0) {
      return 'complex';
    }

    return 'unknown';
  } catch (e) {
    console.error('Error detecting endgame:', e);
    return null;
  }
}

// Total material difference (white - black), pawns included, from a FEN.
const PIECE_VALUES: Record<string, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 };
export function materialDiff(fen: string): number {
  let diff = 0;
  const board = fen.split(' ')[0];
  for (const ch of board) {
    const lower = ch.toLowerCase();
    const val = PIECE_VALUES[lower];
    if (!val) continue;
    diff += ch === ch.toUpperCase() ? val : -val;
  }
  return diff;
}

// Analyze a game to find if/when it reaches an endgame.
//
// In addition to the first endgame position, we scan the whole endgame phase
// and report the largest material edge each side held. This lets the caller
// measure conversion correctly: a player who was clearly ahead in material at
// some point during the ending either converted the win or didn't. (The old
// code only checked material at the single moment the endgame began, where the
// material is usually still level, so it almost always reported 0% conversion.)
export function analyzeGameEndgame(pgn: string): {
  reachedEndgame: boolean;
  endgameType: EndgameType | null;
  endgameFen: string | null;
  moveNumber: number | null;
  maxWhiteAdvantage: number; // best white material edge during the endgame
  maxBlackAdvantage: number; // best black material edge during the endgame
} {
  const empty = {
    reachedEndgame: false,
    endgameType: null as EndgameType | null,
    endgameFen: null as string | null,
    moveNumber: null as number | null,
    maxWhiteAdvantage: 0,
    maxBlackAdvantage: 0,
  };

  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });

    chess.reset();

    let firstType: EndgameType | null = null;
    let firstFen: string | null = null;
    let firstMoveNumber: number | null = null;
    let maxWhiteAdvantage = 0;
    let maxBlackAdvantage = 0;

    for (let i = 0; i < history.length; i++) {
      chess.move(history[i].san);
      const fen = chess.fen();
      const endgameType = detectEndgameType(fen);

      if (endgameType) {
        if (!firstType) {
          firstType = endgameType;
          firstFen = fen;
          firstMoveNumber = Math.floor(i / 2) + 1;
        }
        // Track the largest edge either side held across the endgame phase.
        const diff = materialDiff(fen);
        if (diff > maxWhiteAdvantage) maxWhiteAdvantage = diff;
        if (-diff > maxBlackAdvantage) maxBlackAdvantage = -diff;
      }
    }

    if (!firstType) return empty;

    return {
      reachedEndgame: true,
      endgameType: firstType,
      endgameFen: firstFen,
      moveNumber: firstMoveNumber,
      maxWhiteAdvantage,
      maxBlackAdvantage,
    };
  } catch (e) {
    console.error('Error analyzing game endgame:', e);
    return empty;
  }
}
