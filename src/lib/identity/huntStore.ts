// ============================================================================
// Hunt store — the backgroundable search.
//
// The discovery run used to live inside the FindPlayer page's component state,
// which made the wait a hostage situation: navigating away killed the search.
// This module owns the running hunt at MODULE level (the same pattern
// Report.tsx proves for Stockfish): FindPlayer subscribes with
// useSyncExternalStore, a slim banner reports back from any other page, and
// "Keep searching in background" is just… leaving.
//
// One hunt at a time — exactly one search conducts in this app (net.ts's
// observer slot makes the same assumption).
// ============================================================================

import {
  discoverAccounts,
  resolveIdentity,
  storeResolvedHandle,
  type ConfirmedAnchor,
  type DiscoveredAccount,
  type DiscoverOptions,
  type MemberSearchHit,
  type PlayerQuery,
  type ProgressSnapshot,
  type ResolutionResult,
  type SearchEvent,
} from "./index";

// Same tail-bounding discipline the old page used: a long traversal emits
// THOUSANDS of events; an unbounded list freezes the tab.
const EVENT_TAIL_KEPT = 200;
const EVENT_TAIL_TRIM_AT = 260;
/** Streamed find list cap — the results page shows the full ranked set. */
const FOUND_ACCOUNTS_SHOWN = 8;

export type HuntPhase = "idle" | "running" | "done";

export interface HuntState {
  phase: HuntPhase;
  /** "discovery" = picker-confirmed anchor; "legacy" = old free-text flow. */
  kind: "discovery" | "legacy";
  /** The confirmed member, when this is an anchored discovery run. */
  anchor: MemberSearchHit | null;
  targetName: string;
  events: SearchEvent[];
  providerStatus: Record<string, "running" | "done">;
  matched: boolean;
  progress: ProgressSnapshot | null;
  foundAccounts: DiscoveredAccount[];
  result: ResolutionResult | null;
  error: string | null;
  stopping: boolean;
  backgrounded: boolean;
  startedAt: number;
}

const IDLE: HuntState = {
  phase: "idle",
  kind: "discovery",
  anchor: null,
  targetName: "",
  events: [],
  providerStatus: {},
  matched: false,
  progress: null,
  foundAccounts: [],
  result: null,
  error: null,
  stopping: false,
  backgrounded: false,
  startedAt: 0,
};

let state: HuntState = IDLE;
const listeners = new Set<() => void>();
let abortController: AbortController | null = null;
let softStopFlag = false;
let runSeq = 0;
// The FULL unabridged log (unlike the bounded tail in state) — the View Log
// dialog reads it on demand; appending never triggers a re-render.
let fullLog: SearchEvent[] = [];

function setState(patch: Partial<HuntState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a subscriber bug must never break the hunt */
    }
  }
}

export function subscribeHunt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHuntState(): HuntState {
  return state;
}

export function getHuntFullLog(): SearchEvent[] {
  return fullLog;
}

export function setHuntBackgrounded(backgrounded: boolean): void {
  if (state.phase === "idle") return;
  setState({ backgrounded });
}

/** SOFT stop: the engines stand down gracefully and the run completes with
 *  everything found so far ("Stop and keep what you found"). */
export function softStopHunt(): void {
  if (state.phase !== "running") return;
  softStopFlag = true;
  setState({ stopping: true });
}

/** HARD stop: abort and discard — "New search". */
export function abortHunt(): void {
  abortController?.abort();
  abortController = null;
  runSeq++;
  fullLog = [];
  state = IDLE;
  for (const l of listeners) l();
}

/** Reset after the user consumed the result. */
export function clearHunt(): void {
  if (state.phase === "running") return abortHunt();
  fullLog = [];
  state = IDLE;
  for (const l of listeners) l();
}

// ---------------------------------------------------------------------------
// Shared run plumbing
// ---------------------------------------------------------------------------

function makeCallbacks(seq: number) {
  const onEvent = (event: SearchEvent) => {
    if (seq !== runSeq) return;
    fullLog.push(event);
    const events =
      state.events.length >= EVENT_TAIL_TRIM_AT
        ? [...state.events.slice(state.events.length - EVENT_TAIL_KEPT), event]
        : [...state.events, event];
    const patch: Partial<HuntState> = { events };
    if (event.provider) {
      const next = event.status === "done" ? "done" : state.providerStatus[event.provider] ?? "running";
      if (state.providerStatus[event.provider] !== next) {
        patch.providerStatus = { ...state.providerStatus, [event.provider]: next };
      }
    }
    if (event.message.includes("✔ Match")) patch.matched = true;
    setState(patch);
  };

  const onAccount = (account: DiscoveredAccount) => {
    if (seq !== runSeq) return;
    const key = (a: DiscoveredAccount) => `${a.platform}:${a.username.toLowerCase()}`;
    if (state.foundAccounts.some((a) => key(a) === key(account))) return;
    const foundAccounts = [...state.foundAccounts, account]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, FOUND_ACCOUNTS_SHOWN);
    setState({ foundAccounts });
  };

  const onProgress = (progress: ProgressSnapshot) => {
    if (seq !== runSeq) return;
    setState({ progress });
  };

  return { onEvent, onAccount, onProgress };
}

