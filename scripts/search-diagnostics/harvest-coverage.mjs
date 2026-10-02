// THROWAWAY measurement script (gitignored). Proposal A, parts 1 and 4.
//
// Claim under test: "Chess.com usernames appear literally in profile result
// URLs", so a regex harvest replaces the model extraction step.
//
// GROUND TRUTH METHOD: chess.com's own API gives us (real name -> correct
// handle) pairs for free. /pub/titled/{GM,FM,NM} lists handles; /pub/player/{h}
// exposes `name`. Where `name` is a plausible human name we have a verified
// pair. Ordinary club members supply an "obscure" tier the same way.
//
// KNOWN BIAS, stated up front: titled players are vastly more written-about
// than the scholastic players this product targets, so coverage measured on
// them is an UPPER BOUND on real-world coverage. If it is poor here it is worse
// in production.
//
// CONFOUND GUARD: the concurrency trial showed cumulative engine blocking. A
// player whose ladder returned ~0 results tells us nothing about URL coverage,
// so those are tracked separately as "no retrieval" rather than counted as
// misses.

const SX = "http://127.0.0.1:8080";
const UA = { "User-Agent": "ScoutTree-research/1.0 (measurement)", Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = UA) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch { return null; }
}

function looksLikeHumanName(n) {
  if (typeof n !== "string") return false;
  const s = n.trim();
  if (s.length < 5 || s.length > 40) return false;
  if (!/^[A-Za-z][A-Za-z.'\-]*(?: [A-Za-z][A-Za-z.'\-]*){1,3}$/.test(s)) return false;
  return s.split(/\s+/).length >= 2;
}

// ---------------------------------------------------------------- ground truth
async function buildTier(label, handles, want) {
  const pairs = [];
  for (const h of handles) {
    if (pairs.length >= want) break;
    const p = await getJson(`https://api.chess.com/pub/player/${encodeURIComponent(h)}`);
    await sleep(120);
    if (!p || p.closed) continue;
    if (!looksLikeHumanName(p.name)) continue;
    pairs.push({ tier: label, handle: p.username || h, name: p.name.trim(), country: p.country || "" });
  }
  return pairs;
}

console.log("building ground truth from chess.com's own API...");
const gm = await getJson("https://api.chess.com/pub/titled/GM");
await sleep(150);
const nm = await getJson("https://api.chess.com/pub/titled/NM");
await sleep(150);
const club = await getJson("https://api.chess.com/pub/club/chess-com-developer-community/members");
await sleep(150);

const pick = (arr, n, stride) => (Array.isArray(arr) ? arr.filter((_, i) => i % stride === 0).slice(0, n) : []);
const clubPool = club ? ["weekly", "monthly", "all_time"].flatMap((b) => (Array.isArray(club[b]) ? club[b] : [])).map((m) => m?.username).filter(Boolean) : [];

const tiers = [
  ...(await buildTier("strong(GM)", pick(gm?.players, 24, 37), 8)),
  ...(await buildTier("mid(NM)", pick(nm?.players, 24, 13), 8)),
  ...(await buildTier("obscure(club)", pick([...new Set(clubPool)], 40, 97), 8)),
];

console.log(`\nground-truth pairs: ${tiers.length}`);
for (const t of tiers) console.log(`  ${t.tier.padEnd(14)} ${t.handle.padEnd(22)} "${t.name}" ${t.country.slice(-2)}`);

// ---------------------------------------------------------------- the ladder
// Reduced to 4 queries per player (vs the production 8) to limit total outbound
// volume, since engine blocking accumulates with request count.
function ladder(name) {
  return [
    `site:chess.com "${name}"`,
    `"${name}" chess.com`,
    `site:lichess.org "${name}"`,
    `"${name}" chess profile`,
  ];
}

const PROFILE_RE = /chess\.com\/(?:member|members|player|players|stats\/live[a-z/]*)\/([A-Za-z0-9_-]{2,29})/gi;

