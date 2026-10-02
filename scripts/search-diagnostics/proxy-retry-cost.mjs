// THROWAWAY (gitignored). Corrected replication: models BOTH geminiFetch retry
// branches (ai.ts:256-262 exception, ai.ts:266-277 5xx) plus geminiPace().
const DEAD = "https://radiation-techno-push-found.trycloudflare.com/v1/chat/completions";
const BUDGET = 25_000, SPACING = 500;
const backoff = (a, dl) => Math.min(1500 * 2 ** a + 1500 * 2 ** a * 0.25 * Math.random(), Math.max(250, dl - Date.now()));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const start = performance.now();
const deadline = Date.now() + BUDGET;
let attempt = 0, outcome = "";
for (;;) {
  await sleep(SPACING);                       // geminiPace()
  let res = null, threw = false;
  try { res = await fetch(DEAD, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); }
  catch { threw = true; }
  if (threw) {                                 // ai.ts:256-262
    console.log(`   attempt ${attempt + 1}: network exception`);
    if (Date.now() >= deadline || attempt >= 4) { outcome = "rethrew after exhausting retries"; break; }
    const w = backoff(attempt++, deadline); console.log(`      -> backoff ${Math.round(w)}ms`); await sleep(w); continue;
  }
  console.log(`   attempt ${attempt + 1}: HTTP ${res.status}`);
  if ((res.status === 429 || res.status >= 500) && Date.now() < deadline && attempt < 5) {  // ai.ts:266
    const w = Math.min(backoff(attempt, deadline), Math.max(0, deadline - Date.now()));
    attempt++; console.log(`      -> backoff ${Math.round(w)}ms`); await sleep(w); continue;
  }
  outcome = `returned HTTP ${res.status}`; break;
}
console.log(`\noutcome: ${outcome}`);
console.log(`TOTAL burned before falling through to Gemini direct: ${Math.round(performance.now() - start)}ms`);
console.log(`deployed measurement for a 16-token "say OK" call:      26381ms (median, n=3)`);
