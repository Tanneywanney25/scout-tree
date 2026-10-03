// ============================================================================
// Identity Resolution Engine — shared network discipline (the request allocator)
//
// The traversal engine runs dozens of "agents" (event workers, seed scouts,
// pairing tracers, candidate verifiers, section workers) at the same time. The
// binding limit is requests per unit time per ADDRESS, so every platform call
// in the identity stack funnels through one allocator here:
//
//   • One token bucket per host (Chess.com) or per endpoint class (Lichess),
//     sized from measurement with headroom under the wall, never at it.
//   • Two priority lanes. PROVEN work (anything following a confirmed identity
//     or a known crosstable link) always dequeues first; SPECULATIVE work
//     (handle guessing, unverified candidate probes) only gets tokens nobody
//     proven is waiting for, and never more than a fixed share of the rate.
//   • Adaptive rate (AIMD): a rate-limit signal halves the rate and pauses the
//     bucket; a clean stretch raises it back by a fixed step.
//   • Per-request accounting so a search can report its requests split by
//     lane, its 404 share, and how long proven work waited in the queue.
//
// More agents past the ceiling only make the queue longer, never the request
// rate higher: the bucket is the only way onto the wire.
//
// Measured 2026-10-02 (docs/traversal-implementation.md, Phase 1):
//   Chess.com  first 429 after ~300 requests in a window, whatever the rate
//              (301 at 31/s, 302 at 60/s from a laptop; 392 at 31/s from one
//              edge address). All endpoints pooled. Cloudflare challenge, no
//              Retry-After, no rate headers. Cleared in 0.5–1 s after a
//              just-over trip (8–11 s after hard bursts, prior session).
//   Lichess    /api/user clean at 1, 2 and 4/s serial. /api/games/user: the
//              14th request at 1/s drew a 429 with NO Retry-After header;
//              cleared within 7 s. Fits a bucket of ~7–9 refilling ~0.5/s.
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Speculative marking.
//
// The engine threads one AbortSignal through every fetch it makes. Speculative
// work runs under a DERIVED signal registered here, so politeFetch can route
// it to the speculative lane without a new parameter on every call site.
// ---------------------------------------------------------------------------

const speculativeSignals = new WeakSet<AbortSignal>();

/** A signal that aborts with `parent` and marks every fetch made under it as
 *  speculative. Create one per traversal and reuse it. */
export function speculativeSignal(parent?: AbortSignal): AbortSignal {
  const s = parent ? AbortSignal.any([parent]) : new AbortController().signal;
  speculativeSignals.add(s);
  return s;
}

export function isSpeculativeSignal(signal?: AbortSignal | null): boolean {
  return !!signal && speculativeSignals.has(signal);
}

export type Lane = "proven" | "speculative";

/** Thrown to a speculative request that was dropped under rate pressure. */
export class SpeculativeShed extends Error {
  constructor(where: string) {
    super(`speculative request shed: ${where} is rate-limited`);
    this.name = "SpeculativeShed";
  }
}

// After a rate-limit signal, speculative work on that bucket is DROPPED (not
// queued) until the pause has ended and this much longer has passed clean.
// Measured in acceptance player #6: with speculative Lichess lookups merely
// queued, 46 profile 429s kept the block alive, one speculative request
// waited 17 minutes, and a backtrack that would have finished the search sat
// behind the pauses for ~20 minutes. Proven work keeps its place.
const SHED_GRACE_MS = 30_000;

// Search-wide speculative REQUEST budget (docs/roster-index.md 4.1). The
// earlier caps counted guessed MEMBERS (8 at level 0, 3 per deeper section,
// 24 per search), and each guessed member costs ~20–30 profile probes, so the
// caps compounded: one acceptance search spent 671 speculative requests over
// 38 sections, and speculative work was 70% of all platform requests. This
// counts what is actually sent, across every section and level of one search;
// once spent, every further speculative request is shed before it is sent.
let specBudget: { limit: number; used: number; denied: number } | null = null;

