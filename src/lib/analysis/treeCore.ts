// Pure, worker-safe opening-tree core.
//
// This is the hot path of a scout: parse each game's PGN, walk the first N plies
// and fold win/draw/loss stats into an opening tree, from the *target player's*
// perspective. It is deliberately free of console logging and of any DOM/React
// dependency so it can run unchanged inside a Web Worker (see treeWorker.ts) or
// on the main thread as a fallback.
//
// Two representations are used:
//   - OpeningNode (Map-based children) — the canonical tree the rest of the app
//     consumes, identical to the one chessAnalysis.ts produces.
//   - SerializedNode (array-based children) — a structured-cloneable shape that
//     crosses the worker boundary and that InteractiveOpeningTree renders.
//
// Workers build a SerializedNode from a batch of games; the main thread folds
// those partial trees into one canonical Map tree with mergeSerializedIntoNode().

import { Chess } from "chess.js";
import type { GameData } from "../chessApi";
import type { OpeningNode, AnalysisResult } from "../chessAnalysis";

// Opening phase depth. 30 plies = 15 full moves — enough to characterise an
// opponent's repertoire without paying for full-game tree width.
export const MAX_PLIES = 30;

export interface SerializedNode {
  key?: string;
  move: string;
  san: string;
  count: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  fen?: string;
  children: SerializedNode[];
}

function emptySerializedRoot(): SerializedNode {
  return {
    move: "",
    san: "Start",
    count: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    winRate: 0,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w",
    children: [],
  };
}

/**
 * Build a serialized partial opening tree from a batch of games. Runs inside a
 * worker. Mirrors the tree semantics of chessAnalysis.analyzeGamesIncremental
 * exactly (same move keys, same 30-ply cap, same win/draw/loss accounting) so
 * merged worker output is identical to the single-threaded implementation.
 *
 * Children are kept in a Map during construction for O(1) lookup, then emitted
 * as arrays. `gamesAdded` counts games actually folded in (target found + legal
 * PGN), matching how analyzeGamesIncremental increments totalGames.
 */
export function buildSerializedTree(
  games: GameData[],
  targetUsername: string,
): { tree: SerializedNode; gamesAdded: number } {
  const normalizedTarget = targetUsername.toLowerCase();

  // Internal build node uses a Map for fast child lookup while accumulating.
  interface BuildNode {
    move: string;
    san: string;
    count: number;
    wins: number;
    draws: number;
    losses: number;
    fen?: string;
    children: Map<string, BuildNode>;
  }

  const root: BuildNode = {
    move: "",
    san: "Start",
    count: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w",
    children: new Map(),
  };

  let gamesAdded = 0;

  for (const game of games) {
    const normalizedWhite = (game.white || "").toLowerCase();
    const normalizedBlack = (game.black || "").toLowerCase();
    const isWhite = normalizedWhite === normalizedTarget;
    const isBlack = normalizedBlack === normalizedTarget;
    if (!isWhite && !isBlack) continue;

    const chess = new Chess();
    try {
      chess.loadPgn(game.pgn);
    } catch {
      continue; // Skip unparseable PGN
    }

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
    const maxPlies = Math.min(history.length, MAX_PLIES);

    // Replay forward on a fresh instance: O(n) FEN tracking instead of O(n²).
    const tracking = new Chess();
    let current = root;
    let brokeEarly = false;

    for (let j = 0; j < maxPlies; j++) {
      const move = history[j];
      try {
        tracking.move(move);
      } catch {
        brokeEarly = true;
        break; // Corrupt continuation — keep what we folded so far
      }
      const positionFen = tracking.fen().split(" ").slice(0, 2).join(" ");
      const moveKey = `${move.from}${move.to}${move.promotion || ""}`;

      let child = current.children.get(moveKey);
      if (!child) {
        child = {
          move: moveKey,
          san: move.san,
          count: 0,
          wins: 0,
          draws: 0,
          losses: 0,
          fen: positionFen,
          children: new Map(),
        };
        current.children.set(moveKey, child);
      }
      current = child;
      current.count++;
      if (result === "win") current.wins++;
      else if (result === "draw") current.draws++;
      else current.losses++;
    }

    void brokeEarly;
    gamesAdded++;
  }

  const serialize = (node: BuildNode, key?: string): SerializedNode => ({
    key,
    move: node.move,
    san: node.san,
    count: node.count,
    wins: node.wins,
    draws: node.draws,
    losses: node.losses,
    winRate: node.count > 0 ? (node.wins + node.draws * 0.5) / node.count : 0,
    fen: node.fen,
    children: Array.from(node.children.entries()).map(([k, c]) => serialize(c, k)),
  });

  return { tree: serialize(root), gamesAdded };
}

/**
 * Fold a serialized partial tree (from a worker) into the canonical Map-based
 * OpeningNode on the main thread. Cheap Map arithmetic — the expensive chess.js
 * parsing already happened in the worker. Idempotent per node key: repeated
 * merges accumulate counts, so partial trees from many workers combine into one.
 */
export function mergeSerializedIntoNode(
  target: OpeningNode,
  source: SerializedNode,
): void {
  for (const sChild of source.children) {
    const key = sChild.key ?? sChild.move;
    let tChild = target.children.get(key);
    if (!tChild) {
      tChild = {
        move: sChild.move,
        san: sChild.san,
        count: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        winRate: 0,
        children: new Map(),
        fen: sChild.fen,
      };
      target.children.set(key, tChild);
    }
    tChild.count += sChild.count;
    tChild.wins += sChild.wins;
    tChild.draws += sChild.draws;
    tChild.losses += sChild.losses;
    tChild.winRate =
      tChild.count > 0 ? (tChild.wins + tChild.draws * 0.5) / tChild.count : 0;
    if (!tChild.fen && sChild.fen) tChild.fen = sChild.fen;
    mergeSerializedIntoNode(tChild, sChild);
  }
}

function extractAllLines(
  node: OpeningNode,
  currentLine: string,
  results: Array<{ line: string; winRate: number; count: number }>,
): Array<{ line: string; winRate: number; count: number }> {
  if (node.count > 0 && currentLine) {
    results.push({ line: currentLine.trim(), winRate: node.winRate, count: node.count });
  }
  for (const [, child] of node.children) {
    extractAllLines(child, currentLine ? `${currentLine} ${child.san}` : child.san, results);
  }
  return results;
}

/**
 * Compute weakest/strongest lines and stamp the root count. Run ONCE when the
 * scout finishes — not per batch — since extractAllLines walks the whole tree.
 */
export function finalizeAnalysis(
  root: OpeningNode,
  totalGames: number,
  playerColor: "white" | "black" | "both",
): AnalysisResult {
  root.count = totalGames;
  const allLines = extractAllLines(root, "", []);
  const sortedByWinRate = allLines
    .filter((line) => line.count >= 3)
    .sort((a, b) => a.winRate - b.winRate);
  return {
    totalGames,
    openingTree: root,
    weakestLines: sortedByWinRate.slice(0, 5),
    strongestLines: sortedByWinRate.slice(-5).reverse(),
    playerColor,
  };
}
