// ============================================================================
// School-source adapters — the multi-state generalization of the NWSRS flow.
//
// The school-based identity resolver needs, for ANY state: (1) which platform
// knows this player's school, (2) how to ask it, (3) how to read the answer,
// and (4, when the platform has one) the school's roster. This module defines
// the common adapter interface and implements every non-NWSRS source; the
// NWSRS adapter itself lives in school.ts (wrapping the battle-tested code)
// and is registered alongside these.
//
// Tiers (queried in order; a hit at ≥70% confidence skips the lower tiers):
//   1 — independent regional rating systems (NWSRS WA/OR/ID/BC, WSCF WI,
//       KSCA KS, CXR OK/AR/KS/MO/TX): richest, most structured; explicit
//       school fields → 0.8 confidence.
//   2 — state high-school activities associations (IHSA/IESA IL, AIA AZ,
//       MSHSL MN, KSHSAA KS): rosters by school, board order.
//   3 — state chess association result archives (VA, IL, KS, WI, TX, CA, NY,
//       FL, GA, NC, OH, MI, CO, MA, NJ, PA, WA…): name + school printed
//       together on results pages.
//   4 — registration platforms (KingRegistration, caissachess.net, Tri-State
//       Chess, officialchess.org): public advance-entry lists.
//
// Non-NWSRS sources have no stable documented API, so tiers 2-4 (and the
// scrape side of tier 1) share ONE tolerant results-page scanner: fetch the
// configured pages, find the row naming the player, and read the school out
// of the same row. Page shapes verified against fixtures; live URLs are the
// source list's leads and every fetch fails soft (a wrong lead costs one log
// line). School names found by scanning are INFERRED → 0.6 confidence; an
// explicit structured column (WSCF's master list) → 0.8. The AI web-search
// tier (school.ts, includes LinkedIn) remains the safety net below all of it.
//
// Runtime-agnostic (Deno edge + Node CLI), fail-soft, keyless — same
// discipline as school.ts.
// ============================================================================

const UA = "Mozilla/5.0 (compatible; ScoutTree/1.0; +https://chess-scout.vercel.app)";

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

export interface AdapterPlayer {
  firstName: string;
  lastName: string;
  fullName: string;
  state?: string;
  rating?: number;
}

export interface AdapterSchoolHit {
  schoolName: string;
  schoolCode?: string;
  /** 0.8 when the source states the school in a structured field; 0.6 inferred. */
  confidence: number;
  sourceUrl?: string;
  grade?: string;
  regionalId?: string;
  note?: string;
}

export interface AdapterRosterEntry {
  firstName: string;
  lastName: string;
  rating?: number;
  grade?: string;
  regionalId?: string;
}

export interface SchoolAdapter {
  /** Stable id — carried on the affiliation so the roster call routes back here. */
  id: string;
  label: string;
  tier: 1 | 2 | 3 | 4;
  /** 2-letter state codes this source covers; "*" = any state. */
  states: string[];
  /** How the affiliation is categorized for the UI / consolidation. */
  sourceKind: "nwsrs" | "wscf" | "cxr" | "state-assoc" | "registration";
  findSchool(p: AdapterPlayer, log: (m: string) => void): Promise<AdapterSchoolHit | null>;
  /** Only adapters that can enumerate a school's players implement this. */
  fetchRoster?(school: { name: string; code?: string }, log: (m: string) => void): Promise<AdapterRosterEntry[]>;
}

// ---------------------------------------------------------------------------
// Shared fetch + HTML utilities (tolerant by design — these pages are wild)
// ---------------------------------------------------------------------------

// Page cache: findSchool and fetchRoster read the SAME pages moments apart
// (the WSCF master list is both the lookup table and the roster; NWSRS letter
// pages are re-read for the roster), and every re-download of these slow,
// small-nonprofit-hosted pages costs seconds. Successes are kept 10 minutes on
// the warm instance; failures 60s (so one request's tier ladder doesn't
// re-time-out the same dead URL over and over, but a later request retries).
const pageCache = new Map<string, { at: number; p: Promise<string | null> }>();
const PAGE_OK_TTL_MS = 10 * 60_000;
const PAGE_FAIL_TTL_MS = 60_000;

