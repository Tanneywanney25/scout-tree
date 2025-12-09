import { Chess } from 'chess.js';

export type PawnStructureType = 
  | 'isolated_queen_pawn'   // IQP
  | 'carlsbad'              // Minority attack structure
  | 'hanging_pawns'         // c4+d4 or c5+d5 without support
  | 'hedgehog'              // a6, b6, d6, e6, g6
  | 'french_chain'          // e5-d4-c3 or e4-d5-c6
  | 'stonewall'             // c3-d4-e3-f4 or c6-d5-e6-f5
  | 'caro_structure'        // c6-d5-e6 defense
  | 'sicilian_maroczy'      // c4+e4 bind
  | 'kings_indian'          // d6-e5-f7-g6
  | 'doubled_pawns'         // Same file doubled
  | 'passed_pawn'           // Passed pawn present
  | 'backward_pawn'         // Pawn that can't advance safely
  | 'pawn_chain'            // 3+ connected diagonal pawns
  | 'symmetrical'           // Mirrored pawn structure
  | 'open_center'           // No pawns on e/d files
  | 'closed_center'         // Locked pawns on e/d files
  | 'unknown';

export interface PawnStructure {
  type: PawnStructureType;
  label: string;
  description: string;
  strategicPlans: string[];
  commonMistakes: string[];
  icon: string;
}

export interface StructureDetection {
  structure: PawnStructure;
  confidence: number; // 0-1
  forWhite: boolean;
}

