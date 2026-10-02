// THROWAWAY measurement script (gitignored). Proposal C trial.
//
// Claim under test: 8 parallel ladder queries x 4 engines = ~32 simultaneous
// outbound requests from one residential IP, which triggers "too many requests";
// staggering by 200-500ms with jitter would recover DuckDuckGo and Google.
//
// Design notes:
//  - Hits SearXNG DIRECTLY on :8080, bypassing the token shim, so the shim is
//    not a variable.
//  - Conditions are INTERLEAVED round-robin rather than run in blocks, because
//    engine blocking is plausibly stateful/cumulative and running all the
//    parallel trials first would contaminate the staggered ones.
//  - A cooldown separates every ladder run for the same reason.
//  - Per-engine failure is read from SearXNG's own `unresponsive_engines`.

const BASE = "http://127.0.0.1:8080";
const COOLDOWN_MS = 8000;
const REPEATS = 4;

const LADDER = [
  'site:lichess.org "Hikaru Nakamura"',
  'site:chess.com "Hikaru Nakamura"',
  '"Hikaru Nakamura" lichess',
  '"Hikaru Nakamura" chess.com',
  "site:lichess.org Hikaru Nakamura",
  "site:chess.com Hikaru Nakamura",
  'site:lichess.org "Hikaru Nakamura" new york',
  'site:chess.com "Hikaru Nakamura" new york',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oneQuery(q) {
  const url = `${BASE}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`;
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, ms: performance.now() - t0, hits: 0, down: [], engines: [], http: res.status };
    const d = await res.json();
    const down = (d.unresponsive_engines || []).map((e) => (Array.isArray(e) ? e[0] : e)).filter((x) => typeof x === "string");
    const engines = [...new Set((d.results || []).map((r) => r.engine).filter(Boolean))];
    return { ok: true, ms: performance.now() - t0, hits: (d.results || []).length, down, engines, http: 200 };
  } catch (e) {
    return { ok: false, ms: performance.now() - t0, hits: 0, down: [], engines: [], http: 0, err: String(e).slice(0, 60) };
  }
}

// condition: stagger in ms (0 = fully parallel). Jitter +/-25% when > 0.
async function runLadder(staggerMs) {
  const t0 = performance.now();
  const results = await Promise.all(
    LADDER.map(async (q, i) => {
      if (staggerMs > 0) {
        const jitter = staggerMs * 0.25 * (Math.random() * 2 - 1);
        await sleep(Math.max(0, i * staggerMs + jitter));
      }
      return oneQuery(q);
    })
  );
  return { wallMs: performance.now() - t0, results };
}

const CONDITIONS = [
  { name: "parallel(0ms)", stagger: 0 },
  { name: "stagger-200ms", stagger: 200 },
  { name: "stagger-500ms", stagger: 500 },
];

const acc = new Map(CONDITIONS.map((c) => [c.name, { walls: [], queries: 0, hits: 0, down: new Map(), served: new Map(), httpFail: 0 }]));

console.log(`Proposal C trial: ${CONDITIONS.length} conditions x ${REPEATS} repeats x ${LADDER.length} queries`);
console.log(`interleaved order, ${COOLDOWN_MS}ms cooldown between ladder runs\n`);

let runNo = 0;
for (let rep = 0; rep < REPEATS; rep++) {
  for (const cond of CONDITIONS) {
    if (runNo++ > 0) await sleep(COOLDOWN_MS);
    const { wallMs, results } = await runLadder(cond.stagger);
    const a = acc.get(cond.name);
    a.walls.push(wallMs);
    for (const r of results) {
      a.queries++;
      a.hits += r.hits;
      if (!r.ok) a.httpFail++;
      for (const d of r.down) a.down.set(d, (a.down.get(d) || 0) + 1);
      for (const e of r.engines) a.served.set(e, (a.served.get(e) || 0) + 1);
    }
    const downList = results.flatMap((r) => r.down);
    console.log(
      `rep${rep + 1} ${cond.name.padEnd(14)} wall=${String(Math.round(wallMs)).padStart(5)}ms ` +
        `hits=${String(results.reduce((s, r) => s + r.hits, 0)).padStart(3)} ` +
        `downEvents=${String(downList.length).padStart(2)}`
    );
  }
}

const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log("\n================ RESULTS ================");
for (const cond of CONDITIONS) {
  const a = acc.get(cond.name);
  console.log(`\n${cond.name}`);
  console.log(`  wall time    : median ${Math.round(med(a.walls))}ms  (runs: ${a.walls.map((w) => Math.round(w)).join(", ")})`);
  console.log(`  queries      : ${a.queries}   total hits: ${a.hits}   avg hits/query: ${(a.hits / a.queries).toFixed(1)}`);
  console.log(`  http failures: ${a.httpFail}`);
  console.log(`  per-engine FAILURE rate (unresponsive / ${a.queries} queries):`);
  const engines = new Set([...a.down.keys(), ...a.served.keys()]);
  for (const e of [...engines].sort()) {
    const d = a.down.get(e) || 0;
    const s = a.served.get(e) || 0;
    console.log(`     ${e.padEnd(14)} failed ${String(d).padStart(2)}/${a.queries} (${((d / a.queries) * 100).toFixed(0)}%)   served results in ${s}/${a.queries}`);
  }
}
console.log("\n=========================================");