/** Start (or with null, clear) the current search's speculative budget. */
export function setSpeculativeBudget(limit: number | null): void {
  specBudget = limit === null ? null : { limit: Math.max(0, Math.floor(limit)), used: 0, denied: 0 };
}

export function speculativeBudgetState(): { limit: number; used: number; denied: number } | null {
  return specBudget ? { ...specBudget } : null;
}

// ---------------------------------------------------------------------------
// The rate scheduler: token bucket + priority lanes + AIMD.
// ---------------------------------------------------------------------------

export interface BucketConfig {
  /** Burst size (tokens). */
  capacity: number;
  /** Target sustained rate, tokens per second. */
  rate: number;
  /** AIMD floor. */
  minRate: number;
  /** Additive step back toward `rate` after each clean interval. */
  step: number;
  /** Clean interval before each additive step, ms. */
  recoverMs: number;
  /** Speculative work may use at most this share of the current rate. */
  specShare: number;
}

interface Waiter {
  enqueuedAt: number;
  resolve: (waitMs: number) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class RateScheduler {
  private tokens: number;
  private specTokens: number;
  private last = Date.now();
  private currentRate: number;
  private pausedUntil = 0;
  private shedUntil = 0;
  private lastLimitAt = 0;
  private lastStepAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly queues: Record<Lane, Waiter[]> = { proven: [], speculative: [] };
  limitEvents = 0;

  constructor(readonly name: string, public cfg: BucketConfig) {
    this.tokens = cfg.capacity;
    this.specTokens = Math.max(1, cfg.capacity * cfg.specShare);
    this.currentRate = cfg.rate;
  }

  get rate(): number {
    return this.currentRate;
  }

  depth(lane?: Lane): number {
    return lane ? this.queues[lane].length : this.queues.proven.length + this.queues.speculative.length;
  }

  reset(): void {
    this.tokens = this.cfg.capacity;
    this.specTokens = Math.max(1, this.cfg.capacity * this.cfg.specShare);
    this.currentRate = this.cfg.rate;
    this.pausedUntil = 0;
    this.shedUntil = 0;
    this.lastLimitAt = 0;
    this.limitEvents = 0;
  }

  /** Resolves with the queue wait (ms) once a token is granted. */
  acquire(lane: Lane, signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    if (lane === "speculative" && Date.now() < this.shedUntil) return Promise.reject(new SpeculativeShed(this.name));
    if (lane === "speculative" && specBudget && specBudget.used >= specBudget.limit) {
      specBudget.denied++;
      return Promise.reject(new SpeculativeShed(`${this.name} (search speculative budget spent)`));
    }
    return new Promise<number>((resolve, reject) => {
      const w: Waiter = { enqueuedAt: Date.now(), resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const q = this.queues[lane];
          const i = q.indexOf(w);
          if (i >= 0) q.splice(i, 1);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", w.onAbort, { once: true });
      }
      this.queues[lane].push(w);
      this.pump();
    });
  }

  /** Reject every queued request (both lanes) with the given error. */
  dropAll(err: () => Error): void {
    for (const lane of ["proven", "speculative"] as Lane[]) {
      for (const w of this.queues[lane].splice(0)) {
        if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
        w.reject(err());
      }
    }
  }

  /** A rate-limit signal: halve the rate and pause the bucket. */
  onLimit(pauseMs: number): void {
    const now = Date.now();
    this.limitEvents++;
    this.lastLimitAt = now;
    this.currentRate = Math.max(this.cfg.minRate, this.currentRate * 0.5);
    this.pausedUntil = Math.max(this.pausedUntil, now + pauseMs);
    this.shedUntil = Math.max(this.shedUntil, this.pausedUntil + SHED_GRACE_MS);
    this.tokens = Math.min(this.tokens, 1);
    // Drop every queued speculative request now; it would only re-trip the limit.
    for (const w of this.queues.speculative.splice(0)) {
      if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
      w.reject(new SpeculativeShed(this.name));
    }
    this.pump();
  }

  private refill(now: number): void {
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = now;
    // Additive increase after a clean stretch.
    if (
      this.currentRate < this.cfg.rate &&
      now - this.lastLimitAt > this.cfg.recoverMs &&
      now - this.lastStepAt > this.cfg.recoverMs
    ) {
      this.currentRate = Math.min(this.cfg.rate, this.currentRate + this.cfg.step);
      this.lastStepAt = now;
    }
    this.tokens = Math.min(this.cfg.capacity, this.tokens + dt * this.currentRate);
    const specCap = Math.max(1, this.cfg.capacity * this.cfg.specShare);
    this.specTokens = Math.min(specCap, this.specTokens + dt * this.currentRate * this.cfg.specShare);
  }

  private grant(lane: Lane, now: number): boolean {
    const w = this.queues[lane].shift();
    if (!w) return false;
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
    this.tokens -= 1;
    if (lane === "speculative") {
      this.specTokens -= 1;
      if (specBudget) specBudget.used++;
    }
    w.resolve(now - w.enqueuedAt);
    return true;
  }

  private pump(): void {
    if (this.timer) return;
    const now = Date.now();
    this.refill(now);
    if (now >= this.pausedUntil) {
      while (this.tokens >= 1) {
        if (this.queues.proven.length) {
          this.grant("proven", now);
          continue;
        }
        if (this.queues.speculative.length && this.specTokens >= 1) {
          // Requests queued before the search's speculative budget ran out
          // are checked again here, or the queue overshoots it (measured:
          // 333 sent against a budget of 250 before this check).
          if (specBudget && specBudget.used >= specBudget.limit) {
            for (const w of this.queues.speculative.splice(0)) {
              if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
              specBudget.denied++;
              w.reject(new SpeculativeShed(`${this.name} (search speculative budget spent)`));
            }
            continue;
          }
          this.grant("speculative", now);
          continue;
        }
        break;
      }
    }
    if (this.depth()) {
      let wait: number;
      if (now < this.pausedUntil) wait = this.pausedUntil - now;
      else if (this.tokens < 1) wait = ((1 - this.tokens) / Math.max(this.currentRate, 0.01)) * 1000;
      // Tokens exist but only speculative work waits and its share is spent.
      else wait = ((1 - this.specTokens) / Math.max(this.currentRate * this.cfg.specShare, 0.01)) * 1000;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.max(5, Math.ceil(wait)));
    }
  }
}

