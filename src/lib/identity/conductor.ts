// ============================================================================
// Identity Resolution Engine — the CONDUCTOR (proactive intelligence layer)
//
// The engines already EMIT rich real-time signals (phase timings, agent
// counts, per-trace log activity, candidate confidences, 429s) — but until now
// those signals only fed logging and the detective UI. The conductor turns
// them into autonomous, strategy-level decisions while a search is running:
//
//   COLLECT — engines push signals through cheap synchronous calls (every
//     ingestion is O(1) bookkeeping, no awaits, never throws): trace
//     started/activity/ended, queue depth, anchors resolved, candidate found.
//     net.ts reports every 429/ok through the module observer, and the global
//     Chess.com gate is sampled each tick for occupancy.
//
//   EVALUATE — a once-per-second tick runs threshold/heuristic policies over
//     the aggregated view (plus one event-driven policy on candidate reports):
//       • RATE GOVERNOR    — a burst of 429s steps the Chess.com HTTP gate and
//                            the seed-scout fleet down before throttling turns
//                            into wasted retry latency; a clean window steps
//                            them back up to their defaults.
//       • THROUGHPUT BOOST — free gate slots + pending traces = the fleet is
//                            under-parallelised: raise the seed/trace/event
//                            agent limits (bounded) so queued work drains.
//       • STALL DETECTOR   — a trace that has been quiet well past the typical
//                            completed-trace duration (EMA-based, generous
//                            floors) is stood down and skipped, exactly like
//                            the resolver's own wedge watchdog for the main
//                            traversal.
//       • EARLY EXIT       — a candidate that is federation-ID ANCHORED at
//                            ≥90% is terminal (a unique federation ID cannot
//                            be out-scored by more crawling), so the whole
//                            phase stands down and the answer ships now.
//
//   ACT — engines read the live tuning values at their natural scheduling
//     points (the agent-launch loops re-check limits on every wake) and
//     compose their cooperative stop functions with shouldStandDown()/
//     phaseWon(). Nothing is preempted mid-request; decisions only steer
//     what gets STARTED next. `onChange` lets a long-lived worker pool
//     launch extra workers the moment a limit rises.
//
// ACCURACY CONTRACT: every policy is chosen so it can only preserve or improve
// the result —
//   • the governor changes only HOW FAST requests go out (politeFetch already
//     retries 429s; fewer 429s = less wasted latency, identical data);
//   • the booster only adds parallelism behind the same polite gates;
//   • the stall detector stands a trace down COOPERATIVELY (the engine keeps
//     everything it already found) and only when the trace has been silent
//     past thresholds a healthy trace's own heartbeat cannot trip;
//   • the early exit fires only on a federation-ID-anchored ≥90% candidate —
//     the one evidence class the engine itself treats as decisive.
//
// Dependency-free on purpose (no imports at all): runs in the browser, the
// Node CLI harness and tests alike. Works with zero configuration and no
// optional keys; engines behave exactly as before when no conductor is
// attached.
// ============================================================================

export interface GateStats {
  active: number;
  waiting: number;
  limit: number;
}

/** The slice of net.ts's Gate the conductor drives (injected, not imported —
 *  keeps this module dependency-free and lets tests hand in a fake). */
export interface GateLike {
  stats(): GateStats;
  setLimit(n: number): void;
}

export type NetEventKind = "429" | "ok" | "fail";

export type TraceOutcome = "resolved" | "empty" | "stood-down";

export interface CandidateReport {
  /** 0..1 confidence the reporting engine computed for the candidate. */
  confidence: number;
  /** True when a matching federation ID (USCF/FIDE) anchors the candidate —
   *  the decisive, cannot-be-outranked evidence class. */
  anchored: boolean;
  /** Human-readable handle for the logs, e.g. "@tanneywanney25 on chesscom". */
  label: string;
}

