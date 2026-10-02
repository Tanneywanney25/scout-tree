// ============================================================================
// Proof harness for net.ts's request allocator.
//
//   node scripts/test-allocator.mjs
//
// Stubs global fetch (instant 200s, or scripted 429s) and asserts:
//   1. the bucket caps the request rate at its configured rate;
//   2. adding workers does not raise the rate (more agents = longer queue);
//   3. proven work preempts queued speculative work;
//   4. speculative work alone never exceeds its share of the rate;
//   5. a 429 halves the rate and pauses; a clean stretch steps it back up;
//   6. Lichess backoff: Retry-After honoured, else 6 s doubling, ±20%, ≤60 s;
//   7. every request is accounted to its lane.
// ============================================================================

import {
  politeFetch,
  _resetBreakers,
  configureAllocator,
  speculativeSignal,
  getNetStats,
  resetNetStats,
  lichessBackoffMs,
} from "../src/lib/identity/net";

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`  ✘ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const assert = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let script: (url: string) => number = () => 200;
const starts: number[] = [];
globalThis.fetch = (async (input: any) => {
  const url = typeof input === "string" ? input : input.url;
  starts.push(Date.now());
  return new Response("{}", { status: script(url) });
}) as typeof fetch;

const cc = (i: number) => `https://api.chess.com/pub/player/u${i}`;

async function runWorkers(n: number, total: number, signal?: AbortSignal): Promise<number> {
  let next = 0;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < total) {
        const i = next++;
        await politeFetch(cc(i), { signal }, "chesscom");
      }
    })
  );
  return Date.now() - t0;
}

console.log("Scenario 1: the bucket caps the rate");
_resetBreakers();
configureAllocator("chesscom", { capacity: 5, rate: 100, minRate: 10, step: 10, recoverMs: 200, specShare: 0.5 });
starts.length = 0;
let ms = await runWorkers(16, 205);
let rate = (205 - 5) / (ms / 1000);
assert(rate <= 110 && rate >= 70, `205 requests at a 100/s bucket ran at ${rate.toFixed(0)}/s (want ≤110)`);

console.log("Scenario 2: more workers do not raise the rate");
_resetBreakers();
configureAllocator("chesscom", { capacity: 5, rate: 100, minRate: 10, step: 10, recoverMs: 200, specShare: 0.5 });
const ms4 = await runWorkers(4, 205);
_resetBreakers();
configureAllocator("chesscom", { capacity: 5, rate: 100, minRate: 10, step: 10, recoverMs: 200, specShare: 0.5 });
const ms64 = await runWorkers(64, 205);
assert(Math.abs(ms64 - ms4) / ms4 < 0.15, `4 workers: ${ms4} ms, 64 workers: ${ms64} ms — same wall clock within 15%`);

console.log("Scenario 3: proven work preempts queued speculative work");
_resetBreakers();
configureAllocator("chesscom", { capacity: 1, rate: 50, minRate: 10, step: 10, recoverMs: 10_000, specShare: 1 });
const order: string[] = [];
const spec = speculativeSignal();
const specJobs = Array.from({ length: 30 }, (_, i) => politeFetch(cc(1000 + i), { signal: spec }, "chesscom").then(() => order.push("s")));
await sleep(30); // let the speculative queue build
const provenJobs = Array.from({ length: 10 }, (_, i) => politeFetch(cc(2000 + i), {}, "chesscom").then(() => order.push("p")));
await Promise.all([...specJobs, ...provenJobs]);
const lastProven = order.lastIndexOf("p");
assert(lastProven <= 13, `all 10 proven requests completed by position ${lastProven + 1} of 40 (queued behind ≤3 speculative)`);

console.log("Scenario 4: speculative work alone stays within its share");
_resetBreakers();
configureAllocator("chesscom", { capacity: 2, rate: 100, minRate: 10, step: 10, recoverMs: 10_000, specShare: 0.5 });
const spec2 = speculativeSignal();
const t4 = Date.now();
await Promise.all(Array.from({ length: 60 }, (_, i) => politeFetch(cc(3000 + i), { signal: spec2 }, "chesscom")));
rate = 60 / ((Date.now() - t4) / 1000);
assert(rate <= 56, `60 speculative-only requests ran at ${rate.toFixed(0)}/s against a 50/s speculative share`);

console.log("Scenario 5: a 429 halves the rate and pauses; a clean stretch recovers it");
_resetBreakers();
configureAllocator("chesscom", { capacity: 2, rate: 40, minRate: 5, step: 20, recoverMs: 600, specShare: 0.5 });
let served = 0;
script = () => (++served === 10 ? 429 : 200);
starts.length = 0;
const t5 = Date.now();
await runWorkers(8, 40);
script = () => 200;
const gaps = starts.slice(1).map((s, i) => s - starts[i]);
const pause = Math.max(...gaps);
assert(pause >= 2_900, `the 429 paused the bucket ${pause} ms (configured 3,000 ms)`);
const st = getNetStats();
assert(st.limitEvents.chesscom >= 1, `limit event recorded (${st.limitEvents.chesscom})`);
const afterPause = starts.filter((s) => s > t5 + pause).length;
ok(`${afterPause} requests completed after the pause at the reduced rate`);

console.log("Scenario 6: Lichess backoff");
_resetBreakers();
const noRa = new Response("", { status: 429 });
const now = 1_000_000;
const seq = [0, 1, 2, 3, 4].map((k) => lichessBackoffMs("games", noRa, now + k * 1000, 0.5));
assert(seq[0] === 6_000 && seq[1] === 12_000 && seq[2] === 24_000 && seq[3] === 48_000 && seq[4] === 60_000, `no Retry-After: ${seq.join(", ")} ms (6 s doubling, 60 s cap)`);
const lo = lichessBackoffMs("user", noRa, now, 0), hi = lichessBackoffMs("export", noRa, now, 0.999);
assert(lo === 4_800 && hi >= 7_190 && hi <= 7_200, `jitter bounds on a first 429: ${lo}–${hi} ms (6 s ±20%)`);
const ra = new Response("", { status: 429, headers: { "Retry-After": "17" } });
assert(lichessBackoffMs("other", ra, now) === 17_000, "Retry-After: 17 → 17,000 ms");
const later = lichessBackoffMs("games", noRa, now + 10 * 60_000, 0.5);
assert(later === 6_000, `streak resets after two quiet minutes (${later} ms)`);

console.log("Scenario 7: accounting by lane");
_resetBreakers();
resetNetStats();
configureAllocator("chesscom", { capacity: 50, rate: 1000, minRate: 10, step: 10, recoverMs: 10_000, specShare: 0.5 });
script = (u) => (/u4\d\d\d$/.test(u) && Number(u.slice(-1)) % 2 ? 404 : 200);
const spec3 = speculativeSignal();
await Promise.all([
  ...Array.from({ length: 12 }, (_, i) => politeFetch(cc(4000 + i), { signal: spec3 }, "chesscom")),
  ...Array.from({ length: 7 }, (_, i) => politeFetch(cc(5000 + i), {}, "chesscom")),
]);
const s7 = getNetStats().chesscom;
assert(s7.speculative.requests === 12 && s7.proven.requests === 7, `lanes: ${s7.speculative.requests} speculative, ${s7.proven.requests} proven`);
assert((s7.speculative.statuses["404"] || 0) === 6, `404s attributed to the speculative lane (${s7.speculative.statuses["404"] || 0})`);

console.log(failures ? `\n${failures} assertion(s) FAILED.` : "\nAll allocator scenarios passed.");
process.exit(failures ? 1 : 0);
