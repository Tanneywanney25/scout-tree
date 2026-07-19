// ============================================================================
// School-affiliation discovery (server side).
//
// For a player with no online USCF tournament history, the tournament-graph
// engine has nothing to trace. This module finds the player's SCHOOL — the hook
// the social-graph fallback hangs on — from the public record:
//
//   TIER 1 — NWSRS (Chess Ratings NorthWest): the richest, most structured
//     scholastic source (WA/OR/ID/BC). A player's ratings row encodes their
//     school in the ID tooltip, and a "school report" page lists the whole
//     roster. Pure HTML, no key needed — so this runs everywhere, always.
//
//   TIERS 2-5 — state high-school activity associations, state chess-association
//     result archives, registration/entry-list platforms, and LinkedIn / the
//     general web. These are fragile, hand-rolled, per-state and endlessly
//     varied, so instead of a brittle scraper per site we drive them through
//     ONE AI web-search adapter whose query ladder names the right sources for
//     the player's state (and always includes LinkedIn + a running/athletics
//     roster pass, since those often state a school outright). The model reads
//     whatever HTML each site serves and reports the school; we verify the
//     STATE it returns against the USCF/FIDE record before trusting it.
//
// Everything fails soft: any source that errors, times out or isn't configured
// contributes nothing and the next source runs. Runtime-agnostic (Deno edge +
// Node CLI), same as googleSearch.ts / uscf.ts.
// ============================================================================

import { callAIWithSearch, geminiQuotaCoolingDown, readEnv } from "../_shared/ai.ts";
import {
  EXTERNAL_ADAPTERS,
  adaptersForState,
  type AdapterPlayer,
  type AdapterSchoolHit,
  type SchoolAdapter,
} from "./schoolAdapters.ts";
import type {
  SchoolAffiliation,
  SchoolLookupRequest,
  SchoolLookupResult,
  Schoolmate,
  SchoolRosterResult,
} from "../../../src/lib/identity/schoolTypes.ts";

const UA = "Mozilla/5.0 (compatible; ScoutTree/1.0; +https://chess-scout.vercel.app)";

// States NWSRS actually covers. Outside these it holds nothing, so we skip it
// (and lean on the web adapter, which knows each state's real sources).
const NWSRS_STATES = new Set(["WA", "OR", "ID", "BC"]);

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "Washington DC", BC: "British Columbia",
};

// State → the highest-scholastic-volume sources worth searching (Tiers 2-4).
// Leads to feed the AI ladder, not hardcoded scrapers — validated at read time.
const STATE_SOURCE_HINTS: Record<string, string[]> = {
  WI: ["wisconsinscholasticchess.org", "wischess.org"],
  OK: ["cxrchess.com", "cxr chess"],
  AR: ["cxrchess.com"], KS: ["cxrchess.com", "kansaschess.org", "kshsaa.org"],
  MO: ["cxrchess.com"], TX: ["texaschess.org", "cxrchess.com"],
  IL: ["ihsa.org", "ilchesscoach.org", "il-chess.org", "iesa.org"],
  AZ: ["aiaonline.org", "azchess.org"], MN: ["mshsl.org"],
  CA: ["calchess.org", "bayareachess.com", "scchess.com"],
  NY: ["nyschess.org", "chessnyc.com"], FL: ["floridachess.org"],
  GA: ["georgiachess.org"], NC: ["ncchess.org"], OH: ["ohchess.org"],
  MI: ["michess.org"], CO: ["colorado-chess.com"], MA: ["masschess.org"],
  NJ: ["njscf.org"], PA: ["pscfchess.org"],
  VA: ["vachess.org", "vschess.org/results", "officialchess.org"],
  OR: ["oscf.org", "ratingsnw.com"], WA: ["ratingsnw.com", "wachess.org"],
};
// KSCA runs Kansas' scholastic databases — feed it to the AI ladder too.
STATE_SOURCE_HINTS.KS.push("ksca.us");

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function nameTokens(name: string): { first: string; last: string; all: string[] } {
  const t = norm(name).split(" ").filter(Boolean);
  return { first: t[0] || "", last: t.length > 1 ? t[t.length - 1] : "", all: t };
}

/** Two names refer to the same person when the surnames match and the first
 *  names are compatible (equal, or one is a prefix of the other — handles
 *  "Aditya" vs "Aditya K"). Deliberately strict on surname to avoid cousins. */
