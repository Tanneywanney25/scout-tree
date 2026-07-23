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

/** Counting semaphore — bounds how many callers run `fn` at once. The limit is
 *  LIVE: the conductor may lower it under rate pressure (in-flight calls finish
 *  normally; new admissions wait) or raise it back (waiters admitted at once). */
export interface Gate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Adjust the concurrency limit at runtime (floored at 1). */
  setLimit(n: number): void;
  /** Live occupancy — the conductor's utilization signal. */
  stats(): { active: number; waiting: number; limit: number };
}

export function semaphore(limit: number): Gate {
  let active = 0;
  const waiters: (() => void)[] = [];
  // Admit waiters while slots are free — the ONLY place a waiter is released,
  // so a lowered limit simply stops admissions until enough calls drain.
  const admit = () => {
    while (active < limit && waiters.length) {
      active++;
      waiters.shift()!();
    }
  };
  const acquire = (): Promise<void> =>
    new Promise((resolve) => {
      if (active < limit) {
        active++;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  const release = () => {
    active--;
    admit();
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
    setLimit(n: number) {
      limit = Math.max(1, Math.floor(n));
      admit();
    },
    stats: () => ({ active, waiting: waiters.length, limit }),
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

// ---------------------------------------------------------------------------
// Net observer — the conductor's ear on the wire. politeFetch reports every
// outcome (429 / any-other-response / transport failure) through this slot so
// the rate governor can react to real 429 pressure instead of guessing.
// One slot, not a list: exactly one search conducts at a time in this app, and
// the resolver attaches/detaches it around each search.
// ---------------------------------------------------------------------------

export type NetEventKind = "429" | "ok" | "fail";

let netObserver: ((platform: NetPlatform, kind: NetEventKind) => void) | null = null;

/** Attach (or with `null` detach) the process-wide net observer. */
export function setNetObserver(fn: ((platform: NetPlatform, kind: NetEventKind) => void) | null): void {
  netObserver = fn;
}

const notifyNet = (platform: NetPlatform, kind: NetEventKind) => {
  try {
    netObserver?.(platform, kind);
  } catch {
    /* an observer bug must never break a fetch */
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Platform-outage circuit breaker.
//
// When a platform is DOWN at the transport level (connect timeouts, DNS
// failures — fetch THROWS, no HTTP response at all), every probe pays the
// full timeout×retry ladder (~30s) before surfacing its hole. A traversal
// makes hundreds of speculative probes, so an outage multiplies into HOURS of
// wall-clock spent waiting on a dead socket (observed live: a Lichess outage
// turned a 30-second pairing proof into a 12-minute run).
//
// So each platform gets a breaker: after BREAK_THRESHOLD consecutive
// transport failures the circuit OPENS and politeFetch fast-fails instantly
// for BREAK_COOLDOWN_MS, then lets exactly ONE probe through (half-open) to
// test recovery — success closes the circuit, failure re-opens it. An HTTP
// response of any status (even 429/5xx) is the platform TALKING and resets
// the count; it never opens the circuit.
//
// Fast-fails look to callers exactly like an exhausted retry ladder (a thrown
// error), so the engine's hole-vs-verdict semantics are untouched: an outage
// yields the same retryable holes as before, just in 0ms instead of 30s.
// ---------------------------------------------------------------------------

const BREAK_THRESHOLD = 6;
const BREAK_COOLDOWN_MS = 45_000;

interface Breaker {
  fails: number;
  openUntil: number;
  probing: boolean;
}

const breakers: Record<NetPlatform, Breaker> = {
  chesscom: { fails: 0, openUntil: 0, probing: false },
  lichess: { fails: 0, openUntil: 0, probing: false },
};

/** Throws when the platform's circuit is open (unless this caller wins the
 *  half-open probe slot). Returns whether this attempt IS the probe. */
function breakerAdmit(platform: NetPlatform): boolean {
  const b = breakers[platform];
  if (b.fails < BREAK_THRESHOLD) return false;
  if (Date.now() >= b.openUntil && !b.probing) {
    b.probing = true; // this caller probes recovery for everyone
    return true;
  }
  throw new Error(`${platform} unreachable (circuit open) — fast-failing instead of waiting on a dead socket`);
}

function breakerSuccess(platform: NetPlatform): void {
  const b = breakers[platform];
  b.fails = 0;
  b.openUntil = 0;
  b.probing = false;
}

function breakerFailure(platform: NetPlatform): void {
  const b = breakers[platform];
  b.fails++;
  if (b.fails >= BREAK_THRESHOLD) {
    b.openUntil = Date.now() + BREAK_COOLDOWN_MS;
    b.probing = false;
  }
}

/** TEST-ONLY: reset breaker state between test scenarios. */
export function _resetBreakers(): void {
  for (const b of Object.values(breakers)) {
    b.fails = 0;
    b.openUntil = 0;
    b.probing = false;
  }
}

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
    // Outage fast-path: an open circuit fails the call NOW (0ms) instead of
    // paying the timeout ladder against a dead socket. Checked before pacing
    // so fast-fails also never consume a Lichess pacer slot.
    const isProbe = breakerAdmit(platform);
    let res: Response;
    try {
      if (platform === "lichess") {
        await lichessSlot();
        res = await attemptOnce();
      } else {
        res = await chesscomGate.run(attemptOnce);
      }
      breakerSuccess(platform); // any HTTP response = the platform is talking
      notifyNet(platform, res.status === 429 ? "429" : "ok");
    } catch (e) {
      // Transport failure (timeout / network error), not an HTTP status. An
      // outer abort is the CALLER stopping — it says nothing about the
      // platform, so it must not trip the breaker.
      if (!outer?.aborted) {
        breakerFailure(platform);
        notifyNet(platform, "fail");
      } else if (isProbe) breakers[platform].probing = false; // free the probe slot
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