/** Live concurrency knobs the engines consult at their scheduling points. */
export interface ConductorTuning {
  seedAgents(): number;
  traceAgents(): number;
  eventAgents(): number;
  ccGateLimit(): number;
}

export interface Conductor {
  tuning: ConductorTuning;

  // --- signals in (synchronous, O(1), never throw) --------------------------
  /** net.ts observer: every polite fetch reports its outcome here. */
  netEvent(platform: string, kind: NetEventKind): void;
  /** Register a long-running unit of work (e.g. one schoolmate trace).
   *  Returns the trace id used for activity pings and stand-down checks. */
  traceStarted(scope: string, label: string): string;
  /** Any sign of life from the trace (each engine log line counts). */
  traceActivity(id: string): void;
  traceEnded(id: string, outcome: TraceOutcome): void;
  /** Latest queue depth for a scope (pending work items, running agents). */
  reportQueue(scope: string, pending: number, running: number): void;
  /** One more anchor (e.g. resolved schoolmate) landed in `scope`. */
  anchorResolved(scope: string): void;
  /** A scored candidate surfaced mid-phase; an anchored ≥90% one wins the
   *  phase on the spot. */
  reportCandidate(scope: string, candidate: CandidateReport): void;
  probeStarted(scope: string): void;
  probeEnded(scope: string): void;

  // --- decisions out --------------------------------------------------------
  /** Should this trace wind down now? (stalled, or its phase already won) */
  shouldStandDown(id: string): boolean;
  /** Was this trace specifically marked stalled? (for the caller's logging) */
  wasStoodDown(id: string): boolean;
  /** Has an anchored ≥90% candidate already won this scope? */
  phaseWon(scope: string): boolean;
  /** Is now a good moment for the caller to run a mid-phase probe? */
  wantsProbe(scope: string): boolean;
  /** Subscribe to tuning changes (elastic pools launch workers on raise).
   *  Returns the unsubscribe function. */
  onChange(listener: () => void): () => void;

  // --- lifecycle ------------------------------------------------------------
  /** Run one evaluation round now (the auto tick calls this every tickMs). */
  tick(): void;
  /** Stop the tick, restore the gate's original limit, detach everything. */
  dispose(): void;
}