// Comprehensive structure definitions
export const PAWN_STRUCTURES: Record<PawnStructureType, PawnStructure> = {
  isolated_queen_pawn: {
    type: 'isolated_queen_pawn',
    label: 'Isolated Queen Pawn (IQP)',
    description: 'A d-pawn without neighboring pawns on c/e files',
    strategicPlans: [
      'Control the d5/d4 square in front of the IQP',
      'Exchange pieces to reach a winning endgame',
      'Blockade the pawn with a knight',
      'Attack the isolated pawn with heavy pieces'
    ],
    commonMistakes: [
      'Trading pieces too early (giving IQP side activity)',
      'Allowing the d5 advance to free the position',
      'Neglecting piece activity for pure pawn play'
    ],
    icon: '♙'
  },
  carlsbad: {
    type: 'carlsbad',
    label: 'Carlsbad Structure',
    description: 'Pawns on c3-d4-e3 vs c6-d5-e6 (or reversed)',
    strategicPlans: [
      'Minority attack: b4-b5 to create weaknesses',
      'Kingside attack against castled king',
      'Control the c-file after exchanges',
      'Target the backward c-pawn after b5xc6'
    ],
    commonMistakes: [
      'Rushing the minority attack without preparation',
      'Ignoring counterplay on the kingside',
      'Trading the light-squared bishop (key defender)'
    ],
    icon: '⚔️'
  },
  hanging_pawns: {
    type: 'hanging_pawns',
    label: 'Hanging Pawns',
    description: 'Pawns on c4+d4 (or c5+d5) without pawn support',
    strategicPlans: [
      'Pressure both pawns simultaneously',
      'Force one pawn to advance, creating an isolated pawn',
      'Control squares in front of the pawns',
      'Use the holes created (c5/d5 or c4/d4)'
    ],
    commonMistakes: [
      'Attacking only one pawn (allows advance)',
      'Allowing active piece play for the hanging pawn side',
      'Exchanging too many pieces (reduces pressure)'
    ],
    icon: '⚠️'
  },
  hedgehog: {
    type: 'hedgehog',
    label: 'Hedgehog',
    description: 'Compact structure with pawns on a6, b6, d6, e6',
    strategicPlans: [
      'Maintain space advantage',
      'Prevent ...b5 and ...d5 breaks',
      'Control central squares',
      'Slowly improve piece positions'
    ],
    commonMistakes: [
      'Overextending and allowing counterattack',
      'Ignoring the potential ...b5 or ...d5 break',
      'Trading pieces unnecessarily'
    ],
    icon: '🦔'
  },
  french_chain: {
    type: 'french_chain',
    label: 'French Pawn Chain',
    description: 'Diagonal chain like e5-d4-c3 or d5-e4',
    strategicPlans: [
      'Attack the base of the chain',
      'Undermine with ...c5 or f6',
      'Create a strong knight outpost',
      'Play on the side where you have space'
    ],
    commonMistakes: [
      'Attacking the head of the chain (waste of time)',
      'Blocking the position further',
      'Forgetting kingside counterplay'
    ],
    icon: '⛓️'
  },
  stonewall: {
    type: 'stonewall',
    label: 'Stonewall',
    description: 'Pawns on c3-d4-e3-f4 or c6-d5-e6-f5',
    strategicPlans: [
      'Target the weak e5/e4 square',
      'Trade the bad bishop (blocked by pawns)',
      'Use the strong outpost on e5/e4',
      'Attack down the e-file'
    ],
    commonMistakes: [
      'Playing passively',
      'Not exploiting the weak bishop',
      'Allowing piece activity on the kingside'
    ],
    icon: '🏰'
  },
  caro_structure: {
    type: 'caro_structure',
    label: 'Caro Structure',
    description: 'Solid c6-d5-e6 pawn triangle',
    strategicPlans: [
      'Target the backward e6 pawn',
      'Control the e5 square',
      'Minority attack on queenside',
      'Open the h-file for attack'
    ],
    commonMistakes: [
      'Underestimating Black\'s solid position',
      'Allowing ...c5 break to equalize',
      'Trading too many pieces'
    ],
    icon: '🛡️'
  },
  sicilian_maroczy: {
    type: 'sicilian_maroczy',
    label: 'Maroczy Bind',
    description: 'Pawns on c4+e4 controlling d5',
    strategicPlans: [
      'Maintain the bind on d5',
      'Expand on the kingside',
      'Prevent ...b5 and ...d5 breaks',
      'Use the c4 pawn as a lever with c5'
    ],
    commonMistakes: [
      'Allowing ...b5 to break the bind',
      'Overextending on the queenside',
      'Neglecting piece development'
    ],
    icon: '🔒'
  },
  kings_indian: {
    type: 'kings_indian',
    label: "King's Indian Structure",
    description: 'Fianchetto with d6-e5-f7-g6',
    strategicPlans: [
      'Play on the queenside with c4-c5',
      'Control the d5 square',
      'Prevent ...f5-f4 pawn storm',
      'Exchange the fianchettoed bishop'
    ],
    commonMistakes: [
      'Ignoring the f5-f4 kingside attack',
      'Closing the position prematurely',
      'Not using the extra space on the queenside'
    ],
    icon: '👑'
  },
  doubled_pawns: {
    type: 'doubled_pawns',
    label: 'Doubled Pawns',
    description: 'Two pawns on the same file',
    strategicPlans: [
      'Target the doubled pawns in the endgame',
      'Create a passed pawn on another file',
      'Exchange pieces to simplify',
      'Control the file in front of doubled pawns'
    ],
    commonMistakes: [
      'Overestimating the weakness in middlegame',
      'Ignoring the extra open file compensation',
      'Rushing exchanges before preparation'
    ],
    icon: '♟️♟️'
  },
  passed_pawn: {
    type: 'passed_pawn',
    label: 'Passed Pawn',
    description: 'A pawn with no enemy pawns blocking its path',
    strategicPlans: [
      'Blockade the passed pawn with a piece',
      'Attack the passed pawn with pieces',
      'Create your own passed pawn',
      'Tie down enemy pieces to defense'
    ],
    commonMistakes: [
      'Ignoring a passed pawn until too late',
      'Not blockading with the right piece',
      'Allowing the pawn to advance too far'
    ],
    icon: '🏃'
  },
  backward_pawn: {
    type: 'backward_pawn',
    label: 'Backward Pawn',
    description: 'A pawn that cannot safely advance',
    strategicPlans: [
      'Pressure the backward pawn with pieces',
      'Control the square in front of it',
      'Use as a target for the endgame',
      'Prevent the pawn from advancing'
    ],
    commonMistakes: [
      'Focusing only on the pawn, not piece play',
      'Allowing the pawn to advance and trade',
      'Not coordinating pieces for the attack'
    ],
    icon: '⬅️'
  },
  pawn_chain: {
    type: 'pawn_chain',
    label: 'Pawn Chain',
    description: 'Three or more connected pawns diagonally',
    strategicPlans: [
      'Attack the base of the chain',
      'Undermine with pawn levers',
      'Play on the side where you have space',
      'Use knights to jump over the chain'
    ],
    commonMistakes: [
      'Attacking the head instead of the base',
      'Blocking the position further',
      'Ignoring piece play for pawn moves'
    ],
    icon: '⛓️'
  },
  symmetrical: {
    type: 'symmetrical',
    label: 'Symmetrical Structure',
    description: 'Mirrored pawn structure',
    strategicPlans: [
      'Create an imbalance with piece activity',
      'Target any small weakness',
      'Use superior piece placement',
      'Aim for a better minor piece'
    ],
    commonMistakes: [
      'Playing too passively',
      'Trading into a drawn endgame',
      'Not creating imbalances'
    ],
    icon: '⚖️'
  },
  open_center: {
    type: 'open_center',
    label: 'Open Center',
    description: 'No central pawns on e/d files',
    strategicPlans: [
      'Centralize pieces quickly',
      'Control open files with rooks',
      'Use tactical opportunities',
      'Castle early for king safety'
    ],
    commonMistakes: [
      'Neglecting development for pawn moves',
      'Leaving the king in the center',
      'Not fighting for open files'
    ],
    icon: '🎯'
  },
  closed_center: {
    type: 'closed_center',
    label: 'Closed Center',
    description: 'Locked pawns in the center',
    strategicPlans: [
      'Play on the flanks',
      'Maneuver knights to outposts',
      'Prepare pawn breaks carefully',
      'Use long-term strategic plans'
    ],
    commonMistakes: [
      'Opening the center prematurely',
      'Neglecting king safety',
      'Rushing attacks without preparation'
    ],
    icon: '🔐'
  },
  unknown: {
    type: 'unknown',
    label: 'Complex Structure',
    description: 'Mixed or unusual pawn formation',
    strategicPlans: [
      'Evaluate pawn weaknesses',
      'Look for piece activity',
      'Consider pawn breaks',
      'Focus on king safety'
    ],
    commonMistakes: [
      'Overcomplicating the position',
      'Missing tactical opportunities',
      'Ignoring basic principles'
    ],
    icon: '❓'
  }
};