// Chess.com: ~300 requests per window per address. 20/s sustained is two
// thirds of that; the 60-token burst keeps a burst well clear of 300.
// Speculative work is held to half the rate, so a proven burst always finds
// tokens. A 429 (or, in a browser, a cluster of opaque fetch failures, which
// is what a Cloudflare challenge looks like there) halves the rate and pauses
// 3 s: just-over trips cleared in 0.5–1 s, hard ones in up to 11 s, and AIMD
// keeps the rate down while the window drains.
export const CHESSCOM_BUCKET: BucketConfig = { capacity: 60, rate: 20, minRate: 4, step: 2, recoverMs: 15_000, specShare: 0.5 };
const CHESSCOM_LIMIT_PAUSE_MS = 3_000;

// Lichess: per-endpoint buckets, sized under the measurement.
export type LichessClass = "user" | "games" | "export" | "other";
export const LICHESS_BUCKETS: Record<LichessClass, BucketConfig> = {
  // /api/user, POST /api/users, autocomplete: clean at 4/s in a 59-request
  // serial probe, but 429s under minutes of sustained load in acceptance
  // (player #6: 46 of 161 profile lookups). Sustained 1/s, speculative 0.25/s.
  user: { capacity: 3, rate: 1, minRate: 0.2, step: 0.2, recoverMs: 30_000, specShare: 0.25 },
  // /api/games/user: bucket ~7–9 refilling ~0.5/s measured.
  games: { capacity: 6, rate: 0.4, minRate: 0.1, step: 0.05, recoverMs: 30_000, specShare: 0.5 },
  // tournament / team exports: one stream at a time is what Lichess asks.
  export: { capacity: 2, rate: 0.5, minRate: 0.1, step: 0.1, recoverMs: 30_000, specShare: 0.5 },
  other: { capacity: 3, rate: 1, minRate: 0.2, step: 0.2, recoverMs: 30_000, specShare: 0.5 },
};

