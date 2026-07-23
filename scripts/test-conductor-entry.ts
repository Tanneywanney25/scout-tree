// ============================================================================
// Proof harness for the conductor (the proactive-intelligence layer), offline
// (bundled + run by scripts/test-conductor.mjs).
//
//   node scripts/test-conductor.mjs
//
// Unit scenarios drive createConductor() directly with an injected clock and a
// fake gate; the two integration scenarios fake the chess.com/lichess wire and
// drive the REAL school resolver end-to-end to prove the decisions land:
//   1. semaphore setLimit — raising admits waiters instantly, lowering drains
//      without stranding anyone, stats() stays truthful;
//   2. rate governor — a 429 burst steps the gate + seed fleet down (once per
//      cooldown), a clean window restores them, and the booster stays quiet
//      while the window is dirty;
//   3. throughput booster — free gate slots + fresh queued work spawns more
//      agents (bounded, onChange fires); stale queue reports never boost;
//   4. stall detector — a silent trace is stood down at the 90s floor, an
//      active trace never is, and a slow-but-real EMA raises the threshold;
//   5. early exit — probe cadence (4 anchors, then every 4), a NON-anchored
//      90% candidate does NOT win, an anchored 93% one does and stands the
//      scope's traces down;
//   6. dispose — restores the governed gate and ignores late signals;
//   7. INTEGRATION: school resolver early exit — 4 of 6 schoolmates resolve,
//      the conductor probes mid-phase, the probe finds the federation-ID-
//      anchored target at ≥90%, the two still-hanging traces are stood down
//      and the phase returns early with the anchored account;
//   8. INTEGRATION: school resolver stall — a wedged (silent) mate trace is
//      cancelled by the stall policy while a healthy roster completes.
// ============================================================================

import { semaphore, _resetBreakers, setNetObserver } from "../src/lib/identity/net";
import { createConductor, type GateLike } from "../src/lib/identity/conductor";
import { runSchoolResolution, type SchoolResolverHooks } from "../src/lib/identity/schoolResolver";
import { resetSearchCaches } from "../src/lib/identity/cache";
import type { Schoolmate } from "../src/lib/identity/schoolTypes";

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  ✘ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const assert = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake adjustable gate with scripted occupancy. */
function fakeGate(limit: number, active = 0, waiting = 0): GateLike & { calls: number[]; set active(n: number) } {
  let a = active;
  const g = {
    calls: [] as number[],
    stats: () => ({ active: a, waiting, limit }),
    setLimit(n: number) {
      limit = n;
      g.calls.push(n);
    },
    set active(n: number) {
      a = n;
    },
  };
  return g;
}

// ---------------------------------------------------------------------------
// 1. Dynamic semaphore
// ---------------------------------------------------------------------------
async function scenarioSemaphore() {
  console.log("Scenario 1: semaphore setLimit — raise admits waiters, lower drains without stranding");
  const gate = semaphore(2);
  let running = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const task = () =>
    gate.run(
      () =>
        new Promise<void>((res) => {
          running++;
          peak = Math.max(peak, running);
          release.push(() => {
            running--;
            res();
          });
        })
    );
  const tasks = Array.from({ length: 6 }, task);
  await sleep(20);
  let s = gate.stats();
  assert(s.active === 2 && s.waiting === 4, `limit 2: 2 active, 4 waiting (got ${s.active}/${s.waiting})`);
  gate.setLimit(5);
  await sleep(20);
  s = gate.stats();
  assert(s.active === 5 && s.waiting === 1, `raised to 5: three waiters admitted instantly (got ${s.active}/${s.waiting})`);
  gate.setLimit(2);
  release.shift()!();
  await sleep(20);
  s = gate.stats();
  assert(s.active === 4 && s.waiting === 1, `lowered to 2: a release drains without admitting (got ${s.active}/${s.waiting})`);
  release.shift()!();
  release.shift()!();
  await sleep(20);
  s = gate.stats();
  assert(s.active === 2 && s.waiting === 1, `still above the new limit: no admissions (got ${s.active}/${s.waiting})`);
  release.shift()!();
  await sleep(20);
  s = gate.stats();
  assert(s.active === 2 && s.waiting === 0, `below the limit: the last waiter was admitted (got ${s.active}/${s.waiting})`);
  release.shift()!();
  release.shift()!();
  await Promise.all(tasks);
  assert(peak <= 5, `peak concurrency ${peak} never exceeded the highest limit`);
}

