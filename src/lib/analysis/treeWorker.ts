// Web Worker: parses a batch of games into a serialized partial opening tree,
// off the main thread. One of these is spawned per pool slot (see treePool.ts).
//
// Protocol (raw postMessage):
//   in:  { id: number; games: GameData[]; target: string }
//   out: { id: number; tree: SerializedNode; gamesAdded: number }
//
// chess.js is bundled into this worker chunk by Vite (worker.format = 'es').

import { buildSerializedTree } from "./treeCore";
import type { GameData } from "../chessApi";

interface WorkerRequest {
  id: number;
  games: GameData[];
  target: string;
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, games, target } = e.data;
  try {
    const { tree, gamesAdded } = buildSerializedTree(games, target);
    (self as unknown as Worker).postMessage({ id, tree, gamesAdded });
  } catch (err) {
    // Never let a bad batch wedge the pool — report an empty result so the
    // dispatcher's promise resolves and work keeps flowing.
    (self as unknown as Worker).postMessage({
      id,
      tree: { move: "", san: "Start", count: 0, wins: 0, draws: 0, losses: 0, winRate: 0, children: [] },
      gamesAdded: 0,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