function lichessClassOf(url: string): LichessClass {
  if (/\/api\/games\/user\//.test(url)) return "games";
  if (/\/api\/(swiss|tournament)\/[^/]+\/(games|results)|\/api\/team\/[^/]+\/(swiss|arena)/.test(url)) return "export";
  if (/\/api\/(user\/|users\b|player\/autocomplete)/.test(url)) return "user";
  return "other";
}

const chesscomScheduler = new RateScheduler("chesscom", CHESSCOM_BUCKET);
const lichessSchedulers: Record<LichessClass, RateScheduler> = {
  user: new RateScheduler("lichess:user", LICHESS_BUCKETS.user),
  games: new RateScheduler("lichess:games", LICHESS_BUCKETS.games),
  export: new RateScheduler("lichess:export", LICHESS_BUCKETS.export),
  other: new RateScheduler("lichess:other", LICHESS_BUCKETS.other),
};

/** Backpressure for section fan-out: true while proven work is already
 *  waiting on the Chess.com or Lichess buckets. A new section worker started
 *  now would only lengthen the queue. */
export function allocatorSaturated(): boolean {
  if (chesscomScheduler.depth("proven") >= 8) return true;
  return lichessSchedulers.games.depth("proven") >= 4 || lichessSchedulers.export.depth("proven") >= 2;
}

/** Override a bucket's config (tests / tuning). */
export function configureAllocator(target: "chesscom" | LichessClass, cfg: Partial<BucketConfig>): void {
  const s = target === "chesscom" ? chesscomScheduler : lichessSchedulers[target];
  s.cfg = { ...s.cfg, ...cfg };
  s.reset();
}

/** Back-compat shim: the old light-lane gap, expressed as a Chess.com rate. */
export function setChesscomGapMs(ms: number): void {
  const rate = ms > 0 ? 1000 / ms : CHESSCOM_BUCKET.rate;
  configureAllocator("chesscom", { rate, minRate: Math.min(CHESSCOM_BUCKET.minRate, rate) });
}

/** In-flight cap on Chess.com requests. The bucket, not this, governs the
 *  rate; the cap only stops a few slow multi-MB downloads from holding every
 *  socket. The conductor can still retune it. */
const CC_MAX_INFLIGHT = 12;
export const chesscomGate = semaphore(CC_MAX_INFLIGHT);

// Lichess's published rule is one request at a time. Streamed bodies keep
// downloading outside the gate on their own single-file lanes.
const LICHESS_MAX_INFLIGHT = 1;
export const lichessGate = semaphore(LICHESS_MAX_INFLIGHT);
/** Bulk exports (a tournament's games, a team's history) run single-file. */
export const lichessExportLane = semaphore(1);
/** Long-lived team-history streams get their own single-file lane. */
export const lichessStreamLane = semaphore(1);

/** Kept for callers that pace themselves; the buckets above do the real work. */
let lichessNextSlot = 0;
export async function lichessSlot(gapMs = 120): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, lichessNextSlot - now);
  lichessNextSlot = Math.max(now, lichessNextSlot) + gapMs;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

/** Classify a Chess.com HTTP status into the endpoint-ladder's decision classes.
 *    ok         — 2xx, a real answer.
 *    absent     — 404, the account/month genuinely does not exist (a VERDICT).
 *    gone       — 410, Chess.com guarantees data will never exist here (permanent).
 *    structural — 500, their code failed building the response (size limits etc.).
 *                 Do NOT retry: a repeat just escalates us toward a 429.
 *    transient  — 502/503/504/524, proxy-layer hiccups worth ONE retry after a wait.
 *    rate       — 429, throttling (handled inside politeFetch by pausing the bucket). */
export type ChesscomStatusClass = "ok" | "absent" | "gone" | "structural" | "transient" | "rate" | "other";
export function classifyChesscomStatus(status: number): ChesscomStatusClass {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "absent";
  if (status === 410) return "gone";
  if (status === 429) return "rate";
  if (status === 500) return "structural";
  if (status === 502 || status === 503 || status === 504 || status === 524) return "transient";
  return "other";
}