// ---------------------------------------------------------------------------
// 2. Rate governor
// ---------------------------------------------------------------------------
function scenarioGovernor() {
  console.log("Scenario 2: rate governor — 429 bursts throttle, clean windows restore");
  let t = 1_000_000;
  const gate = fakeGate(12);
  const logs: string[] = [];
  const c = createConductor({ log: (m) => logs.push(m), gate, tickMs: 0, now: () => t });

  for (let i = 0; i < 3; i++) c.netEvent("chesscom", "429");
  c.tick();
  assert(gate.stats().limit === 7, `429 burst stepped the gate 12→7 (got ${gate.stats().limit})`);
  assert(c.tuning.seedAgents() === 4, `seed scouts stepped 6→4 (got ${c.tuning.seedAgents()})`);
  assert(logs.some((l) => l.includes("throttling")), "the throttle decision was logged");

  // Same burst again inside the cooldown: no double-step.
  c.tick();
  assert(gate.stats().limit === 7, "re-ticking inside the cooldown does not double-step");

  // Booster must stay quiet while the window is dirty, even with queued work.
  c.reportQueue("graph", 25, 5);
  t += 6_000;
  for (let i = 0; i < 3; i++) c.netEvent("chesscom", "429");
  c.tick();
  assert(gate.stats().limit === 4, `second burst stepped 7→4 (the floor; got ${gate.stats().limit})`);
  assert(c.tuning.seedAgents() === 2, `seed scouts at their floor (got ${c.tuning.seedAgents()})`);

  // Clean recovery: step back up once per cooldown until defaults return.
  t += 31_000;
  c.tick();
  assert(gate.stats().limit === 6, `clean window restored the gate one step 4→6 (got ${gate.stats().limit})`);
  assert(logs.some((l) => l.includes("restoring")), "the restore decision was logged");
  for (let i = 0; i < 6; i++) {
    t += 11_000;
    c.tick();
  }
  assert(gate.stats().limit === 12, `gate fully restored to 12 (got ${gate.stats().limit})`);
  assert(c.tuning.seedAgents() === 6, `seed scouts fully restored to 6 (got ${c.tuning.seedAgents()})`);
  c.dispose();
}

// ---------------------------------------------------------------------------
// 3. Throughput booster
// ---------------------------------------------------------------------------
function scenarioBooster() {
  console.log("Scenario 3: booster — free gate slots + queued work spawns more agents");
  let t = 2_000_000;
  const gate = fakeGate(12, 2); // 2 of 12 slots busy — plenty free
  const logs: string[] = [];
  const c = createConductor({ log: (m) => logs.push(m), gate, tickMs: 0, now: () => t });
  let changes = 0;
  c.onChange(() => changes++);

  c.reportQueue("graph", 20, 7);
  c.tick();
  assert(c.tuning.seedAgents() === 8, `seed scouts boosted 6→8 (got ${c.tuning.seedAgents()})`);
  assert(c.tuning.traceAgents() === 4, `pairing tracers boosted 3→4 (got ${c.tuning.traceAgents()})`);
  assert(c.tuning.eventAgents() === 5, `event agents boosted 4→5 (got ${c.tuning.eventAgents()})`);
  assert(changes >= 1, "onChange fired so elastic pools can launch the new workers");
  assert(logs.some((l) => l.includes("spawning")), "the spawn decision was logged");

  // Keep boosting once per cooldown until every fleet is at its cap.
  for (let i = 0; i < 4; i++) {
    t += 11_000;
    c.reportQueue("graph", 20, 7);
    c.tick();
  }
  assert(c.tuning.seedAgents() === 12 && c.tuning.traceAgents() === 6 && c.tuning.eventAgents() === 6, "fleets cap at their bounds");
  const logCount = logs.length;
  t += 11_000;
  c.reportQueue("graph", 20, 7);
  c.tick();
  assert(logs.length === logCount, "at the caps, nothing further is logged or changed");
  c.dispose();

  // Stale queue reports never boost.
  let t2 = 3_000_000;
  const c2 = createConductor({ tickMs: 0, now: () => t2 });
  c2.reportQueue("graph", 20, 7);
  t2 += 11_000; // report is now stale (>10s)
  c2.tick();
  assert(c2.tuning.seedAgents() === 6, "a stale queue report does not boost");
  c2.dispose();

  // A gate with waiters is the bottleneck — never boost into it.
  const t3 = 4_000_000;
  const g3 = fakeGate(12, 12, 5);
  const c3 = createConductor({ gate: g3, tickMs: 0, now: () => t3 });
  c3.reportQueue("graph", 20, 7);
  c3.tick();
  assert(c3.tuning.seedAgents() === 6, "a saturated gate (waiters queued) suppresses the boost");
  c3.dispose();
}