// Extract pawn positions from FEN
function getPawnPositions(fen: string): { white: string[]; black: string[] } {
  const white: string[] = [];
  const black: string[] = [];
  
  try {
    const chess = new Chess(fen);
    const board = chess.board();
    
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file];
        if (piece && piece.type === 'p') {
          const square = String.fromCharCode(97 + file) + (8 - rank);
          if (piece.color === 'w') {
            white.push(square);
          } else {
            black.push(square);
          }
        }
      }
    }
  } catch (e) {
    console.error('Error parsing FEN:', e);
  }
  
  return { white, black };
}

// Check for isolated pawn
function hasIsolatedPawn(pawns: string[], file: string): boolean {
  const fileNum = file.charCodeAt(0);
  const adjacentFiles = [
    String.fromCharCode(fileNum - 1),
    String.fromCharCode(fileNum + 1)
  ].filter(f => f >= 'a' && f <= 'h');
  
  const hasNeighbor = pawns.some(p => adjacentFiles.includes(p[0]));
  return !hasNeighbor && pawns.some(p => p[0] === file);
}

// Check for doubled pawns
function hasDoubledPawns(pawns: string[]): string | null {
  const fileCount: Record<string, number> = {};
  for (const pawn of pawns) {
    const file = pawn[0];
    fileCount[file] = (fileCount[file] || 0) + 1;
    if (fileCount[file] >= 2) return file;
  }
  return null;
}