// ---------------------------------------------------------------------------
// Lichess 429 backoff. Measured: the 429 carries no Retry-After, and a single
// overrun cleared within 7 s. So: honour Retry-After if Lichess ever sends it;
// otherwise 6 s doubling per consecutive 429 on the same endpoint class within
// two minutes, ±20% jitter, capped at the 60 s Lichess's docs ask for. The old
// flat 20 s pause was both longer than a single overrun needs and too short to
// stop a repeat (prior session: a block that lasted 40+ minutes).
// ---------------------------------------------------------------------------

const LICHESS_BACKOFF_BASE_MS = 6_000;
const LICHESS_BACKOFF_CEIL_MS = 60_000;
const LICHESS_STREAK_WINDOW_MS = 120_000;
const lichessStreak: Record<LichessClass, { n: number; at: number }> = {
  user: { n: 0, at: 0 },
  games: { n: 0, at: 0 },
  export: { n: 0, at: 0 },
  other: { n: 0, at: 0 },
};

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// Lichess saturation breaker, PER ENDPOINT CLASS. Acceptance players #6 and
// #22 each drew 30–46 Lichess 429s within minutes; every queued request
// retried through pauses of up to 60 s, which kept the block alive, and both
// searches made no progress for 13–20 minutes. After
// LICHESS_SATURATION_EVENTS rate-limit events on one endpoint class inside
// LICHESS_SATURATION_WINDOW_MS, every request of THAT class (proven too) fails
// fast for the cool-off. The engine reads that as a retryable hole and moves
// on to work that does not need it.
//
// Measured 2026-10-03 (docs/roster-index.md 4.3): Lichess blocks per class.
// /api/games/user tripped on the 10th request at 2/s and cleared in 1.3–3.4 s,
// four trips in a row, with no escalation; after a 40-request overrun it still
// cleared in 1.5 s. /api/user/{name} meanwhile stayed 429 for every name for
// at least 13.7 minutes, while /api/users/status, autocomplete and the
// tournament exports kept answering 200. So one class's block must not take
// the others down (the first version dropped ALL Lichess requests), and a
// class that 429s again right after its cool-off is still in a long penalty:
// the cool-off doubles each time, from 90 s up to 15 minutes.
const LICHESS_SATURATION_EVENTS = 4;
const LICHESS_SATURATION_WINDOW_MS = 120_000;
const LICHESS_SATURATION_COOLOFF_MS = 90_000;
const LICHESS_SATURATION_COOLOFF_MAX_MS = 15 * 60_000;
interface ClassBreaker {
  times: number[];
  until: number;
  /** Cool-off to apply at the next trip (doubles on a re-trip). */
  next: number;
}
const freshClassBreaker = (): ClassBreaker => ({ times: [], until: 0, next: LICHESS_SATURATION_COOLOFF_MS });
let lichessBreakers: Record<LichessClass, ClassBreaker> = {
  user: freshClassBreaker(),
  games: freshClassBreaker(),
  export: freshClassBreaker(),
  other: freshClassBreaker(),
};

/** Thrown to a Lichess request refused while its endpoint class is saturated. */
export class PlatformSaturated extends Error {
  constructor(cls = "") {
    super(`lichess is rate-limiting ${cls ? cls + " requests from " : ""}this address — failing fast during the cool-off`);
    this.name = "PlatformSaturated";
  }
}

/** Record a Lichess rate-limit event on a class; returns true when it trips. */
function noteLichessLimit(cls: LichessClass, now = Date.now()): boolean {
  const b = lichessBreakers[cls];
  // A 429 soon after a cool-off ended: the penalty is still running. Re-trip
  // at once, for twice as long.
  const reTrip = b.until > 0 && now >= b.until && now - b.until < LICHESS_SATURATION_WINDOW_MS;
  b.times = b.times.filter((t) => now - t < LICHESS_SATURATION_WINDOW_MS);
  b.times.push(now);
  if (now < b.until) return false;
  if (!reTrip && b.times.length < LICHESS_SATURATION_EVENTS) {
    if (b.until > 0 && now - b.until >= LICHESS_SATURATION_WINDOW_MS) b.next = LICHESS_SATURATION_COOLOFF_MS; // calm since
    return false;
  }
  const cool = reTrip ? Math.min(LICHESS_SATURATION_COOLOFF_MAX_MS, b.next * 2) : b.next;
  b.next = cool;
  b.until = now + cool;
  b.times = [];
  lichessSchedulers[cls].dropAll(() => new PlatformSaturated(cls));
  return true;
}

