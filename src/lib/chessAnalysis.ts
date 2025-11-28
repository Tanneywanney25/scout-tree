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
  };

  return {
    totalGames: 0,
    openingTree: rootNode,
    weakestLines: [],
    strongestLines: [],
    playerColor,
  };
}

export function analyzeGamesIncremental(
  existingAnalysis: AnalysisResult,
  newGames: GameData[],
  targetUsername: string
): AnalysisResult {
  const rootNode = existingAnalysis.openingTree;
  let totalGames = existingAnalysis.totalGames;
  const playerColor = existingAnalysis.playerColor;

  for (const game of newGames) {
    const chess = new Chess();
    
    try {
      chess.loadPgn(game.pgn);
    } catch (e) {
      continue;
    }

    const isWhite = game.white.toLowerCase() === targetUsername.toLowerCase();
    const isBlack = game.black.toLowerCase() === targetUsername.toLowerCase();

    if (playerColor === "white" && !isWhite) continue;
    if (playerColor === "black" && !isBlack) continue;
    if (!isWhite && !isBlack) continue;

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
    const maxPlies = Math.min(20, history.length);

    // Determine which moves belong to the target player
    // White plays on even indices (0, 2, 4...), Black plays on odd indices (1, 3, 5...)
    const targetPlaysMoveAtIndex = (index: number) => {
      if (playerColor === "both") return true;
      if (isWhite) return index % 2 === 0; // White's moves
      if (isBlack) return index % 2 === 1; // Black's moves
      return false;
    };

    for (let i = 0; i < maxPlies; i++) {
      const move = history[i];
      const moveKey = `${move.from}${move.to}${move.promotion || ""}`;

      // Only track moves made by the target player
      if (targetPlaysMoveAtIndex(i)) {
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
          });
        }

        currentNode = currentNode.children.get(moveKey)!;
        currentNode.count++;

        if (result === "win") currentNode.wins++;
        else if (result === "draw") currentNode.draws++;
        else currentNode.losses++;

        currentNode.winRate = currentNode.count > 0 
          ? (currentNode.wins + currentNode.draws * 0.5) / currentNode.count 
          : 0;
      }
    }
  }

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

    // Filter by color if specified
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

    // Build opening tree (first 10 moves = 20 plies)
    const history = chess.history({ verbose: true });
    let currentNode = rootNode;
    const maxPlies = Math.min(20, history.length);

    // Determine which moves belong to the target player
    const targetPlaysMoveAtIndex = (index: number) => {
      if (playerColor === "both") return true;
      if (isWhite) return index % 2 === 0;
      if (isBlack) return index % 2 === 1;
      return false;
    };

    for (let i = 0; i < maxPlies; i++) {
      const move = history[i];
      const moveKey = `${move.from}${move.to}${move.promotion || ""}`;

      // Only track moves made by the target player
      if (targetPlaysMoveAtIndex(i)) {
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
          });
        }

        currentNode = currentNode.children.get(moveKey)!;
        currentNode.count++;

        if (result === "win") currentNode.wins++;
        else if (result === "draw") currentNode.draws++;
        else currentNode.losses++;

        currentNode.winRate = currentNode.count > 0 
          ? (currentNode.wins + currentNode.draws * 0.5) / currentNode.count 
          : 0;
      }
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
    children: Array.from(node.children.entries()).map(([key, child]) => ({
      key,
      ...serializeOpeningTree(child),
    })),
  };
}