// ---------------------------------------------------------------------------
// 4. Stall detector
// ---------------------------------------------------------------------------
function scenarioStall() {
  console.log("Scenario 4: stall detector — silence past the threshold stands a trace down");
  let t = 5_000_000;
  const logs: string[] = [];
  const c = createConductor({ log: (m) => logs.push(m), tickMs: 0, now: () => t });

  const silent = c.traceStarted("school-anchor", "Maya Chen");
  const active = c.traceStarted("school-anchor", "Omar Diaz");
  t += 50_000;
  c.traceActivity(active);
  c.tick();
  assert(!c.shouldStandDown(silent) && !c.shouldStandDown(active), "at 50s nobody is stood down (below the 90s floor)");
  t += 45_000;
  c.traceActivity(active);
  c.tick();
  assert(c.shouldStandDown(silent), "95s of total silence stands the silent trace down");
  assert(!c.shouldStandDown(active), "the pinging trace is untouched");
  assert(
    logs.some((l) => l.includes('cancelled school-anchor trace "Maya Chen" (stalled')),
    "the stall decision was logged with the trace's name"
  );
  c.traceEnded(silent, "stood-down");
  c.traceEnded(active, "resolved");
  c.dispose();

  // EMA: two 60s completions raise the threshold to 3×60s=180s.
  let t2 = 6_000_000;
  const c2 = createConductor({ tickMs: 0, now: () => t2 });
  const a = c2.traceStarted("school-anchor", "A");
  t2 += 60_000;
  c2.traceEnded(a, "resolved");
  const b = c2.traceStarted("school-anchor", "B");
  t2 += 60_000;
  c2.traceEnded(b, "resolved");
  const slow = c2.traceStarted("school-anchor", "Slow Sam");
  t2 += 95_000;
  c2.tick();
  assert(!c2.shouldStandDown(slow), "95s silent is fine when typical traces run 60s (threshold 180s)");
  t2 += 90_000;
  c2.tick();
  assert(c2.shouldStandDown(slow), "185s silent finally trips the EMA-raised threshold");
  c2.dispose();
}