/** Is this class (or, with no class, any class) in its cool-off? */
export function lichessSaturated(now = Date.now(), cls?: LichessClass): boolean {
  if (cls) return now < lichessBreakers[cls].until;
  return Object.values(lichessBreakers).some((b) => now < b.until);
}

/** TEST-ONLY: record a rate-limit event on a class at a given time. */
export function _noteLichessLimit(cls: LichessClass, now: number): boolean {
  return noteLichessLimit(cls, now);
}

/** Exported for tests: the current cool-off of a class (ms left). */
export function lichessCooloffLeft(cls: LichessClass, now = Date.now()): number {
  return Math.max(0, lichessBreakers[cls].until - now);
}

/** Exported for tests: the pause a Lichess 429 earns. */
export function lichessBackoffMs(cls: LichessClass, res: Response | null, now = Date.now(), rand = Math.random()): number {
  const st = lichessStreak[cls];
  st.n = now - st.at < LICHESS_STREAK_WINDOW_MS ? st.n + 1 : 1;
  st.at = now;
  const ra = res ? retryAfterMs(res) : undefined;
  if (ra !== undefined) return Math.min(LICHESS_BACKOFF_CEIL_MS, ra);
  const base = LICHESS_BACKOFF_BASE_MS * Math.pow(2, st.n - 1);
  const jitter = 1 + (rand * 0.4 - 0.2);
  return Math.min(LICHESS_BACKOFF_CEIL_MS, Math.round(base * jitter));
}

export type NetPlatform = "chesscom" | "lichess";

// ---------------------------------------------------------------------------
// Per-request accounting.
// ---------------------------------------------------------------------------

export interface LaneStats {
  requests: number;
  statuses: Record<string, number>;
  /** Queue wait per request (ms), for medians. Capped at 20k samples. */
  waits: number[];
  byClass: Record<string, number>;
}

export interface NetStats {
  chesscom: Record<Lane, LaneStats>;
  lichess: Record<Lane, LaneStats>;
  limitEvents: { chesscom: number; lichess: number };
  /** Speculative requests dropped under rate pressure (never sent). */
  shed: { chesscom: number; lichess: number };
}

const blankLane = (): LaneStats => ({ requests: 0, statuses: {}, waits: [], byClass: {} });
let netStats: NetStats = {
  chesscom: { proven: blankLane(), speculative: blankLane() },
  lichess: { proven: blankLane(), speculative: blankLane() },
  limitEvents: { chesscom: 0, lichess: 0 },
  shed: { chesscom: 0, lichess: 0 },
};

export function getNetStats(): NetStats {
  return netStats;
}

export function resetNetStats(): void {
  netStats = {
    chesscom: { proven: blankLane(), speculative: blankLane() },
    lichess: { proven: blankLane(), speculative: blankLane() },
    limitEvents: { chesscom: 0, lichess: 0 },
    shed: { chesscom: 0, lichess: 0 },
  };
}

