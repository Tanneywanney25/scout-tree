// Popular chess opening names mapped to move sequences
interface Opening {
  name: string;
  moves: string[];
  eco?: string;
}

const openings: Opening[] = [
  // King's Pawn Openings - e4
  { name: "King's Pawn Opening", moves: ["e4"], eco: "B00" },
  { name: "King's Pawn Game", moves: ["e4", "e5"], eco: "C20" },
  
  // Sicilian Defense
  { name: "Sicilian Defense", moves: ["e4", "c5"], eco: "B20" },
  { name: "Sicilian Defense, Open", moves: ["e4", "c5", "Nf3"], eco: "B20" },
  { name: "Sicilian, Closed", moves: ["e4", "c5", "Nc3"], eco: "B23" },
  { name: "Sicilian, Alapin", moves: ["e4", "c5", "c3"], eco: "B22" },
  { name: "Sicilian, Accelerated Dragon", moves: ["e4", "c5", "Nf3", "Nc6", "d4", "cxd4", "Nxd4", "g6"], eco: "B34" },
  { name: "Sicilian, Najdorf", moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"], eco: "B90" },
  { name: "Sicilian, Dragon", moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "g6"], eco: "B70" },
  { name: "Sicilian, Classical", moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "Nc6"], eco: "B56" },
  { name: "Sicilian, Sveshnikov", moves: ["e4", "c5", "Nf3", "Nc6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "e5"], eco: "B33" },
  { name: "Sicilian, Taimanov", moves: ["e4", "c5", "Nf3", "e6", "d4", "cxd4", "Nxd4", "Nc6"], eco: "B44" },
  { name: "Sicilian, Kan", moves: ["e4", "c5", "Nf3", "e6", "d4", "cxd4", "Nxd4", "a6"], eco: "B42" },
  { name: "Sicilian, Scheveningen", moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "e6"], eco: "B80" },
  
  // Italian Game
  { name: "Italian Game", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"], eco: "C50" },
  { name: "Italian Game, Two Knights", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"], eco: "C55" },
  { name: "Italian Game, Giuoco Piano", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], eco: "C53" },
  { name: "Italian Game, Evans Gambit", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4"], eco: "C51" },
  { name: "Italian Game, Fried Liver", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6", "Ng5", "d5", "exd5", "Nxd5", "Nxf7"], eco: "C57" },
  
  // Spanish (Ruy Lopez)
  { name: "Ruy Lopez", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"], eco: "C60" },
  { name: "Ruy Lopez, Berlin Defense", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "Nf6"], eco: "C65" },
  { name: "Ruy Lopez, Morphy Defense", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"], eco: "C70" },
  { name: "Ruy Lopez, Closed", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7"], eco: "C84" },
  { name: "Ruy Lopez, Marshall Attack", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O", "Be7", "Re1", "b5", "Bb3", "O-O", "c3", "d5"], eco: "C89" },
  { name: "Ruy Lopez, Exchange", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6"], eco: "C68" },
  
  // French Defense
  { name: "French Defense", moves: ["e4", "e6"], eco: "C00" },
  { name: "French Defense, Advance", moves: ["e4", "e6", "d4", "d5", "e5"], eco: "C02" },
  { name: "French Defense, Winawer", moves: ["e4", "e6", "d4", "d5", "Nc3", "Bb4"], eco: "C15" },
  { name: "French Defense, Classical", moves: ["e4", "e6", "d4", "d5", "Nc3", "Nf6"], eco: "C11" },
  { name: "French Defense, Tarrasch", moves: ["e4", "e6", "d4", "d5", "Nd2"], eco: "C03" },
  { name: "French Defense, Exchange", moves: ["e4", "e6", "d4", "d5", "exd5"], eco: "C01" },
  
  // Caro-Kann
  { name: "Caro-Kann Defense", moves: ["e4", "c6"], eco: "B10" },
  { name: "Caro-Kann, Advance", moves: ["e4", "c6", "d4", "d5", "e5"], eco: "B12" },
  { name: "Caro-Kann, Classical", moves: ["e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Bf5"], eco: "B18" },
  { name: "Caro-Kann, Exchange", moves: ["e4", "c6", "d4", "d5", "exd5"], eco: "B13" },
  { name: "Caro-Kann, Panov Attack", moves: ["e4", "c6", "d4", "d5", "exd5", "cxd5", "c4"], eco: "B14" },
  
  // Scandinavian
  { name: "Scandinavian Defense", moves: ["e4", "d5"], eco: "B01" },
  { name: "Scandinavian, Main Line", moves: ["e4", "d5", "exd5", "Qxd5"], eco: "B01" },
  
  // Alekhine's Defense
  { name: "Alekhine's Defense", moves: ["e4", "Nf6"], eco: "B02" },
  { name: "Alekhine's Defense, Four Pawns", moves: ["e4", "Nf6", "e5", "Nd5", "d4", "d6", "c4", "Nb6", "f4"], eco: "B03" },
  
  // Pirc Defense
  { name: "Pirc Defense", moves: ["e4", "d6"], eco: "B07" },
  { name: "Pirc Defense, Classical", moves: ["e4", "d6", "d4", "Nf6", "Nc3", "g6"], eco: "B08" },
  { name: "Pirc Defense, Austrian Attack", moves: ["e4", "d6", "d4", "Nf6", "Nc3", "g6", "f4"], eco: "B09" },
  
  // Philidor Defense
  { name: "Philidor Defense", moves: ["e4", "e5", "Nf3", "d6"], eco: "C41" },
  
  // Petrov Defense
  { name: "Petrov Defense", moves: ["e4", "e5", "Nf3", "Nf6"], eco: "C42" },
  { name: "Petrov Defense, Classical", moves: ["e4", "e5", "Nf3", "Nf6", "Nxe5", "d6", "Nf3", "Nxe4"], eco: "C42" },
  
  // King's Gambit
  { name: "King's Gambit", moves: ["e4", "e5", "f4"], eco: "C30" },
  { name: "King's Gambit Accepted", moves: ["e4", "e5", "f4", "exf4"], eco: "C33" },
  { name: "King's Gambit Declined", moves: ["e4", "e5", "f4", "Bc5"], eco: "C30" },
  
  // Scotch Game
  { name: "Scotch Game", moves: ["e4", "e5", "Nf3", "Nc6", "d4"], eco: "C44" },
  { name: "Scotch Game, Classical", moves: ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Nxd4", "Bc5"], eco: "C45" },
  
  // Vienna Game
  { name: "Vienna Game", moves: ["e4", "e5", "Nc3"], eco: "C25" },
  { name: "Vienna Gambit", moves: ["e4", "e5", "Nc3", "Nf6", "f4"], eco: "C29" },
  
  // Four Knights Game
  { name: "Four Knights Game", moves: ["e4", "e5", "Nf3", "Nc6", "Nc3", "Nf6"], eco: "C47" },
  
  // Queen's Pawn Openings - d4
  { name: "Queen's Pawn Opening", moves: ["d4"], eco: "A40" },
  { name: "Queen's Pawn Game", moves: ["d4", "d5"], eco: "D00" },
  
  // Queen's Gambit
  { name: "Queen's Gambit", moves: ["d4", "d5", "c4"], eco: "D06" },
  { name: "Queen's Gambit Declined", moves: ["d4", "d5", "c4", "e6"], eco: "D30" },
  { name: "Queen's Gambit Accepted", moves: ["d4", "d5", "c4", "dxc4"], eco: "D20" },
  { name: "Slav Defense", moves: ["d4", "d5", "c4", "c6"], eco: "D10" },
  { name: "Semi-Slav Defense", moves: ["d4", "d5", "c4", "c6", "Nf3", "Nf6", "Nc3", "e6"], eco: "D43" },
  { name: "Tarrasch Defense", moves: ["d4", "d5", "c4", "e6", "Nc3", "c5"], eco: "D32" },
  { name: "Chigorin Defense", moves: ["d4", "d5", "c4", "Nc6"], eco: "D07" },
  
  // Indian Defenses
  { name: "King's Indian Defense", moves: ["d4", "Nf6", "c4", "g6"], eco: "E60" },
  { name: "King's Indian, Classical", moves: ["d4", "Nf6", "c4", "g6", "Nc3", "Bg7", "e4", "d6", "Nf3", "O-O", "Be2", "e5"], eco: "E90" },
  { name: "Nimzo-Indian Defense", moves: ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"], eco: "E20" },
  { name: "Queen's Indian Defense", moves: ["d4", "Nf6", "c4", "e6", "Nf3", "b6"], eco: "E12" },
  { name: "Bogo-Indian Defense", moves: ["d4", "Nf6", "c4", "e6", "Nf3", "Bb4+"], eco: "E11" },
  { name: "Catalan Opening", moves: ["d4", "Nf6", "c4", "e6", "g3"], eco: "E00" },
  { name: "Grünfeld Defense", moves: ["d4", "Nf6", "c4", "g6", "Nc3", "d5"], eco: "D80" },
  { name: "Budapest Gambit", moves: ["d4", "Nf6", "c4", "e5"], eco: "A51" },
  
  // Benoni Defenses
  { name: "Benoni Defense", moves: ["d4", "Nf6", "c4", "c5"], eco: "A56" },
  { name: "Modern Benoni", moves: ["d4", "Nf6", "c4", "c5", "d5", "e6"], eco: "A60" },
  { name: "Czech Benoni", moves: ["d4", "Nf6", "c4", "c5", "d5", "e5"], eco: "A56" },
  
  // Dutch Defense
  { name: "Dutch Defense", moves: ["d4", "f5"], eco: "A80" },
  { name: "Dutch Defense, Stonewall", moves: ["d4", "f5", "g3", "Nf6", "Bg2", "e6", "Nf3", "d5", "O-O", "Bd6"], eco: "A90" },
  { name: "Dutch Defense, Leningrad", moves: ["d4", "f5", "g3", "Nf6", "Bg2", "g6"], eco: "A87" },
  
  // London System
  { name: "London System", moves: ["d4", "d5", "Bf4"], eco: "D02" },
  { name: "London System", moves: ["d4", "Nf6", "Bf4"], eco: "A45" },
  { name: "London System", moves: ["d4", "d5", "Nf3", "Nf6", "Bf4"], eco: "D02" },
  
  // Torre Attack
  { name: "Torre Attack", moves: ["d4", "Nf6", "Nf3", "e6", "Bg5"], eco: "A46" },
  { name: "Torre Attack", moves: ["d4", "Nf6", "Nf3", "g6", "Bg5"], eco: "A48" },
  
  // Trompowsky Attack
  { name: "Trompowsky Attack", moves: ["d4", "Nf6", "Bg5"], eco: "A45" },
  
  // English Opening
  { name: "English Opening", moves: ["c4"], eco: "A10" },
  { name: "English, Symmetrical", moves: ["c4", "c5"], eco: "A30" },
  { name: "English, Four Knights", moves: ["c4", "e5", "Nc3", "Nf6", "Nf3", "Nc6"], eco: "A28" },
  { name: "English, Reversed Sicilian", moves: ["c4", "e5"], eco: "A20" },
  
  // Réti Opening
  { name: "Réti Opening", moves: ["Nf3"], eco: "A04" },
  { name: "Réti Opening, King's Indian", moves: ["Nf3", "Nf6", "g3", "g6"], eco: "A05" },
  
  // Bird's Opening
  { name: "Bird's Opening", moves: ["f4"], eco: "A02" },
  { name: "Bird's Opening, From Gambit", moves: ["f4", "e5"], eco: "A02" },
  
  // Uncommon First Moves
  { name: "Sokolsky Opening", moves: ["b4"], eco: "A00" },
  { name: "Grob Opening", moves: ["g4"], eco: "A00" },
  { name: "Polish Opening", moves: ["b4"], eco: "A00" },
];

/**
 * Match a sequence of moves (in SAN notation) to a known opening name
 * Returns the most specific (longest matching) opening found
 */
export function getOpeningName(movePath: string[]): string | null {
  if (!movePath || movePath.length === 0) return null;
  
  let bestMatch: Opening | null = null;
  let bestMatchLength = 0;
  
  for (const opening of openings) {
    // Check if the move path matches this opening's sequence
    if (opening.moves.length <= movePath.length && opening.moves.length > bestMatchLength) {
      const matches = opening.moves.every((move, index) => move === movePath[index]);
      if (matches) {
        bestMatch = opening;
        bestMatchLength = opening.moves.length;
      }
    }
  }
  
  return bestMatch ? bestMatch.name : null;
}

/**
 * Get opening name with ECO code
 */
export function getOpeningWithEco(movePath: string[]): { name: string; eco: string } | null {
  if (!movePath || movePath.length === 0) return null;
  
  let bestMatch: Opening | null = null;
  let bestMatchLength = 0;
  
  for (const opening of openings) {
    if (opening.moves.length <= movePath.length && opening.moves.length > bestMatchLength) {
      const matches = opening.moves.every((move, index) => move === movePath[index]);
      if (matches) {
        bestMatch = opening;
        bestMatchLength = opening.moves.length;
      }
    }
  }
  
  return bestMatch ? { name: bestMatch.name, eco: bestMatch.eco || "" } : null;
}
