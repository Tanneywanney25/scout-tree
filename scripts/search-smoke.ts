// Dev harness: exercise the free search pipeline against a local SearXNG and
// print real timings. Run with:
//   node scripts/search-smoke.ts
// Reads SEARXNG_LOCAL_URL + SEARXNG_TOKEN from the environment (.env.local).
import { retrieve } from "../supabase/functions/_shared/search/pipeline.ts";
import { searxngSearchMany, searxngConfigured } from "../supabase/functions/_shared/search/searxng.ts";
import { cacheStats, groundingAllowed } from "../supabase/functions/_shared/search/store.ts";
import { findUsernamesOnWeb, buildQueryLadder } from "../supabase/functions/resolve-identity/googleSearch.ts";

const QUERIES = [
  'site:uschess.org "Hikaru Nakamura"',
  'site:lichess.org "Fabiano Caruana"',
  'site:chess.com "Wesley So"',
  '"Levon Aronian" chess.com',
  'site:new.uschess.org player search',
  '"Ray Robson" lichess',
  'texaschess.org scholastic results',
  '"Sam Shankland" chess profile',
  'calchess.org scholastic championship',
  '"Awonder Liang" chess.com member',
];

function ms(t: number) { return `${Math.round(t)}ms`; }

console.log("searxng configured:", searxngConfigured());
console.log("grounding allowed (expect false: no ledger locally -> fail closed):", await groundingAllowed((m) => console.log("   ", m)));

console.log("\n--- raw retrieval, 10 distinct queries ---");
const times: number[] = [];
let totalHits = 0;
for (const q of QUERIES) {
  const t0 = performance.now();
  const r = await searxngSearchMany([q], { maxResults: 25 });
  const dt = performance.now() - t0;
  times.push(dt);
  totalHits += r.hits.length;
  console.log(`${ms(dt).padStart(7)}  ${String(r.hits.length).padStart(2)} hits  ${r.status.unresponsiveEngines.length ? "(down: " + r.status.unresponsiveEngines.join(",") + ") " : ""}${q}`);
}
times.sort((a, b) => a - b);
console.log(`\nlatency: min ${ms(times[0])}  median ${ms(times[Math.floor(times.length / 2)])}  max ${ms(times[times.length - 1])}`);
console.log(`total hits across 10 queries: ${totalHits}`);

console.log("\n--- full parallel retrieve() with the username ladder ---");
const ladder = buildQueryLadder({ name: "Hikaru Nakamura", state: "NY", uscfRating: 2846 });
console.log(`ladder has ${ladder.length} queries; using first 8 as seeds`);
const t1 = performance.now();
const got = await retrieve({
  intent: "Find the Lichess and/or Chess.com username of Hikaru Nakamura",
  seedQueries: ladder.slice(0, 8),
  cacheKind: "identity",
  log: (m) => console.log("   ", m),
});
console.log(`retrieve(): ${ms(performance.now() - t1)}  hits=${got.hits.length}  fromCache=${got.fromCache}  geminiCalls=${got.geminiCalls}`);

console.log("\n--- findUsernamesOnWeb() end to end ---");
const t2 = performance.now();
const res = await findUsernamesOnWeb({ name: "Hikaru Nakamura", state: "NY", uscfRating: 2846 }, (m) => console.log("   ", m));
console.log(`findUsernamesOnWeb(): ${ms(performance.now() - t2)}  backend=${res.backend}  candidates=${res.candidates.length}`);
for (const c of res.candidates.slice(0, 8)) console.log(`   ${c.platform.padEnd(9)} ${c.username.padEnd(24)} ${c.sourceUrl || ""}`);
console.log("\ncache stats:", JSON.stringify(cacheStats()));