function samePerson(a: string, b: string): boolean {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.last || !y.last || x.last !== y.last) return false;
  if (!x.first || !y.first) return true;
  return x.first === y.first || x.first.startsWith(y.first) || y.first.startsWith(x.first);
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(t);
    return null;
  }
}

const decodeEntities = (s: string) =>
  s
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Tier 1 — NWSRS (Chess Ratings NorthWest)
//
// Ratings are published on per-first-letter-of-surname pages
// (ratings/ratingsB.php for "Brahmachary"), each row:
//   <td>Last</td><td>First</td><td>Grade</td>
//   <td><span class="id" onmouseover="Tip('Skyline High School, 11th grade')">SKNLH30T</span></td>
//   <td>1542</td>...
// The Tip literally names the school — no code table needed. A "school report"
// page (ratings/schoolreport.php?school=<code>) lists that school's roster,
// keyed by the id's three-letter school code ("SKN") — never the school name.
// ---------------------------------------------------------------------------

const NWSRS_BASE = "https://www.ratingsnw.com";

/** One parsed NWSRS ratings/roster row. */
interface NwsrsRow {
  last: string;
  first: string;
  grade?: string;
  id: string;
  school?: string;
  rating?: number;
}

/** Pull the school out of an id cell's onmouseover Tip (the tooltip text). */
const TIP_RE = /Tip\('([^']*)'\)/i;

/** An NWSRS regional id: three school letters, then the player's initials and a
 *  serial that always carries at least one DIGIT ("SKNLH30T"). This SHAPE is
 *  how we find the id column regardless of where it sits or how it's wrapped —
 *  far more robust than a fixed position. Requiring a digit also keeps a header
 *  word like "Rating" (3+ letters, no digit) from being mistaken for an id. */
const NWSRS_ID_RE = /^[A-Z]{3}[A-Z0-9]*[0-9][A-Z0-9]*$/i;

/** School name out of a "Skyline High School, 11th grade" tooltip. */
function schoolFromTip(tip?: string): string | undefined {
  if (!tip) return undefined;
  const clean = decodeEntities(tip);
  const comma = clean.lastIndexOf(",");
  const school = (comma > 0 ? clean.slice(0, comma) : clean).trim();
  return school || undefined;
}

/** One <td> cell: both its stripped TEXT and its raw inner HTML (the Tip lives
 *  in an attribute, so it survives only in the raw form). */
interface NwsrsCell {
  text: string;
  raw: string;
}

/** Split a <tr>…</tr> block into cells, tolerating attributes on <td>/<th> and
 *  any inner markup (the id may be bare, or wrapped in a <span>/<a>/<font>). */
function rowCells(rowHtml: string): NwsrsCell[] {
  const cells: NwsrsCell[] = [];
  const re = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml))) {
    cells.push({ raw: m[1], text: decodeEntities(m[1].replace(/<[^>]*>/g, " ")) });
  }
  return cells;
}

// Parse the ratings/roster table STRUCTURALLY rather than with one rigid
// pattern. The old single regex demanded bare <td> tags and an id wrapped in a
// <span> in fixed positions; the live page varies (cell attributes, the id as
// plain text or inside an <a>/<font>), so every row silently failed to match
// and the player was reported "not found". Now: pull each row's cells, locate
// the id by its SHAPE, read last/first from the first two cells, and lift the
// school from the id cell's Tip when present — deriving the code from the id
// either way, so a missing tooltip never drops the player.
function parseNwsrsRows(html: string): NwsrsRow[] {
  const rows: NwsrsRow[] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(html))) {
    const cells = rowCells(tr[1]);
    if (cells.length < 4) continue; // need at least last, first, grade, id
    const last = cells[0].text;
    const first = cells[1].text;
    if (!last || !/[a-z]/i.test(last)) continue; // header / junk row
    if (!first || !/[a-z]/i.test(first)) continue;
    // The id is the first cell (after the name) whose text is id-shaped.
    const idIdx = cells.findIndex((c, i) => i >= 2 && NWSRS_ID_RE.test(c.text.trim()));
    if (idIdx < 0) continue;
    const id = cells[idIdx].text.trim().toUpperCase();
    // School: the Tip lives in the id cell's attributes; fall back to scanning
    // the whole row's raw HTML in case the markup nests it differently.
    const tip = TIP_RE.exec(cells[idIdx].raw)?.[1] ?? TIP_RE.exec(tr[1])?.[1];
    // Grade: a "K"/number cell sitting between the name and the id.
    const grade = cells.slice(2, idIdx).find((c) => /^(K|\d{1,2})$/i.test(c.text.trim()))?.text.trim();
    // Rating: the first plausible number in a cell after the id.
    const rating = cells
      .slice(idIdx + 1)
      .map((c) => Number(c.text.replace(/[^0-9]/g, "")))
      .find((n) => n >= 100 && n <= 3000);
    rows.push({ last, first, grade, school: schoolFromTip(tip), id, rating });
  }
  return rows;
}