// ---------------------------------------------------------------------------
// 5. Early exit + probe cadence
// ---------------------------------------------------------------------------
function scenarioEarlyExit() {
  console.log("Scenario 5: early exit — anchored ≥90% wins the phase; probe cadence is 4, then every 4");
  const logs: string[] = [];
  const c = createConductor({ log: (m) => logs.push(m), tickMs: 0 });

  for (let i = 0; i < 3; i++) c.anchorResolved("school-anchor");
  assert(!c.wantsProbe("school-anchor"), "3 anchors: no probe yet");
  c.anchorResolved("school-anchor");
  assert(c.wantsProbe("school-anchor"), "4 anchors: probe wanted");
  c.probeStarted("school-anchor");
  assert(!c.wantsProbe("school-anchor"), "no second probe while one is in flight");
  c.probeEnded("school-anchor");
  assert(!c.wantsProbe("school-anchor"), "after a probe at 4 anchors, the next fires at 8");
  for (let i = 0; i < 4; i++) c.anchorResolved("school-anchor");
  assert(c.wantsProbe("school-anchor"), "8 anchors: next probe wanted");

  c.reportCandidate("school-anchor", { confidence: 0.9, anchored: false, label: "@social-only" });
  assert(!c.phaseWon("school-anchor"), "a NON-anchored 90% candidate does not win the phase");
  c.reportCandidate("school-anchor", { confidence: 0.85, anchored: true, label: "@weak-anchor" });
  assert(!c.phaseWon("school-anchor"), "an anchored 85% candidate does not win the phase");
  c.reportCandidate("school-anchor", { confidence: 0.93, anchored: true, label: "@tanney on chesscom" });
  assert(c.phaseWon("school-anchor"), "an anchored 93% candidate wins the phase");
  assert(
    logs.some((l) => l.includes("early exiting — target found at 93%")),
    "the early-exit decision was logged with the confidence"
  );
  const straggler = c.traceStarted("school-anchor", "Straggler");
  assert(c.shouldStandDown(straggler), "traces in a won scope are stood down");
  c.dispose();
}

// ---------------------------------------------------------------------------
// 6. Dispose
// ---------------------------------------------------------------------------
function scenarioDispose() {
  console.log("Scenario 6: dispose — restores the governed gate and ignores late signals");
  const t = 7_000_000;
  const gate = fakeGate(12);
  const c = createConductor({ gate, tickMs: 0, now: () => t });
  for (let i = 0; i < 3; i++) c.netEvent("chesscom", "429");
  c.tick();
  assert(gate.stats().limit === 7, "governed down to 7 before dispose");
  c.dispose();
  assert(gate.stats().limit === 12, "dispose restored the original limit");
  c.netEvent("chesscom", "429");
  c.tick();
  c.dispose();
  assert(gate.stats().limit === 12, "late signals and a double dispose are harmless");
}

// ---------------------------------------------------------------------------
// Shared fake wire for the school-resolver integrations
// ---------------------------------------------------------------------------

const J = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

interface Wire {
  ccProfiles: Record<string, Record<string, unknown>>;
  ccMonths: Record<string, { games: unknown[] }>;
  lichessUsers: Record<string, Record<string, unknown>>;
}

const game = (a: string, b: string) => ({ white: { username: a }, black: { username: b } });

function installWire(wire: Wire): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    let m: RegExpExecArray | null;
    if ((m = /api\.chess\.com\/pub\/player\/([^/]+)\/stats$/.exec(url))) {
      return J({ chess_rapid: { last: { rating: 1520 }, record: { win: 100, loss: 80, draw: 10 } } });
    }
    if ((m = /api\.chess\.com\/pub\/player\/([^/]+)\/games\/archives$/.exec(url))) {
      const u = decodeURIComponent(m[1]).toLowerCase();
      return wire.ccMonths[u]
        ? J({ archives: [`https://api.chess.com/pub/player/${u}/games/2026/06`] })
        : J({ archives: [] });
    }
    if ((m = /api\.chess\.com\/pub\/player\/([^/]+)\/games\/(\d{4})\/(\d{2})$/.exec(url))) {
      const u = decodeURIComponent(m[1]).toLowerCase();
      return J(wire.ccMonths[u] || { games: [] });
    }
    if ((m = /api\.chess\.com\/pub\/player\/([^/]+)\/clubs$/.exec(url))) {
      return J({ clubs: [] });
    }
    if ((m = /api\.chess\.com\/pub\/player\/([^/]+)$/.exec(url))) {
      const u = decodeURIComponent(m[1]).toLowerCase();
      const p = wire.ccProfiles[u];
      return p ? J(p) : J({ message: "Not found" }, 404);
    }
    if ((m = /lichess\.org\/api\/user\/([^/?]+)/.exec(url))) {
      const u = decodeURIComponent(m[1]).toLowerCase();
      const p = wire.lichessUsers[u];
      return p ? J(p) : new Response("{}", { status: 404 });
    }
    return J({ error: `unrouted url in test wire: ${url}` }, 500);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