function fetchText(url: string, timeoutMs = 15000): Promise<string | null> {
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_OK_TTL_MS) return hit.p;
  const p = fetchTextUncached(url, timeoutMs);
  const entry = { at: Date.now(), p };
  pageCache.set(url, entry);
  void p.then((text) => {
    if (text === null) {
      // Re-stamp failures with the short TTL by expiry-shifting the entry.
      entry.at = Date.now() - (PAGE_OK_TTL_MS - PAGE_FAIL_TTL_MS);
    }
  });
  if (pageCache.size > 150) {
    const entries = [...pageCache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of entries.slice(0, 75)) pageCache.delete(k);
  }
  return p;
}

async function fetchTextUncached(url: string, timeoutMs: number): Promise<string | null> {
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

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " "));

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** All <tr> rows of every table on the page, as arrays of cell texts. */
export function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(html))) {
    const cells: string[] = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cell: RegExpExecArray | null;
    while ((cell = cellRe.exec(tr[1]))) cells.push(stripTags(cell[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Does this row's text name the player? Handles "First Last", "Last, First"
 *  and a first-initial ("Smith, J"). Token-boundary matched — "Lin" must not
 *  hit "Linda". */
export function rowNamesPlayer(cells: string[], p: AdapterPlayer): boolean {
  const text = norm(cells.join(" "));
  const last = norm(p.lastName);
  const first = norm(p.firstName);
  if (!last || !new RegExp(`(^|\\s)${last}(\\s|$)`).test(text)) return false;
  if (!first) return true;
  return new RegExp(`(^|\\s)${first}(\\s|$)`).test(text) || new RegExp(`(^|\\s)${first[0]}(\\s|$)`).test(text);
}

const SCHOOL_WORD_RE =
  /\b(high school|middle school|elementary|junior high|academy|charter|prep(?:aratory)?|montessori|school|(?:[A-Z][a-z]+ )+(?:HS|MS|ES|JH))\b/i;

/** Pull a school-looking string out of a row. Prefers a cell that names a
 *  school outright; refuses the player-name cell and pure numbers. */
export function schoolFromRow(cells: string[], p: AdapterPlayer): string | undefined {
  for (const raw of cells) {
    const cell = raw.trim();
    if (!cell || cell.length < 3 || cell.length > 64) continue;
    if (rowNamesPlayer([cell], p)) continue; // that's the player, not the school
    if (SCHOOL_WORD_RE.test(cell)) return cell.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

/** Parse a roster row's player name: "Last, First ..." or "First ... Last". */
function nameFromCell(cell: string): { first: string; last: string } | null {
  const c = cell.replace(/\s+/g, " ").trim();
  const comma = /^([A-Za-z' -]+),\s*([A-Za-z' -]+)$/.exec(c);
  if (comma) {
    const first = comma[2].trim().split(" ")[0];
    const last = comma[1].trim().split(" ").pop() || "";
    return first && last ? { first, last } : null;
  }
  const parts = c.split(" ").filter((x) => /^[A-Za-z'-]+$/.test(x));
  if (parts.length < 2 || parts.length > 4) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

/** First plausible chess rating in the row (300..3000, standalone number). */
function ratingFromRow(cells: string[]): number | undefined {
  for (const cell of cells) {
    const m = /^\s*(\d{3,4})\s*$/.exec(cell);
    if (m) {
      const n = Number(m[1]);
      if (n >= 300 && n <= 3000) return n;
    }
  }
  return undefined;
}

function gradeFromRow(cells: string[]): string | undefined {
  for (const cell of cells) {
    if (/^(K|1[0-2]|[1-9])$/.test(cell.trim())) return cell.trim();
  }
  return undefined;
}

/** Fill {last}/{first}/{full} placeholders into a search-URL template. */
const fillTemplate = (tpl: string, p: AdapterPlayer) =>
  tpl
    .replace(/\{last\}/g, encodeURIComponent(p.lastName))
    .replace(/\{first\}/g, encodeURIComponent(p.firstName))
    .replace(/\{full\}/g, encodeURIComponent(p.fullName));

// ---------------------------------------------------------------------------
// The generic results-page scanner (tiers 2-4 + scrape-side tier 1)
// ---------------------------------------------------------------------------

interface ScanConfig {
  id: string;
  label: string;
  tier: 1 | 2 | 3 | 4;
  states: string[];
  sourceKind: SchoolAdapter["sourceKind"];
  /** Static pages worth scanning (results archives, entry lists). */
  urls?: string[];
  /** Search-URL templates with {last}/{first}/{full} placeholders. */
  searchUrls?: string[];
  /** Confidence when a school is read from a matching row (0.6 inferred). */
  confidence?: number;
  /** Cap on pages fetched per lookup. */
  maxPages?: number;
}

const SCAN_PAGE_CAP = 4;

function makeScanAdapter(cfg: ScanConfig): SchoolAdapter {
  const pagesFor = (p: AdapterPlayer): string[] =>
    [...(cfg.searchUrls || []).map((t) => fillTemplate(t, p)), ...(cfg.urls || [])].slice(0, cfg.maxPages ?? SCAN_PAGE_CAP);

  const scan = async (
    p: AdapterPlayer,
    log: (m: string) => void
  ): Promise<{ hit: AdapterSchoolHit; url: string } | null> => {
    // Fetch every page at once (≤4), then evaluate IN ORDER — identical
    // winner to the old serial walk, but a dead site costs one timeout in
    // parallel instead of 15s × pages in series.
    const urls = pagesFor(p);
    const bodies = await Promise.all(urls.map((url) => fetchText(url)));
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const html = bodies[i];
      if (!html) {
        log(`[tier ${cfg.tier}] ${cfg.label}: ${url} unreachable — skipping.`);
        continue;
      }
      for (const cells of tableRows(html)) {
        if (!rowNamesPlayer(cells, p)) continue;
        const school = schoolFromRow(cells, p);
        if (!school) continue;
        return {
          hit: {
            schoolName: school,
            confidence: cfg.confidence ?? 0.6,
            sourceUrl: url,
            grade: gradeFromRow(cells),
            note: `${cfg.label} lists ${p.fullName} with ${school}.`,
          },
          url,
        };
      }
    }
    return null;
  };

  return {
    id: cfg.id,
    label: cfg.label,
    tier: cfg.tier,
    states: cfg.states,
    sourceKind: cfg.sourceKind,
    async findSchool(p, log) {
      const found = await scan(p, log);
      if (!found) return null;
      log(`[tier ${cfg.tier}] ${cfg.label}: "${p.fullName}" → ${found.hit.schoolName} (${Math.round(found.hit.confidence * 100)}%).`);
      return found.hit;
    },
    // Roster = every OTHER player the same pages list with the same school.
    async fetchRoster(school, log) {
      const out: AdapterRosterEntry[] = [];
      const seen = new Set<string>();
      const want = norm(school.name);
      const pages = [...(cfg.urls || [])].slice(0, cfg.maxPages ?? SCAN_PAGE_CAP);
      const bodies = await Promise.all(pages.map((url) => fetchText(url)));
      for (let i = 0; i < pages.length; i++) {
        const html = bodies[i];
        if (!html) continue;
        for (const cells of tableRows(html)) {
          if (!cells.some((c) => norm(c) === want)) continue;
          for (const cell of cells) {
            if (norm(cell) === want) continue;
            const name = nameFromCell(cell);
            if (!name) continue;
            const key = `${norm(name.first)}|${norm(name.last)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ firstName: name.first, lastName: name.last, rating: ratingFromRow(cells), grade: gradeFromRow(cells) });
            break; // one player per row
          }
        }
      }
      log(`[tier ${cfg.tier}] ${cfg.label}: roster for "${school.name}" → ${out.length} player(s).`);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// WSCF (Wisconsin) — tier 1. Master rating lists carry name, rating, grade and
// team/school in explicit columns, so this adapter maps columns by header and
// reads the school field directly (0.8), and the same table IS the roster.
// ---------------------------------------------------------------------------

const WSCF_URLS = [
  "https://www.wisconsinscholasticchess.org/tournaments/ratings-look-up",
  "https://wisconsinscholasticchess.org/tournaments/ratings-look-up",
];

interface ColumnMap {
  name?: number;
  last?: number;
  first?: number;
  school?: number;
  rating?: number;
  grade?: number;
}

function mapColumns(header: string[]): ColumnMap | null {
  const map: ColumnMap = {};
  header.forEach((h, i) => {
    const k = norm(h);
    if (/^(player|name|player name)$/.test(k)) map.name = i;
    else if (/last/.test(k)) map.last = i;
    else if (/first/.test(k)) map.first = i;
    else if (/school|team|club/.test(k)) map.school = i;
    else if (/rating|rtg/.test(k)) map.rating ??= i;
    else if (/grade|gr\b/.test(k)) map.grade = i;
  });
  const hasName = map.name !== undefined || (map.last !== undefined && map.first !== undefined);
  return hasName && map.school !== undefined ? map : null;
}

function wscfRows(html: string): { first: string; last: string; school: string; rating?: number; grade?: string }[] {
  const out: { first: string; last: string; school: string; rating?: number; grade?: string }[] = [];
  const rows = tableRows(html);
  let cols: ColumnMap | null = null;
  for (const cells of rows) {
    const asHeader = mapColumns(cells);
    if (asHeader) {
      cols = asHeader; // a new table's header row
      continue;
    }
    if (!cols) continue;
    const school = (cells[cols.school!] || "").trim();
    if (!school) continue;
    let first = "";
    let last = "";
    if (cols.name !== undefined) {
      const name = nameFromCell(cells[cols.name] || "");
      if (!name) continue;
      first = name.first;
      last = name.last;
    } else {
      first = (cells[cols.first!] || "").trim().split(" ")[0];
      last = (cells[cols.last!] || "").trim().split(" ").pop() || "";
    }
    if (!first || !last) continue;
    const ratingRaw = cols.rating !== undefined ? Number((cells[cols.rating] || "").replace(/\D/g, "")) : NaN;
    out.push({
      first,
      last,
      school,
      rating: ratingRaw >= 100 && ratingRaw <= 3000 ? ratingRaw : undefined,
      grade: cols.grade !== undefined ? (cells[cols.grade] || "").trim() || undefined : undefined,
    });
  }
  return out;
}

const wscfAdapter: SchoolAdapter = {
  id: "wscf",
  label: "Wisconsin Scholastic Chess Federation (WSCF)",
  tier: 1,
  states: ["WI"],
  sourceKind: "wscf",
  async findSchool(p, log) {
    for (const url of WSCF_URLS) {
      const html = await fetchText(url, 20000);
      if (!html) {
        log(`[tier 1] WSCF: ${url} unreachable — skipping.`);
        continue;
      }
      const rows = wscfRows(html);
      const mine = rows.filter((r) => norm(r.last) === norm(p.lastName) && norm(r.first).startsWith(norm(p.firstName)));
      if (!mine.length) {
        log(`[tier 1] WSCF: no "${p.fullName}" in the master rating list (${rows.length} rows).`);
        return null;
      }
      // Rating-closest row wins when homonyms exist (mirrors findMemberId).
      mine.sort((a, b) => Math.abs((a.rating || 0) - (p.rating || 0)) - Math.abs((b.rating || 0) - (p.rating || 0)));
      const hit = mine[0];
      log(`[tier 1] WSCF: "${p.fullName}" → ${hit.school} (explicit school column, 80%).`);
      return {
        schoolName: hit.school,
        schoolCode: hit.school,
        confidence: 0.8,
        sourceUrl: url,
        grade: hit.grade,
        note: `WSCF master rating list ties ${p.fullName} to ${hit.school}.`,
      };
    }
    return null;
  },
  async fetchRoster(school, log) {
    const want = norm(school.code || school.name);
    for (const url of WSCF_URLS) {
      const html = await fetchText(url, 20000);
      if (!html) continue;
      const rows = wscfRows(html).filter((r) => norm(r.school) === want);
      if (rows.length) {
        log(`[tier 1] WSCF: roster for "${school.name}" → ${rows.length} player(s).`);
        return rows.map((r) => ({ firstName: r.first, lastName: r.last, rating: r.rating, grade: r.grade }));
      }
    }
    log(`[tier 1] WSCF: no roster rows for "${school.name}".`);
    return [];
  },
};

// ---------------------------------------------------------------------------
// The registry (everything except NWSRS, which school.ts registers itself).
// URLs beyond the verified tier-1 systems are the source list's leads — every
// one fails soft, so a stale lead costs a log line, never a wrong answer.
// ---------------------------------------------------------------------------

export const EXTERNAL_ADAPTERS: SchoolAdapter[] = [
  wscfAdapter,

  // --- Tier 1: CXR (Chess Express Ratings) — OK is CXR-first (OSCO rates all
  //     sections through it); per-player profile pages carry the school.
  makeScanAdapter({
    id: "cxr",
    label: "Chess Express Ratings (CXR)",
    tier: 1,
    states: ["OK", "AR", "KS", "MO", "TX"],
    sourceKind: "cxr",
    searchUrls: [
      "https://www.cxrchess.com/search.php?last={last}&first={first}",
      "https://www.cxrchess.com/players/?q={full}",
    ],
    confidence: 0.8, // CXR profiles state the school in a structured field
  }),

  // --- Tier 1: KSCA (Kansas) — school/player databases + results.
  makeScanAdapter({
    id: "ksca",
    label: "Kansas Scholastic Chess Association (KSCA)",
    tier: 1,
    states: ["KS"],
    sourceKind: "state-assoc",
    urls: ["https://www.ksca.us/", "https://ksca.us/"],
    confidence: 0.6,
  }),

  // --- Tier 2: state HS activities associations (chess as an official sport).
  makeScanAdapter({
    id: "il-ihsa",
    label: "IHSA chess (Illinois HS)",
    tier: 2,
    states: ["IL"],
    sourceKind: "state-assoc",
    urls: [
      "https://www.ihsa.org/Sports-Activities/Chess",
      "https://ilchesscoach.org/results/",
      "https://www.ilchesscoach.org/results/",
    ],
  }),
  makeScanAdapter({
    id: "il-iesa",
    label: "IESA chess (Illinois grades 5-8)",
    tier: 2,
    states: ["IL"],
    sourceKind: "state-assoc",
    urls: ["https://www.iesa.org/activities/ch/", "https://www.iesa.org/activities/chess/"],
  }),
  makeScanAdapter({
    id: "az-aia",
    label: "AIA chess (Arizona HS)",
    tier: 2,
    states: ["AZ"],
    sourceKind: "state-assoc",
    urls: ["https://aiaonline.org/activities/chess", "https://www.aiaonline.org/activities/chess"],
  }),
  makeScanAdapter({
    id: "mn-mshsl",
    label: "MSHSL chess (Minnesota HS)",
    tier: 2,
    states: ["MN"],
    sourceKind: "state-assoc",
    urls: ["https://www.mshsl.org/activities/chess"],
  }),
  makeScanAdapter({
    id: "ks-kshsaa",
    label: "KSHSAA chess (Kansas HS)",
    tier: 2,
    states: ["KS"],
    sourceKind: "state-assoc",
    urls: ["https://www.kshsaa.org/Public/Chess/Main.cfm"],
  }),

  // --- Tier 3: state chess association result archives (name + school appear
  //     together on results pages). High-scholastic-volume states first.
  makeScanAdapter({ id: "va-vsca", label: "VSCA results (Virginia)", tier: 3, states: ["VA"], sourceKind: "state-assoc", urls: ["https://vschess.org/results", "https://www.vschess.org/results"] }),
  makeScanAdapter({ id: "va-vcf", label: "Virginia Chess Federation", tier: 3, states: ["VA"], sourceKind: "state-assoc", urls: ["https://vachess.org/"] }),
  makeScanAdapter({ id: "or-oscf", label: "OSCF (Oregon scholastic)", tier: 3, states: ["OR"], sourceKind: "state-assoc", urls: ["https://oscf.org/", "https://www.oscf.org/"] }),
  makeScanAdapter({ id: "il-ica", label: "Illinois Chess Association", tier: 3, states: ["IL"], sourceKind: "state-assoc", urls: ["https://il-chess.org/"] }),
  makeScanAdapter({ id: "ks-kca", label: "Kansas Chess Association", tier: 3, states: ["KS"], sourceKind: "state-assoc", urls: ["https://kansaschess.org/"] }),
  makeScanAdapter({ id: "wi-wca", label: "Wisconsin Chess Association", tier: 3, states: ["WI"], sourceKind: "state-assoc", urls: ["https://wischess.org/"] }),
  makeScanAdapter({ id: "tx-tca", label: "Texas Chess Association", tier: 3, states: ["TX"], sourceKind: "state-assoc", urls: ["https://texaschess.org/"] }),
  makeScanAdapter({ id: "ca-calchess", label: "CalChess (Northern California)", tier: 3, states: ["CA"], sourceKind: "state-assoc", urls: ["https://calchess.org/", "https://www.bayareachess.com/results/"] }),
  makeScanAdapter({ id: "ca-scchess", label: "Southern California Chess Federation", tier: 3, states: ["CA"], sourceKind: "state-assoc", urls: ["https://scchess.com/"] }),
  makeScanAdapter({ id: "ny-nysca", label: "New York State Chess Association", tier: 3, states: ["NY"], sourceKind: "state-assoc", urls: ["https://www.nysca.net/", "https://nyschess.org/"] }),
  makeScanAdapter({ id: "fl-fca", label: "Florida Chess Association", tier: 3, states: ["FL"], sourceKind: "state-assoc", urls: ["https://floridachess.org/"] }),
  makeScanAdapter({ id: "ga-gca", label: "Georgia Chess Association", tier: 3, states: ["GA"], sourceKind: "state-assoc", urls: ["https://georgiachess.org/"] }),
  makeScanAdapter({ id: "nc-ncca", label: "North Carolina Chess Association", tier: 3, states: ["NC"], sourceKind: "state-assoc", urls: ["https://www.ncchess.org/"] }),
  makeScanAdapter({ id: "oh-oca", label: "Ohio Chess Association", tier: 3, states: ["OH"], sourceKind: "state-assoc", urls: ["https://ohchess.org/"] }),
  makeScanAdapter({ id: "mi-mca", label: "Michigan Chess Association", tier: 3, states: ["MI"], sourceKind: "state-assoc", urls: ["https://michess.org/"] }),
  makeScanAdapter({ id: "co-csca", label: "Colorado State Chess Association", tier: 3, states: ["CO"], sourceKind: "state-assoc", urls: ["https://colorado-chess.com/"] }),
  makeScanAdapter({ id: "ma-maca", label: "Massachusetts Chess Association", tier: 3, states: ["MA"], sourceKind: "state-assoc", urls: ["https://masschess.org/"] }),
  makeScanAdapter({ id: "nj-njscf", label: "New Jersey State Chess Federation", tier: 3, states: ["NJ"], sourceKind: "state-assoc", urls: ["https://njscf.org/"] }),
  makeScanAdapter({ id: "pa-pscf", label: "Pennsylvania State Chess Federation", tier: 3, states: ["PA"], sourceKind: "state-assoc", urls: ["https://pscfchess.org/"] }),
  makeScanAdapter({ id: "wa-wcf", label: "Washington Chess Federation", tier: 3, states: ["WA"], sourceKind: "state-assoc", urls: ["https://wachess.org/"] }),

  // --- Tier 4: registration platforms (public advance-entry lists: name +
  //     school + section before the event even runs).
  makeScanAdapter({
    id: "reg-king",
    label: "KingRegistration entry lists",
    tier: 4,
    states: ["KS", "MO", "OK", "AR", "NE", "IA"],
    sourceKind: "registration",
    searchUrls: ["https://kingregistration.com/search?q={full}"],
    urls: ["https://kingregistration.com/"],
  }),
  makeScanAdapter({
    id: "reg-caissa",
    label: "caissachess.net entry lists",
    tier: 4,
    states: ["*"],
    sourceKind: "registration",
    searchUrls: ["https://caissachess.net/online-registration/search?name={full}"],
  }),
  makeScanAdapter({
    id: "reg-tristate",
    label: "Tri-State Chess advance entries (NYC)",
    tier: 4,
    states: ["NY", "NJ", "CT"],
    sourceKind: "registration",
    urls: ["https://tristatechess.com/advance-entries", "https://www.tristatechess.com/advance-entries"],
  }),
  makeScanAdapter({
    id: "reg-officialchess",
    label: "officialchess.org entries (VA / mid-Atlantic)",
    tier: 4,
    states: ["VA", "MD", "DC"],
    sourceKind: "registration",
    urls: ["https://officialchess.org/", "https://www.officialchess.org/"],
  }),
];

/** Adapters eligible for a state (or the wildcard ones when state is unknown),
 *  grouped and ordered by tier. */
export function adaptersForState(state: string | undefined, registry: SchoolAdapter[]): SchoolAdapter[][] {
  const st = state?.trim().toUpperCase();
  const eligible = registry.filter((a) => (st ? a.states.includes(st) || a.states.includes("*") : a.states.includes("*")));
  const tiers: SchoolAdapter[][] = [[], [], [], []];
  for (const a of eligible) tiers[a.tier - 1].push(a);
  return tiers;
}
