// THROWAWAY (gitignored). v2 of the handle/name resemblance measurement.
//
// v1 was too strict and over-reported "no resemblance": it only tested the
// FIRST and LAST name tokens, required >=4 chars, and demanded a whole-token
// substring. That mis-classified gmarunchess ("Arunprasad" -> "arun"),
// gmronbo ("Ron", 3 chars) and aguiar94 (a MIDDLE name).
//
// v2 reports two bounds so the reader can see the sensitivity:
//   STRICT  : some whole name token (>=3 chars, any position) is a substring
//   LENIENT : also counts a >=3-char prefix of any token, and initial+surname
// "no resemblance" under LENIENT is the defensible figure; STRICT is the ceiling.

const UA = { "User-Agent": "ScoutTree-research/1.0 (measurement)", Accept: "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = 110;
async function j(u) { try { const r = await fetch(u, { headers: UA }); return r.ok ? await r.json().catch(() => null) : null; } catch { return null; } }
const humanName = (n) => typeof n === "string" && /^[A-Za-z][A-Za-z.'\-]*(?: [A-Za-z][A-Za-z.'\-]*){1,3}$/.test(n.trim()) && n.trim().length >= 5 && n.trim().length <= 40;
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function resemble(name, handle) {
  const h = norm(handle);
  const toks = name.trim().split(/\s+/).map(norm).filter((t) => t.length >= 2);
  if (!toks.length || !h) return { strict: false, lenient: false, why: "" };
  // STRICT: whole token (>=3) appears in the handle
  for (const t of toks) if (t.length >= 3 && h.includes(t)) return { strict: true, lenient: true, why: `token "${t}"` };
  // LENIENT: a >=3-char prefix of any token appears
  for (const t of toks) {
    for (let L = Math.min(t.length, 6); L >= 3; L--) {
      if (h.includes(t.slice(0, L))) return { strict: false, lenient: true, why: `prefix "${t.slice(0, L)}" of "${t}"` };
    }
  }
  // LENIENT: initial(s) + surname, e.g. "jsmith" / "lcunha"
  const last = toks[toks.length - 1];
  if (last.length >= 4) {
    for (const t of toks.slice(0, -1)) if (h.includes(t[0] + last.slice(0, 4))) return { strict: false, lenient: true, why: `initial+surname` };
  }
  return { strict: false, lenient: false, why: "" };
}

const pick = (a, n, stride) => (Array.isArray(a) ? a.filter((_, i) => i % stride === 0).slice(0, n) : []);
async function tier(label, handles, want) {
  const out = [];
  for (const u of handles) {
    if (out.length >= want) break;
    const p = await j(`https://api.chess.com/pub/player/${encodeURIComponent(u)}`);
    await sleep(PACE);
    if (!p || p.closed || !humanName(p.name)) continue;
    const hdl = p.username || u;
    out.push({ tier: label, handle: hdl, name: p.name.trim(), ...resemble(p.name, hdl) });
  }
  return out;
}

const gm = await j("https://api.chess.com/pub/titled/GM"); await sleep(150);
const fm = await j("https://api.chess.com/pub/titled/FM"); await sleep(150);
const nm = await j("https://api.chess.com/pub/titled/NM"); await sleep(150);
const club = await j("https://api.chess.com/pub/club/chess-com-developer-community/members"); await sleep(150);
const clubPool = club ? [...new Set(["weekly","monthly","all_time"].flatMap((b) => (Array.isArray(club[b]) ? club[b] : [])).map((m) => m?.username).filter(Boolean))] : [];

// same deterministic strides as v1, so this is the same sample
const rows = [
  ...(await tier("titled-GM", pick(gm?.players, 60, 29), 20)),
  ...(await tier("titled-FM", pick(fm?.players, 60, 53), 20)),
  ...(await tier("titled-NM", pick(nm?.players, 60, 17), 20)),
  ...(await tier("ordinary", pick(clubPool, 120, 61), 20)),
];

console.log(`pairs: ${rows.length}\n`);
console.log("tier         n   noResemblance(STRICT)   noResemblance(LENIENT)");
for (const t of [...new Set(rows.map((r) => r.tier))]) {
  const g = rows.filter((r) => r.tier === t);
  const ns = g.filter((r) => !r.strict).length, nl = g.filter((r) => !r.lenient).length;
  console.log(`${t.padEnd(12)} ${String(g.length).padStart(2)}   ${String(ns).padStart(2)}/${g.length} (${((ns/g.length)*100).toFixed(0)}%)            ${String(nl).padStart(2)}/${g.length} (${((nl/g.length)*100).toFixed(0)}%)`);
}
const ns = rows.filter((r) => !r.strict).length, nl = rows.filter((r) => !r.lenient).length;
console.log("\n================ OVERALL ================");
console.log(`handle carries a whole name token (STRICT) : ${rows.length-ns}/${rows.length} (${(((rows.length-ns)/rows.length)*100).toFixed(0)}%)`);
console.log(`handle carries any name signal  (LENIENT)  : ${rows.length-nl}/${rows.length} (${(((rows.length-nl)/rows.length)*100).toFixed(0)}%)`);
console.log(`NO name signal at all (LENIENT)            : ${nl}/${rows.length} (${((nl/rows.length)*100).toFixed(0)}%)   <-- defensible figure`);
console.log(`NO whole token      (STRICT)               : ${ns}/${rows.length} (${((ns/rows.length)*100).toFixed(0)}%)   <-- ceiling`);
console.log("\ntruly unrelated handles (no signal even under LENIENT):");
for (const r of rows.filter((x) => !x.lenient).slice(0, 15)) console.log(`   ${r.tier.padEnd(10)} "${r.name}" -> ${r.handle}`);
console.log("\nrescued by LENIENT (v1 wrongly called these unrelated):");
for (const r of rows.filter((x) => !x.strict && x.lenient).slice(0, 10)) console.log(`   "${r.name}" -> ${r.handle}   [${r.why}]`);