function chesscomClassOf(url: string): string {
  if (/\/games\/\d{4}\/\d{2}/.test(url)) return "archive-month";
  if (/\/games\/archives/.test(url)) return "archives-list";
  if (/\/stats$/.test(url)) return "stats";
  if (/\/clubs$/.test(url)) return "clubs";
  if (/\/tournament\//.test(url)) return "tournament";
  if (/\/pub\/player\/[^/?]+$/.test(url)) return "profile";
  return "other";
}

function record(platform: NetPlatform, lane: Lane, url: string, status: number | string, waitMs: number): void {
  const s = netStats[platform][lane];
  s.requests++;
  s.statuses[String(status)] = (s.statuses[String(status)] || 0) + 1;
  if (s.waits.length < 20_000) s.waits.push(waitMs);
  const cls = platform === "chesscom" ? chesscomClassOf(url) : lichessClassOf(url);
  s.byClass[cls] = (s.byClass[cls] || 0) + 1;
}

// ---------------------------------------------------------------------------
// Net observer — the conductor's ear on the wire.
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

// ---------------------------------------------------------------------------
// Platform-outage circuit breaker. After BREAK_THRESHOLD consecutive transport
// failures the circuit opens and politeFetch fast-fails for BREAK_COOLDOWN_MS,
// then lets one probe through. Any HTTP response resets the count.
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

function breakerAdmit(platform: NetPlatform): boolean {
  const b = breakers[platform];
  if (b.fails < BREAK_THRESHOLD) return false;
  if (Date.now() >= b.openUntil && !b.probing) {
    b.probing = true;
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

/** TEST-ONLY: reset breaker and allocator state between test scenarios. */
export function _resetBreakers(): void {
  for (const b of Object.values(breakers)) {
    b.fails = 0;
    b.openUntil = 0;
    b.probing = false;
  }
  chesscomScheduler.reset();
  for (const s of Object.values(lichessSchedulers)) s.reset();
  for (const st of Object.values(lichessStreak)) {
    st.n = 0;
    st.at = 0;
  }
  lichessBreakers = { user: freshClassBreaker(), games: freshClassBreaker(), export: freshClassBreaker(), other: freshClassBreaker() };
}

// In a browser a Cloudflare challenge carries no CORS header, so the page
// sees `TypeError: Failed to fetch`, never the 429 (measured in a real tab by
// the previous session). Several such failures close together while the
// platform is otherwise answering are treated as a rate-limit signal.
const CC_FAIL_CLUSTER = 3;
const CC_FAIL_CLUSTER_MS = 2_000;
let ccRecentFails: number[] = [];

// A descriptive User-Agent with a contact URL on every request from a runtime
// that lets us set one (Node, Deno). Chess.com answers an absent or tool-default
// UA with 403. Browsers send their own UA and treat this header as forbidden
// (setting it would also force a CORS preflight), so it is left alone there.
const CONTACT_UA = "ScoutTree/1.0 (+https://chess-scout.vercel.app)";
const IS_BROWSER =
  typeof navigator !== "undefined" && typeof navigator.userAgent === "string" && navigator.userAgent.startsWith("Mozilla");

function withUa(init: RequestInit): RequestInit {
  if (IS_BROWSER) return init;
  const headers = new Headers(init.headers || {});
  if (!headers.has("User-Agent")) headers.set("User-Agent", CONTACT_UA);
  return { ...init, headers };
}

// ---------------------------------------------------------------------------
// Body guard. politeFetch's timeout and abort wiring end when the HEADERS
// arrive; a body that then stalls (a long NDJSON stream Lichess stops
// feeding) would leave `await reader.read()` / `res.text()` pending forever,
// deaf to the search's abort signal. Measured: one Phase 6 search
// (docs/roster-index.md) did not end when its 25-minute guard aborted it and
// was killed two minutes later; the only streamed read in the stack is the
// Lichess team-history stream, which holds a single-file lane while it runs.
// So every response body is re-wrapped: a read rejects on abort, and after
// BODY_IDLE_MS without a byte.
// ---------------------------------------------------------------------------

export const BODY_IDLE_MS = 30_000;

export function guardBody(res: Response, signal: AbortSignal | undefined, idleMs = BODY_IDLE_MS): Response {
  if (!res.body) return res;
  const src = res.body.getReader();
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined); // observed by the race below, never unhandled
  const detach = () => {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`response body idle for ${Math.round(idleMs / 1000)} s`)), idleMs);
      });
      try {
        const { value, done } = await Promise.race([src.read(), idle, aborted]);
        if (done) {
          detach();
          ctrl.close();
        } else ctrl.enqueue(value);
      } catch (e) {
        detach();
        src.cancel().catch(() => undefined);
        ctrl.error(e);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      detach();
      return src.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * Fetch with the platform's discipline applied:
 *   • a token from the platform's bucket, proven work first;
 *   • a slot in the platform's in-flight gate;
 *   • a per-attempt timeout;
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
  const lane: Lane = isSpeculativeSignal(outer) || (init as { priority?: string }).priority === "low" ? "speculative" : "proven";
  const reqInit = withUa(init);
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
        return await fetch(url, { ...reqInit, signal: controller.signal });
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
      }
    };
    const isProbe = breakerAdmit(platform);
    const lcls = platform === "lichess" ? lichessClassOf(url) : null;
    if (lcls && lichessSaturated(Date.now(), lcls)) {
      netStats.shed.lichess++;
      throw new PlatformSaturated(lcls);
    }
    const scheduler = platform === "chesscom" ? chesscomScheduler : lichessSchedulers[lcls!];
    let res: Response;
    let waitMs = 0;
    try {
      waitMs = await scheduler.acquire(lane, outer);
      const gate = platform === "chesscom" ? chesscomGate : lichessGate;
      res = await gate.run(attemptOnce);
      breakerSuccess(platform);
      record(platform, lane, url, res.status, waitMs);
      notifyNet(platform, res.status === 429 ? "429" : "ok");
    } catch (e) {
      if (e instanceof SpeculativeShed || e instanceof PlatformSaturated) {
        netStats.shed[platform]++;
        throw e; // never sent; callers read it as a transient miss
      }
      if (!outer?.aborted) {
        record(platform, lane, url, "THROW", waitMs);
        breakerFailure(platform);
        notifyNet(platform, "fail");
        if (platform === "chesscom") {
          const now = Date.now();
          ccRecentFails = ccRecentFails.filter((t) => now - t < CC_FAIL_CLUSTER_MS);
          ccRecentFails.push(now);
          if (ccRecentFails.length >= CC_FAIL_CLUSTER) {
            ccRecentFails = [];
            netStats.limitEvents.chesscom++;
            chesscomScheduler.onLimit(CHESSCOM_LIMIT_PAUSE_MS);
          }
        }
      } else if (isProbe) breakers[platform].probing = false;
      if (outer?.aborted || attempt >= 2) throw e;
      await sleep(500 * (attempt + 1));
      continue;
    }
    if (res.status === 429 && lane === "speculative") {
      // A speculative request is never retried: report the limit, shed the
      // rest of the speculative queue, and let the caller treat it as a miss.
      if (platform === "chesscom") {
        netStats.limitEvents.chesscom++;
        chesscomScheduler.onLimit(CHESSCOM_LIMIT_PAUSE_MS);
      } else {
        netStats.limitEvents.lichess++;
        scheduler.onLimit(lichessBackoffMs(lcls!, res));
        noteLichessLimit(lcls!);
      }
      return guardBody(res, outer);
    }
    if (res.status === 429 && attempt < maxRetries && !outer?.aborted) {
      let backoff: number;
      if (platform === "chesscom") {
        netStats.limitEvents.chesscom++;
        backoff = CHESSCOM_LIMIT_PAUSE_MS * (attempt + 1);
        chesscomScheduler.onLimit(backoff);
        console.warn(`[net] Chess.com 429 on ${url} — bucket rate now ${chesscomScheduler.rate.toFixed(1)}/s, paused ${backoff}ms.`);
      } else {
        netStats.limitEvents.lichess++;
        backoff = lichessBackoffMs(lcls!, res);
        scheduler.onLimit(backoff);
        if (noteLichessLimit(lcls!)) {
          console.warn(`[net] Lichess ${lcls} requests are saturated — failing them fast for ${Math.round(lichessCooloffLeft(lcls!) / 1000)}s (other Lichess endpoints unaffected).`);
          return guardBody(res, outer); // no retry into a saturated endpoint class
        }
        console.warn(`[net] Lichess 429 (${lcls}) on ${url} — pausing that endpoint class ${Math.round(backoff / 1000)}s.`);
      }
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      // The scheduler holds the pause; the retry simply queues behind it.
      continue;
    }
    return guardBody(res, outer);
  }
}