// Check for hanging pawns (c+d pawns without a/b/e support)
function hasHangingPawns(pawns: string[]): boolean {
  const hasCPawn = pawns.some(p => p[0] === 'c');
  const hasDPawn = pawns.some(p => p[0] === 'd');
  const hasBPawn = pawns.some(p => p[0] === 'b');
  const hasEPawn = pawns.some(p => p[0] === 'e');
  
  return hasCPawn && hasDPawn && !hasBPawn && !hasEPawn;
}

// Check for hedgehog structure
function isHedgehog(pawns: string[]): boolean {
  const files = pawns.map(p => p[0]);
  const ranks = pawns.map(p => parseInt(p[1]));
  
  // Hedgehog: pawns mostly on 6th rank (for Black) with a6, b6, d6, e6
  const sixthRankCount = ranks.filter(r => r === 6).length;
  return sixthRankCount >= 4 && files.includes('a') && files.includes('b');
}

// Check for Maroczy bind
function isMaroczyBind(whitePawns: string[], blackPawns: string[]): boolean {
  const hasC4 = whitePawns.includes('c4');
  const hasE4 = whitePawns.includes('e4');
  const noD5 = !blackPawns.includes('d5');
  
  return hasC4 && hasE4 && noD5;
}

// Check for French chain
function hasFrenchChain(whitePawns: string[], blackPawns: string[]): 'white' | 'black' | null {
  // White chain: e5-d4-c3
  if (whitePawns.includes('e5') && whitePawns.includes('d4')) return 'white';
  // Black chain: d5-e4
  if (blackPawns.includes('d5') && blackPawns.includes('e4')) return 'black';
  return null;
}

// Check for Stonewall
function isStonewall(pawns: string[], isWhite: boolean): boolean {
  if (isWhite) {
    return pawns.includes('d4') && pawns.includes('e3') && pawns.includes('f4');
  } else {
    return pawns.includes('d5') && pawns.includes('e6') && pawns.includes('f5');
  }
}

// Check for open/closed center
function getCenterStatus(whitePawns: string[], blackPawns: string[]): 'open' | 'closed' | 'semi' {
  const allPawns = [...whitePawns, ...blackPawns];
  const centralFiles = ['d', 'e'];
  const centralPawns = allPawns.filter(p => centralFiles.includes(p[0]));
  
  if (centralPawns.length === 0) return 'open';
  if (centralPawns.length >= 3) return 'closed';
  return 'semi';
}

