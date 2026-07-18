// ============================================================================
// Proof harness for net.ts's platform-outage circuit breaker.
//
//   node scripts/test-net.mjs
//
// Stubs global fetch to simulate transport failures / HTTP statuses and
// asserts the breaker's contract:
//   1. transport failures open the circuit after the threshold, and further
//      calls fast-fail in ~0ms instead of paying the timeout ladder;
//   2. HTTP responses of ANY status (even 500/429… here 500) keep the circuit
//      closed — a talking platform is never treated as a dead one;
//   3. after the cooldown exactly one half-open probe goes out; its success
//      closes the circuit for everyone;
//   4. a failed probe re-opens the circuit;
//   5. caller aborts never count toward opening the circuit.
// ============================================================================

import { politeFetch, _resetBreakers } from "../src/lib/identity/net";

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  ✘ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const assert = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));

type FetchMode = "down" | "up" | "http500";
let mode: FetchMode = "down";
let fetchCalls = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: any, _init?: any) => {
  fetchCalls++;
  if (mode === "down") throw new TypeError("fetch failed: connect timeout (simulated)");
  if (mode === "http500") return new Response("boom", { status: 500 });
  return new Response("{}", { status: 200 });
}) as typeof fetch;

/** One politeFetch call that reports (threw?, elapsedMs). */
async function call(): Promise<{ threw: boolean; ms: number; res?: Response }> {
  const t0 = Date.now();
  try {
    const res = await politeFetch("https://lichess.org/api/user/test", {}, "lichess", 2_000);
    return { threw: false, ms: Date.now() - t0, res };
  } catch {
    return { threw: true, ms: Date.now() - t0 };
  }
}

async function main() {
  console.log("Scenario 1: transport-down platform opens the circuit, later calls fast-fail");
  _resetBreakers();
  mode = "down";
  fetchCalls = 0;
  // Each politeFetch retries transport errors internally (3 attempts), so two
  // calls are enough to cross the 6-failure threshold.
  const a = await call();
  const b = await call();
  assert(a.threw && b.threw, "both priming calls surfaced their failure");
  const before = fetchCalls;
  const c = await call();
  assert(c.threw, "open circuit still surfaces a failure to the caller");
  assert(fetchCalls === before, `open circuit made NO network attempt (fetch calls stayed at ${before})`);
  assert(c.ms < 200, `open-circuit call fast-failed in ${c.ms}ms (was ~30s during a real outage)`);

  console.log("Scenario 2: HTTP error statuses never open the circuit");
  _resetBreakers();
  mode = "http500";
  fetchCalls = 0;
  for (let i = 0; i < 10; i++) {
    const r = await call();
    if (r.threw || r.res?.status !== 500) {
      fail(`call ${i} should have returned the 500 response`);
      break;
    }
  }
  assert(fetchCalls === 10, `all 10 calls reached the network (${fetchCalls}) — a talking platform stays admitted`);

  console.log("Scenario 3: after the cooldown, one probe goes out; success closes the circuit");
  _resetBreakers();
  mode = "down";
  await call();
  await call(); // circuit now open
  // Jump past the cooldown without waiting 45s.
  const realNow = Date.now;
  const skew = 46_000;
  Date.now = () => realNow() + skew;
  try {
    mode = "up";
    fetchCalls = 0;
    const probe = await call();
    assert(!probe.threw && probe.res?.status === 200, "half-open probe went through and succeeded");
    const after = await call();
    assert(!after.threw, "circuit closed after the successful probe — traffic flows again");
    assert(fetchCalls === 2, `exactly the probe + the follow-up hit the network (${fetchCalls})`);
  } finally {
    Date.now = realNow;
  }

  console.log("Scenario 4: a failed probe re-opens the circuit");
  _resetBreakers();
  mode = "down";
  await call();
  await call(); // open
  const realNow2 = Date.now;
  Date.now = () => realNow2() + 46_000;
  try {
    fetchCalls = 0;
    const probe = await call(); // still down — probe fails
    assert(probe.threw, "failed probe surfaced its failure");
    const primed = fetchCalls;
    const next = await call();
    assert(next.threw && fetchCalls === primed, "circuit re-opened — next call made no network attempt");
  } finally {
    Date.now = realNow2;
  }

  console.log("Scenario 5: caller aborts never open the circuit");
  _resetBreakers();
  mode = "up";
  fetchCalls = 0;
  for (let i = 0; i < 10; i++) {
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      await politeFetch("https://lichess.org/api/user/test", { signal: ctrl.signal }, "lichess", 2_000);
      fail("aborted call should throw");
    } catch {
      /* expected */
    }
  }
  const r = await call();
  assert(!r.threw, "after 10 aborted calls the circuit is still closed");

  globalThis.fetch = realFetch;
  if (failures) {
    console.error(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll circuit-breaker scenarios passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