/** The first THREE letters of an NWSRS id are the school code ("SKNLH30T" →
 *  "SKN") — the key the school-report page is queried by. The letters after
 *  them are the player's initials, so a greedy grab corrupts the code. */
function schoolCodeOf(id: string): string | undefined {
  const m = /^([A-Z]{3})/.exec(id);
  return m ? m[1] : undefined;
}

/** Fetch one ratings letter page and return the rows matching the player. */
async function nwsrsRowsFor(
  letter: string,
  req: SchoolLookupRequest,
  log: (m: string) => void
): Promise<{ url: string; matches: NwsrsRow[] } | null> {
  const L = letter.toUpperCase();
  if (!/[A-Z]/.test(L)) return null;
  const url = `${NWSRS_BASE}/ratings/ratings${L}.php`;
  const html = await fetchText(url, 20000);
  if (!html) {
    log(`NWSRS: ratings page ${L} unreachable.`);
    return null;
  }
  const all = parseNwsrsRows(html);
  const matches = all.filter((r) => samePerson(`${r.first} ${r.last}`, req.name));
  if (matches.length) {
    log(`NWSRS: found last name "${matches[0].last}" on the ${L} page (${all.length} rows scanned, ${matches.length} name match(es)).`);
  }
  return { url, matches };
}

/** NWSRS: find the target's row (school + regional id), keyless. Reads the
 *  ratings page for the surname's first letter, and — if the player isn't on
 *  it — scans the rest of A–Z as a fallback (a hyphenated/compound surname can
 *  bucket under a different letter than we guessed). */
async function nwsrsLookup(req: SchoolLookupRequest, log: (m: string) => void): Promise<SchoolAffiliation | null> {
  const { last } = nameTokens(req.name);
  if (!last) return null;
  const firstLetter = last[0].toUpperCase();
  if (!/[A-Z]/.test(firstLetter)) return null;

  log(`NWSRS: scanning ${NWSRS_BASE}/ratings/ratings${firstLetter}.php for "${req.name}"…`);
  let found = await nwsrsRowsFor(firstLetter, req, log);

  if (!found || !found.matches.length) {
    log(`NWSRS: no "${req.name}" on the ${firstLetter} page — scanning the other letters as a fallback…`);
    const others = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter((l) => l !== firstLetter);
    // 6 letters in flight; results picked in A–Z order (same winner as the
    // serial walk). The old one-at-a-time scan cost up to 25 × 20s against a
    // down site; now a dead NWSRS bails after the first burst of failures.
    const results = new Array<Awaited<ReturnType<typeof nwsrsRowsFor>>>(others.length);
    let hitAt = others.length; // lowest index with matches — later fetches stop
    let fails = 0;
    let idx = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (idx < others.length) {
          const i = idx++;
          if (i > hitAt || fails >= 8) return; // already found earlier in order / site is down
          const r = await nwsrsRowsFor(others[i], req, log);
          results[i] = r;
          if (r === null) fails++;
          if (r && r.matches.length && i < hitAt) hitAt = i;
        }
      })
    );
    if (fails >= 8) log(`NWSRS: the ratings pages look unreachable — abandoning the letter scan.`);
    for (const r of results) {
      if (r && r.matches.length) {
        found = r;
        break;
      }
    }
  }

  if (!found || !found.matches.length) {
    log(`NWSRS: "${req.name}" not found on any ratings page.`);
    return null;
  }

  // Prefer the highest-rated matching row (a serious player over a namesake).
  const matches = [...found.matches].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const hit = matches[0];
  const code = schoolCodeOf(hit.id);
  // The school report is keyed by the CODE, so the code (always derivable from
  // the id) is what the roster needs; the tooltip name is for display. Fall
  // back to the code as the display name when the tooltip is absent.
  const schoolName = hit.school || (code ? `NWSRS school ${code}` : undefined);
  if (!schoolName || !code) {
    log(`NWSRS: matched ${hit.first} ${hit.last} but couldn't derive a school code from id ${hit.id} — skipping.`);
    return null;
  }
  log(`NWSRS: found ${hit.last}, ${hit.first} (id ${hit.id}, school ${code}${hit.school ? ` — ${hit.school}` : ""}, NWSRS ${hit.rating ?? "?"}).`);
  return {
    school: schoolName,
    state: req.state,
    source: "nwsrs",
    sourceLabel: "Chess Ratings NorthWest (NWSRS)",
    sourceUrl: found.url,
    // Deterministic exact-name hit in a structured DB — a strong single source.
    // Slightly lower when the tooltip school name was missing (code-only).
    confidence: hit.school ? 0.8 : 0.7,
    regionalId: hit.id,
    schoolCode: code,
    grade: hit.grade,
    note: `NWSRS id ${hit.id} encodes school ${code}${hit.school ? ` (${hit.school})` : ""}.`,
  };
}

