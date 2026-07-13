// ============================================================================
// TEST HARNESS: the multi-state school-source adapters, offline (bundled + run
// by scripts/test-school-adapters.mjs). Fakes every external site in-memory
// and drives the REAL orchestration: findSchoolForPlayer's tier ladder →
// adapter parsing → fetchSchoolRoster's adapter routing.
//
//   node scripts/test-school-adapters.mjs
//
// Scenarios:
//   WA — NWSRS (tier 1): Aditya → Skyline/SKN at 80%, roster from the
//        code-keyed school report, lower tiers skipped (wachess.org untouched).
//   WI — WSCF (tier 1): explicit school column at 80% + roster from the same
//        master list; tier 3 (wischess.org) skipped.
//   OK — CXR (tier 1): search page names the school (80%).
//   IL — IHSA (tier 2): no IL tier 1; results table infers the school (60%)
//        and co-listed rows form the roster.
//   AZ — AIA (tier 2): championship table infers the school.
//   KS — KSCA (tier 1, 60%) + KSHSAA (tier 2, 60%) agree → consolidated ≥70%.
//   NH — no state source: nationwide tier 4 attempted, then nothing (the AI
//        web/LinkedIn tier is keyless here and fails soft).
//   Rating sanity — ratingMatchWeight punishes implausible USCF↔online gaps
//        (the 242-vs-1298 @ethan_ao case must not reach 60%+).
// ============================================================================

import { findSchoolForPlayer, fetchSchoolRoster } from "../supabase/functions/resolve-identity/school";
import { ratingMatchWeight, scoreFromEvidence } from "../src/lib/identity/confidence";
import type { Evidence } from "../src/lib/identity/types";

// ---------------------------------------------------------------------------
// Fake network — every outbound URL is recorded, fixtures served, rest 404.
// ---------------------------------------------------------------------------

const fetched: string[] = [];
const H = (html: string) => new Response(html, { status: 200, headers: { "content-type": "text/html" } });

const nwsrsRow = (last: string, first: string, grade: string, school: string, id: string, rating: number) =>
  `<tr><td>${last}</td><td>${first}</td><td>${grade}</td><td><span class="id" onmouseover="Tip('${school}, ${grade}th grade')">${id}</span></td><td>${rating}</td></tr>`;