/** Feed the moat: every identity-confirmed find for the anchored member is
 *  written to resolved_handles (fire-and-forget — the UI never waits on it). */
function persistConfirmedHandles(anchor: ConfirmedAnchor, result: ResolutionResult): void {
  const anchorId = anchor.uscfId.replace(/\D/g, "");
  for (const identity of result.identities) {
    // Only the identity that IS the anchored member (or carries no contradicting ID).
    const idDigits = (identity.uscfId || "").replace(/\D/g, "");
    if (idDigits && idDigits !== anchorId) continue;
    for (const acc of identity.accounts) {
      const namesake = acc.evidence?.some((e) => /namesake/i.test(e.label));
      if (!acc.verified || namesake || acc.confidence < 0.75) continue;
      if (acc.platform !== "chesscom" && acc.platform !== "lichess") continue;
      void storeResolvedHandle({
        uscfId: anchorId,
        platform: acc.platform,
        username: acc.username,
        confidence: acc.confidence,
        evidence: acc.evidence?.slice(0, 12).map((e) => ({ kind: e.kind, weight: e.weight, label: e.label, source: e.source })),
        source: "engine",
      });
    }
  }
}

async function run(
  seq: number,
  targetName: string,
  work: (cb: ReturnType<typeof makeCallbacks>, signal: AbortSignal, shouldStop: () => boolean) => Promise<ResolutionResult>
): Promise<void> {
  const controller = new AbortController();
  abortController = controller;
  const cb = makeCallbacks(seq);
  try {
    const result = await work(cb, controller.signal, () => softStopFlag);
    if (seq !== runSeq) return; // superseded by a newer run / hard abort
    setState({ phase: "done", result, stopping: false });
  } catch (err) {
    if (seq !== runSeq) return;
    if ((err as Error)?.name === "AbortError") return; // hard abort already reset state
    console.error("[hunt] resolution failed:", err);
    setState({
      phase: "done",
      result: null,
      stopping: false,
      error: err instanceof Error ? err.message : "Search failed. Please try again.",
    });
  }
}

// ---------------------------------------------------------------------------
// Public starters
// ---------------------------------------------------------------------------

/** The anchored path: discovery over a picker-confirmed person. */
export function startDiscovery(
  member: MemberSearchHit,
  options: { clues?: DiscoverOptions["clues"]; allowSocial?: boolean } = {}
): void {
  abortHunt(); // one hunt at a time; a stale run must not write into the new one
  const seq = ++runSeq;
  softStopFlag = false;
  fullLog = [];
  state = {
    ...IDLE,
    phase: "running",
    kind: "discovery",
    anchor: member,
    targetName: member.name,
    startedAt: Date.now(),
  };
  for (const l of listeners) l();

  const anchor: ConfirmedAnchor = {
    uscfId: member.uscfId,
    name: member.name,
    state: member.state,
    fideId: member.fideId,
    approxRating: member.ratings.onlineRegular ?? member.rating,
    hasOnline: member.hasOnline,
  };
  void run(seq, member.name, (cb, signal, shouldStop) =>
    discoverAccounts(anchor, {
      signal,
      shouldStop,
      allowSocial: options.allowSocial,
      clues: options.clues,
      ...cb,
    }).then((result) => {
      if (seq === runSeq) persistConfirmedHandles(anchor, result);
      return result;
    })
  );
}

/** The legacy path: the full combined pipeline over free-text clues (no-USCF
 *  branch, FIDE-only players, school-first searches). Same engine as always. */
export function startLegacySearch(query: PlayerQuery, options: { allowSocial?: boolean } = {}): void {
  abortHunt();
  const seq = ++runSeq;
  softStopFlag = false;
  fullLog = [];
  state = {
    ...IDLE,
    phase: "running",
    kind: "legacy",
    anchor: null,
    targetName: query.name,
    startedAt: Date.now(),
  };
  for (const l of listeners) l();

  void run(seq, query.name, (cb, signal, shouldStop) =>
    resolveIdentity(query, { signal, shouldStop, allowSocial: options.allowSocial, ...cb })
  );
}
