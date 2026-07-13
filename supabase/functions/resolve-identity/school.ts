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

// A row: three text cells, then the id <span> (whose Tip attribute carries the
// school), then the rating cell. We capture the span's ATTRIBUTES as a whole and
// pull the Tip out separately — an inline optional Tip group lets the lazy match
// skip it, which silently drops the school from every row.
const NWSRS_ROW_RE =
  /<td>\s*([^<]*?)\s*<\/td>\s*<td>\s*([^<]*?)\s*<\/td>\s*<td>\s*([^<]*?)\s*<\/td>\s*<td>\s*<span\s+([^>]*)>\s*([A-Za-z0-9]+)\s*<\/span>\s*<\/td>\s*<td>\s*([0-9]+)\s*<\/td>/gi;

/** Pull the school out of an id-span's attributes (the onmouseover Tip). */
const TIP_RE = /Tip\('([^']*)'\)/i;

/** School name out of a "Skyline High School, 11th grade" tooltip. */
function schoolFromTip(tip?: string): string | undefined {
  if (!tip) return undefined;
  const clean = decodeEntities(tip);
  const comma = clean.lastIndexOf(",");
  const school = (comma > 0 ? clean.slice(0, comma) : clean).trim();
  return school || undefined;
}

function parseNwsrsRows(html: string): NwsrsRow[] {
  const rows: NwsrsRow[] = [];
  NWSRS_ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NWSRS_ROW_RE.exec(html))) {
    const last = decodeEntities(m[1]);
    const first = decodeEntities(m[2]);
    if (!last || !/[a-z]/i.test(last)) continue; // skip header / junk rows
    const tip = TIP_RE.exec(m[4] || "")?.[1];
    rows.push({
      last,
      first,
      grade: decodeEntities(m[3]) || undefined,
      school: schoolFromTip(tip),
      id: m[5].toUpperCase(),
      rating: Number(m[6]) || undefined,
    });
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

/** NWSRS: find the target's row (school + regional id), keyless. */
async function nwsrsLookup(req: SchoolLookupRequest, log: (m: string) => void): Promise<SchoolAffiliation | null> {
  const { last } = nameTokens(req.name);
  if (!last) return null;
  const letter = last[0].toUpperCase();
  if (!/[A-Z]/.test(letter)) return null;
  const url = `${NWSRS_BASE}/ratings/ratings${letter}.php`;
  log(`NWSRS: scanning ${url} for "${req.name}"…`);
  const html = await fetchText(url, 20000);
  if (!html) {
    log("NWSRS: ratings page unreachable.");
    return null;
  }
  const rows = parseNwsrsRows(html).filter((r) => samePerson(`${r.first} ${r.last}`, req.name) && r.school);
  if (!rows.length) {
    log(`NWSRS: no "${req.name}" on the ${letter} ratings page.`);
    return null;
  }
  // Prefer the highest-rated matching row (a serious player over a namesake).
  rows.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const hit = rows[0];
  log(`NWSRS: "${req.name}" → ${hit.school} (id ${hit.id}, NWSRS ${hit.rating ?? "?"}).`);
  return {
    school: hit.school!,
    state: req.state,
    source: "nwsrs",
    sourceLabel: "Chess Ratings NorthWest (NWSRS)",
    sourceUrl: url,
    // Deterministic exact-name hit in a structured DB — a strong single source.
    confidence: 0.8,
    regionalId: hit.id,
    schoolCode: schoolCodeOf(hit.id),
    grade: hit.grade,
    note: `NWSRS id ${hit.id} encodes ${hit.school}.`,
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
// ---------------------------------------------------------------------------

const HANDLE_RE = /^[A-Za-z0-9_-]{2,30}$/;

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

let friendsAuthMode: string | undefined; // last-logged cookie presence — announce the mode once, not per mate

export async function fetchChesscomFriends(username: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const cookie = readEnv("CHESSCOM_COOKIE") || readEnv("CHESSCOM_SESSION");
  const mode = cookie ? "cookie" : "none";
  if (friendsAuthMode !== mode) {
    friendsAuthMode = mode;
    log(
      cookie
        ? "Chess.com friends: CHESSCOM_COOKIE is configured — using the authenticated top-friends endpoint."
        : "Chess.com friends: no CHESSCOM_COOKIE in the environment — public game archives and clubs carry the crawl."
    );
  }
  if (!cookie) return []; // no session configured — game-overlap carries the crawl
  const clean = username.trim().replace(/^@/, "");
  if (!clean) return [];
  const url = `https://www.chess.com/callback/friends/${encodeURIComponent(clean)}/top-friends`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: cookie,
        Referer: `https://www.chess.com/member/${clean}`,
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.status === 401 || res.status === 403) {
      log("Chess.com friends: session cookie rejected (expired?) — falling back to game overlap.");
      return [];
    }
    if (!res.ok) return [];
    const data = await res.json();
    const set = new Set<string>();
    collectUsernames(data, set);
    set.delete(clean); // the owner isn't their own friend
    return [...set];
  } catch {
    clearTimeout(t);
    return [];
  }
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