/** NWSRS: the roster of a school ("school report"), keyless. The endpoint is
 *  keyed by the three-letter school CODE (?school=SKN) — handing it the
 *  school's NAME silently returns a roster that isn't this school's. */
export async function nwsrsSchoolRoster(schoolCode: string, log: (m: string) => void): Promise<Schoolmate[]> {
  const code = schoolCode.trim().toUpperCase();
  const url = `${NWSRS_BASE}/ratings/schoolreport.php?school=${encodeURIComponent(code)}`;
  log(`NWSRS: pulling the school report for code ${code}…`);
  const html = await fetchText(url, 20000);
  if (!html) return [];
  const rows = parseNwsrsRows(html);
  const mates: Schoolmate[] = rows.map((r) => ({
    name: `${r.first} ${r.last}`.replace(/\s+/g, " ").trim(),
    rating: r.rating,
    regionalId: r.id,
    grade: r.grade,
    state: undefined,
    source: "nwsrs-school-report",
  }));
  log(`NWSRS: school report ${code} → ${mates.length} player(s).`);
  return mates;
}

// ---------------------------------------------------------------------------
// Tiers 2-5 — AI web search (state assns / registration / LinkedIn / general)
// ---------------------------------------------------------------------------

interface AiSchoolRow {
  school?: unknown;
  state?: unknown;
  source?: unknown;
  url?: unknown;
  confidence?: unknown;
  note?: unknown;
}

function buildSchoolSearchPrompt(req: SchoolLookupRequest): string {
  const stateName = req.state ? STATE_NAMES[req.state.toUpperCase()] || req.state : undefined;
  const hints = req.state ? STATE_SOURCE_HINTS[req.state.toUpperCase()] || [] : [];
  const ctx: string[] = [`Full name: ${req.name}`];
  if (stateName) ctx.push(`US state: ${stateName}`);
  if (req.city) ctx.push(`City: ${req.city}`);
  if (req.uscfRating) ctx.push(`USCF rating (approx): ${req.uscfRating}`);
  if (req.uscfId) ctx.push(`USCF member ID: ${req.uscfId}`);

  return `Find the SCHOOL (K-12 school, or the college/university for an adult) that a specific US chess player attends or attended. This is used to locate their schoolmates, so a current or recent school is what matters.

PLAYER:
${ctx.join("\n")}

Search the open web, trying these angles (do not stop at the first plausible hit — corroborate the state):
1. State scholastic chess results / crosstables that print name + school together${hints.length ? ` (try: ${hints.join(", ")})` : ""}.
2. State high-school activity-association chess rosters (team by school, board order).
3. Tournament registration / advance-entry lists (KingRegistration, caissachess.net, Tri-State Chess, officialchess.org) — these show name + school + section.
4. LinkedIn: site:linkedin.com/in "${req.name}"${stateName ? ` ${stateName}` : ""} — the Education section, or the Google snippet, often states a school even without login.
5. Other indexed pages that tie the name to a school: youth sports / running / robotics / debate rosters, honor rolls, news, club pages. Many list the athlete's school outright.

Rules:
- Only report a school an indexed page ACTUALLY ties to THIS person (same name, and same state when the state is known). Do not guess a school from the city.
- If the state you find contradicts the known state above, do NOT report it.
- Report every distinct well-supported school (current first), up to 4.

Return STRICT JSON only (no prose, no markdown fences):
{"schools":[{"school":"Full School Name","state":"2-letter","source":"linkedin|state-assoc|registration|web","url":"page that ties name to school","confidence":0.0-1.0,"note":"one short sentence"}]}`;
}

