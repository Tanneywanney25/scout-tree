import { Chess } from "chess.js";
import { GameData } from "./chessApi";

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

// Build a FEN-to-nodes lookup map for transposition detection (post-processing step)
export function buildFenToNodesMap(
  node: OpeningNode, 
  map = new Map<string, OpeningNode[]>()
): Map<string, OpeningNode[]> {
  if (node.fen) {
    if (!map.has(node.fen)) map.set(node.fen, []);
    map.get(node.fen)!.push(node);
  }
  for (const child of node.children.values()) {
    buildFenToNodesMap(child, map);
  }
  return map;
}

export interface StoredGameData {
  pgn: string;
  white: string;
  black: string;
  result: string;
  date?: string;
  url?: string;
  timeControl?: string;
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
  initialSelectedPath?: string[]; // Preserved navigation state
  games?: StoredGameData[]; // Raw games for deep analysis (max 50)
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
  
  // Track skip reasons for debugging
  let skipPgn = 0;
  let skipPlayerNotFound = 0;
  const normalizedTarget = targetUsername.toLowerCase();

  // Reduced logging - only log batch summary
  console.log(`[ANALYSIS] Batch: ${newGames.length} games for "${normalizedTarget}", color: ${playerColor}`);

  for (let i = 0; i < newGames.length; i++) {
    const game = newGames[i];
    const chess = new Chess();
    
    // Yield to browser every 10 games (reduced from 2 to minimize overhead)
    if (i > 0 && i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    try {
      chess.loadPgn(game.pgn);
    } catch (e) {
      skipPgn++;
      continue; // Silent skip - logged in summary
    }

    const normalizedWhite = game.white.toLowerCase();
    const normalizedBlack = game.black.toLowerCase();
    const isWhite = normalizedWhite === normalizedTarget;
    const isBlack = normalizedBlack === normalizedTarget;

    if (!isWhite && !isBlack) {
      skipPlayerNotFound++;
      continue; // Silent skip - logged in summary
    }

    totalGames++;

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
    const maxPlies = Math.min(history.length, 30);

    // Create tracking chess instance that moves forward incrementally (O(n) instead of O(n²))
    const trackingChess = new Chess();

    // Add ALL moves to create a continuous tree structure
    // Each path creates separate nodes - no FEN-based sharing
    for (let j = 0; j < maxPlies; j++) {
      const move = history[j];
      
      // Make the move on tracking instance (O(1) per move instead of O(n²))
      try {
        trackingChess.move(move);
      } catch (e) {
        console.warn(`[ANALYSIS] Failed to process move ${j}:`, move.san, e);
        break; // Skip rest of this game if move fails
      }
      const positionFen = trackingChess.fen().split(' ').slice(0, 2).join(' '); // Board + turn only
      
      const moveKey = `${move.from}${move.to}${move.promotion || ""}`;
      
      // Debug logging (first 3 games)
      if (totalGames <= 3) {
        console.log(`  Move ${j}: ${move.san} (${moveKey})`);
      }

      // Build tree by move sequence - each path creates separate nodes
      let targetNode: OpeningNode;
      if (currentNode.children.has(moveKey)) {
        targetNode = currentNode.children.get(moveKey)!;
      } else {
        targetNode = {
          move: moveKey,
          san: move.san,
          count: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          winRate: 0,
          children: new Map(),
          fen: positionFen, // Store FEN for lookup purposes
        };
        currentNode.children.set(moveKey, targetNode);
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
    
    // Optional: Call progress callback after each game
    if (onProgress) {
      onProgress(totalGames);
    }
  }

  console.log(`[ANALYSIS] Complete. Processed: ${newGames.length}, Skipped(PGN): ${skipPgn}, Skipped(player): ${skipPlayerNotFound}, Successfully analyzed: ${totalGames - existingAnalysis.totalGames}, Total: ${totalGames}`);
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
  };

  let totalGames = 0;

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

    // Add ALL moves to create a continuous tree structure
    // Each path creates separate nodes - no FEN-based sharing
    for (let i = 0; i < maxPlies; i++) {
      const move = history[i];
      
      // Make the move on tracking instance (O(1) per move instead of O(n²))
      try {
        trackingChess.move(move);
      } catch (e) {
        console.warn(`Failed to process move ${i}:`, move.san, e);
        break; // Skip rest of this game if move fails
      }
      const positionFen = trackingChess.fen().split(' ').slice(0, 2).join(' '); // Board + turn only
      
      const moveKey = `${move.from}${move.to}${move.promotion || ""}`;

      // Build tree by move sequence - each path creates separate nodes
      let targetNode: OpeningNode;
      if (currentNode.children.has(moveKey)) {
        targetNode = currentNode.children.get(moveKey)!;
      } else {
        targetNode = {
          move: moveKey,
          san: move.san,
          count: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          winRate: 0,
          children: new Map(),
          fen: positionFen, // Store FEN for lookup purposes
        };
        currentNode.children.set(moveKey, targetNode);
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
    children,
  };
}