const FIXTURES: Record<string, string> = {
  // --- NWSRS (WA) ------------------------------------------------------------
  "https://www.ratingsnw.com/ratings/ratingsB.php": `<table>${nwsrsRow("Brahmachary", "Aditya", "11", "Skyline High School", "SKNAB30T", 1632)}</table>`,
  "https://www.ratingsnw.com/ratings/schoolreport.php?school=SKN": `<table>
    ${nwsrsRow("Bhatia", "Tanush", "11", "Skyline High School", "SKNTB30X", 1696)}
    ${nwsrsRow("Liu", "Austin", "12", "Skyline High School", "SKNAL29Y", 2179)}
    ${nwsrsRow("Brahmachary", "Aditya", "11", "Skyline High School", "SKNAB30T", 1632)}
  </table>`,

  // --- WSCF (WI) — explicit columns ------------------------------------------
  "https://www.wisconsinscholasticchess.org/tournaments/ratings-look-up": `<table>
    <tr><th>Last Name</th><th>First Name</th><th>Rating</th><th>Grade</th><th>School/Team</th></tr>
    <tr><td>Chen</td><td>Maya</td><td>1548</td><td>10</td><td>Madison West High School</td></tr>
    <tr><td>Doe</td><td>Jon</td><td>1300</td><td>9</td><td>Madison West High School</td></tr>
    <tr><td>Smith</td><td>Ann</td><td>1100</td><td>11</td><td>Rufus King High School</td></tr>
  </table>`,

  // --- CXR (OK) — search result names the school -----------------------------
  "https://www.cxrchess.com/search.php?last=nguyen&first=liam": `<table>
    <tr><td>Nguyen, Liam</td><td>1420</td><td>Jenks High School</td></tr>
  </table>`,

  // --- IHSA (IL) — results table, school inferred ----------------------------
  "https://www.ihsa.org/Sports-Activities/Chess": `<table>
    <tr><td>Ramirez, Sofia</td><td>11</td><td>Whitney Young High School</td></tr>
    <tr><td>Park, Ethan</td><td>12</td><td>Whitney Young High School</td></tr>
    <tr><td>Lee, Ana</td><td>10</td><td>New Trier High School</td></tr>
  </table>`,

  // --- AIA (AZ) ---------------------------------------------------------------
  "https://aiaonline.org/activities/chess": `<table>
    <tr><td>Soto, Diego</td><td>Desert Vista High School</td><td>5.0</td></tr>
  </table>`,

  // --- KSCA + KSHSAA (KS) — two sources agreeing on the same school ----------
  "https://www.ksca.us/": `<table>
    <tr><td>Wilson, Emma</td><td>1200</td><td>Blue Valley North High School</td></tr>
  </table>`,
  "https://www.kshsaa.org/Public/Chess/Main.cfm": `<table>
    <tr><td>Wilson, Emma</td><td>Blue Valley North High School</td><td>4.5</td></tr>
  </table>`,
};

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  fetched.push(url);
  // Fixtures are registered with lowercase query values (the adapters
  // URL-encode the normalized player fields).
  const hit = FIXTURES[url] ?? FIXTURES[url.toLowerCase()];
  if (hit) return H(hit);
  return new Response("Not Found", { status: 404 });
}) as typeof fetch;

// ---------------------------------------------------------------------------

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};
const log = (m: string) => console.log(`    ${m}`);
const wasFetched = (part: string) => fetched.some((u) => u.includes(part));

async function waNwsrs() {
  console.log("\n=== WA — NWSRS (tier 1) regression ===\n");
  const r = await findSchoolForPlayer({ name: "Aditya Brahmachary", state: "WA", uscfRating: 1632 }, log);
  const top = r.affiliations[0];
  check("WA1 school found via NWSRS", top?.school === "Skyline High School" && top?.sourceId === "nwsrs", JSON.stringify(top));
  check("WA2 code + confidence carried", top?.schoolCode === "SKN" && top?.confidence >= 0.8, `code=${top?.schoolCode} conf=${top?.confidence}`);
  check("WA3 lower tiers skipped (wachess.org untouched)", !wasFetched("wachess.org"));
  const roster = await fetchSchoolRoster(top.school, top.schoolCode, "WA", top.source, top.sourceId, log);
  const names = roster.schoolmates.map((s) => s.name);
  check("WA4 roster from the SKN school report", names.includes("Tanush Bhatia") && names.includes("Austin Liu"), names.join(", "));
}

async function wiWscf() {
  console.log("\n=== WI — WSCF (tier 1) ===\n");
  const r = await findSchoolForPlayer({ name: "Maya Chen", state: "WI", uscfRating: 1550 }, log);
  const top = r.affiliations[0];
  check("WI1 explicit school column at 80%", top?.school === "Madison West High School" && top?.confidence >= 0.8, JSON.stringify(top));
  check("WI2 adapter id carried", top?.sourceId === "wscf", top?.sourceId);
  check("WI3 tier 3 skipped (wischess.org untouched)", !wasFetched("wischess.org"));
  const roster = await fetchSchoolRoster(top.school, top.schoolCode, "WI", top.source, top.sourceId, log);
  const names = roster.schoolmates.map((s) => s.name);
  check("WI4 roster from the same master list", names.includes("Jon Doe") && !names.includes("Ann Smith"), names.join(", "));
}