// Main detection function
export function detectPawnStructure(fen: string): StructureDetection[] {
  const { white, black } = getPawnPositions(fen);
  const detections: StructureDetection[] = [];
  
  // Check for IQP (Isolated Queen Pawn)
  if (hasIsolatedPawn(white, 'd') && white.some(p => p[0] === 'd')) {
    detections.push({
      structure: PAWN_STRUCTURES.isolated_queen_pawn,
      confidence: 0.9,
      forWhite: true
    });
  }
  if (hasIsolatedPawn(black, 'd') && black.some(p => p[0] === 'd')) {
    detections.push({
      structure: PAWN_STRUCTURES.isolated_queen_pawn,
      confidence: 0.9,
      forWhite: false
    });
  }
  
  // Check for doubled pawns
  const whiteDoubled = hasDoubledPawns(white);
  if (whiteDoubled) {
    detections.push({
      structure: PAWN_STRUCTURES.doubled_pawns,
      confidence: 0.95,
      forWhite: true
    });
  }
  const blackDoubled = hasDoubledPawns(black);
  if (blackDoubled) {
    detections.push({
      structure: PAWN_STRUCTURES.doubled_pawns,
      confidence: 0.95,
      forWhite: false
    });
  }
  
  // Check for hanging pawns
  if (hasHangingPawns(white)) {
    detections.push({
      structure: PAWN_STRUCTURES.hanging_pawns,
      confidence: 0.85,
      forWhite: true
    });
  }
  if (hasHangingPawns(black)) {
    detections.push({
      structure: PAWN_STRUCTURES.hanging_pawns,
      confidence: 0.85,
      forWhite: false
    });
  }
  
  // Check for Maroczy bind
  if (isMaroczyBind(white, black)) {
    detections.push({
      structure: PAWN_STRUCTURES.sicilian_maroczy,
      confidence: 0.9,
      forWhite: true
    });
  }
  
  // Check for hedgehog
  if (isHedgehog(black)) {
    detections.push({
      structure: PAWN_STRUCTURES.hedgehog,
      confidence: 0.8,
      forWhite: false
    });
  }
  
  // Check for French chain
  const chainSide = hasFrenchChain(white, black);
  if (chainSide) {
    detections.push({
      structure: PAWN_STRUCTURES.french_chain,
      confidence: 0.85,
      forWhite: chainSide === 'white'
    });
  }
  
  // Check for Stonewall
  if (isStonewall(white, true)) {
    detections.push({
      structure: PAWN_STRUCTURES.stonewall,
      confidence: 0.9,
      forWhite: true
    });
  }
  if (isStonewall(black, false)) {
    detections.push({
      structure: PAWN_STRUCTURES.stonewall,
      confidence: 0.9,
      forWhite: false
    });
  }
  
  // Check center status
  const centerStatus = getCenterStatus(white, black);
  if (centerStatus === 'open') {
    detections.push({
      structure: PAWN_STRUCTURES.open_center,
      confidence: 0.95,
      forWhite: true // Neutral
    });
  } else if (centerStatus === 'closed') {
    detections.push({
      structure: PAWN_STRUCTURES.closed_center,
      confidence: 0.9,
      forWhite: true // Neutral
    });
  }
  
  // Check for symmetrical structure
  if (white.length === black.length) {
    const whiteFiles = white.map(p => p[0]).sort().join('');
    const blackFiles = black.map(p => p[0]).sort().join('');
    if (whiteFiles === blackFiles) {
      detections.push({
        structure: PAWN_STRUCTURES.symmetrical,
        confidence: 0.8,
        forWhite: true
      });
    }
  }
  
  // If no specific structure detected, mark as unknown/complex
  if (detections.length === 0) {
    detections.push({
      structure: PAWN_STRUCTURES.unknown,
      confidence: 0.5,
      forWhite: true
    });
  }
  
  return detections;
}

// Analyze a game and extract structure occurrences
export function analyzeGameStructures(pgn: string): { 
  structures: Map<PawnStructureType, number>;
  positions: Map<PawnStructureType, string[]>; // FENs for each structure
} {
  const structures = new Map<PawnStructureType, number>();
  const positions = new Map<PawnStructureType, string[]>();
  
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    const history = chess.history({ verbose: true });
    
    // Reset and replay to get FENs
    chess.reset();
    
    // Sample positions (every 5 moves to avoid over-counting)
    for (let i = 0; i < history.length; i++) {
      chess.move(history[i].san);
      
      if (i % 5 === 0 && i >= 10) { // After move 10, sample every 5 moves
        const fen = chess.fen();
        const detections = detectPawnStructure(fen);
        
        for (const detection of detections) {
          const type = detection.structure.type;
          structures.set(type, (structures.get(type) || 0) + 1);
          
          const fens = positions.get(type) || [];
          if (fens.length < 3) { // Keep max 3 example positions
            fens.push(fen);
            positions.set(type, fens);
          }
        }
      }
    }
  } catch (e) {
    console.error('Error analyzing game structures:', e);
  }
  
  return { structures, positions };
}