async function searxng(q) {
  const d = await getJson(`${SX}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`);
  if (!d) return { hits: [], down: [] };
  return {
    hits: (d.results || []).map((r) => ({ url: r.url || "", title: r.title || "", content: r.content || "" })),
    down: (d.unresponsive_engines || []).map((e) => (Array.isArray(e) ? e[0] : e)),
  };
}

console.log("\n=== PART 1/4: does the CORRECT handle appear literally in a result URL? ===\n");
const out = [];
for (const t of tiers) {
  let hits = [];
  const down = new Set();
  for (const q of ladder(t.name)) {
    const r = await searxng(q);
    hits.push(...r.hits);
    r.down.forEach((d) => down.add(d));
    await sleep(400);
  }
  const urlBlob = hits.map((h) => h.url).join("\n");
  const textBlob = hits.map((h) => `${h.title} ${h.content}`).join("\n");

  // handles appearing in any chess.com profile URL
  PROFILE_RE.lastIndex = 0;
  const urlHandles = new Set();
  let m;
  while ((m = PROFILE_RE.exec(urlBlob))) urlHandles.add(m[1].toLowerCase());

  const target = t.handle.toLowerCase();
  const inUrl = urlHandles.has(target);
  const inText = new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\b`, "i").test(textBlob);
  const noRetrieval = hits.length < 3;

  out.push({ ...t, hits: hits.length, urlHandles: urlHandles.size, inUrl, inText, noRetrieval, down: [...down] });
  console.log(
    `${t.tier.padEnd(14)} ${t.handle.padEnd(22)} hits=${String(hits.length).padStart(3)} ` +
      `distinctHandlesInUrls=${String(urlHandles.size).padStart(2)} ` +
      `CORRECT_IN_URL=${inUrl ? "YES" : "no "} inSnippetText=${inText ? "YES" : "no "}` +
      `${noRetrieval ? "  <-- NO RETRIEVAL, excluded" : ""}`
  );
}

// ---------------------------------------------------------------- summary
console.log("\n================ COVERAGE ================");
const usable = out.filter((o) => !o.noRetrieval);
const excluded = out.length - usable.length;
console.log(`players measured: ${out.length}   usable: ${usable.length}   excluded (no retrieval): ${excluded}`);
for (const tier of ["strong(GM)", "mid(NM)", "obscure(club)"]) {
  const g = usable.filter((o) => o.tier === tier);
  if (!g.length) { console.log(`\n${tier}: no usable samples`); continue; }
  const inUrl = g.filter((o) => o.inUrl).length;
  const inText = g.filter((o) => o.inText).length;
  console.log(`\n${tier}  n=${g.length}`);
  console.log(`  correct handle in a result URL : ${inUrl}/${g.length} (${((inUrl / g.length) * 100).toFixed(0)}%)`);
  console.log(`  correct handle in snippet text : ${inText}/${g.length} (${((inText / g.length) * 100).toFixed(0)}%)`);
  console.log(`  avg distinct handles per player: ${(g.reduce((s, o) => s + o.urlHandles, 0) / g.length).toFixed(1)}  <-- regex-harvest noise`);
}
const allInUrl = usable.filter((o) => o.inUrl).length;
console.log(`\nOVERALL correct-handle-in-URL coverage: ${allInUrl}/${usable.length} (${usable.length ? ((allInUrl / usable.length) * 100).toFixed(0) : 0}%)`);
const avgNoise = usable.length ? usable.reduce((s, o) => s + o.urlHandles, 0) / usable.length : 0;
console.log(`Average distinct chess.com handles harvested per player: ${avgNoise.toFixed(1)}`);
console.log(`=> a regex harvest returns ~${avgNoise.toFixed(0)} candidates of which at most 1 is correct;`);
console.log(`   precision ceiling without a discriminator: ~${avgNoise ? (100 / avgNoise).toFixed(0) : 0}%`);
console.log("\nMISSES (correct handle NOT in any URL) - these are what the model must carry:");
for (const o of usable.filter((x) => !x.inUrl)) console.log(`  ${o.tier.padEnd(14)} "${o.name}" -> ${o.handle}`);
