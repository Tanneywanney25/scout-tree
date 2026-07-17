// ============================================================================
// TEST HARNESS: the NWSRS adapter's table parsing, offline (bundled + run by
// scripts/test-nwsrs.mjs). Serves ratings-page HTML shaped like the LIVE site
// — the shapes the old single-regex parser silently failed on — and drives the
// real findSchoolForPlayer / fetchSchoolRoster path end to end.
//
//   node scripts/test-nwsrs.mjs
//
// Row shapes covered (all on one page, as the live page mixes them):
//   • <td> cells with attributes (align/class) — the old /(<td>)/ literal
//     never matched these.
//   • id wrapped in <span onmouseover="Tip('School, grade')"> — school name +
//     code both extracted.
//   • id as BARE text (no span, no Tip) — code still derived from the id, the
//     player is NOT dropped (confidence 0.7, code-only).
//   • id wrapped in <a href> with the Tip on the anchor.
// Plus: the A-page (Ethan Ao) case, the A-Z fallback scan for a surname that
// buckets under a different letter, and the code-keyed roster.
// ============================================================================

import { findSchoolForPlayer, fetchSchoolRoster } from "../supabase/functions/resolve-identity/school";

const H = (html: string) => new Response(html, { status: 200, headers: { "content-type": "text/html" } });
const fetched: string[] = [];

// A realistic page wrapper: a header row (must be skipped) + data rows. Cells
// carry attributes; the id column varies in markup row to row.
const page = (rows: string) => `<!DOCTYPE html><html><body>
<table class="ratings" border="1">
  <tr><th>Last</th><th>First</th><th>Gr</th><th>ID</th><th>Rating</th><th>Games</th><th>YTD</th><th>State</th></tr>
  ${rows}
</table></body></html>`;

// Skyline row for Aditya — id in a <span> with the Tip (the canonical shape).
const spanRow = (last: string, first: string, grade: string, school: string, id: string, rating: number) =>
  `<tr>
     <td align="left">${last}</td>
     <td align="left">${first}</td>
     <td align="center">${grade}</td>
     <td class="id"><span class="id" onmouseover="Tip('${school}, ${grade}th grade')" onmouseout="UnTip()">${id}</span></td>
     <td align="right">${rating}</td><td align="right">31</td><td align="right">12</td><td>WA</td>
   </tr>`;

// Bare id — no span, no tooltip. Code must still come from the id.
const bareRow = (last: string, first: string, grade: string, id: string, rating: number) =>
  `<tr><td>${last}</td><td>${first}</td><td>${grade}</td><td>${id}</td><td>${rating}</td><td>5</td><td>2</td><td>WA</td></tr>`;

// id inside an <a> with the Tip on the anchor.
const linkRow = (last: string, first: string, grade: string, school: string, id: string, rating: number) =>
  `<tr><td>${last}</td><td>${first}</td><td>${grade}</td>` +
  `<td><a href="/player/${id}" onmouseover="Tip('${school}, ${grade}th grade')">${id}</a></td>` +
  `<td>${rating}</td><td>9</td><td>3</td><td>WA</td></tr>`;

const FIXTURES: Record<string, string> = {
  // B page — Aditya Brahmachary (span+Tip), plus other-letter noise and a bare
  // row to prove code-only extraction, and a link-wrapped row.
  "https://www.ratingsnw.com/ratings/ratingsB.php": page(
    spanRow("Brahmachary", "Aditya", "11", "Skyline High School", "SKNLH30T", 1542) +
      bareRow("Booker", "Chris", "9", "RDMCB09Q", 980) +
      linkRow("Bianchi", "Elena", "10", "IntlBellevue Academy", "BELEB10Z", 1330)
  ),
  // A page — Ethan Ao (span+Tip → Newport High School).
  "https://www.ratingsnw.com/ratings/ratingsA.php": page(
    spanRow("Ao", "Ethan", "10", "Newport High School", "NEWEA10R", 1298) +
      spanRow("Anderson", "Kyle", "12", "Skyline High School", "SKNKA12T", 1710)
  ),
  // D page — for the fallback scan: "De La Cruz" buckets under C (last token
  // "cruz") but the row lives on the D page.
  "https://www.ratingsnw.com/ratings/ratingsD.php": page(
    spanRow("De La Cruz", "Maria", "11", "Garfield High School", "GARMD11P", 1455)
  ),
  // Code-keyed school report (the roster).
  "https://www.ratingsnw.com/ratings/schoolreport.php?school=SKN": page(
    spanRow("Bhatia", "Tanush", "11", "Skyline High School", "SKNTB30X", 1696) +
      spanRow("Liu", "Austin", "12", "Skyline High School", "SKNAL29Y", 2179) +
      bareRow("Yu", "Luke", "10", "SKNLY10M", 1453)
  ),
};

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  fetched.push(url);
  if (FIXTURES[url]) return H(FIXTURES[url]);
  // Every other ratings letter page: an empty table (so the fallback scan runs
  // but finds nothing there).
  if (/ratings[A-Z]\.php$/.test(url)) return H(page(""));
  return new Response("Not Found", { status: 404 });
}) as typeof fetch;

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const log = (m: string) => console.log(`    ${m}`);

