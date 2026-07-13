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
    for (const url of pagesFor(p)) {
      const html = await fetchText(url);
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
      for (const url of pages) {
        const html = await fetchText(url);
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
// The registry (everything except NWSRS, which school.ts registers itself).
// URLs beyond the verified tier-1 systems are the source list's leads — every
// one fails soft, so a stale lead costs a log line, never a wrong answer.
// ---------------------------------------------------------------------------

export const EXTERNAL_ADAPTERS: SchoolAdapter[] = [];

/** Adapters eligible for a state (or the wildcard ones when state is unknown),
 *  grouped and ordered by tier. */
export function adaptersForState(state: string | undefined, registry: SchoolAdapter[]): SchoolAdapter[][] {
  const st = state?.trim().toUpperCase();
  const eligible = registry.filter((a) => (st ? a.states.includes(st) || a.states.includes("*") : a.states.includes("*")));
  const tiers: SchoolAdapter[][] = [[], [], [], []];
  for (const a of eligible) tiers[a.tier - 1].push(a);
  return tiers;
}