async function okCxr() {
  console.log("\n=== OK — CXR (tier 1) ===\n");
  const r = await findSchoolForPlayer({ name: "Liam Nguyen", state: "OK", uscfRating: 1400 }, log);
  const top = r.affiliations[0];
  check("OK1 CXR names the school", top?.school === "Jenks High School" && top?.sourceId === "cxr", JSON.stringify(top));
  check("OK2 structured profile → 80%", (top?.confidence ?? 0) >= 0.8, `conf=${top?.confidence}`);
}

async function ilIhsa() {
  console.log("\n=== IL — IHSA (tier 2) ===\n");
  const r = await findSchoolForPlayer({ name: "Sofia Ramirez", state: "IL", uscfRating: 1500 }, log);
  const top = r.affiliations[0];
  check("IL1 IHSA infers the school", top?.school === "Whitney Young High School" && top?.sourceId === "il-ihsa", JSON.stringify(top));
  check("IL2 inferred → 60%", Math.abs((top?.confidence ?? 0) - 0.6) < 0.01, `conf=${top?.confidence}`);
  const roster = await fetchSchoolRoster(top.school, top.schoolCode, "IL", top.source, top.sourceId, log);
  const names = roster.schoolmates.map((s) => s.name);
  check("IL3 co-listed rows form the roster", names.includes("Ethan Park") && !names.includes("Ana Lee"), names.join(", "));
}

async function azAia() {
  console.log("\n=== AZ — AIA (tier 2) ===\n");
  const r = await findSchoolForPlayer({ name: "Diego Soto", state: "AZ" }, log);
  const top = r.affiliations[0];
  check("AZ1 AIA infers the school", top?.school === "Desert Vista High School" && top?.sourceId === "az-aia", JSON.stringify(top));
}

async function ksAgreement() {
  console.log("\n=== KS — KSCA + KSHSAA agreement ===\n");
  const r = await findSchoolForPlayer({ name: "Emma Wilson", state: "KS", uscfRating: 1200 }, log);
  const top = r.affiliations[0];
  check("KS1 school found", top?.school === "Blue Valley North High School", JSON.stringify(top));
  check("KS2 both sources queried", wasFetched("ksca.us") && wasFetched("kshsaa.org"));
  check("KS3 agreement lifts confidence ≥ 70%", (top?.confidence ?? 0) >= 0.7, `conf=${top?.confidence}`);
}

async function nhNothing() {
  console.log("\n=== NH — no state source, nationwide tier 4 only ===\n");
  const r = await findSchoolForPlayer({ name: "Zoe Adams", state: "NH" }, log);
  check("NH1 nationwide registration source attempted", wasFetched("caissachess.net"));
  check("NH2 gracefully found nothing", r.affiliations.length === 0 && r.notes.some((n) => n.includes("No school affiliation found")));
}

function ratingSanity() {
  console.log("\n=== Rating sanity — the 242-vs-1298 case ===\n");
  check("R1 implausible gap is strong counter-evidence", ratingMatchWeight(1298, 242) <= -1.2, `got ${ratingMatchWeight(1298, 242)}`);
  // The @ethan_ao evidence shape: perfect name match + live account + the gap.
  const ev: Evidence[] = [
    { kind: "name-match", weight: 2.4, label: "name", source: "verification" },
    { kind: "account-verified", weight: 0.6, label: "live", source: "verification" },
    { kind: "rating-match", weight: ratingMatchWeight(1298, 242), label: "rating", source: "verification" },
  ];
  const conf = scoreFromEvidence(ev);
  check("R2 namesake with implausible rating stays below 55%", conf < 0.55, `got ${Math.round(conf * 100)}%`);
  check("R3 plausible offsets stay corroborating", ratingMatchWeight(1500, 1200) > 0, `got ${ratingMatchWeight(1500, 1200)}`);
}

async function main() {
  await waNwsrs();
  await wiWscf();
  await okCxr();
  await ilIhsa();
  await azAia();
  await ksAgreement();
  await nhNothing();
  ratingSanity();
  console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
