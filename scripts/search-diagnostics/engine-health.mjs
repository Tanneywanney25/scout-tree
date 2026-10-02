// Minimal SearXNG engine-health probe, safe to run on a schedule.
//
// WHY: the retrieval layer is served by a handful of engines that suspend this
// address under load. On 2026-10-01 all of them were suspended and retrieval
// returned zero; ~5 hours later duckduckgo and google cse had recovered while
// brave and google (CAPTCHA) had not. Whether, and how fast, those suspensions
// decay decides whether a single-address SearXNG is viable at all - so it needs
// a time series, not another one-off burst.
//
// ONE query per run, on purpose. This probe must never be the thing that causes
// a suspension. Run it on a timer (hourly is plenty) and read the JSONL.
//
//   node scripts/search-diagnostics/engine-health.mjs            # human output
//   node scripts/search-diagnostics/engine-health.mjs --append   # + JSONL line
//
// Env: SEARXNG_ORIGIN (default http://127.0.0.1:8080), HEALTH_LOG (default
// .searxng-run/engine-health.jsonl, which is gitignored).

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const ORIGIN = process.env.SEARXNG_ORIGIN || "http://127.0.0.1:8080";
const LOG = process.env.HEALTH_LOG || ".searxng-run/engine-health.jsonl";
const APPEND = process.argv.includes("--append");

const t0 = Date.now();
let out = { ts: new Date().toISOString(), ok: false, ms: 0, results: 0, answered: [], suspended: {}, error: null };

try {
  const res = await fetch(`${ORIGIN}/search?q=chess&format=json&safesearch=0`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  out.ms = Date.now() - t0;
  if (!res.ok) {
    out.error = `HTTP ${res.status}`;
  } else {
    const d = await res.json();
    out.ok = true;
    out.results = Array.isArray(d.results) ? d.results.length : 0;
    out.answered = [...new Set((d.results || []).map((r) => r.engine).filter(Boolean))].sort();
    for (const e of d.unresponsive_engines || []) {
      const [name, reason] = Array.isArray(e) ? e : [e, "?"];
      if (typeof name === "string") out.suspended[name] = String(reason);
    }
  }
} catch (e) {
  out.ms = Date.now() - t0;
  out.error = String(e?.message || e).slice(0, 120);
}

console.log(`[${out.ts}] ${out.ok ? "ok" : "FAIL"} ${out.ms}ms results=${out.results}`);
console.log(`  answered : ${out.answered.join(", ") || "(none)"}`);
const sus = Object.entries(out.suspended);
console.log(`  suspended: ${sus.length ? sus.map(([k, v]) => `${k} (${v})`).join(", ") : "(none)"}`);
if (out.error) console.log(`  error    : ${out.error}`);

if (APPEND) {
  await mkdir(dirname(LOG), { recursive: true }).catch(() => {});
  await appendFile(LOG, JSON.stringify(out) + "\n", "utf8");
  console.log(`  appended -> ${LOG}`);
}

// Non-zero when retrieval is unusable, so a scheduler can alert on it.
process.exit(out.ok && out.results > 0 ? 0 : 1);