const ccProfile = (username: string, name?: string) => ({
  username,
  name,
  country: "https://api.chess.com/pub/country/US",
  location: "Sammamish, WA",
  last_online: 1_780_000_000,
  joined: 1_600_000_000,
  url: `https://www.chess.com/member/${username}`,
});

// ---------------------------------------------------------------------------
// 7. INTEGRATION: school resolver early exit
// ---------------------------------------------------------------------------
async function scenarioSchoolEarlyExit() {
  console.log("Scenario 7: INTEGRATION — mid-phase probe finds the anchored target; hanging traces stand down");
  resetSearchCaches();
  _resetBreakers();

  const mates = ["Maya Chen", "Omar Diaz", "Nina Rao", "Leo Park", "Ivy Tran", "Sam Cole"];
  const handles: Record<string, string> = {
    "Maya Chen": "mate1",
    "Omar Diaz": "mate2",
    "Nina Rao": "mate3",
    "Leo Park": "mate4",
  };
  const wire: Wire = { ccProfiles: {}, ccMonths: {}, lichessUsers: {} };
  for (const h of Object.values(handles)) {
    wire.ccProfiles[h] = ccProfile(h);
    // Each resolved mate's month: 3 games vs the target's handle (a real
    // cohort tie) + 1 vs a stranger (below the ≥3-game bar).
    wire.ccMonths[h] = {
      games: [game(h, "CandidateKid"), game("CandidateKid", h), game(h, "CandidateKid"), game(h, "randomguy")],
    };
  }
  wire.ccProfiles["candidatekid"] = ccProfile("CandidateKid", "Tanush Bhatia");
  wire.lichessUsers["candidatekid"] = {
    username: "CandidateKid",
    profile: { realName: "Tanush Bhatia", flag: "US", location: "Sammamish, WA", bio: "USCF 16538484 — scholastic player" },
    perfs: { rapid: { rating: 1550, games: 300 } },
    seenAt: 1_780_000_000_000,
    createdAt: 1_600_000_000_000,
    count: { all: 900 },
    url: "https://lichess.org/@/CandidateKid",
  };
  const restore = installWire(wire);

  let hangsStarted = 0;
  let hangsExited = 0;
  const hooks: SchoolResolverHooks = {
    findSchool: async () => [
      { school: "Skyline High School", state: "WA", source: "nwsrs", sourceLabel: "NWSRS", confidence: 0.9 },
    ],
    findSchoolmates: async () =>
      mates.map(
        (name, i): Schoolmate => ({ name, rating: 1500 - i * 50, state: "WA", source: "nwsrs-school-report" })
      ),
    findUscfId: async (req) => ({ uscfId: `1700000${mates.findIndex((n) => n.startsWith(req.firstName)) + 1}` }),
    resolveUscfIdentity: async (req) => {
      const handle = handles[req.name];
      if (handle) return { platform: "chesscom", username: handle, confidence: 0.8 };
      hangsStarted++;
      while (!req.stopWhen?.()) await sleep(20); // hangs until stood down
      hangsExited++;
      return null;
    },
  };

  const logs: string[] = [];
  const conductor = createConductor({ log: (m) => logs.push(m), tickMs: 0 });
  const t0 = Date.now();
  const result = await runSchoolResolution(
    { name: "Tanush Bhatia", state: "WA", uscfId: "16538484", targetRating: 1600 },
    { log: (m) => logs.push(m), hooks, conductor }
  );
  conductor.dispose();
  restore();

  assert(result.found, "the phase found the target");
  assert(result.accounts[0]?.username === "CandidateKid", `top account is the anchored target (got @${result.accounts[0]?.username})`);
  assert(result.accounts[0]?.confidence >= 0.9, `anchored confidence ≥90% (got ${Math.round((result.accounts[0]?.confidence || 0) * 100)}%)`);
  assert(result.schoolmatesResolved === 4, `early exit after 4 of 6 schoolmates (got ${result.schoolmatesResolved})`);
  assert(
    logs.some((l) => l.includes("early exiting — target found at")),
    "the conductor logged the early-exit decision"
  );
  assert(
    logs.some((l) => l.includes("School resolver: early exit — @CandidateKid")),
    "the resolver logged the early return"
  );
  assert(hangsStarted > 0 && hangsExited === hangsStarted, `all ${hangsStarted} hanging trace(s) were stood down and released`);
  assert(Date.now() - t0 < 20_000, "the run finished promptly instead of waiting out the roster");
}

