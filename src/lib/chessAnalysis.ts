import { Chess } from "chess.js";
import { GameData } from "./chessApi";

export interface TranspositionPath {
  path: string[];  // Move sequence that led to this position
  count: number;   // How many games reached via this path
}

export interface OpeningNode {
  move: string;
  san: string;
  count: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  children: Map<string, OpeningNode>;
  fen?: string;  // Position FEN for this node (board + turn only)
  transpositions?: TranspositionPath[];  // Alternative paths that reach this position
}

export interface AnalysisResult {
  totalGames: number;
  openingTree: OpeningNode;
  weakestLines: Array<{
    line: string;
    winRate: number;
    count: number;
  }>;
  strongestLines: Array<{
    line: string;
    winRate: number;
    count: number;
  }>;
  playerColor: "white" | "black" | "both";
}

export interface SerializedAnalysisResult {
  totalGames: number;
  openingTree: any; // Serialized tree structure
  weakestLines: Array<{
    line: string;
    winRate: number;
    count: number;
  }>;
  strongestLines: Array<{
    line: string;
    winRate: number;
    count: number;
  }>;
  playerColor: "white" | "black" | "both";
}

export function createEmptyAnalysis(playerColor: "white" | "black" | "both" = "both"): AnalysisResult {
  const rootNode: OpeningNode = {
    move: "",
    san: "Start",
    count: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    winRate: 0,
    children: new Map(),
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w',
    transpositions: [],
  };

  return {
    totalGames: 0,
    openingTree: rootNode,
    weakestLines: [],
    strongestLines: [],
    playerColor,
  };
}

