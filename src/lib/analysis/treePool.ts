// A pool of tree-building Web Workers — the parallel "agents" that turn fetched
// games into opening-tree fragments off the main thread. The main thread stays
// free to fetch, render the live preview, and stay responsive; parsing fans out
// across CPU cores.
//
// Each worker processes one chunk at a time. process() assigns to a free worker
// or queues the chunk until one frees up, and resolves with that chunk's partial
// serialized tree. If Web Workers are unavailable (or fail to construct), it
// degrades to synchronous main-thread parsing so scouting never breaks.

import type { GameData } from "../chessApi";
import { buildSerializedTree, type SerializedNode } from "./treeCore";

export interface TreeResult {
  tree: SerializedNode;
  gamesAdded: number;
}

interface Job {
  id: number;
  games: GameData[];
  target: string;
  resolve: (r: TreeResult) => void;
}

function desiredWorkerCount(): number {
  const cores =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency
      ? navigator.hardwareConcurrency
      : 4;
  // Leave a core for the main thread + fetch; cap so we don't over-spawn.
  return Math.max(2, Math.min(cores - 1, 6));
}

export class TreePool {
  private workers: Worker[] = [];
  private freeWorkers: Worker[] = [];
  private busy = new Map<Worker, Job>();
  private queue: Job[] = [];
  private pending = new Map<number, Job>();
  private nextId = 1;
  private disabled = false;
  private terminated = false;

  constructor(size = desiredWorkerCount()) {
    if (typeof Worker === "undefined") {
      this.disabled = true;
      return;
    }
    for (let i = 0; i < size; i++) {
      try {
        const worker = new Worker(new URL("./treeWorker.ts", import.meta.url), {
          type: "module",
        });
        worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(worker, e);
        worker.onerror = () => this.onWorkerError(worker);
        this.workers.push(worker);
        this.freeWorkers.push(worker);
      } catch {
        // Couldn't build workers in this environment — fall back to main thread.
        this.disabled = true;
        this.terminateWorkers();
        return;
      }
    }
    if (this.workers.length === 0) this.disabled = true;
  }

  get parallelism(): number {
    return this.disabled ? 1 : this.workers.length;
  }

  /** Parse a chunk of games into a partial serialized opening tree. */
  process(games: GameData[], target: string): Promise<TreeResult> {
    if (this.disabled || this.terminated) {
      // Synchronous fallback — still correct, just not off-thread.
      return Promise.resolve(buildSerializedTree(games, target));
    }
    return new Promise<TreeResult>((resolve) => {
      const job: Job = { id: this.nextId++, games, target, resolve };
      const worker = this.freeWorkers.pop();
      if (worker) {
        this.dispatch(worker, job);
      } else {
        this.queue.push(job);
      }
    });
  }

  private dispatch(worker: Worker, job: Job): void {
    this.busy.set(worker, job);
    this.pending.set(job.id, job);
    worker.postMessage({ id: job.id, games: job.games, target: job.target });
  }

  private onWorkerMessage(worker: Worker, e: MessageEvent): void {
    const { id, tree, gamesAdded } = e.data as {
      id: number;
      tree: SerializedNode;
      gamesAdded: number;
    };
    const job = this.pending.get(id);
    if (job) {
      this.pending.delete(id);
      job.resolve({ tree, gamesAdded });
    }
    this.busy.delete(worker);
    const next = this.queue.shift();
    if (next) {
      this.dispatch(worker, next);
    } else {
      this.freeWorkers.push(worker);
    }
  }

  private onWorkerError(worker: Worker): void {
    // The in-flight job on this worker is lost; resolve it via main-thread
    // parsing so the merge still completes, then retire the worker.
    const job = this.busy.get(worker);
    this.busy.delete(worker);
    if (job) {
      this.pending.delete(job.id);
      job.resolve(buildSerializedTree(job.games, job.target));
    }
    this.workers = this.workers.filter((w) => w !== worker);
    this.freeWorkers = this.freeWorkers.filter((w) => w !== worker);
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    if (this.workers.length === 0) this.disabled = true;
    // Drain any queued jobs on the remaining workers / fallback.
    const next = this.queue.shift();
    if (next) {
      const free = this.freeWorkers.pop();
      if (free) this.dispatch(free, next);
      else next.resolve(buildSerializedTree(next.games, next.target));
    }
  }

  private terminateWorkers(): void {
    for (const w of this.workers) {
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
    }
    this.workers = [];
    this.freeWorkers = [];
    this.busy.clear();
  }

  terminate(): void {
    this.terminated = true;
    // Any still-queued jobs resolve empty so awaiting callers don't hang.
    for (const job of this.queue) {
      job.resolve({ tree: emptyTree(), gamesAdded: 0 });
    }
    this.queue = [];
    for (const job of this.pending.values()) {
      job.resolve({ tree: emptyTree(), gamesAdded: 0 });
    }
    this.pending.clear();
    this.terminateWorkers();
  }
}

function emptyTree(): SerializedNode {
  return {
    move: "",
    san: "Start",
    count: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    winRate: 0,
    children: [],
  };
}