/** Map an AI "source" string to our SchoolSource enum. */
function aiSourceKind(s: unknown): SchoolAffiliation["source"] {
  const v = typeof s === "string" ? s.toLowerCase() : "";
  if (v.includes("linkedin")) return "linkedin";
  if (v.includes("regist") || v.includes("entry") || v.includes("king") || v.includes("caissa") || v.includes("tri")) return "registration";
  if (v.includes("assoc") || v.includes("state") || v.includes("scholastic") || v.includes("hs") || v.includes("high school activ")) return "state-assoc";
  return "web";
}

async function webFindSchool(req: SchoolLookupRequest, log: (m: string) => void): Promise<SchoolAffiliation[]> {
  if (geminiQuotaCoolingDown()) {
    log("School web search: AI quota cooling down — skipping (not a no-match).");
    return [];
  }
  const ai = await callAIWithSearch(
    "You are a research assistant who finds which school a chess player attends, strictly from what public web pages state. You never guess; you corroborate the state; you output strict JSON only.",
    buildSchoolSearchPrompt(req),
    1400,
    { maxSearchUses: 8 }
  );
  if (!ai.ok) {
    log(`School web search unavailable (${ai.status}, backend ${ai.backend || "?"}).`);
    return [];
  }
  log(`School web search served by ${ai.backend || "unknown backend"}.`);

  const out: SchoolAffiliation[] = [];
  try {
    const s = ai.text.replace(/```(?:json)?/gi, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(s.slice(start, end + 1));
      const rows: AiSchoolRow[] = Array.isArray(parsed.schools) ? parsed.schools : [];
      for (const r of rows) {
        const school = typeof r.school === "string" ? decodeEntities(r.school) : "";
        if (!school || school.length < 3) continue;
        const state = typeof r.state === "string" ? r.state.trim().toUpperCase().slice(0, 2) : undefined;
        // State sanity: if we know the player's state, a contradicting hit is
        // dropped (a same-name person in another state is a classic false lead).
        if (req.state && state && state !== req.state.trim().toUpperCase()) continue;
        const conf = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5;
        out.push({
          school,
          state: state || req.state,
          source: aiSourceKind(r.source),
          sourceLabel:
            aiSourceKind(r.source) === "linkedin" ? "LinkedIn (public profile / snippet)" : "Web / state-association search",
          sourceUrl: typeof r.url === "string" ? r.url : undefined,
          // Web/AI leads are inherently softer than a structured-DB hit; cap so
          // a single unverified web claim can never masquerade as certainty.
          confidence: Math.min(conf, 0.6),
          note: typeof r.note === "string" ? r.note.slice(0, 200) : undefined,
        });
      }
    }
  } catch {
    /* non-JSON answer — treat as no result */
  }
  return out.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

const schoolKey = (s: string) => norm(s).replace(/\b(the|school|high|middle|elementary|academy|of)\b/g, "").replace(/\s+/g, "");

/** Merge affiliations naming the same school; agreement across sources raises
 *  confidence. Highest-confidence school first. */
function consolidate(affs: SchoolAffiliation[]): SchoolAffiliation[] {
  const groups = new Map<string, SchoolAffiliation[]>();
  for (const a of affs) {
    const k = schoolKey(a.school);
    if (!k) continue;
    (groups.get(k) || groups.set(k, []).get(k)!).push(a);
  }
  const merged: SchoolAffiliation[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => b.confidence - a.confidence);
    const best = { ...group[0] };
    if (group.length > 1) {
      // Independent corroboration: two sources agreeing is much stronger than
      // either alone (log-odds-ish bump, clamped short of certainty).
      best.confidence = Math.min(0.95, best.confidence + 0.15 * (group.length - 1));
      best.note = `${group.length} sources agree (${group.map((g) => g.source).join(", ")}).`;
    }
    merged.push(best);
  }
  return merged.sort((a, b) => b.confidence - a.confidence);
}

// ---------------------------------------------------------------------------
// The adapter registry — NWSRS plus every external source (Tiers 1-4).
// ---------------------------------------------------------------------------

/** NWSRS expressed through the common adapter contract (the template every
 *  other adapter follows). Roster stays on the code-keyed school report via
 *  fetchSchoolRoster's dedicated path, which preserves full roster names. */
const nwsrsAdapter: SchoolAdapter = {
  id: "nwsrs",
  label: "Chess Ratings NorthWest (NWSRS)",
  tier: 1,
  states: [...NWSRS_STATES],
  sourceKind: "nwsrs",
  async findSchool(p: AdapterPlayer, log: (m: string) => void): Promise<AdapterSchoolHit | null> {
    const aff = await nwsrsLookup({ name: p.fullName, state: p.state, uscfRating: p.rating }, log);
    if (!aff) return null;
    return {
      schoolName: aff.school,
      schoolCode: aff.schoolCode,
      confidence: aff.confidence,
      sourceUrl: aff.sourceUrl,
      grade: aff.grade,
      regionalId: aff.regionalId,
      note: aff.note,
    };
  },
};

const REGISTRY: SchoolAdapter[] = [nwsrsAdapter, ...EXTERNAL_ADAPTERS];

/** A tier-1 (or better) hit at/above this skips the lower tiers entirely. */
const TIER_SKIP_CONFIDENCE = 0.7;

function hitToAffiliation(adapter: SchoolAdapter, hit: AdapterSchoolHit, state?: string): SchoolAffiliation {
  return {
    school: hit.schoolName,
    state,
    source: adapter.sourceKind,
    sourceId: adapter.id,
    sourceLabel: adapter.label,
    sourceUrl: hit.sourceUrl,
    confidence: Math.max(0, Math.min(1, hit.confidence)),
    regionalId: hit.regionalId,
    schoolCode: hit.schoolCode,
    grade: hit.grade,
    note: hit.note,
  };
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export async function findSchoolForPlayer(
  req: SchoolLookupRequest,
  log: (m: string) => void = () => {}
): Promise<SchoolLookupResult> {
  const notes: string[] = [];
  const affs: SchoolAffiliation[] = [];
  const state = req.state?.trim().toUpperCase();
  const { first, last } = nameTokens(req.name);
  const player: AdapterPlayer = {
    firstName: first,
    lastName: last,
    fullName: req.name,
    state,
    rating: req.uscfRating,
  };

  // The AI web/LinkedIn search runs CONCURRENTLY with the tier ladder — it is
  // slow, keyed and independent, and its findings merge in at the end whatever
  // the deterministic tiers produced.
  const webPromise = webFindSchool(req, log).catch(() => [] as SchoolAffiliation[]);

  // Deterministic sources, tier by tier: 1 regional rating systems, 2 HS
  // activity associations, 3 state-association archives, 4 registration
  // platforms. A confident hit (≥70%) stops the ladder.
  const tiers = adaptersForState(state, REGISTRY);
  if (!state) {
    // No state on record: NWSRS still scans keylessly by surname (the common
    // NW case), plus whatever nationwide sources exist.
    tiers[0].unshift(nwsrsAdapter);
    notes.push("No state on record — queried NWSRS and nationwide sources only.");
  } else if (!tiers.some((t) => t.length)) {
    notes.push(`No structured scholastic source registered for ${state} — relying on the web/AI search.`);
  }

  for (let t = 0; t < tiers.length; t++) {
    const group = tiers[t];
    if (!group.length) continue;
    const best = affs.reduce((m, a) => Math.max(m, a.confidence), 0);
    if (best >= TIER_SKIP_CONFIDENCE) {
      log(`School lookup: tier ${t + 1} skipped — a higher tier already answered at ${Math.round(best * 100)}%.`);
      notes.push(`Tier ${t + 1} skipped (higher-tier hit at ${Math.round(best * 100)}%).`);
      break;
    }
    log(`School lookup: tier ${t + 1} — ${group.map((g) => g.label).join("; ")}.`);
    const hits = await Promise.all(
      group.map(async (a) => {
        try {
          const hit = await a.findSchool(player, log);
          if (hit) log(`School lookup: ${a.label} → ${hit.schoolName} (${Math.round(hit.confidence * 100)}%).`);
          return hit ? hitToAffiliation(a, hit, state) : null;
        } catch (e) {
          log(`School lookup: ${a.label} failed (${e instanceof Error ? e.message : "error"}) — continuing.`);
          return null;
        }
      })
    );
    for (const h of hits) if (h) affs.push(h);
  }

  affs.push(...(await webPromise));

  const schools = consolidate(affs);
  if (schools.length) notes.push(`Found ${schools.length} candidate school(s): ${schools.map((s) => s.school).join("; ")}.`);
  else notes.push("No school affiliation found in any source.");

  return { affiliations: schools, notes, available: true };
}

// ---------------------------------------------------------------------------
// Chess.com friends (member-public, but the endpoint requires an authenticated
// session — the web UI calls /callback/friends/{user}/top-friends with the
// logged-in member's cookie; an anonymous call returns 401). We fetch it here
// (server-side) with a session cookie the OPERATOR supplies via env
// (CHESSCOM_COOKIE) — the same "bring your own credential" model as the AI keys.
// With no cookie configured this returns [] and the crawler leans on the fully
// public game-overlap signal instead. This is never CORS-accessible from the
// browser, which is exactly why it lives behind the edge function.
//
// FULL LIST, not just the widget's default page. The endpoint's default page is
// small (it powers the profile's top-friends widget — ~7 for a 28-friend
// member, which is why the crawl was starved of second-connection evidence). It
// accepts `page` and `per_page`, so we request a large page size and paginate
// until the list is exhausted, deduping across pages. That turns the "7 of 28"
// subset into every friend — the missing @Kai0627-style ties the social graph
// needs to crown a target from a second independent connection.
// ---------------------------------------------------------------------------

const HANDLE_RE = /^[A-Za-z0-9_-]{2,30}$/;

// Pagination bounds for the friends fetch. per_page is set high so a typical
// member comes back in one request; the page loop covers members with hundreds.
const FRIENDS_PER_PAGE = 100;
const FRIENDS_MAX_PAGES = 25; // safety ceiling (≤ FRIENDS_PER_PAGE × this friends)

/** Recursively pull friend usernames out of the callback response, whatever its
 *  shape. The exact JSON of /callback/friends/{u}/top-friends isn't documented
 *  (it needs auth to observe), so this is deliberately tolerant of both
 *  object-lists ([{username|user|handle: "x"}]) and bare string-lists (["x"]):
 *   • values of any username-ish key, and
 *   • handle-shaped bare strings that are elements of an array (a friends array).
 *  Over-collection is harmless — every handle is re-verified against the live
 *  chess.com API downstream, so a stray non-handle string just fails to verify. */
function collectUsernames(v: unknown, out: Set<string>, depth = 0, inArray = false): void {
  if (depth > 6 || out.size > 500 || v == null) return;
  if (typeof v === "string") {
    if (inArray && HANDLE_RE.test(v)) out.add(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectUsernames(x, out, depth + 1, true);
    return;
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Only handle-carrying keys — NOT "name" (a display name like "Kai" would
    // pass the pattern but resolve to the wrong account).
    for (const key of ["username", "user", "friendUsername", "handle"]) {
      const val = o[key];
      if (typeof val === "string" && HANDLE_RE.test(val)) out.add(val);
    }
    for (const val of Object.values(o)) if (val && typeof val === "object") collectUsernames(val, out, depth + 1, false);
  }
}

/** Pull a "total friends" count out of the response's pagination metadata, if
 *  it exposes one, for logging (how complete is the list we assembled?). The
 *  JSON shape is undocumented, so this scans generously and is informational
 *  only — the fetch loop stops on the first page that reveals no NEW friend,
 *  never on this number. */
function readTotalCount(v: unknown, depth = 0): number | undefined {
  if (depth > 6 || v == null || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  for (const [k, val] of Object.entries(o)) {
    if (typeof val === "number" && Number.isFinite(val)) {
      const key = k.toLowerCase();
      if (/(total.?count|total.?friends|friend.?count|total.?results|^total$|^count$)/.test(key)) return val;
    }
  }
  for (const val of Object.values(o)) {
    if (val && typeof val === "object") {
      const n = readTotalCount(val, depth + 1);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

type FriendsPage =
  | { status: "ok"; handles: string[]; total?: number }
  | { status: "auth" }
  | { status: "error" };

/** Fetch ONE page of a member's friends from the authenticated callback. The
 *  endpoint powers the profile top-friends widget but accepts `page`/`per_page`
 *  and returns the member's friends a page at a time; we request a large page
 *  and let the caller paginate. */
async function fetchFriendsPage(clean: string, cookie: string, page: number): Promise<FriendsPage> {
  const url =
    `https://www.chess.com/callback/friends/${encodeURIComponent(clean)}/top-friends` +
    `?page=${page}&per_page=${FRIENDS_PER_PAGE}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: cookie,
        Referer: `https://www.chess.com/member/${clean}/friends`,
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) return { status: "auth" };
    if (!res.ok) return { status: "error" };
    const data = await res.json();
    const set = new Set<string>();
    collectUsernames(data, set);
    set.delete(clean); // the owner isn't their own friend
    return { status: "ok", handles: [...set], total: readTotalCount(data) };
  } catch {
    clearTimeout(t);
    return { status: "error" };
  }
}

