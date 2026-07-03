// ============================================================================
// Identity Resolution Engine — shared network discipline
//
// The traversal engine runs dozens of "agents" (event workers, seed scouts,
// pairing tracers, candidate verifiers) at the same time. That parallelism is
// where the speed comes from — but it must never turn into a request storm
// that gets the client rate-limited, because a silently dropped response IS an
// accuracy bug (a lost month of games breaks a pairing chain).
//
// So every platform call in the identity stack funnels through here:
//   • Chess.com — a global concurrency GATE (their CDN-backed pub API handles
//     parallel readers fine, but unbounded fan-out earns 429s). Any number of
//     logical agents can be in flight; only CC_MAX_INFLIGHT HTTP requests are.
//   • Lichess  — a global PACER (they rate-limit per IP and want requests
//     spaced out; bursts get 429s or a temporary ban).
//   • Both     — 429 means "slow down", NEVER "doesn't exist": politeFetch
//     retries with growing backoff instead of surfacing a fake miss.
//
// Dependency-free on purpose: runs in the browser, the Node CLI harness and
// tests alike.
// ============================================================================

/** Bounded-concurrency map — the worker pool behind every "agent" group.
 *  Feeds `items` to at most `limit` concurrent runs of `fn`; `stop` is checked
 *  before each item so a found target / expired budget halts the pool. */
export async function pool<T>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<void>,
  stop?: () => boolean
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        if (stop?.()) return;
        await fn(items[idx], idx);
      }
    })
  );
}

/** Counting semaphore — bounds how many callers run `fn` at once. */
export interface Gate {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function semaphore(limit: number): Gate {
  let active = 0;
  const waiters: (() => void)[] = [];
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < limit) {
        active++;
        resolve();
      } else {
        waiters.push(() => {
          active++;
          resolve();
        });
      }
    });
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/** Global cap on simultaneous Chess.com pub-API requests, shared by every
 *  agent in the search (verifications, monthly archives, tournament rosters). */
const CC_MAX_INFLIGHT = 12;
export const chesscomGate = semaphore(CC_MAX_INFLIGHT);

// Lichess enforces per-IP rate limits and answers bursts with 429s (or a
// temporary ban). One global pacer spaces every Lichess call in the process.
let lichessNextSlot = 0;
export async function lichessSlot(gapMs = 250): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, lichessNextSlot - now);
  lichessNextSlot = Math.max(now, lichessNextSlot) + gapMs;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export type NetPlatform = "chesscom" | "lichess";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with the platform's politeness discipline applied:
 *   • Chess.com attempts hold a slot in the global gate; Lichess attempts wait
 *     for the global pacer first.
 *   • Each attempt gets its own timeout (a hung socket must not pin an agent).
 *   • 429s back off and retry — they are throttling, not absence.
 * Throws only on abort or after every retry is exhausted with a network error;
 * callers still check `res.ok` exactly as with a raw fetch.
 */
export async function politeFetch(
  url: string,
  init: RequestInit,
  platform: NetPlatform,
  timeoutMs = 10_000
): Promise<Response> {
  const outer = init.signal as AbortSignal | undefined;
  const maxRetries = 4;
  for (let attempt = 0; ; attempt++) {
    if (outer?.aborted) throw new DOMException("Aborted", "AbortError");
    const attemptOnce = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (outer) {
        if (outer.aborted) controller.abort();
        else outer.addEventListener("abort", onAbort, { once: true });
      }
      try {
        return await fetch(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
      }
    };
    let res: Response;
    try {
      if (platform === "lichess") {
        await lichessSlot();
        res = await attemptOnce();
      } else {
        res = await chesscomGate.run(attemptOnce);
      }
    } catch (e) {
      // Timeouts / transient network errors: retry a couple of times before
      // giving up — but an outer abort propagates immediately.
      if (outer?.aborted || attempt >= 2) throw e;
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (res.status === 429 && attempt < maxRetries && !outer?.aborted) {
      await sleep((platform === "lichess" ? 2500 : 2000) * (attempt + 1));
      continue;
    }
    return res;
  }
}