export interface ConductorOptions {
  /** Where decisions are narrated ("Conductor: …"). Default: silent. */
  log?: (message: string) => void;
  /** The global Chess.com gate to govern (net.ts's chesscomGate). */
  gate?: GateLike;
  /** Evaluation cadence. 0 disables the auto tick (tests drive tick()). */
  tickMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Policy constants. Defaults mirror the engines' own static fleet sizes so an
// untouched conductor changes nothing; bounds keep every adjustment polite.
// ---------------------------------------------------------------------------

const TICK_MS = 1_000;

// Agent-fleet bounds (defaults == the engines' constants).
const SEED_DEF = 6, SEED_MIN = 2, SEED_MAX = 12;
const TRACE_DEF = 3, TRACE_MIN = 1, TRACE_MAX = 6;
const EVENT_DEF = 4, EVENT_MIN = 1, EVENT_MAX = 6;

// Rate governor: N 429s inside the window trips a step-down; a fully clean
// window restores one step at a time.
const RATE_WINDOW_MS = 15_000;
const RATE_TRIP_COUNT = 3;
const RATE_RECOVER_MS = 30_000;
const GATE_FLOOR = 4;
const STEP_DOWN_COOLDOWN_MS = 5_000;
const STEP_UP_COOLDOWN_MS = 10_000;

// Throughput booster: gate occupancy EMA below this fraction of the limit
// counts as "free slots"; queue reports older than this are ignored.
const OCC_ALPHA = 0.3;
const IDLE_OCCUPANCY = 0.5;
const QUEUE_FRESH_MS = 10_000;
const BOOST_COOLDOWN_MS = 10_000;

// Stall detector: a trace is stalled only when BOTH hold — total runtime past
// max(floor, factor × typical completed duration) AND no sign of life for the
// quiet window. The engines heartbeat every ~25s when healthy, so a live trace
// cannot trip the 45s quiet bar.
const STALL_FLOOR_MS = 90_000;
const STALL_EMA_FACTOR = 3;
const STALL_QUIET_MS = 45_000;
const EMA_ALPHA = 0.3;
const EMA_MIN_SAMPLES = 2;

// Early exit / probe pacing.
const EARLY_EXIT_CONFIDENCE = 0.9;
const PROBE_MIN_ANCHORS = 4;
const PROBE_STRIDE = 4;

interface TraceRec {
  scope: string;
  label: string;
  startedAt: number;
  lastActivityAt: number;
  running: boolean;
  stoodDown: boolean;
}

interface ScopeRec {
  emaMs?: number;
  samples: number;
  anchors: number;
  lastProbeAnchors: number;
  probing: boolean;
  won: boolean;
}

interface QueueRec {
  pending: number;
  running: number;
  at: number;
}

export function createConductor(options: ConductorOptions = {}): Conductor {
  const now = options.now ?? Date.now;
  const log = (m: string) => {
    try {
      options.log?.(m);
    } catch {
      /* the UI must never break the pipeline */
    }
  };
  const gate = options.gate;

  let disposed = false;
  const traces = new Map<string, TraceRec>();
  const scopes = new Map<string, ScopeRec>();
  const queues = new Map<string, QueueRec>();
  const listeners = new Set<() => void>();
  let traceSeq = 0;

  const scopeOf = (scope: string): ScopeRec => {
    let s = scopes.get(scope);
    if (!s) scopes.set(scope, (s = { samples: 0, anchors: 0, lastProbeAnchors: 0, probing: false, won: false }));
    return s;
  };

  // --- tuning state ----------------------------------------------------------
  const originalGateLimit = gate?.stats().limit;
  let ccGateLimit = originalGateLimit ?? 12;
  const gateDefault = ccGateLimit;
  let seedAgents = SEED_DEF;
  let traceAgents = TRACE_DEF;
  let eventAgents = EVENT_DEF;

  const notifyChange = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        /* listener errors must not stop the conductor */
      }
    }
  };

  const applyGate = (n: number) => {
    ccGateLimit = n;
    try {
      gate?.setLimit(n);
    } catch {
      /* a broken gate must not stop the search */
    }
  };

  // --- net window ------------------------------------------------------------
  let recent429: number[] = []; // timestamps inside RATE_WINDOW_MS
  let last429At = 0;
  let lastAdjustAt = 0;
  let lastBoostAt = 0;
  let occupancyEma = 0;

  // --- policies --------------------------------------------------------------

  const governor = () => {
    const t = now();
    recent429 = recent429.filter((at) => t - at <= RATE_WINDOW_MS);

    // Step DOWN: a burst of 429s means the fleet is outrunning the platform.
    if (recent429.length >= RATE_TRIP_COUNT && t - lastAdjustAt > STEP_DOWN_COOLDOWN_MS) {
      const nextGate = Math.max(GATE_FLOOR, Math.round(ccGateLimit * 0.6));
      const nextSeed = Math.max(SEED_MIN, seedAgents - 2);
      if (nextGate < ccGateLimit || nextSeed < seedAgents) {
        lastAdjustAt = t;
        const bits: string[] = [];
        if (nextGate < ccGateLimit) {
          bits.push(`chess.com concurrency ${ccGateLimit}→${nextGate}`);
          applyGate(nextGate);
        }
        if (nextSeed < seedAgents) {
          bits.push(`seed scouts ${seedAgents}→${nextSeed}`);
          seedAgents = nextSeed;
        }
        log(
          `Conductor: ${recent429.length} rate-limit response(s) in the last ${Math.round(RATE_WINDOW_MS / 1000)}s — throttling ${bits.join(
            ", "
          )} to avoid 429s.`
        );
        notifyChange();
      }
      return;
    }

    // Step UP: the window has been clean long enough — restore toward defaults.
    if (last429At && t - last429At > RATE_RECOVER_MS && t - lastAdjustAt > STEP_UP_COOLDOWN_MS) {
      const nextGate = Math.min(gateDefault, ccGateLimit + 2);
      const nextSeed = Math.min(SEED_DEF, seedAgents + 1);
      if (nextGate > ccGateLimit || nextSeed > seedAgents) {
        lastAdjustAt = t;
        const bits: string[] = [];
        if (nextGate > ccGateLimit) {
          bits.push(`chess.com concurrency ${ccGateLimit}→${nextGate}`);
          applyGate(nextGate);
        }
        if (nextSeed > seedAgents) {
          bits.push(`seed scouts ${seedAgents}→${nextSeed}`);
          seedAgents = nextSeed;
        }
        log(`Conductor: rate limits clear for ${Math.round(RATE_RECOVER_MS / 1000)}s — restoring ${bits.join(", ")}.`);
        notifyChange();
      }
    }
  };

  const booster = () => {
    const t = now();
    if (last429At && t - last429At < RATE_RECOVER_MS) return; // net not clean — never boost into throttling
    if (t - lastBoostAt < BOOST_COOLDOWN_MS) return;
    const stats = gate?.stats();
    if (stats) {
      occupancyEma = occupancyEma * (1 - OCC_ALPHA) + stats.active * OCC_ALPHA;
      // A gate with waiters, or mostly-busy slots, is the bottleneck — more
      // agents would only lengthen its queue.
      if (stats.waiting > 0 || occupancyEma >= IDLE_OCCUPANCY * stats.limit) return;
    }
    let pending = 0;
    let running = 0;
    for (const q of queues.values()) {
      if (t - q.at > QUEUE_FRESH_MS) continue;
      pending += q.pending;
      running += q.running;
    }
    if (pending <= 0) return;

    const nextSeed = Math.min(SEED_MAX, seedAgents + 2);
    const nextTrace = Math.min(TRACE_MAX, traceAgents + 1);
    const nextEvent = Math.min(EVENT_MAX, eventAgents + 1);
    const bits: string[] = [];
    if (nextSeed > seedAgents) bits.push(`${nextSeed - seedAgents} more seed scout(s) (${seedAgents}→${nextSeed})`);
    if (nextTrace > traceAgents) bits.push(`${nextTrace - traceAgents} more pairing tracer(s) (${traceAgents}→${nextTrace})`);
    if (nextEvent > eventAgents) bits.push(`${nextEvent - eventAgents} more event agent(s) (${eventAgents}→${nextEvent})`);
    if (!bits.length) return;
    lastBoostAt = t;
    seedAgents = nextSeed;
    traceAgents = nextTrace;
    eventAgents = nextEvent;
    log(
      `Conductor: ${
        stats ? `the chess.com gate has free slots (≈${Math.round(occupancyEma)}/${stats.limit} busy)` : `the fleet is under-parallelised`
      } with ${pending} unit(s) of work queued (${running} agent(s) running) — spawning ${bits.join(", ")}.`
    );
    notifyChange();
  };

  const stallScan = () => {
    const t = now();
    for (const [id, trace] of traces) {
      if (!trace.running || trace.stoodDown) continue;
      const scope = scopeOf(trace.scope);
      if (scope.won) continue; // phaseWon already stands everything down
      const typical = scope.samples >= EMA_MIN_SAMPLES ? scope.emaMs : undefined;
      const threshold = Math.max(STALL_FLOOR_MS, typical ? STALL_EMA_FACTOR * typical : 0);
      const elapsed = t - trace.startedAt;
      const quiet = t - trace.lastActivityAt;
      if (elapsed > threshold && quiet > STALL_QUIET_MS) {
        trace.stoodDown = true;
        log(
          `Conductor: cancelled ${trace.scope} trace "${trace.label}" (stalled — ${Math.round(elapsed / 1000)}s in, silent for ${Math.round(
            quiet / 1000
          )}s${typical ? `, typical trace ≈${Math.round(typical / 1000)}s` : ""}) — deprioritizing it and moving on.`
        );
        void id;
      }
    }
  };

  // --- the public object -----------------------------------------------------

  const conductor: Conductor = {
    tuning: {
      seedAgents: () => seedAgents,
      traceAgents: () => traceAgents,
      eventAgents: () => eventAgents,
      ccGateLimit: () => ccGateLimit,
    },

    netEvent(_platform, kind) {
      if (disposed) return;
      if (kind === "429") {
        const t = now();
        recent429.push(t);
        last429At = t;
      }
    },

    traceStarted(scope, label) {
      const id = `t${++traceSeq}`;
      if (disposed) return id;
      const t = now();
      traces.set(id, { scope, label, startedAt: t, lastActivityAt: t, running: true, stoodDown: false });
      return id;
    },

    traceActivity(id) {
      const trace = traces.get(id);
      if (trace) trace.lastActivityAt = now();
    },

    traceEnded(id, outcome) {
      const trace = traces.get(id);
      if (!trace || !trace.running) return;
      trace.running = false;
      if (outcome === "stood-down") return; // a killed trace's duration must not poison the EMA
      const scope = scopeOf(trace.scope);
      const ms = now() - trace.startedAt;
      scope.emaMs = scope.emaMs === undefined ? ms : scope.emaMs * (1 - EMA_ALPHA) + ms * EMA_ALPHA;
      scope.samples++;
    },

    reportQueue(scope, pending, running) {
      if (disposed) return;
      queues.set(scope, { pending: Math.max(0, pending), running: Math.max(0, running), at: now() });
    },

    anchorResolved(scope) {
      if (disposed) return;
      scopeOf(scope).anchors++;
    },

    reportCandidate(scope, candidate) {
      if (disposed) return;
      const s = scopeOf(scope);
      if (s.won) return;
      if (candidate.anchored && candidate.confidence >= EARLY_EXIT_CONFIDENCE) {
        s.won = true;
        log(
          `Conductor: early exiting — target found at ${Math.round(candidate.confidence * 100)}% (${candidate.label}, federation-ID anchored). Standing the remaining traces down.`
        );
      }
    },

    probeStarted(scope) {
      const s = scopeOf(scope);
      s.probing = true;
      s.lastProbeAnchors = s.anchors;
    },

    probeEnded(scope) {
      scopeOf(scope).probing = false;
    },

    shouldStandDown(id) {
      const trace = traces.get(id);
      if (!trace) return false;
      return trace.stoodDown || scopeOf(trace.scope).won;
    },

    wasStoodDown(id) {
      return !!traces.get(id)?.stoodDown;
    },

    phaseWon(scope) {
      return !!scopes.get(scope)?.won;
    },

    wantsProbe(scope) {
      const s = scopes.get(scope);
      if (!s || s.probing || s.won) return false;
      const nextAt = s.lastProbeAnchors === 0 ? PROBE_MIN_ANCHORS : s.lastProbeAnchors + PROBE_STRIDE;
      return s.anchors >= nextAt;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    tick() {
      if (disposed) return;
      try {
        governor();
        booster();
        stallScan();
      } catch {
        /* a policy bug must never take the search down */
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      if (gate && originalGateLimit !== undefined && ccGateLimit !== originalGateLimit) {
        try {
          gate.setLimit(originalGateLimit);
        } catch {
          /* best-effort restore */
        }
      }
      listeners.clear();
    },
  };

  // Auto tick (opt out with tickMs: 0 — tests drive tick() themselves).
  // `unref` (Node only) keeps a leaked conductor from pinning the process.
  const tickMs = options.tickMs ?? TICK_MS;
  const timer = tickMs > 0 ? setInterval(() => conductor.tick(), tickMs) : undefined;
  (timer as unknown as { unref?: () => void } | undefined)?.unref?.();

  return conductor;
}