let friendsAuthMode: string | undefined; // last-logged cookie presence — announce the mode once, not per mate

/** A member's FULL chess.com friends list (all pages), deduped. Paginates the
 *  authenticated callback until a page reveals no new friend — so a 28-friend
 *  member returns all 28, not the top-friends widget's default handful. Returns
 *  [] when no session cookie is configured or the cookie is rejected. */
export async function fetchChesscomFriends(username: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const cookie = readEnv("CHESSCOM_COOKIE") || readEnv("CHESSCOM_SESSION");
  const mode = cookie ? "cookie" : "none";
  if (friendsAuthMode !== mode) {
    friendsAuthMode = mode;
    log(
      cookie
        ? "Chess.com friends: CHESSCOM_COOKIE is configured — paginating the authenticated friends endpoint for the FULL list."
        : "Chess.com friends: no CHESSCOM_COOKIE in the environment — public game archives and clubs carry the crawl."
    );
  }
  if (!cookie) return []; // no session configured — game-overlap carries the crawl
  const clean = username.trim().replace(/^@/, "");
  if (!clean) return [];

  const all = new Set<string>();
  let reportedTotal: number | undefined;
  let pagesWithFriends = 0;
  for (let page = 1; page <= FRIENDS_MAX_PAGES; page++) {
    const res = await fetchFriendsPage(clean, cookie, page);
    if (res.status === "auth") {
      log("Chess.com friends: session cookie rejected (expired?) — falling back to game overlap.");
      return [...all]; // empty on page 1; whatever we gathered otherwise
    }
    if (res.status === "error") break; // transient page error — keep what we have
    if (res.total !== undefined) reportedTotal = res.total;
    if (!res.handles.length) break; // past the last page — no more friends to gather
    const before = all.size;
    for (const h of res.handles) all.add(h);
    pagesWithFriends++;
    // End of the list: a page that reveals no NEW friend. Covers a curated
    // endpoint that ignores `page` (the second identical page adds nothing) and
    // an exact-multiple-of-per_page list (the next page comes back empty above).
    if (all.size === before) break;
  }
  const total = all.size;
  if (total) {
    log(
      `Chess.com friends: @${clean} → ${total} friend(s) across ${pagesWithFriends} page(s)` +
        (reportedTotal !== undefined && reportedTotal !== total ? ` (endpoint reports ${reportedTotal} total)` : "") +
        "."
    );
  }
  return [...all];
}

