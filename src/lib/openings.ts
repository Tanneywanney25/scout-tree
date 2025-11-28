// Popular chess opening names mapped to move sequences
interface Opening {
  name: string;
  moves: string[];
  eco?: string;
}

const openings: Opening[] = [
  // Sicilian Defense
  { name: "Sicilian Defense", moves: ["e4", "c5"], eco: "B20" },
  { name: "Sicilian, Najdorf", moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "a6"], eco: "B90" },
  { name: "Sicilian, Dragon", moves: ["e4", "c5", "Nf3", "d6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "g6"], eco: "B70" },
  { name: "Sicilian, Sveshnikov", moves: ["e4", "c5", "Nf3", "Nc6", "d4", "cxd4", "Nxd4", "Nf6", "Nc3", "e5"], eco: "B33" },
  
  // Italian Game
  { name: "Italian Game", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4"], eco: "C50" },
  { name: "Italian Game, Two Knights", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6"], eco: "C55" },
  { name: "Italian Game, Giuoco Piano", moves: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"], eco: "C53" },
  
  // Spanish (Ruy Lopez)
  { name: "Ruy Lopez", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5"], eco: "C60" },
  { name: "Ruy Lopez, Berlin Defense", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "Nf6"], eco: "C65" },
  { name: "Ruy Lopez, Morphy Defense", moves: ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"], eco: "C70" },
  
  // French Defense
  { name: "French Defense", moves: ["e4", "e6"], eco: "C00" },
  { name: "French Defense, Advance", moves: ["e4", "e6", "d4", "d5", "e5"], eco: "C02" },
  { name: "French Defense, Winawer", moves: ["e4", "e6", "d4", "d5", "Nc3", "Bb4"], eco: "C15" },
  
  // Caro-Kann
  { name: "Caro-Kann Defense", moves: ["e4", "c6"], eco: "B10" },
  { name: "Caro-Kann, Advance", moves: ["e4", "c6", "d4", "d5", "e5"], eco: "B12" },
  
  // Scandinavian
  { name: "Scandinavian Defense", moves: ["e4", "d5"], eco: "B01" },
  
  // Alekhine's Defense
  { name: "Alekhine's Defense", moves: ["e4", "Nf6"], eco: "B02" },
  
  // Pirc Defense
  { name: "Pirc Defense", moves: ["e4", "d6"], eco: "B07" },
  { name: "Pirc Defense, Classical", moves: ["e4", "d6", "d4", "Nf6", "Nc3", "g6"], eco: "B08" },
  
  // Queen's Gambit
  { name: "Queen's Gambit", moves: ["d4", "d5", "c4"], eco: "D06" },
  { name: "Queen's Gambit Declined", moves: ["d4", "d5", "c4", "e6"], eco: "D30" },
  { name: "Queen's Gambit Accepted", moves: ["d4", "d5", "c4", "dxc4"], eco: "D20" },
  { name: "Slav Defense", moves: ["d4", "d5", "c4", "c6"], eco: "D10" },
  
  // Indian Defenses
  { name: "King's Indian Defense", moves: ["d4", "Nf6", "c4", "g6"], eco: "E60" },
  { name: "Nimzo-Indian Defense", moves: ["d4", "Nf6", "c4", "e6", "Nc3", "Bb4"], eco: "E20" },
  { name: "Queen's Indian Defense", moves: ["d4", "Nf6", "c4", "e6", "Nf3", "b6"], eco: "E12" },
  { name: "Grünfeld Defense", moves: ["d4", "Nf6", "c4", "g6", "Nc3", "d5"], eco: "D80" },
  
  // English Opening
  { name: "English Opening", moves: ["c4"], eco: "A10" },
  { name: "English, Symmetrical", moves: ["c4", "c5"], eco: "A30" },
  
  // Réti Opening
  { name: "Réti Opening", moves: ["Nf3"], eco: "A04" },
  
  // London System
  { name: "London System", moves: ["d4", "Nf6", "Nf3", "d5", "Bf4"], eco: "D02" },
  { name: "London System", moves: ["d4", "d5", "Nf3", "Nf6", "Bf4"], eco: "D02" },
  
  // King's Gambit
  { name: "King's Gambit", moves: ["e4", "e5", "f4"], eco: "C30" },
  
  // Scotch Game
  { name: "Scotch Game", moves: ["e4", "e5", "Nf3", "Nc6", "d4"], eco: "C44" },
  
  // Vienna Game
  { name: "Vienna Game", moves: ["e4", "e5", "Nc3"], eco: "C25" },
  
  // Dutch Defense
  { name: "Dutch Defense", moves: ["d4", "f5"], eco: "A80" },
  
  // Benoni Defense
  { name: "Benoni Defense", moves: ["d4", "Nf6", "c4", "c5"], eco: "A56" },
  { name: "Modern Benoni", moves: ["d4", "Nf6", "c4", "c5", "d5", "e6"], eco: "A60" },
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