export async function analyzeGamesIncremental(
  existingAnalysis: AnalysisResult,
  newGames: GameData[],
  targetUsername: string,
  onProgress?: (count: number) => void
): Promise<AnalysisResult> {
  const rootNode = existingAnalysis.openingTree;
  let totalGames = existingAnalysis.totalGames;
  const playerColor = existingAnalysis.playerColor;

  console.log(`[ANALYSIS] Starting incremental analysis for ${targetUsername}, playerColor: ${playerColor}, newGames: ${newGames.length}`);

  // CRITICAL FIX: Move fenToNode OUTSIDE game loop for proper transposition detection across ALL games
  const globalFenToNode = new Map<string, OpeningNode>();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w';
  globalFenToNode.set(startFen, rootNode);

  for (let i = 0; i < newGames.length; i++) {
    const game = newGames[i];
    const chess = new Chess();
    
    // Yield to browser every 2 games to prevent freezing
    if (i > 0 && i % 2 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    try {
      chess.loadPgn(game.pgn);
    } catch (e) {
      continue;
    }

    const isWhite = game.white.toLowerCase() === targetUsername.toLowerCase();
    const isBlack = game.black.toLowerCase() === targetUsername.toLowerCase();

    // Only include games where scouted player played the selected color
    if (playerColor === "white" && !isWhite) continue;
    if (playerColor === "black" && !isBlack) continue;
    if (!isWhite && !isBlack) {
      console.log(`[ANALYSIS] Skipping game - player not found. White: ${game.white}, Black: ${game.black}`);
      continue;
    }

    totalGames++;
    console.log(`[ANALYSIS] Processing game #${totalGames}: ${game.white} vs ${game.black}, target is ${isWhite ? 'white' : 'black'}`);

    let result: "win" | "draw" | "loss";
    if (!game.winner) {
      result = "draw";
    } else if (
      (game.winner === "white" && isWhite) ||
      (game.winner === "black" && isBlack)
    ) {
      result = "win";
    } else {
      result = "loss";
    }

    const history = chess.history({ verbose: true });
    let currentNode = rootNode;
    // Limit to opening phase (30 plies = 15 full moves) for performance and relevance
    const maxPlies = Math.min(history.length, 30);

    console.log(`[ANALYSIS] Game ${totalGames} has ${history.length} total moves, analyzing first ${maxPlies} plies`);

    // Create tracking chess instance that moves forward incrementally (O(n) instead of O(n²))
    const trackingChess = new Chess();
    
    // Track move sequence for transposition detection
    const selectedPath: string[] = [];

    // Add ALL moves to create a continuous tree structure
    // Statistics are tracked from target player's perspective for the entire game
    for (let i = 0; i < maxPlies; i++) {
      const move = history[i];
      
      // Make the move on tracking instance (O(1) per move instead of O(n²))
      try {
        trackingChess.move(move);
        selectedPath.push(move.san);
      } catch (e) {
        console.warn(`[ANALYSIS] Failed to process move ${i}:`, move.san, e);
        break; // Skip rest of this game if move fails
      }
      const positionFen = trackingChess.fen().split(' ').slice(0, 2).join(' '); // Board + turn only
      
      const moveKey = `${move.from}${move.to}${move.promotion || ""}`;
      
      // Debug logging (first 3 games)
      if (totalGames <= 3) {
        console.log(`  Move ${i}: ${move.san} (${moveKey})`);
      }

      // Build the current move path for transposition tracking
      const currentMoveSequence = selectedPath.slice(0, i + 1).map((_, idx) => history[idx].san);
      currentMoveSequence[i] = move.san;
      
      // Check if we've seen this position before (transposition) - use GLOBAL map
      let targetNode = globalFenToNode.get(positionFen);
      const isTransposition = !!targetNode;
      
      if (!targetNode) {
        // New position - add move to tree
        if (!currentNode.children.has(moveKey)) {
          currentNode.children.set(moveKey, {
            move: moveKey,
            san: move.san,
            count: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            winRate: 0,
            children: new Map(),
            fen: positionFen,
            transpositions: [],
          });
        }
        targetNode = currentNode.children.get(moveKey)!;
        targetNode.fen = positionFen;
        globalFenToNode.set(positionFen, targetNode);
      }

      // Track transposition paths
      if (!targetNode.transpositions) {
        targetNode.transpositions = [];
      }
      
      // Get the full path to this position
      const fullPath = selectedPath.slice(0, i + 1);
      fullPath[i] = move.san;
      const pathStr = fullPath.join(' ');
      
      const existingPath = targetNode.transpositions.find(t => t.path.join(' ') === pathStr);
      if (existingPath) {
        existingPath.count++;
      } else {
        targetNode.transpositions.push({
          path: [...fullPath],
          count: 1
        });
      }

      currentNode = targetNode;
      currentNode.count++;

      // Statistics are tracked from target player's perspective
      if (result === "win") currentNode.wins++;
      else if (result === "draw") currentNode.draws++;
      else currentNode.losses++;

      currentNode.winRate = currentNode.count > 0 
        ? (currentNode.wins + currentNode.draws * 0.5) / currentNode.count 
        : 0;
    }
    
    console.log(`[ANALYSIS] Game ${totalGames} added all ${maxPlies} moves to tree`);
    
    // Optional: Call progress callback after each game (not used anymore to avoid conflicts)
    if (onProgress) {
      onProgress(totalGames);
    }
  }

  console.log(`[ANALYSIS] Complete. Total games analyzed: ${totalGames}`);
  rootNode.count = totalGames;

  const allLines = extractAllLines(rootNode, "", []);
  const sortedByWinRate = allLines
    .filter(line => line.count >= 3)
    .sort((a, b) => a.winRate - b.winRate);

  const weakestLines = sortedByWinRate.slice(0, 5);
  const strongestLines = sortedByWinRate.slice(-5).reverse();

  return {
    totalGames,
    openingTree: rootNode,
    weakestLines,
    strongestLines,
    playerColor,
  };
}

export function analyzeGames(
  games: GameData[],
  targetUsername: string,
  playerColor: "white" | "black" | "both" = "both"
): AnalysisResult {
  const rootNode: OpeningNode = {
    move: "",
    san: "Start",
    count: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    winRate: 0,
    children: new Map(),
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w',
    transpositions: [],
  };

  let totalGames = 0;

  // CRITICAL FIX: Move fenToNode OUTSIDE game loop for proper transposition detection across ALL games
  const globalFenToNode = new Map<string, OpeningNode>();
  const startFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w';
  globalFenToNode.set(startFen, rootNode);

  for (const game of games) {
    const chess = new Chess();
    
    try {
      chess.loadPgn(game.pgn);
    } catch (e) {
      continue; // Skip invalid PGN
    }

    const isWhite = game.white.toLowerCase() === targetUsername.toLowerCase();
    const isBlack = game.black.toLowerCase() === targetUsername.toLowerCase();

    // Only include games where scouted player played the selected color
    if (playerColor === "white" && !isWhite) continue;
    if (playerColor === "black" && !isBlack) continue;
    if (!isWhite && !isBlack) continue;

    totalGames++;

    // Determine result from target player's perspective
    let result: "win" | "draw" | "loss";
    if (!game.winner) {
      result = "draw";
    } else if (
      (game.winner === "white" && isWhite) ||
      (game.winner === "black" && isBlack)
    ) {
      result = "win";
    } else {
      result = "loss";
    }

    // Build opening tree - limit to opening phase for performance and relevance
    const history = chess.history({ verbose: true });
    let currentNode = rootNode;
    const maxPlies = Math.min(history.length, 30); // 30 plies = 15 full moves

    // Create tracking chess instance that moves forward incrementally (O(n) instead of O(n²))
    const trackingChess = new Chess();
    
    // Track move sequence for transposition detection
    const selectedPath: string[] = [];

    // Add ALL moves to create a continuous tree structure
    // Statistics are tracked from target player's perspective for the entire game
    for (let i = 0; i < maxPlies; i++) {
      const move = history[i];
      
      // Make the move on tracking instance (O(1) per move instead of O(n²))
      try {
        trackingChess.move(move);
        selectedPath.push(move.san);
      } catch (e) {
        console.warn(`Failed to process move ${i}:`, move.san, e);
        break; // Skip rest of this game if move fails
      }
      const positionFen = trackingChess.fen().split(' ').slice(0, 2).join(' '); // Board + turn only
      
      const moveKey = `${move.from}${move.to}${move.promotion || ""}`;

      // Check if we've seen this position before (transposition) - use GLOBAL map
      let targetNode = globalFenToNode.get(positionFen);
      
      if (!targetNode) {
        // New position - add move to tree
        if (!currentNode.children.has(moveKey)) {
          currentNode.children.set(moveKey, {
            move: moveKey,
            san: move.san,
            count: 0,
            wins: 0,
            draws: 0,
            losses: 0,
            winRate: 0,
            children: new Map(),
            fen: positionFen,
            transpositions: [],
          });
        }
        targetNode = currentNode.children.get(moveKey)!;
        targetNode.fen = positionFen;
        globalFenToNode.set(positionFen, targetNode);
      }

      // Track transposition paths
      if (!targetNode.transpositions) {
        targetNode.transpositions = [];
      }
      
      // Get the full path to this position
      const pathStr = selectedPath.join(' ');
      
      const existingPath = targetNode.transpositions.find(t => t.path.join(' ') === pathStr);
      if (existingPath) {
        existingPath.count++;
      } else {
        targetNode.transpositions.push({
          path: [...selectedPath],
          count: 1
        });
      }

      currentNode = targetNode;
      currentNode.count++;

      // Statistics are tracked from target player's perspective
      if (result === "win") currentNode.wins++;
      else if (result === "draw") currentNode.draws++;
      else currentNode.losses++;

      currentNode.winRate = currentNode.count > 0 
        ? (currentNode.wins + currentNode.draws * 0.5) / currentNode.count 
        : 0;
    }
  }

  rootNode.count = totalGames;

  // Extract weakest and strongest lines
  const allLines = extractAllLines(rootNode, "", []);
  const sortedByWinRate = allLines
    .filter(line => line.count >= 3) // Minimum 3 games for reliability
    .sort((a, b) => a.winRate - b.winRate);

  const weakestLines = sortedByWinRate.slice(0, 5);
  const strongestLines = sortedByWinRate.slice(-5).reverse();

  return {
    totalGames,
    openingTree: rootNode,
    weakestLines,
    strongestLines,
    playerColor,
  };
}

function extractAllLines(
  node: OpeningNode,
  currentLine: string,
  results: Array<{ line: string; winRate: number; count: number }>
): Array<{ line: string; winRate: number; count: number }> {
  if (node.count > 0 && currentLine) {
    results.push({
      line: currentLine.trim(),
      winRate: node.winRate,
      count: node.count,
    });
  }

  for (const [, child] of node.children) {
    extractAllLines(
      child,
      currentLine ? `${currentLine} ${child.san}` : child.san,
      results
    );
  }

  return results;
}

export function serializeOpeningTree(node: OpeningNode): any {
  return {
    move: node.move,
    san: node.san,
    count: node.count,
    wins: node.wins,
    draws: node.draws,
    losses: node.losses,
    winRate: node.winRate,
    fen: node.fen,
    transpositions: node.transpositions,
    children: Array.from(node.children.entries()).map(([key, child]) => ({
      key,
      ...serializeOpeningTree(child),
    })),
  };
}

export function deserializeOpeningTree(serialized: any): OpeningNode {
  const children = new Map<string, OpeningNode>();
  
  if (serialized.children && Array.isArray(serialized.children)) {
    for (const child of serialized.children) {
      children.set(child.key, deserializeOpeningTree(child));
    }
  }
  
  return {
    move: serialized.move,
    san: serialized.san,
    count: serialized.count,
    wins: serialized.wins,
    draws: serialized.draws,
    losses: serialized.losses,
    winRate: serialized.winRate,
    fen: serialized.fen,
    transpositions: serialized.transpositions || [],
    children,
  };
}