export async function fetchSchoolRoster(
  school: string,
  schoolCode: string | undefined,
  state: string | undefined,
  source: string | undefined,
  sourceId: string | undefined,
  log: (m: string) => void = () => {}
): Promise<SchoolRosterResult> {
  const notes: string[] = [];
  let schoolmates: Schoolmate[] = [];
  const st = state?.trim().toUpperCase();
  const code = schoolCode?.trim().toUpperCase();

  // 1. Adapter-routed roster: the affiliation carries WHICH source named the
  //    school (sourceId), and that source knows how to enumerate its players
  //    (WSCF's master list, a results archive's co-listed rows, …). NWSRS is
  //    handled below on its dedicated code-keyed path.
  const adapter = sourceId && sourceId !== "nwsrs" ? REGISTRY.find((a) => a.id === sourceId) : undefined;
  if (adapter?.fetchRoster) {
    const entries = await adapter.fetchRoster({ name: school, code }, log).catch(() => []);
    schoolmates = entries.map((e) => ({
      name: `${e.firstName} ${e.lastName}`.replace(/\s+/g, " ").trim(),
      rating: e.rating,
      regionalId: e.regionalId,
      grade: e.grade,
      state: st,
      source: `${adapter.id}-roster`,
    }));
    if (schoolmates.length) log(`School roster: ${adapter.label} → ${schoolmates.length} player(s) for "${school}".`);
  }

  // 2. NWSRS school report (also the fallback for any NW-state school): keyed
  //    by the three-letter school code the NWSRS id encodes — without a code
  //    there is no report (querying by name returns the WRONG school's
  //    roster, which is worse than none).
  if (!schoolmates.length && (sourceId === "nwsrs" || source === "nwsrs" || !st || NWSRS_STATES.has(st))) {
    if (code && /^[A-Z]{2,5}$/.test(code)) {
      schoolmates = await nwsrsSchoolRoster(code, log).catch(() => []);
    } else {
      log(`NWSRS: no school code for "${school}" — skipping its school report.`);
    }
  }

  if (schoolmates.length) notes.push(`Roster: ${schoolmates.length} schoolmate(s) from ${school}.`);
  else notes.push(`No roster available for ${school}.`);

  return { schoolmates, notes, available: true };
}