// ---------------------------------------------------------------------------
// 8. INTEGRATION: school resolver stall stand-down
// ---------------------------------------------------------------------------
async function scenarioSchoolStall() {
  console.log("Scenario 8: INTEGRATION — a wedged mate trace is cancelled as stalled; the roster completes");
  resetSearchCaches();
  _resetBreakers();

  const wire: Wire = { ccProfiles: {}, ccMonths: {}, lichessUsers: {} };
  for (const h of ["mate1", "mate2"]) {
    wire.ccProfiles[h] = ccProfile(h);
    wire.ccMonths[h] = { games: [] }; // no cohort ties — no candidate, no early exit
  }
  const restore = installWire(wire);

  let fakeNow = 9_000_000;
  let hangStarted = false;
  let hangExited = false;
  const hooks: SchoolResolverHooks = {
    findSchool: async () => [
      { school: "Skyline High School", state: "WA", source: "nwsrs", sourceLabel: "NWSRS", confidence: 0.9 },
    ],
    findSchoolmates: async (): Promise<Schoolmate[]> => [
      { name: "Maya Chen", rating: 1500, state: "WA", source: "nwsrs-school-report" },
      { name: "Omar Diaz", rating: 1400, state: "WA", source: "nwsrs-school-report" },
      { name: "Wedge Willis", rating: 1300, state: "WA", source: "nwsrs-school-report" },
    ],
    findUscfId: async (req) => ({ uscfId: req.lastName === "Willis" ? "18000003" : req.lastName === "Chen" ? "18000001" : "18000002" }),
    resolveUscfIdentity: async (req) => {
      if (req.name === "Maya Chen") return { platform: "chesscom", username: "mate1", confidence: 0.8 };
      if (req.name === "Omar Diaz") return { platform: "chesscom", username: "mate2", confidence: 0.8 };
      hangStarted = true;
      while (!req.stopWhen?.()) await sleep(20); // wedged: NO onActivity pings, ever
      hangExited = true;
      return null;
    },
  };

  const logs: string[] = [];
  const conductor = createConductor({ log: (m) => logs.push(m), tickMs: 0, now: () => fakeNow });
  const runP = runSchoolResolution(
    { name: "Tanush Bhatia", state: "WA", uscfId: "16538484", targetRating: 1600 },
    { log: (m) => logs.push(m), hooks, conductor }
  );

  // Pump the conductor: wait for the wedge to start, then advance the injected
  // clock past the 90s floor and tick — the stall policy stands it down.
  const pumpStart = Date.now();
  while (!hangStarted && Date.now() - pumpStart < 5_000) await sleep(10);
  for (let i = 0; i < 12 && !hangExited; i++) {
    fakeNow += 25_000;
    conductor.tick();
    await sleep(30);
  }
  const result = await runP;
  conductor.dispose();
  restore();

  assert(hangStarted && hangExited, "the wedged trace was released by the stall stand-down");
  assert(
    logs.some((l) => l.includes('cancelled school-anchor trace "Wedge Willis" (stalled')),
    "the conductor logged the stall decision"
  );
  assert(
    logs.some((l) => l.includes("cancelled Wedge Willis's trace (stalled")),
    "the resolver logged the cancellation and moved on"
  );
  assert(result.schoolmatesResolved === 2, `the two healthy mates still resolved (got ${result.schoolmatesResolved})`);
  assert(!result.found, "no candidate was invented — accuracy preserved");
}

async function main() {
  setNetObserver(null); // unit hygiene: nothing attached unless a scenario attaches it
  await scenarioSemaphore();
  scenarioGovernor();
  scenarioBooster();
  scenarioStall();
  scenarioEarlyExit();
  scenarioDispose();
  await scenarioSchoolEarlyExit();
  await scenarioSchoolStall();

  if (failures) {
    console.error(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll conductor scenarios passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