async function aditya() {
  console.log("\n=== Aditya Brahmachary (the reported bug: span+Tip on the B page) ===\n");
  const r = await findSchoolForPlayer({ name: "Aditya Brahmachary", state: "WA", uscfRating: 1632 }, log);
  const top = r.affiliations[0];
  check("A1 school found (was 'not found')", !!top, JSON.stringify(top));
  check("A2 school name from Tip", top?.school === "Skyline High School", top?.school);
  check("A3 school code SKN from id", top?.schoolCode === "SKN", top?.schoolCode);
  check("A4 regional id + grade", top?.regionalId === "SKNLH30T" && top?.grade === "11", `${top?.regionalId}/${top?.grade}`);
  check("A5 confidence 80%", top?.confidence === 0.8, `${top?.confidence}`);
}

async function roster() {
  console.log("\n=== Roster from the code-keyed school report ===\n");
  const r = await fetchSchoolRoster("Skyline High School", "SKN", "WA", "nwsrs", "nwsrs", log);
  const names = r.schoolmates.map((s) => s.name);
  check("R1 roster non-empty", r.schoolmates.length >= 3, names.join(", "));
  check("R2 includes Tanush + Austin + Luke", ["Tanush Bhatia", "Austin Liu", "Luke Yu"].every((n) => names.includes(n)), names.join(", "));
}

async function ethanAo() {
  console.log("\n=== Ethan Ao (A page) ===\n");
  const r = await findSchoolForPlayer({ name: "Ethan Ao", state: "WA", uscfRating: 1298 }, log);
  const top = r.affiliations[0];
  check("E1 found on the A page", !!top && top.school === "Newport High School", JSON.stringify(top));
  check("E2 code NEW from id NEWEA10R", top?.schoolCode === "NEW", top?.schoolCode);
}

async function bareId() {
  console.log("\n=== Bare id (no span/Tip): code-only, player NOT dropped ===\n");
  // Chris Booker's row on the B page has a bare id RDMCB09Q — no tooltip.
  const r = await findSchoolForPlayer({ name: "Chris Booker", state: "WA" }, log);
  const top = r.affiliations[0];
  check("B1 matched despite no tooltip", !!top, JSON.stringify(top));
  check("B2 code RDM derived from id", top?.schoolCode === "RDM", top?.schoolCode);
  check("B3 confidence 70% (code-only)", top?.confidence === 0.7, `${top?.confidence}`);
}

async function fallbackScan() {
  console.log("\n=== A-Z fallback scan (surname buckets under a different letter) ===\n");
  const before = fetched.length;
  const r = await findSchoolForPlayer({ name: "Maria De La Cruz", state: "WA" }, log);
  const top = r.affiliations[0];
  check("F1 found via fallback scan", !!top && top.school === "Garfield High School", JSON.stringify(top));
  check("F2 the C page was tried first", fetched.slice(before).some((u) => u.endsWith("ratingsC.php")));
  check("F3 the D page ultimately matched", fetched.slice(before).some((u) => u.endsWith("ratingsD.php")));
}

async function main() {
  await aditya();
  await roster();
  await ethanAo();
  await bareId();
  await fallbackScan();
  console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
