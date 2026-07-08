// ============================================================================
// USCF tournament-graph traversal — the tournament-first discovery engine
//
// Online usernames rarely match real names, and name-searching a platform finds
// the wrong homonym ("the 200-rated John Smith") far too easily. So the engine
// NEVER name-searches the target. It works every online-rated USCF event the
// target played, in order, until one gives up the username:
//
//   1. Pin the host platform for the event — from the event name, from a
//      web/flyer search (TLA, club announcement) via the `discoverPlatform`
//      hook, or by trying both platforms.
//   2. Roster shortcut — most USCF online events ran as a Chess.com tournament
//      or Lichess swiss/arena whose public API returns the EXACT participant
//      handles. Match those to the crosstable by real name; if every player but
//      the target is claimed, the leftover handle IS the target (elimination).
//   3. Google-index the TARGET — the `findUsernames` hook runs a ladder of
//      site:-restricted Google searches (site:lichess.org "Name", state/USCF/
//      club context, profile-URL mentions…) that tie real names to handles on
//      INDEXED pages. A candidate only counts once it provably has games inside
//      this event's date window; round-sequence alignment, membership in the
//      event's linked tournament, or games against confirmed section players
//      then close the case. A lead that exists but has no in-window games is
//      the wrong username — we keep searching.
//   4. Seed hunt — resolve ANY section player's account (direct opponents
//      first, then the whole roster) the same Google-first way, date-verified
//      against the event window. Platform name search (handle guessing +
//      autocomplete) is the ABSOLUTE last resort, used only when the Google
//      index offers nothing verifiable for that person. Seeds are never the
//      answer — they are entry points.
//   5. Pairing-chain BFS — from each seed, pull their games from the event's
//      date window (Chess.com monthly archives / Lichess since-until export),
//      keep the games scoped to the event (tournament/swiss linkage, else
//      rated + expected time control), and align them 1:1 against that
//      player's crosstable rounds by checking the win/loss/draw sequence.
//      Every aligned game maps one more crosstable player to their handle —
//      player 22 reveals player 10, who reveals player 15, … — until a chain
//      reaches the target. No name needed at any hop: the pairing itself is
//      the proof.
//   6. If every event fails, recurse (depth 1) into direct opponents' OWN
//      online histories via the `expandMember` hook to pin *their* handles,
//      then come back and trace the shared event.
//
// A FIDE ID linked on a candidate profile is compared against the target's
// USCF-registered FIDE ID: a match is near-decisive, a hard mismatch rejects.
// Usernames are often reused across sites, so a handle found on one platform
// is also echoed onto the other when the event could have run there.
//
// The US Chess half (crosstables) arrives via the edge function as the
// `tournamentGraph`; this module does the online half wherever fetch exists
// (browser, or Node for the CLI harness). There are NO request-count caps and
// no meaningful time budget: the search runs until every avenue is exhausted
// or the caller aborts. Politeness pacing (Lichess pacer, Chess.com gate,
// Google spacing) is the only rate control.
//
// SPEED comes from running the SAME work as concurrent agents, never from
// skipping any of it:
//   • EVENT AGENTS work several events at once (each event still gets the full
//     roster → Google → seeds → pairing-BFS treatment).
//   • Inside an event, SEED SCOUTS resolve several section players in parallel
//     (each still gets the full Google ladder + attribute scoring + date
//     verification) while PAIRING TRACERS drain the frontier concurrently —
//     the frontier never starves waiting on one seed, and a fresh mapping is
//     traced the moment it lands.
//   • Candidate verifications, monthly game archives and shortlist game
//     fetches all run in worker pools; flyer searches for upcoming events are
//     prefetched so an event never blocks on the web search when its turn
//     comes; the deep phase expands several opponents at once.
//   • Expensive fetches (profile verifies, game archives, Google searches,
//     Chess.com monthly archives) are memoized once and SHARED all the way
//     down into deep-phase sub-traversals — nothing is fetched twice.
// All of it funnels through net.ts's global Chess.com gate / Lichess pacer, so
// forty logical agents still make a polite, bounded number of HTTP calls.
// ============================================================================

import type { DiscoveredAccount, Evidence } from "./types";
import type {
  TournamentGraph,
  GraphEvent,
  GraphGame,
  EventPlatformInfo,
  UsernameSearchRequest,
  UsernameCandidate,
} from "./graphTypes";
import { verifyChesscom, verifyLichess, type VerifiedProfile } from "./verify";
import { pool, politeFetch, lichessSlot } from "./net";
import {
  nameSimilarity,
  nameMatchWeight,
  normalizeName,
  scoreFromEvidence,
  onlineRatingMatchWeight,
  graphDiscoveryWeight,
} from "./confidence";

// ---------------------------------------------------------------------------
// Tuning — agent counts and pacing only. There are deliberately NO
// request-count caps: the search must be able to grind through every
// tournament and every player without stopping. The default budget is
// effectively "run until exhausted"; the UI's abort signal (or an explicit
// budgetMs, e.g. from the CLI) is the only real stop. The agent counts decide
// how much of that work happens AT THE SAME TIME.
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_MS = 6 * 60 * 60_000; // effectively unbounded (6 h)
const EVENT_MIN_MS = 30_000; // minimum slice each event gets before moving on
const EVENT_AGENTS = 4; // events worked concurrently
const TRACE_AGENTS = 3; // pairing tracers per event (frontier drained in parallel)
const SEED_AGENTS = 6; // seed scouts per event (members resolved in parallel)
const VERIFY_POOL = 8; // concurrent candidate verifications per scan
const DEEP_AGENTS = 3; // opponents expanded concurrently in the deep phase
const DISCOVER_LOOKAHEAD = 2; // upcoming events whose flyer search is prefetched
const DAY = 86_400_000;

export type OnlinePlatform = "chesscom" | "lichess";

/** Generate plausible Chess.com/Lichess handles from a real name. One base
 *  shape per line, then common suffixes on the two shapes people actually use
 *  most (firstlast, f-initial+last) — a single "firstlast" guess per person is
 *  the 5%-hit-rate lazy path this replaces. */
export function guessHandles(name: string): string[] {
  const clean = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const t = clean.split(" ").filter(Boolean);
  const first = t[0] || "";
  const last = t.length > 1 ? t[t.length - 1] : "";
  const g = new Set<string>();
  const add = (s: string) => {
    const u = s.replace(/[^a-z0-9_-]/g, "");
    if (u.length >= 3) g.add(u);
  };
  if (first && last) {
    add(`${first}${last}`);
    add(`${first}_${last}`);
    add(`${first}-${last}`);
    add(`${first[0]}${last}`); // jsmith
    add(`${first}${last[0]}`); // johns / jefferyx
    add(`${last}${first}`);
    add(`${last}${first[0]}`);
    for (const base of [`${first}${last}`, `${first[0]}${last}`]) {
      for (const suffix of ["1", "2", "3", "7", "123", "chess"]) add(`${base}${suffix}`);
    }
  }
  add(clean.replace(/\s/g, ""));
  if (first) add(first);
  if (first) add(`${first}chess`);
  if (last) add(last);
  return Array.from(g).slice(0, 24);
}

function platformLabel(p: OnlinePlatform): string {
  return p === "lichess" ? "Lichess" : "Chess.com";
}

const digits = (s?: string) => (s ? s.replace(/\D/g, "") : "");

// ---------------------------------------------------------------------------
// Name uniqueness — a "Ujwal Garine" is far more likely to Google-resolve to
// the right person than a "John Smith", so unique names are worked FIRST.
// ---------------------------------------------------------------------------

const COMMON_LAST_NAMES = new Set([
  "smith", "johnson", "williams", "brown", "jones", "garcia", "miller", "davis", "rodriguez", "martinez",
  "hernandez", "lopez", "gonzalez", "wilson", "anderson", "thomas", "taylor", "moore", "jackson", "martin",
  "lee", "perez", "thompson", "white", "harris", "sanchez", "clark", "ramirez", "lewis", "robinson",
  "walker", "young", "allen", "king", "wright", "scott", "torres", "nguyen", "hill", "flores",
  "green", "adams", "nelson", "baker", "hall", "rivera", "campbell", "mitchell", "carter", "roberts",
  "gomez", "phillips", "evans", "turner", "diaz", "parker", "cruz", "edwards", "collins", "reyes",
  "stewart", "morris", "morales", "murphy", "cook", "rogers", "peterson", "cooper", "reed", "bailey",
  "bell", "kelly", "howard", "ward", "cox", "richardson", "wood", "watson", "brooks", "bennett",
  "gray", "james", "price", "myers", "long", "ross", "foster", "powell", "russell", "sullivan",
  "kim", "park", "choi", "patel", "shah", "singh", "kumar", "khan", "ali", "chen",
  "wang", "li", "liu", "zhang", "wu", "yang", "lin", "huang", "zhao", "xu",
]);

const COMMON_FIRST_NAMES = new Set([
  "john", "michael", "david", "james", "robert", "william", "daniel", "joseph", "thomas", "christopher",
  "matthew", "andrew", "joshua", "ryan", "alex", "alexander", "jacob", "nicholas", "tyler", "ethan",
  "noah", "liam", "mason", "lucas", "oliver", "jack", "henry", "leo", "kevin", "brian",
  "eric", "adam", "mark", "paul", "steven", "peter", "richard", "charles", "sam", "samuel",
  "ben", "benjamin", "nathan", "aaron", "justin", "brandon", "austin", "jason", "timothy", "george",
  "sarah", "emily", "emma", "olivia", "ava", "sophia", "mia", "anna", "maria", "jennifer",
  "jessica", "ashley", "amanda", "elizabeth", "grace", "chloe", "lily", "hannah", "julia", "victoria",
]);

/**
 * Higher = the name is a sharper Google search key. Uses common-name lists
 * plus how often the surname repeats inside this very tournament graph.
 */
function nameUniqueness(name: string, lastNameCounts?: Map<string, number>): number {
  const tokens = normalizeName(name).split(" ").filter(Boolean);
  if (!tokens.length) return 0;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  let s = 1;
  if (last && COMMON_LAST_NAMES.has(last)) s -= 0.5;
  if (first && COMMON_FIRST_NAMES.has(first)) s -= 0.2;
  if (last) {
    const dupes = (lastNameCounts?.get(last) || 1) - 1;
    s -= Math.min(0.3, dupes * 0.1); // surname repeats even inside this graph
    if (last.length >= 8) s += 0.15; // long surnames are rarely ambiguous
    if (last.length <= 3) s -= 0.15;
  }
  if (tokens.length >= 3) s += 0.1; // middle names sharpen queries a lot
  if (tokens.join("").length >= 13) s += 0.1;
  return s;
}

// US state code → full name, for matching free-text profile locations.
const US_STATE_NAMES: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado",
  CT: "connecticut", DE: "delaware", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho",
  IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana",
  ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi",
  MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey",
  NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma",
  OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota",
  TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington",
  WV: "west virginia", WI: "wisconsin", WY: "wyoming", DC: "washington dc",
};

/** Does a free-text profile location mention the given US state? */
function locationMatchesState(location: string, state: string): boolean {
  const code = state.trim().toUpperCase();
  if (code.length !== 2) return false;
  if (new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`).test(location)) return true;
  const full = US_STATE_NAMES[code];
  return !!full && location.toLowerCase().includes(full);
}

/** Which US state a free-text location CONFIDENTLY names, if any — a full
 *  state name anywhere, or a two-letter code in the postal ", XX" position.
 *  (Deliberately stricter than locationMatchesState: this feeds a NEGATIVE
 *  signal, so words like "in"/"or" inside prose must not read as states.) */
function strictStateOf(location: string): string | null {
  const lower = location.toLowerCase();
  for (const [code, full] of Object.entries(US_STATE_NAMES)) {
    if (lower.includes(full)) return code;
  }
  const m = location.match(/,\s*([A-Za-z]{2})(?:[^A-Za-z]|$)/);
  if (m) {
    const code = m[1].toUpperCase();
    if (US_STATE_NAMES[code]) return code;
  }
  return null;
}

// A profile's country claim, normalised. Lichess flags can be regional
// ("GB-ENG") and include fantasy flags (filtered in verify.ts); chess.com uses
// clean ISO-2 plus a few specials. "XX" (international) claims nothing.
const US_LIKE_COUNTRIES = new Set(["US", "PR", "GU", "VI", "AS", "MP"]);
function countryClaimOf(country?: string): string | undefined {
  const m = /^([A-Za-z]{2})/.exec((country || "").trim());
  const code = m ? m[1].toUpperCase() : undefined;
  return code && code !== "XX" ? code : undefined;
}
const isUsCountry = (c?: string) => {
  const k = countryClaimOf(c);
  return !!k && US_LIKE_COUNTRIES.has(k);
};
/** The profile CONFIDENTLY claims a non-US country — strong negative evidence
 *  for a US Chess member (though never absolute proof: a verified WA junior's
 *  account was observed flying a Canada flag). */
const isForeignCountry = (c?: string) => {
  const k = countryClaimOf(c);
  return !!k && !US_LIKE_COUNTRIES.has(k);
};

// ---------------------------------------------------------------------------
// Club membership — a club tied to the event's organiser or region is the kind
// of corroboration a careful human looks for (e.g. "PNWCC - Masters" on a
// candidate for a PNWCC event; "Washington Chess Federation" for a WA player).
// ---------------------------------------------------------------------------

const GENERIC_CLUB_TOKENS = new Set([
  "chess", "club", "clubs", "online", "open", "team", "the", "and", "of", "for", "not", "with",
  "tournament", "tournaments", "league", "center", "centre", "academy", "school", "federation",
  "association", "kids", "junior", "juniors", "scholastic", "group", "community", "official",
  "fan", "fans", "blitz", "bullet", "rapid", "daily", "classical", "live", "arena", "swiss",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

const isLetterSubsequence = (needle: string, hay: string): boolean => {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
};

/** Why a club/team name ties an account to this event or its region — or null. */
export function clubEventTie(clubName: string, eventName: string, states: (string | undefined)[]): string | null {
  const clubLower = clubName.toLowerCase();
  for (const st of states) {
    const full = st ? US_STATE_NAMES[st.trim().toUpperCase()] : undefined;
    if (full && clubLower.includes(full)) return `club "${clubName}" names ${st}`;
  }
  const clubTokens = clubLower.split(/[^a-z0-9]+/).filter(Boolean);
  const clubSpecific = new Set(clubTokens.filter((t) => t.length >= 3 && !GENERIC_CLUB_TOKENS.has(t)));
  const evTokens = eventName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const t of evTokens) {
    if (t.length >= 3 && !GENERIC_CLUB_TOKENS.has(t) && !/^\d+$/.test(t) && clubSpecific.has(t)) {
      return `club "${clubName}" shares "${t}" with the event`;
    }
  }
  // Organiser acronyms ("PNWCC" ⊆ "Pacific Northwest Chess Center"): an
  // acronym-shaped event token (4-6 letters, at most one vowel — real words
  // don't qualify) whose letters appear in order through the club name,
  // starting at its first letter.
  const squished = clubLower.replace(/[^a-z0-9]/g, "");
  for (const t of evTokens) {
    if (t.length < 4 || t.length > 6 || GENERIC_CLUB_TOKENS.has(t) || /^\d+$/.test(t)) continue;
    if ((t.match(/[aeiou]/g) || []).length > 1) continue;
    if (clubTokens.length >= 2 && t[0] === squished[0] && isLetterSubsequence(t, squished)) {
      return `club "${clubName}" matches the event's "${t.toUpperCase()}"`;
    }
  }
  return null;
}

/** Club/team names an account belongs to, memoized per handle. Fails soft. */
const clubsCache = new Map<string, Promise<string[]>>();
function fetchClubs(platform: OnlinePlatform, username: string, signal?: AbortSignal): Promise<string[]> {
  const key = `${platform}:${username.toLowerCase()}`;
  const hit = clubsCache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<string[]> => {
    try {
      if (platform === "chesscom") {
        const res = await politeFetch(
          `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/clubs`,
          { headers: { Accept: "application/json" }, signal },
          "chesscom"
        );
        if (!res.ok) return [];
        const data = await res.json();
        return (Array.isArray(data?.clubs) ? data.clubs : []).map((c: { name?: string }) => String(c?.name || "")).filter(Boolean);
      }
      const res = await politeFetch(
        `https://lichess.org/api/team/of/${encodeURIComponent(username)}`,
        { headers: { Accept: "application/json" }, signal },
        "lichess"
      );
      if (!res.ok) return [];
      const data = await res.json();
      return (Array.isArray(data) ? data : []).map((t: { name?: string }) => String(t?.name || "")).filter(Boolean);
    } catch {
      return [];
    }
  })();
  clubsCache.set(key, p);
  return p;
}

/** Event date window in ms, generously padded (online events can run weekly). */
function windowFor(ev: GraphEvent): { startMs: number; endMs: number } {
  const start = ev.startDate ? Date.parse(ev.startDate) : NaN;
  const end = ev.endDate ? Date.parse(ev.endDate) : NaN;
  const s = isNaN(start) ? (isNaN(end) ? Date.now() - 120 * DAY : end - 45 * DAY) : start - 2 * DAY;
  const e = isNaN(end) ? (isNaN(start) ? Date.now() : start + 45 * DAY) : end + 2 * DAY;
  return { startMs: s, endMs: e + DAY - 1 };
}

// ---------------------------------------------------------------------------
// Crosstable round normalisation
// ---------------------------------------------------------------------------

type Outcome = "w" | "l" | "d";

/** Normalise a MUIR outcome string; null = no game was actually played. */
function normOutcome(raw: string): Outcome | null {
  const t = (raw || "").toLowerCase();
  if (!t) return null;
  if (/forfeit|bye|unplayed|not\s*played|no\s*result/.test(t)) return null;
  if (t.startsWith("w")) return "w";
  if (t.startsWith("l")) return "l";
  if (t.startsWith("d")) return "d";
  return null;
}

interface RoundGame {
  round: number;
  color: GraphGame["color"];
  outcome: Outcome;
  opponentUscfId: string;
  opponentName: string;
}

/** A player's actually-played crosstable rounds, in round order. */
function playedRounds(games: GraphGame[]): RoundGame[] {
  const out: RoundGame[] = [];
  for (const g of games) {
    const o = normOutcome(g.outcome);
    if (!o || !g.opponentUscfId) continue;
    out.push({ round: g.round, color: g.color, outcome: o, opponentUscfId: g.opponentUscfId, opponentName: g.opponentName });
  }
  return out.sort((a, b) => a.round - b.round);
}

/** A USCF section time control resolved to platform clock terms. */
export interface EventTc {
  baseSecs: number;
  /** Increment in seconds, when the control names one (";+5", "inc/15"). */
  incSecs?: number;
  /** Delay in seconds ("d5", ";d/3") — online platforms have no delay, so
   *  organisers map it to an equal increment or drop it entirely. */
  delaySecs?: number;
  label: string;
}

/**
 * Parse a USCF time-control string ("G/60;+5", "G/45;inc/15", "G/25 d5") into
 * the exact platform clock the event's games were played at. Multi-stage OTB
 * controls ("40/90;SD/30") and unparseable strings return null — scoping then
 * falls back to the soft time-class filter.
 */
export function parseEventTc(timeControl?: string): EventTc | null {
  const s = (timeControl || "").trim();
  if (!s) return null;
  if (/\d+\/\d+.*sd/i.test(s)) return null; // multi-stage control — not an online single clock
  const base = /G\/?\s*(\d+)/i.exec(s);
  if (!base) return null;
  const baseSecs = parseInt(base[1], 10) * 60;
  if (!isFinite(baseSecs) || baseSecs <= 0) return null;
  const inc = /(?:\+|inc\/?)\s*(\d+)/i.exec(s);
  const delay = /d\/?\s*(\d+)/i.exec(s);
  const incSecs = inc ? parseInt(inc[1], 10) : undefined;
  const delaySecs = !inc && delay ? parseInt(delay[1], 10) : undefined;
  const label = `${baseSecs / 60}+${incSecs ?? (delaySecs != null ? `d${delaySecs}` : 0)}`;
  return { baseSecs, incSecs, delaySecs, label };
}

/** Does an archive game's exact clock match the event's control? A delay-based
 *  control accepts an equal increment or none (platforms lack delay); a control
 *  with no increment/delay means an exact base with zero increment. */
export function gameMatchesTc(g: { baseSecs?: number; incSecs?: number }, tc: EventTc): boolean {
  if (g.baseSecs === undefined || g.baseSecs !== tc.baseSecs) return false;
  const inc = g.incSecs ?? 0;
  if (tc.incSecs !== undefined) return inc === tc.incSecs;
  if (tc.delaySecs !== undefined) return inc === tc.delaySecs || inc === 0;
  return inc === 0;
}

/** Soft expectation of platform time classes for a section. */
function expectedTimeClasses(ev: GraphEvent): Set<string> {
  const m = /G\/?\s*(\d+)/i.exec(ev.timeControl || "");
  const mins = m ? parseInt(m[1], 10) : undefined;
  if (mins !== undefined && isFinite(mins)) {
    if (mins <= 2) return new Set(["bullet", "blitz"]);
    if (mins <= 5) return new Set(["blitz", "bullet"]);
    if (mins <= 9) return new Set(["blitz", "rapid"]);
    if (mins <= 20) return new Set(["rapid", "blitz"]);
    return new Set(["rapid", "classical", "daily", "standard"]);
  }
  const sys = (ev.ratingSystem || "").toUpperCase();
  if (ev.isBlitz || sys === "OB") return new Set(["bullet", "blitz"]);
  if (sys === "OQ") return new Set(["blitz", "rapid"]);
  return new Set(["rapid", "classical", "daily", "standard"]);
}

// ---------------------------------------------------------------------------
// Date-windowed game fetchers (the "sort their games by the event's dates")
// ---------------------------------------------------------------------------

interface ArchiveGame {
  oppHandle: string; // the OTHER player's username
  sourceColor: "white" | "black"; // colour the source account had
  sourceOutcome?: Outcome; // result from the source's point of view
  endMs: number;
  rated: boolean;
  timeClass?: string;
  /** Exact clock (base seconds + increment seconds), when the platform gave it.
   *  Undefined for daily/correspondence. Lets games be scoped to the EVENT's
   *  time control instead of a whole time class. */
  baseSecs?: number;
  incSecs?: number;
  url?: string;
  /** Chess.com tournament API url this game belonged to (the golden signal). */
  chesscomTournament?: string;
  /** Lichess swiss / arena ids, equally golden. */
  lichessSwiss?: string;
  lichessArena?: string;
}

function monthsBetween(startMs: number, endMs: number): { y: number; m: number }[] {
  const out: { y: number; m: number }[] = [];
  const d = new Date(startMs);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  const last = new Date(endMs);
  while (d.getTime() <= last.getTime() && out.length < 12) {
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

const CC_DRAW_CODES = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);

/** Chess.com time_control: "3600+5" | "180" (live, seconds) | "1/259200" (daily). */
function chesscomClock(tc: unknown): { baseSecs: number; incSecs: number } | null {
  const s = typeof tc === "string" ? tc : "";
  const m = /^(\d+)(?:\+(\d+))?$/.exec(s);
  if (!m) return null; // daily ("1/86400") or missing
  return { baseSecs: parseInt(m[1], 10), incSecs: m[2] ? parseInt(m[2], 10) : 0 };
}

function chesscomOutcome(myResult?: string, oppResult?: string): Outcome | undefined {
  if (myResult === "win") return "w";
  if (oppResult === "win") return "l";
  if (myResult && CC_DRAW_CODES.has(myResult)) return "d";
  return undefined;
}

/** One player's full Chess.com archive for one month, memoized in `cache` so
 *  overlapping event windows never refetch the same month.
 *
 *  Chess.com's archive shards intermittently serve 404 with a 503 "internal
 *  error" BODY (or plain 5xx/timeouts) for months that exist — observed live
 *  while the same account's profile and other months answered 200. To the
 *  judgment awaiting this month, "no games" and "the shard hiccuped" are the
 *  difference between rejecting the player's REAL account as a namesake and
 *  mapping it — one flaked GET zeroed an entire live search. So:
 *    • the 404-flake is retried IN PLACE (politeFetch already retries 429s
 *      and network errors — those are NOT re-retried here);
 *    • a month that still fails is recorded in `failedMonths` (keyed with the
 *      failure time) and evicted from the cache, so callers can tell "hole in
 *      the data" from "provably played nothing";
 *    • a month that failed moments ago FAST-FAILS for MONTH_FAIL_COOLDOWN_MS
 *      instead of re-fetching — a hard-down shard must not be re-hammered
 *      with full backoff by every judgment that touches its window. */
const MONTH_FAIL_COOLDOWN_MS = 45_000;

function chesscomMonthGames(
  username: string,
  y: number,
  m: number,
  cache: Map<string, Promise<ArchiveGame[]>>,
  signal?: AbortSignal,
  failedMonths?: Map<string, number>
): Promise<ArchiveGame[]> {
  const uLower = username.toLowerCase();
  const key = `${uLower}:${y}:${m}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const failedAt = failedMonths?.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < MONTH_FAIL_COOLDOWN_MS) {
    return Promise.resolve([]); // still cooling down — the hole stays marked, nothing is cached
  }
  const giveUp = (): ArchiveGame[] => {
    cache.delete(key);
    failedMonths?.set(key, Date.now());
    return [];
  };
  const p = (async (): Promise<ArchiveGame[]> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await politeFetch(
          `https://api.chess.com/pub/player/${uLower}/games/${y}/${String(m).padStart(2, "0")}`,
          { headers: { Accept: "application/json" }, signal },
          "chesscom",
          20_000
        );
      } catch {
        return giveUp(); // politeFetch already retried network errors
      }
      if (!res.ok) {
        // A real 404 (month truly absent) caches as empty; a 404 whose body
        // carries a 5xx error code is the shard flake in disguise.
        let transient = res.status !== 404;
        if (!transient) {
          try {
            const body = await res.text();
            transient = /"code"\s*:\s*5\d\d|internal error/i.test(body);
          } catch {
            transient = true;
          }
        }
        if (!transient) {
          failedMonths?.delete(key);
          return [];
        }
        if (attempt < 2 && !signal?.aborted) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        return giveUp();
      }
      let data;
      try {
        data = await res.json();
      } catch {
        return giveUp(); // corrupt body — treat as the same transient hole
      }
      const out: ArchiveGame[] = [];
      for (const g of Array.isArray(data.games) ? data.games : []) {
        const endT = (g.end_time || 0) * 1000;
        const wU = g.white?.username?.toLowerCase();
        const sourceColor: "white" | "black" = wU === uLower ? "white" : "black";
        const me = sourceColor === "white" ? g.white : g.black;
        const them = sourceColor === "white" ? g.black : g.white;
        const opp = them?.username;
        if (!opp || opp.toLowerCase() === uLower) continue;
        const clock = chesscomClock(g.time_control);
        out.push({
          oppHandle: opp,
          sourceColor,
          sourceOutcome: chesscomOutcome(me?.result, them?.result),
          endMs: endT,
          rated: g.rated !== false,
          timeClass: g.time_class,
          baseSecs: clock?.baseSecs,
          incSecs: clock?.incSecs,
          url: g.url,
          chesscomTournament: typeof g.tournament === "string" ? g.tournament : undefined,
        });
      }
      failedMonths?.delete(key);
      return out;
    }
  })();
  cache.set(key, p);
  return p;
}

/** Chess.com: pull the monthly archives spanning the window IN PARALLEL (they
 *  are independent GETs behind the global gate), keep in-window games. */
async function chesscomWindowGames(
  username: string,
  startMs: number,
  endMs: number,
  monthCache: Map<string, Promise<ArchiveGame[]>>,
  signal?: AbortSignal,
  failedMonths?: Map<string, number>
): Promise<ArchiveGame[]> {
  const months = monthsBetween(startMs, endMs);
  const perMonth = await Promise.all(months.map(({ y, m }) => chesscomMonthGames(username, y, m, monthCache, signal, failedMonths)));
  return perMonth
    .flat()
    .filter((g) => g.endMs >= startMs && g.endMs <= endMs)
    .sort((a, b) => a.endMs - b.endMs);
}

/** Lichess: pull games in the [since, until] window as NDJSON. A failed fetch
 *  is recorded in `failedWindows` (same reasoning as chess.com's failedMonths:
 *  "the export failed" must never read as "played nothing"). */
async function lichessWindowGames(
  username: string,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
  failedWindows?: Set<string>,
  windowKey?: string
): Promise<ArchiveGame[]> {
  const uLower = username.toLowerCase();
  const out: ArchiveGame[] = [];
  const markFailed = () => {
    if (failedWindows && windowKey) failedWindows.add(windowKey);
  };
  try {
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?since=${Math.floor(startMs)}&until=${Math.ceil(
      endMs
    )}&max=300&pgnInJson=false&clocks=false&evals=false&opening=false`;
    // politeFetch paces the call and retries 429s with hard backoff — a 429
    // means "slow down", never "no games"; losing games here silently breaks
    // the traversal.
    const res = await politeFetch(url, { headers: { Accept: "application/x-ndjson" }, signal }, "lichess", 20_000);
    if (!res.ok) {
      markFailed();
      return out;
    }
    const text = await res.text();
    if (failedWindows && windowKey) failedWindows.delete(windowKey);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let g: ReturnType<typeof JSON.parse>;
      try {
        g = JSON.parse(line);
      } catch {
        continue;
      }
      if (g.status === "noStart" || g.status === "aborted") continue;
      const w = g.players?.white?.user;
      const b = g.players?.black?.user;
      const wId = (w?.id || w?.name || "").toLowerCase();
      const sourceColor: "white" | "black" = wId === uLower ? "white" : "black";
      const oppUser = sourceColor === "white" ? b : w;
      const oppHandle = oppUser?.name || oppUser?.id;
      if (!oppHandle || oppHandle.toLowerCase() === uLower) continue;
      const endT = g.lastMoveAt || g.createdAt || 0;
      const sourceOutcome: Outcome | undefined =
        g.winner === sourceColor ? "w" : g.winner === "white" || g.winner === "black" ? "l" : g.status ? "d" : undefined;
      out.push({
        oppHandle,
        sourceColor,
        sourceOutcome,
        endMs: endT,
        rated: g.rated !== false,
        timeClass: g.speed,
        baseSecs: typeof g.clock?.initial === "number" ? g.clock.initial : undefined,
        incSecs: typeof g.clock?.increment === "number" ? g.clock.increment : undefined,
        // Current exports use swissTour/arenaTour objects; older ones used
        // flat swiss/tournament id strings. Accept both.
        lichessSwiss: g.swissTour?.id || (typeof g.swiss === "string" ? g.swiss : undefined),
        lichessArena: g.arenaTour?.id || (typeof g.tournament === "string" ? g.tournament : undefined),
      });
    }
  } catch {
    markFailed(); // rate-limited or blocked — a hole, not an idle window
  }
  return out.sort((a, b) => a.endMs - b.endMs);
}

// ---------------------------------------------------------------------------
// Tournament roster fetchers — the golden handle sets
// ---------------------------------------------------------------------------

/** A concrete link from a USCF event to a platform tournament object. */
export interface EventLink {
  platform: OnlinePlatform;
  kind: "chesscom-tournament" | "lichess-swiss" | "lichess-arena";
  /** Chess.com api url or slug; Lichess swiss/arena id. */
  id: string;
  source: "flyer" | "games";
}

/** Chess.com tournament ids appear both as full API urls (from games) and as
 *  bare slugs (from flyers) — normalise to the slug for comparison. */
const chesscomSlug = (idOrUrl: string) => (idOrUrl.split("/").filter(Boolean).pop() || idOrUrl).toLowerCase();

const linkKey = (l: EventLink) =>
  `${l.kind}:${l.kind === "chesscom-tournament" ? chesscomSlug(l.id) : l.id.toLowerCase()}`;

const rosterCache = new Map<string, Promise<string[]>>();

function fetchRoster(link: EventLink, signal?: AbortSignal): Promise<string[]> {
  const key = linkKey(link);
  const hit = rosterCache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<string[]> => {
    try {
      if (link.kind === "chesscom-tournament") {
        const url = link.id.startsWith("http") ? link.id : `https://api.chess.com/pub/tournament/${link.id}`;
        const res = await politeFetch(url, { headers: { Accept: "application/json" }, signal }, "chesscom", 20_000);
        if (!res.ok) return [];
        const data = await res.json();
        const players = Array.isArray(data.players) ? data.players : [];
        return players.map((p: { username?: string }) => String(p.username)).filter(Boolean);
      }
      const path = link.kind === "lichess-swiss" ? `swiss/${link.id}/results` : `tournament/${link.id}/results`;
      const res = await politeFetch(`https://lichess.org/api/${path}?nb=400`, { headers: { Accept: "application/x-ndjson" }, signal }, "lichess", 20_000);
      if (!res.ok) return [];
      const text = await res.text();
      const out: string[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row?.username) out.push(String(row.username));
        } catch {
          /* skip row */
        }
      }
      return out;
    } catch {
      return [];
    }
  })();
  rosterCache.set(key, p);
  return p;
}

/** Distinct event links present in a batch of archive games. */
function linksFromGames(games: ArchiveGame[]): EventLink[] {
  const seen = new Map<string, EventLink>();
  for (const g of games) {
    if (g.chesscomTournament) {
      const l: EventLink = { platform: "chesscom", kind: "chesscom-tournament", id: g.chesscomTournament, source: "games" };
      seen.set(linkKey(l), l);
    }
    if (g.lichessSwiss) {
      const l: EventLink = { platform: "lichess", kind: "lichess-swiss", id: g.lichessSwiss, source: "games" };
      seen.set(linkKey(l), l);
    }
    if (g.lichessArena) {
      const l: EventLink = { platform: "lichess", kind: "lichess-arena", id: g.lichessArena, source: "games" };
      seen.set(linkKey(l), l);
    }
  }
  return Array.from(seen.values());
}

/** Does an archive game belong to a specific linked tournament? */
function gameInLink(g: ArchiveGame, link: EventLink): boolean {
  if (link.kind === "chesscom-tournament") {
    return !!g.chesscomTournament && chesscomSlug(g.chesscomTournament) === chesscomSlug(link.id);
  }
  if (link.kind === "lichess-swiss") return !!g.lichessSwiss && g.lichessSwiss === link.id;
  return !!g.lichessArena && g.lichessArena === link.id;
}

// ---------------------------------------------------------------------------
// Lichess name autocomplete (used ONLY to seed opponents — never the target)
// ---------------------------------------------------------------------------

async function lichessAutocomplete(term: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await politeFetch(
      `https://lichess.org/api/player/autocomplete?term=${encodeURIComponent(term)}&object=true`,
      { headers: { Accept: "application/json" }, signal },
      "lichess"
    );
    if (!res.ok) return [];
    const data = await res.json();
    const arr = Array.isArray(data?.result) ? data.result : [];
    return arr.map((u: { id?: string; name?: string }) => String(u.name || u.id)).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Round ↔ archive alignment (the pairing checksum)
// ---------------------------------------------------------------------------

interface AlignedPair {
  round: RoundGame;
  game: ArchiveGame;
}

/**
 * The archive games a direct-opponent source could have played the TARGET in,
 * for the cross-corroborated single-edge reveal. The source's crosstable result
 * vs the target is the anchor: a candidate game's outcome MUST be known and equal
 * it, its colour must agree when both sides know it, and its opponent must not be
 * the source itself or an already-accounted-for handle (an aligned board or a
 * known section-mate). Returning exactly ONE game means this source
 * unambiguously names that handle as the target; 0 or ≥2 means it can't vote.
 */
export function targetEdgeCandidates(
  targetRound: { outcome: Outcome; color: GraphGame["color"] },
  scoped: ArchiveGame[],
  sourceHandleLower: string,
  claimed: Set<string>
): ArchiveGame[] {
  return scoped.filter((g) => {
    const k = g.oppHandle.toLowerCase();
    if (k === sourceHandleLower || claimed.has(k)) return false;
    if (!g.sourceOutcome || g.sourceOutcome !== targetRound.outcome) return false;
    if (
      (targetRound.color === "white" || targetRound.color === "black") &&
      (g.sourceColor === "white" || g.sourceColor === "black") &&
      g.sourceColor !== targetRound.color
    )
      return false;
    return true;
  });
}

/**
 * Align a player's crosstable rounds with their event-scoped archive games,
 * validating the win/loss/draw sequence (and colours + already-known opponent
 * handles when available).
 *
 * A real archive almost NEVER has exactly one game per crosstable round: there
 * is usually a warm-up game, an extra casual game in the same time class, or a
 * round that never made it to the archive (a bye, a forfeit, a game played on a
 * second account). The old implementation demanded `rounds.length ===
 * scoped.length` and matched positionally — so a single spare game discarded the
 * WHOLE edge (empirically the norm: 10-vs-9, 12-vs-4, 1-vs-4 all threw away
 * perfectly recoverable pairings). We instead find the best ORDERED SUBSEQUENCE
 * match, skipping spare games (and, where forced, unmatched rounds). Because
 * tournament rounds are played in time order, the games that correspond to the
 * rounds form an increasing subsequence of the (time-sorted) archive.
 *
 * `roundPins` maps an opponent's USCF id → the lowercased handle we ALREADY
 * mapped them to on this platform. Those are hard constraints that anchor the
 * alignment (a pinned round can only match its known handle, and that handle
 * can't be used for any other round), which both sharpens accuracy and makes it
 * safe to align even a loose game pool.
 *
 * Returns null unless the surviving alignment is trustworthy.
 */
export function alignRounds(
  rounds: RoundGame[],
  scoped: ArchiveGame[],
  viaLinkage: boolean,
  roundPins?: Map<string, string>
): { pairs: AlignedPair[]; checked: number } | null {
  const n = rounds.length;
  if (!n) return null;
  if (!viaLinkage && n < 3) return null; // too little signal without a tournament link
  const games = [...scoped].sort((a, b) => a.endMs - b.endMs);
  const m = games.length;
  if (!m) return null;

  // Handles we already know belong to a specific round of THIS player — they
  // pin the alignment. `anchors` is how many spare games are so pinned.
  const pinnedHandles = new Set<string>();
  if (roundPins) for (const h of roundPins.values()) pinnedHandles.add(h.toLowerCase());
  const anchors = pinnedHandles.size
    ? games.filter((g) => pinnedHandles.has(g.oppHandle.toLowerCase())).length
    : 0;
  // Without a trusted tournament link, a game pool much larger than the round
  // count makes the outcome checksum meaningless — many DIFFERENT subsequences
  // fit the same short W/L/D shape, so the matcher can lock a round onto a random
  // casual opponent (observed: a rated bullet game stole the round a player
  // actually spent against the target). Bail unless the alignment is WELL
  // anchored — i.e. at least half the rounds are already pinned to known handles,
  // which collapses the ambiguity. One or two stray pins are NOT enough licence
  // to align a big mixed pool.
  const wellAnchored = anchors >= Math.ceil(n / 2);
  if (!viaLinkage && !wellAnchored && m > 2 * n + 2) return null;

  const BIG = 1e6;
  // Cost of matching round i to game j. BIG = forbidden (result/colour
  // contradiction, or a pin violation). Negative = a pinned (known-handle)
  // match, strongly preferred. 0 = checked & consistent. 0.4 = allowed but the
  // game carries no verifiable result, so it does not corroborate.
  const cost = (i: number, j: number): number => {
    const r = rounds[i];
    const g = games[j];
    const oppLower = g.oppHandle.toLowerCase();
    const pin = roundPins?.get(r.opponentUscfId);
    if (pin) {
      if (oppLower !== pin.toLowerCase()) return BIG; // this round's opponent is known — must be that handle
    } else if (pinnedHandles.has(oppLower)) {
      return BIG; // this handle is a DIFFERENT known round's opponent
    }
    if ((r.color === "white" || r.color === "black") && (g.sourceColor === "white" || g.sourceColor === "black")) {
      if (g.sourceColor !== r.color) return BIG;
    }
    if (g.sourceOutcome) return g.sourceOutcome === r.outcome ? (pin ? -0.5 : 0) : BIG;
    return pin ? -0.5 : 0.4;
  };

  // DP over (rounds[i..], games[j..]) → best (matched count, penalty), maximise
  // matched then minimise penalty. move: 0=match i&j, 1=skip round i, 2=skip
  // game j.
  type Cell = { matched: number; pen: number; move: 0 | 1 | 2 };
  const f: Cell[][] = Array.from({ length: n + 1 }, () => new Array<Cell>(m + 1));
  for (let j = 0; j <= m; j++) f[n][j] = { matched: 0, pen: 0, move: 2 };
  for (let i = 0; i < n; i++) f[i][m] = { matched: 0, pen: 0, move: 1 };
  const better = (a: Cell, b: Cell) => (a.matched !== b.matched ? a.matched > b.matched : a.pen <= b.pen);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skipRound: Cell = { matched: f[i + 1][j].matched, pen: f[i + 1][j].pen, move: 1 };
      const skipGame: Cell = { matched: f[i][j + 1].matched, pen: f[i][j + 1].pen, move: 2 };
      let best = better(skipRound, skipGame) ? skipRound : skipGame;
      const c = cost(i, j);
      if (c < BIG) {
        const nxt = f[i + 1][j + 1];
        const matchCell: Cell = { matched: nxt.matched + 1, pen: nxt.pen + c, move: 0 };
        if (better(matchCell, best)) best = matchCell;
      }
      f[i][j] = best;
    }
  }

  // Reconstruct the chosen pairs.
  const pairs: AlignedPair[] = [];
  let checked = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const move = f[i][j].move;
    if (move === 0) {
      pairs.push({ round: rounds[i], game: games[j] });
      if (games[j].sourceOutcome) checked++;
      i++;
      j++;
    } else if (move === 1) i++;
    else j++;
  }

  const matched = pairs.length;
  // Enough of the player's rounds must be explained to trust the edge.
  const minMatched = viaLinkage ? Math.min(n, 2) : Math.min(n, 3);
  if (matched < minMatched) return null;
  // The outcome checksum must actually bite (a tournament link is its own proof).
  if (!viaLinkage && checked < 3) return null;
  return { pairs, checked };
}

// ---------------------------------------------------------------------------
// Engine options / results
// ---------------------------------------------------------------------------

/** Server-backed helpers the engine can use when available (injected so the
 *  engine itself stays runnable anywhere fetch exists). */
export interface TraversalHooks {
  /** Web/flyer search: which platform hosted this USCF event (edge AI). */
  discoverPlatform?: (ev: GraphEvent) => Promise<EventPlatformInfo | null>;
  /** Fetch a specific member's own online tournament graph (edge, MUIR). */
  expandMember?: (memberId: string) => Promise<TournamentGraph | null>;
  /** Google-index username search (site:-restricted query ladder) — THE way a
   *  person's handles are discovered from their name. Results are leads that
   *  the engine verifies against real games in the event's date window. */
  findUsernames?: (req: UsernameSearchRequest) => Promise<UsernameCandidate[] | null>;
}

/** Caches shared across the whole search — including deep-phase
 *  sub-traversals — so an expensive fetch (profile verify, game archive,
 *  monthly Chess.com archive, Google search) never runs twice for one key. */
export interface SharedCaches {
  verify: Map<string, Promise<VerifiedProfile | null>>;
  games: Map<string, Promise<ArchiveGame[]>>;
  ccMonths: Map<string, Promise<ArchiveGame[]>>;
  google: Map<string, Promise<UsernameCandidate[]>>;
  /** Chess.com months (`user:y:m`) whose archive fetch LAST failed (shard
   *  flake), keyed to the failure time — a window spanning one is a HOLE in
   *  the data, not proof the player was idle, and must never be cached or
   *  judged as "no games". Recent failures fast-fail instead of refetching. */
  ccFailedMonths: Map<string, number>;
  /** Lichess windows (`user:startDay:endDay`) whose game export failed —
   *  the same hole semantics as ccFailedMonths. */
  lichessFailedWindows: Set<string>;
}

export function makeSharedCaches(): SharedCaches {
  return {
    verify: new Map(),
    games: new Map(),
    ccMonths: new Map(),
    google: new Map(),
    ccFailedMonths: new Map(),
    lichessFailedWindows: new Set(),
  };
}

export interface TraversalOptions {
  targetName: string;
  /** The target's USCF online rating (or approx rating), for corroboration. */
  targetRating?: number;
  /** The target's FIDE ID from their USCF record — decisive when a candidate
   *  profile links the same ID; a hard mismatch rejects the candidate. */
  targetFideId?: string;
  signal?: AbortSignal;
  log: (message: string) => void;
  budgetMs?: number;
  hooks?: TraversalHooks;
  /** Internal recursion depth (deep opponent expansion runs at depth 0 only). */
  depth?: number;
  /** Internal: fetch caches handed down to deep-phase sub-traversals. */
  shared?: SharedCaches;
  /** Internal: lets a parent traversal stand a sub-traversal down the moment
   *  the parent's own target is found. */
  stopWhen?: () => boolean;
  /** TEST/DEBUG affordance (not used in production): pre-seed known member→handle
   *  mappings so the pairing/target-reveal logic can be validated end-to-end
   *  without depending on live Google seed discovery. Each is verified and
   *  mapped as a "seed" before the main loop. */
  seedMappings?: { memberId: string; platform: OnlinePlatform; username: string }[];
}

export interface TraversalResult {
  accounts: DiscoveredAccount[];
  notes: string[];
  /** Whether at least one online account was traced back to the target. */
  found: boolean;
  /** How many of the target's tournament opponents we DID resolve to a handle,
   *  even when the target's own account never fell out. Lets the caller say
   *  "mapped N of your opponents but couldn't confirm you" instead of silently
   *  presenting a same-name guess as if it were the answer. */
  mappedOpponents: number;
}

interface Mapping {
  profile: VerifiedProfile;
  how: "seed" | "roster" | "pairing" | "deep";
  /** Human chain, e.g. ["Jane Roe", "Bob Lee"] — who led us here. */
  chain: string[];
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface Appearance {
  event: GraphEvent;
  startMs: number;
  endMs: number;
  rounds: RoundGame[];
}

export async function runGraphTraversal(graph: TournamentGraph, opts: TraversalOptions): Promise<TraversalResult> {
  const { targetName, signal, log, hooks = {} } = opts;
  const depth = opts.depth ?? 0;
  const shared = opts.shared ?? makeSharedCaches();
  const totalBudgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + totalBudgetMs;
  // The opponent-pivot fallback is the LAST discovery stage before callers
  // drop to name-search namesakes — it must never be starved by the main
  // event loop. Observed live: the main loop ate the whole budget, the pivot
  // RANKED 39 opponents and then deepStop was already true — zero dives ran,
  // "Exhausted every online event" logged the same second as the ranking.
  // So when the pivot is possible, the main loop is capped at mainDeadline
  // and the reserved tail belongs to the pivot (a main-loop find just ends
  // the search early — the reserve costs nothing on success).
  const pivotPossible = depth === 0 && !!hooks.expandMember;
  // A reserve below ~45s can't clear the pivot's own entry gate (>35s) — on a
  // tiny budget it would shorten the main loop while funding NOTHING, so the
  // reserve only exists when it is big enough to actually run the stage.
  const rawReserve = pivotPossible ? Math.min(150_000, Math.round(totalBudgetMs * 0.4)) : 0;
  const pivotReserveMs = rawReserve >= 45_000 ? rawReserve : 0;
  const mainDeadline = deadline - pivotReserveMs;
  const outOfTime = (localDeadline?: number) =>
    Date.now() > (localDeadline ?? deadline) || !!signal?.aborted || !!opts.stopWhen?.();

  const targetId = graph.rootUscfId;
  const targetFideId = digits(opts.targetFideId) || undefined;
  const notes: string[] = [];
  const accounts: DiscoveredAccount[] = [];

  // Set when the target is structurally confirmed anywhere — every agent in
  // every event checks it so the whole fleet stands down together.
  let found = false;
  const stopNow = (localDeadline?: number) => found || outOfTime(localDeadline);

  // --- Indices over the whole online mesh ------------------------------------
  const memberName = new Map<string, string>();
  const memberRating = new Map<string, number>();
  const memberState = new Map<string, string>();
  if (graph.rootState) memberState.set(targetId, graph.rootState.trim().toUpperCase());
  const appearances = new Map<string, Appearance[]>();
  for (const ev of graph.onlineEvents) {
    const { startMs, endMs } = windowFor(ev);
    for (const p of ev.players) {
      if (!memberName.has(p.uscfId)) memberName.set(p.uscfId, p.name);
      if (p.rating && !memberRating.has(p.uscfId)) memberRating.set(p.uscfId, p.rating);
      if (p.state && !memberState.has(p.uscfId)) memberState.set(p.uscfId, p.state);
      const list = appearances.get(p.uscfId) || [];
      list.push({ event: ev, startMs, endMs, rounds: playedRounds(p.games) });
      appearances.set(p.uscfId, list);
    }
  }
  const effTargetRating = opts.targetRating ?? memberRating.get(targetId);

  // Surname frequency across the whole graph — feeds name-uniqueness ordering
  // (a surname that repeats even here is a weak Google key).
  const lastNameCounts = new Map<string, number>();
  for (const name of memberName.values()) {
    const tokens = normalizeName(name).split(" ").filter(Boolean);
    const last = tokens[tokens.length - 1];
    if (last) lastNameCounts.set(last, (lastNameCounts.get(last) || 0) + 1);
  }
  const uniquenessOf = (memberId: string) => nameUniqueness(memberName.get(memberId) || "", lastNameCounts);

  const directOpponents = new Set<string>();
  for (const app of appearances.get(targetId) || []) {
    for (const r of app.rounds) if (r.opponentUscfId !== targetId) directOpponents.add(r.opponentUscfId);
  }

  // --- Shared caches (search-wide, incl. deep-phase sub-traversals) -----------
  const verifyCache = shared.verify;
  const verifyOn = (platform: OnlinePlatform, handle: string): Promise<VerifiedProfile | null> => {
    const key = `${platform}:${handle.toLowerCase()}`;
    const hit = verifyCache.get(key);
    if (hit) return hit;
    // verifyLichess paces itself through the global Lichess slot machine;
    // verifyChesscom runs behind the global Chess.com gate.
    const p = platform === "chesscom" ? verifyChesscom(handle, signal) : verifyLichess(handle, signal);
    verifyCache.set(key, p);
    return p;
  };

  const gamesCache = shared.games;
  const windowKeyOf = (handle: string, startMs: number, endMs: number) =>
    `${handle.toLowerCase()}:${Math.round(startMs / DAY)}:${Math.round(endMs / DAY)}`;
  /** Does this window span archive data whose fetch FAILED (chess.com month
   *  shard flake / lichess export failure)? Then an empty — or PARTIAL —
   *  result is a HOLE in the data, not proof of inactivity, and no judgment
   *  may treat it as a rejection verdict. */
  const archiveHole = (platform: OnlinePlatform, handle: string, startMs: number, endMs: number): boolean =>
    platform === "chesscom"
      ? monthsBetween(startMs, endMs).some(({ y, m }) => shared.ccFailedMonths.has(`${handle.toLowerCase()}:${y}:${m}`))
      : shared.lichessFailedWindows.has(windowKeyOf(handle, startMs, endMs));
  const windowGames = (platform: OnlinePlatform, handle: string, startMs: number, endMs: number): Promise<ArchiveGame[]> => {
    const key = `${platform}:${windowKeyOf(handle, startMs, endMs)}`;
    const hit = gamesCache.get(key);
    if (hit) return hit;
    const p =
      platform === "chesscom"
        ? chesscomWindowGames(handle, startMs, endMs, shared.ccMonths, signal, shared.ccFailedMonths)
        : lichessWindowGames(handle, startMs, endMs, signal, shared.lichessFailedWindows, windowKeyOf(handle, startMs, endMs));
    gamesCache.set(key, p);
    // An aggregate with a failed month/export in its span must not be
    // remembered as gospel — evict it so the next asker refetches (healthy
    // chess.com months stay memoized; only the hole is retried).
    void p.then(() => {
      if (archiveHole(platform, handle, startMs, endMs)) gamesCache.delete(key);
    });
    return p;
  };

  const discoverCache = new Map<string, Promise<EventPlatformInfo | null>>();
  const discover = (ev: GraphEvent): Promise<EventPlatformInfo | null> => {
    if (!hooks.discoverPlatform) return Promise.resolve(null);
    const hit = discoverCache.get(ev.eventId);
    if (hit) return hit;
    const p = hooks.discoverPlatform(ev).catch(() => null);
    discoverCache.set(ev.eventId, p);
    return p;
  };

  // Confirmed member ↔ handle mappings (per platform). Never contains the target.
  const mapped = new Map<string, Map<OnlinePlatform, Mapping>>();
  // Reverse index: which member(s) each handle has been mapped to. ONE handle
  // can only be ONE person — when partial alignments in a big casual pool claim
  // the same handle for several DIFFERENT crosstable players (observed: one
  // hyperactive blitz account "mapped" to three section players), every one of
  // those claims is junk. Contested handles keep feeding BFS (their games still
  // reach real section players) but are permanently disqualified from naming or
  // BEING the target.
  const handleClaims = new Map<string, Set<string>>();
  const contestedHandles = new Set<string>();
  const claimKey = (platform: OnlinePlatform, username: string) => `${platform}:${username.toLowerCase()}`;
  const setMapping = (memberId: string, platform: OnlinePlatform, m: Mapping) => {
    const per = mapped.get(memberId) || new Map<OnlinePlatform, Mapping>();
    if (!per.has(platform)) {
      per.set(platform, m);
      const key = claimKey(platform, m.profile.username);
      const claimants = handleClaims.get(key) || new Set<string>();
      claimants.add(memberId);
      handleClaims.set(key, claimants);
      if (claimants.size === 2) {
        contestedHandles.add(key);
        log(
          `⚠ @${m.profile.username} has now been mapped to ${claimants.size} different crosstable players — treating it as a busy casual account, not evidence.`
        );
      }
    }
    mapped.set(memberId, per);
  };
  const unsetMapping = (memberId: string, platform: OnlinePlatform) => {
    const m = mapped.get(memberId)?.get(platform);
    if (!m) return;
    mapped.get(memberId)!.delete(platform);
    const key = claimKey(platform, m.profile.username);
    const claimants = handleClaims.get(key);
    claimants?.delete(memberId);
    if (claimants && !claimants.size) handleClaims.delete(key);
    // A contested mark stays — the ambiguity was observed, un-mapping one
    // claimant doesn't make the account trustworthy again.
  };
  /** True when this handle is disqualified from being (or naming) the target:
   *  it is contested, or it is already mapped to a DIFFERENT member. */
  const handleDisqualified = (platform: OnlinePlatform, username: string): boolean => {
    const key = claimKey(platform, username);
    if (contestedHandles.has(key)) return true;
    const claimants = handleClaims.get(key);
    return !!claimants && [...claimants].some((id) => id !== targetId);
  };

  // --- Google-index username discovery (the PRIMARY name→handle route) -------
  // One index search per person (memoized): the answer doesn't change between
  // events. Candidates are only ACCEPTED per event, once date-verified there.
  // The cache is search-wide (shared with sub-traversals); target-grade
  // lookups (state + FIDE-enriched queries) are keyed apart from seed-grade
  // ones so a deep dive's own target still gets its full sharpened ladder.
  const googleCandidatesCache = shared.google;
  const googleCandidatesFor = (memberId: string, ev: GraphEvent): Promise<UsernameCandidate[]> => {
    if (!hooks.findUsernames) return Promise.resolve([]);
    const cacheKey = `${memberId}:${memberId === targetId ? "t" : "s"}`;
    const hit = googleCandidatesCache.get(cacheKey);
    if (hit) return hit;
    const name = memberName.get(memberId) || "";
    if (!name) return Promise.resolve([]);
    const req: UsernameSearchRequest = {
      name,
      uscfRating: memberRating.get(memberId),
      // MUIR gives every section player a state of record — it sharpens seed
      // queries and disambiguation, not just the target's.
      state: memberState.get(memberId),
      fideId: memberId === targetId ? targetFideId : undefined,
      eventName: ev.name,
      eventDate: ev.startDate,
    };
    const p = hooks
      .findUsernames(req)
      .then((r) => r || [])
      .catch(() => [] as UsernameCandidate[]);
    googleCandidatesCache.set(cacheKey, p);
    return p;
  };

  /** Candidates to try on `platform`: same-platform finds first (discovery
   *  order), then handles found on the OTHER platform — people frequently use
   *  the same username on both sites, so a Lichess find is worth one cheap
   *  check on Chess.com (and vice versa) when the event may have run there. */
  const candidatesForPlatform = (cands: UsernameCandidate[], platform: OnlinePlatform): UsernameCandidate[] => {
    const seen = new Set<string>();
    const out: UsernameCandidate[] = [];
    for (const c of cands) {
      const k = c.username.toLowerCase();
      if (c.platform !== platform || seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    for (const c of cands) {
      const k = c.username.toLowerCase();
      if (c.platform === platform || seen.has(k)) continue;
      seen.add(k);
      out.push({ ...c, platform, note: `same handle found on ${platformLabel(c.platform)}` });
    }
    return out;
  };

  // --- Attribute matching -----------------------------------------------------
  // Every candidate is scored against what USCF knows about the player (real
  // name on the profile, rating with the usual online offset, US country,
  // location vs state, account age vs the event, activity, game count) BEFORE
  // any games are pulled. Acceptance needs BOTH a passing attribute score and
  // games in the event window. A username that merely looks like the name is a
  // NEGATIVE signal — real-name handles are rare; namesake accounts are not.
  const ATTR_ACCEPT = 0.7; // accept threshold (with in-window games)
  const ATTR_SHORTLIST = 0.5; // below this a candidate isn't worth game fetches

  interface AttrResult {
    score: number;
    evidence: Evidence[];
  }

  /** null = hard reject: the account was created after the event ended, or it
   *  publishes a USCF member ID that belongs to somebody else. */
  const attributeMatch = (
    name: string,
    rating: number | undefined,
    state: string | undefined,
    prof: VerifiedProfile,
    viaGoogle: UsernameCandidate | null,
    startMs: number,
    endMs: number,
    memberUscfId?: string
  ): AttrResult | null => {
    if (prof.joinedMs && prof.joinedMs > endMs + DAY) return null;
    const profUscfId = digits(prof.uscfId);
    if (profUscfId && memberUscfId && profUscfId !== memberUscfId) return null;
    const evi: Evidence[] = [];
    const push = (weight: number, label: string) =>
      evi.push({ kind: "cross-reference", weight, label, source: "uscf-graph" });

    if (profUscfId && memberUscfId && profUscfId === memberUscfId) {
      push(3.0, `Profile publishes USCF ID ${prof.uscfId} — exact match`);
    }

    if (viaGoogle) {
      push(
        viaGoogle.sourceUrl ? 0.7 : 0.4,
        `Google index tied "${name}" to @${prof.username}${viaGoogle.sourceUrl ? ` via ${viaGoogle.sourceUrl}` : ""}`
      );
    }
    if (prof.displayName) {
      const sim = nameSimilarity(name, prof.displayName);
      if (sim >= 0.85) push(1.6, `Profile real name "${prof.displayName}" matches ${name}`);
      else if (sim >= 0.7) push(1.0, `Profile real name "${prof.displayName}" closely resembles ${name}`);
      else if (sim >= 0.5) push(0.3, `Profile real name "${prof.displayName}" partially matches ${name}`);
      else push(-1.2, `Profile real name "${prof.displayName}" appears to be someone else`);
    } else if (nameSimilarity(name, prof.username) >= 0.8) {
      push(-0.3, `Username @${prof.username} merely resembles the name — a weak NEGATIVE signal, not a match`);
    }
    if (rating && prof.rating) {
      push(
        onlineRatingMatchWeight(rating, prof.rating),
        `${platformLabel(prof.platform as OnlinePlatform)} rating ${prof.rating} vs ~${rating} USCF`
      );
    }
    if (rating && prof.uscfRating && Math.abs(prof.uscfRating - rating) <= 200) {
      push(0.8, `Profile lists USCF rating ${prof.uscfRating} (player ~${rating})`);
    }
    if (isUsCountry(prof.country)) {
      push(0.3, "Profile country US matches US Chess");
    } else if (isForeignCountry(prof.country)) {
      // A confident foreign-country claim on a candidate for a US federation
      // member is how a wrong-person account slips in (observed live: an
      // Adelaide, Australia account accepted as a WA tournament player). A
      // heavy strike — but not fatal, since joke/heritage flags exist.
      push(-0.9, `Profile claims country ${prof.country} for a US Chess member`);
    }
    if (state && prof.location) {
      if (locationMatchesState(prof.location, state)) {
        push(0.6, `Profile location "${prof.location}" matches ${state}`);
      } else {
        // A profile that confidently names a DIFFERENT state is most likely a
        // namesake (observed live: a Missouri "Timothy Campbell" nearly stole
        // a Washington player's identity at 80% attributes). Not fatal —
        // people move — but a heavy strike.
        const other = strictStateOf(prof.location);
        if (other && other !== state.trim().toUpperCase()) {
          push(-0.9, `Profile location "${prof.location}" is in ${other}, not the player's ${state}`);
        }
      }
    }
    if (!prof.gamesFound) push(-0.8, "Account has no games at all");
    if (prof.lastActiveMs && prof.lastActiveMs < startMs) {
      push(-1.0, "Account went inactive before the event even started");
    }
    return { score: scoreFromEvidence(evi, 0), evidence: evi };
  };

  /** Is this link PROVEN to be the event's own tournament? Flyer-sourced
   *  links are, by construction. A games-derived link needs TWO distinct
   *  crosstable members' window games tying to it: one source alone can be a
   *  plausibly-sized same-weekend tournament that is NOT this event (observed
   *  live: one seed's 25-player tournament cascaded five wrong mappings into
   *  a 99% wrong crown of the target). */
  const linkTrusted = (state: LinkState | undefined, link: EventLink): boolean =>
    link.source === "flyer" || (state?.linkSources.get(linkKey(link))?.size ?? 0) >= 2;

  /** The link-related slice of EventState that scoping needs. */
  interface LinkState {
    links: Map<string, EventLink>;
    junkLinks: Set<string>;
    linkSources: Map<string, Set<string>>;
  }

  /** Scope archive games to an event: the best-fitting TRUSTED tournament
   *  link, else the event's exact time control, else its expected time
   *  classes.
   *
   *  A games-derived "link" is only the event if the player played SEVERAL of
   *  their games there AND the link is trusted (see linkTrusted) — a single
   *  game tagged with a tournament id is almost always a giant public arena
   *  the player dipped into once (empirically: a "1|0 Bullet" arena of 25
   *  strangers matched a 26-player scholastic crosstable at 0 overlap), and
   *  even a multi-game link from ONE source can be the wrong tournament
   *  entirely. Scoping to a wrong link strands the real event games. */
  const scopeToEvent = (
    games: ArchiveGame[],
    state: LinkState | undefined,
    platform: OnlinePlatform,
    ev: GraphEvent
  ): { scoped: ArchiveGame[]; viaLink?: EventLink; viaTc?: EventTc } => {
    if (state) {
      let best: { link: EventLink; inLink: ArchiveGame[] } | null = null;
      for (const link of state.links.values()) {
        if (link.platform !== platform) continue;
        if (state.junkLinks.has(linkKey(link))) continue; // a proven public pool, not this event
        if (!linkTrusted(state, link)) continue; // one source's tournament ≠ the event
        const inLink = games.filter((g) => gameInLink(g, link));
        if (inLink.length && (!best || inLink.length > best.inLink.length)) best = { link, inLink };
      }
      if (best && (best.link.source === "flyer" || best.inLink.length >= 2)) {
        return { scoped: best.inLink, viaLink: best.link };
      }
    }
    // The event's EXACT time control beats a whole time class: a busy account
    // can have 20+ in-window games in the right class where only the 4 played
    // at the event's control are the event (observed: 23 window games, 4 at
    // G/60+5 = precisely the crosstable rounds). A same-class casual pool is
    // what lets the alignment checksum lock onto strangers.
    const tc = parseEventTc(ev.timeControl);
    if (tc) {
      const exact = games.filter((g) => gameMatchesTc(g, tc));
      if (exact.length) return { scoped: exact, viaTc: tc };
    }
    // Manually-paired USCF events were usually played as UNRATED casual
    // challenges, so don't require rated — the time class is the useful filter.
    // (Also the fallback when the organiser ran a slightly different clock than
    // the USCF control string, in which case NO game matches it exactly.)
    const classes = expectedTimeClasses(ev);
    return { scoped: games.filter((g) => !g.timeClass || classes.has(g.timeClass)) };
  };

  /** Already-mapped opponents of a player in an event → their handles, keyed by
   *  the opponent's USCF id. These anchor `alignRounds` (a round whose opponent
   *  we already know can only match that handle). */
  const roundPinsFor = (rounds: RoundGame[], platform: OnlinePlatform): Map<string, string> | undefined => {
    let pins: Map<string, string> | undefined;
    for (const r of rounds) {
      const h = mapped.get(r.opponentUscfId)?.get(platform)?.profile.username;
      if (h) (pins ??= new Map()).set(r.opponentUscfId, h.toLowerCase());
    }
    return pins;
  };

  /** Round alignment. For manually-paired (link-less) events the games were
   *  UNRATED challenges, while the player's rated casual games sit in the same
   *  time class — a mixed pool lets the matcher pick a wrong same-shaped
   *  subsequence (a rated bullet game stealing the round played against the
   *  target). So when a substantial unrated subset exists, align on IT FIRST;
   *  only fall back to the whole pool if the unrated slice doesn't line up. */
  const alignWithRetry = (rounds: RoundGame[], scoped: ArchiveGame[], viaLink: boolean, platform: OnlinePlatform) => {
    const pins = roundPinsFor(rounds, platform);
    if (viaLink) return alignRounds(rounds, scoped, true, pins);
    const unrated = scoped.filter((g) => !g.rated);
    if (unrated.length >= Math.min(rounds.length, 3) && unrated.length < scoped.length) {
      const a = alignRounds(rounds, unrated, false, pins);
      if (a) return a;
    }
    return alignRounds(rounds, scoped, false, pins);
  };

  /**
   * The corroboration bar for accepting "this account IS crosstable player X"
   * from a PARTIAL pairing alignment. A fully-determined alignment (every board
   * unambiguous) is structural proof and passes outright. Anything looser gets
   * judged like a careful human would: an account whose own claims CONTRADICT
   * the USCF record (a confident foreign country, a location in the wrong
   * state, a clearly different real name, someone else's published USCF ID)
   * is NOT that player unless a strong corroborator (matching name, location,
   * listed USCF rating, or a club tied to the event/region) vouches for it.
   * Observed live: an "Adelaide, Australia" account was accepted as a WA
   * tournament player off one same-TC same-date game — this bar rejects that.
   * Accounts that claim nothing (no name, no flag) still map: the checksum is
   * the only signal they offer, and it now runs on TC-scoped pools.
   */
  const mapGate = async (
    memberId: string,
    prof: VerifiedProfile,
    platform: OnlinePlatform,
    ev: GraphEvent,
    structural: boolean
  ): Promise<{ ok: boolean; why?: string }> => {
    const profUscfId = digits(prof.uscfId);
    if (profUscfId) {
      if (profUscfId === memberId) return { ok: true };
      return { ok: false, why: `the profile publishes USCF ID ${prof.uscfId}, which belongs to a different member` };
    }
    if (structural) return { ok: true };
    const name = memberName.get(memberId) || "";
    const st = memberState.get(memberId);
    const rating = memberRating.get(memberId);

    const contradictions: string[] = [];
    if (isForeignCountry(prof.country)) contradictions.push(`claims country ${prof.country}`);
    if (st && prof.location && !locationMatchesState(prof.location, st)) {
      const other = strictStateOf(prof.location);
      if (other && other !== st.trim().toUpperCase()) contradictions.push(`locates itself in ${other}, not ${st}`);
    }
    if (prof.displayName && nameSimilarity(name, prof.displayName) < 0.3) {
      contradictions.push(`shows real name "${prof.displayName}"`);
    }
    if (!contradictions.length) return { ok: true };

    if (prof.displayName && nameSimilarity(name, prof.displayName) >= 0.72) return { ok: true };
    if (st && prof.location && locationMatchesState(prof.location, st)) return { ok: true };
    if (rating && prof.uscfRating && Math.abs(prof.uscfRating - rating) <= 250) return { ok: true };
    const clubs = await fetchClubs(platform, prof.username, signal);
    for (const club of clubs) {
      if (clubEventTie(club, ev.name, [st, graph.rootState])) return { ok: true };
    }
    return { ok: false, why: `it ${contradictions.join(" and ")} with no corroborating name/location/rating/club` };
  };

  const seedCache = new Map<string, Promise<VerifiedProfile | null>>();

  /** Resolve a NON-target member's account. PRIMARY: the Google index —
   *  collect ALL leads, score each candidate profile's attributes against the
   *  USCF record, then work the shortlist best-first; acceptance needs a
   *  passing attribute score AND games inside this event's date window
   *  (crosstable round alignment settles it outright when it bites). LAST
   *  RESORT, only when the index yields nothing verifiable: careful handle
   *  guessing + Lichess autocomplete, strictly gated on the profile's REAL
   *  name — a handle that merely looks like the name never qualifies. */
  const resolveMemberOn = (
    memberId: string,
    platform: OnlinePlatform,
    ev: GraphEvent,
    state?: EventState,
    stop?: () => boolean
  ): Promise<VerifiedProfile | null> => {
    const key = `${memberId}:${platform}:${ev.eventId}`;
    const hit = seedCache.get(key);
    if (hit) return hit;
    // Observe the caller's (event-slice) stop as well as the global one: an
    // in-flight judgment that ignores its event's deadline is how the main
    // loop overran its budget and starved the pivot stage.
    const stopHere = () => stopNow() || !!stop?.();
    const name = memberName.get(memberId) || "";
    // Set when this resolution concluded null for TRANSIENT reasons (archive
    // shard hole, clock ran out) rather than a real verdict — such a null must
    // not stay cached as "this member has no account here".
    let transientMiss = false;
    const promise = (async (): Promise<VerifiedProfile | null> => {
      if (!name || memberId === targetId) return null;
      const app = (appearances.get(memberId) || []).find((a) => a.event.eventId === ev.eventId);
      const win = app ?? { startMs: windowFor(ev).startMs, endMs: windowFor(ev).endMs, rounds: [] as RoundGame[] };

      // 1. PRIMARY: the Google index — never settle for the first hit.
      const leads = candidatesForPlatform(await googleCandidatesFor(memberId, ev), platform);
      if (leads.length && !stopHere()) {
        const scored: { cand: UsernameCandidate; prof: VerifiedProfile; score: number }[] = [];
        await pool(
          leads,
          VERIFY_POOL,
          async (cand) => {
            if (stopHere()) return;
            if (dudHandles.has(`${platform}:${cand.username.toLowerCase()}`)) return;
            const prof = await verifyOn(platform, cand.username);
            if (!prof || dudHandles.has(`${platform}:${prof.username.toLowerCase()}`)) return;
            const attr = attributeMatch(
              name,
              memberRating.get(memberId),
              memberState.get(memberId),
              prof,
              cand,
              win.startMs,
              win.endMs,
              memberId
            );
            if (!attr) return; // created after the event, or publishes someone else's USCF ID
            scored.push({ cand, prof, score: attr.score });
          },
          () => stopHere()
        );
        scored.sort((a, b) => b.score - a.score);
        if (scored.length) {
          log(
            `${name}: ${scored.length} Google lead(s) on ${platformLabel(platform)}; best attribute match ${Math.round(
              scored[0].score * 100
            )}%.`
          );
        }

        // Prefetch every shortlisted lead's window games at once (windowGames
        // is memoized, so this is pure overlap), then JUDGE them strictly
        // best-attribute-first — identical accept order to the serial scan.
        const shortlist = scored.filter((s) => s.score >= ATTR_SHORTLIST);
        for (const s of shortlist) void windowGames(platform, s.prof.username, win.startMs, win.endMs);

        let fallback: VerifiedProfile | null = null;
        const evTc = parseEventTc(ev.timeControl);
        for (const { prof, score } of shortlist) {
          if (stopHere()) break;
          const games = await windowGames(platform, prof.username, win.startMs, win.endMs);
          if (!games.length) {
            if (archiveHole(platform, prof.username, win.startMs, win.endMs)) {
              transientMiss = true;
              log(
                `Google lead @${prof.username} (${name}): chess.com's archive shard failed for the "${ev.name}" window — data hole, not a verdict; will retry later.`
              );
            } else {
              log(
                `Google lead @${prof.username} (${name}, ${Math.round(score * 100)}% attributes) played no ${platformLabel(
                  platform
                )} games during "${ev.name}" — wrong account for this event; trying the next lead.`
              );
            }
            continue;
          }
          // Crosstable check: do the in-window games line up with the member's
          // actual rounds (result sequence + tournament linkage)?
          const { scoped, viaLink, viaTc } = scopeToEvent(games, state, platform, ev);
          const alignment = app ? alignWithRetry(app.rounds, scoped, !!viaLink, platform) : null;
          if (alignment) {
            log(
              `Google index: ${name} → @${prof.username} (${platformLabel(platform)}) — ${Math.round(
                score * 100
              )}% attributes AND their event games align with the crosstable.`
            );
            return prof;
          }
          // In-window games that include NONE at the event's known time control
          // are the signature of the wrong account (a same-name player who was
          // merely online that day) — only structural alignment may overrule.
          if (evTc && !viaTc && !viaLink) {
            if (archiveHole(platform, prof.username, win.startMs, win.endMs)) {
              // The failed month may hold exactly the event-TC games — a hole,
              // not a wrong-account verdict.
              transientMiss = true;
              continue;
            }
            log(
              `Google lead @${prof.username} (${name}) has ${games.length} in-window game(s) but none at the event's ${evTc.label} control — likely the wrong account; trying the next lead.`
            );
            continue;
          }
          if (score >= ATTR_ACCEPT && !fallback) {
            fallback = prof;
            log(
              `Google index: ${name} → @${prof.username} (${platformLabel(platform)}) — ${Math.round(
                score * 100
              )}% attribute match with games in the event window.`
            );
          }
        }
        if (fallback) return fallback;
      }

      // 2. ABSOLUTE LAST RESORT: platform-side guessing (only after Google).
      // The profile must show a matching REAL name — a username that looks
      // like the player's name is meaningless (namesakes, not identities).
      // And a real name alone is still not enough: EVERY name-gated candidate
      // is pre-screened against the event itself (games in the window, at the
      // event's control, aligning with the crosstable) BEFORE it may map.
      // The old path returned the first name-matcher unseen — it got mapped,
      // traced, found gameless, blacklisted and re-derived, one candidate per
      // cycle. Now all candidates are judged concurrently in one pass, which
      // also handles several same-name accounts and players with more than
      // one account: the one that actually played the event wins.
      const st = memberState.get(memberId);
      const evTc = parseEventTc(ev.timeControl);

      /** Judge name-gated candidates by real event evidence; best first. */
      const judgeSeedCandidates = async (profs: VerifiedProfile[]): Promise<VerifiedProfile | null> => {
        interface Judged {
          prof: VerifiedProfile;
          aligned: boolean;
          tcOk: boolean;
          order: number;
        }
        const judged: Judged[] = [];
        await pool(
          profs,
          4,
          async (prof, order) => {
            if (stopHere()) return;
            const games = await windowGames(platform, prof.username, win.startMs, win.endMs);
            // A window spanning a failed month/export is a HOLE: even a
            // NON-EMPTY result can be missing exactly the event games, so a
            // hole may never feed a REJECTION verdict — positive evidence
            // (an alignment on the partial data) still counts.
            const hole = archiveHole(platform, prof.username, win.startMs, win.endMs);
            if (!games.length) {
              // Provably not the account that played this event — UNLESS the
              // archive fetch failed, in which case we know nothing.
              if (hole) transientMiss = true;
              return;
            }
            const { scoped, viaLink, viaTc } = scopeToEvent(games, state, platform, ev);
            const alignment = app ? alignWithRetry(app.rounds, scoped, !!viaLink, platform) : null;
            // "Name match + a same-TC same-date game" must NOT clear the bar
            // when the profile CONTRADICTS the USCF record (foreign country,
            // wrong state) — namesakes ace name matches. A contradicted
            // candidate needs structural alignment, its published USCF ID, or
            // a club tie to survive.
            const otherState = st && prof.location && !locationMatchesState(prof.location, st) ? strictStateOf(prof.location) : null;
            const contradicted = isForeignCountry(prof.country) || (!!otherState && otherState !== st!.trim().toUpperCase());
            if (contradicted && !alignment && digits(prof.uscfId) !== memberId) {
              if (hole) {
                transientMiss = true;
                return; // can't judge a contradicted candidate over partial data
              }
              const clubs = await fetchClubs(platform, prof.username, signal);
              if (!clubs.some((c) => clubEventTie(c, ev.name, [st, graph.rootState]))) {
                log(
                  `Name-guess @${prof.username} matches "${name}" and played in the window, but its profile contradicts the USCF record (${
                    isForeignCountry(prof.country) ? `country ${prof.country}` : `location ${prof.location}`
                  }) with no structural tie — not accepting a namesake.`
                );
                return;
              }
            }
            const tcOk = !evTc || !!viaTc || !!viaLink;
            // Window games that include NONE at the event's known control are
            // the wrong account unless the crosstable alignment itself bites —
            // same rule as the Google-lead path (observed: a namesake with
            // same-class games in the window mapping a section player).
            if (!tcOk && !alignment) {
              if (hole) {
                transientMiss = true;
                return; // the missing month may hold exactly the event-TC games
              }
              log(
                `Name-guess @${prof.username} (${name}) has ${games.length} in-window game(s) but none at the event's ${evTc!.label} control — likely the wrong account; skipping.`
              );
              return;
            }
            judged.push({ prof, aligned: !!alignment, tcOk, order });
          },
          () => stopHere()
        );
        // Aligned beats TC-fitting beats mere in-window; original order last —
        // deterministic, same winner as a serial best-first scan.
        judged.sort(
          (a, b) => (b.aligned ? 1 : 0) - (a.aligned ? 1 : 0) || (b.tcOk ? 1 : 0) - (a.tcOk ? 1 : 0) || a.order - b.order
        );
        return judged[0]?.prof ?? null;
      };

      const gate = (prof: VerifiedProfile): boolean =>
        !!prof.displayName && nameSimilarity(name, prof.displayName) >= 0.72;
      const guesses = guessHandles(name).filter((h) => !dudHandles.has(`${platform}:${h.toLowerCase()}`));
      const guessProfs = new Map<string, VerifiedProfile | null>();
      await pool(
        guesses,
        VERIFY_POOL,
        async (h) => {
          if (stopHere()) return;
          guessProfs.set(h, await verifyOn(platform, h));
        },
        () => stopHere()
      );
      const seenGuess = new Set<string>();
      const guessPassers: VerifiedProfile[] = [];
      for (const h of guesses) {
        const prof = guessProfs.get(h);
        if (!prof || !gate(prof) || dudHandles.has(`${platform}:${prof.username.toLowerCase()}`)) continue;
        const k = prof.username.toLowerCase();
        if (seenGuess.has(k)) continue;
        seenGuess.add(k);
        guessPassers.push(prof);
      }
      if (guessPassers.length && !stopHere()) {
        const best = await judgeSeedCandidates(guessPassers);
        if (best) return best;
        // Honesty in the rejection: "none verifiably played" is only a verdict
        // when the candidates were actually judged against real data. A clock
        // that ran out or an archive shard that failed is NOT a namesake call —
        // say so, and (via transientMiss) let a later pass retry this member.
        if (stopHere()) {
          transientMiss = true;
          if (!found) log(`${name}: ran out of time mid-verification of ${guessPassers.length} name-matching account(s) — not a verdict.`);
        } else if (transientMiss) {
          log(
            `${name}: ${guessPassers.length} name-matching account(s) exist but chess.com's archive shards failed while checking them — data hole, not a namesake verdict; will retry.`
          );
        } else {
          log(
            `${name}: ${guessPassers.length} name-matching guessed account(s) exist, but none verifiably played "${ev.name}" — not settling for a namesake.`
          );
        }
      }
      if (platform === "lichess" && !stopHere()) {
        // Lichess offers autocomplete — still only a SEED finder for opponents.
        const t = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
        const terms = new Set<string>();
        if (t.length >= 2) terms.add(`${t[0]}${t[t.length - 1]}`.slice(0, 20));
        const last = t[t.length - 1];
        if (last && last.length >= 4) terms.add(last);
        for (const term of terms) {
          if (stopHere()) return null;
          const handles = (await lichessAutocomplete(term, signal)).slice(0, 5).filter((h) => !dudHandles.has(`lichess:${h.toLowerCase()}`));
          const acProfs = new Map<string, VerifiedProfile | null>();
          await pool(
            handles,
            4,
            async (h) => {
              if (stopHere()) return;
              acProfs.set(h, await verifyOn("lichess", h));
            },
            () => stopHere()
          );
          const acPassers: VerifiedProfile[] = [];
          for (const h of handles) {
            const prof = acProfs.get(h);
            if (prof && prof.displayName && nameSimilarity(name, prof.displayName) >= 0.78 && !seenGuess.has(prof.username.toLowerCase())) {
              acPassers.push(prof);
            }
          }
          if (acPassers.length) {
            const best = await judgeSeedCandidates(acPassers);
            if (best) return best;
          }
        }
      }
      return null;
    })();
    seedCache.set(key, promise);
    void promise.then((r) => {
      // A transient null (archive shard hole, out of clock, fleet stand-down)
      // is not this member's verdict — evict it so a later pass, the requeue
      // path or the opponent pivot gets a REAL attempt instead of the cached
      // artifact of bad weather.
      if (!r && (transientMiss || stopHere())) seedCache.delete(key);
    });
    return promise;
  };

  // --- Recording the target ---------------------------------------------------
  interface FoundVia {
    method: "pairing" | "roster-name" | "elimination" | "opponent-archive" | "google" | "google-lead";
    event: GraphEvent;
    link?: EventLink;
    chain?: string[];
    viaName?: string;
    viaHandle?: string;
    round?: number;
    checkedRounds?: number;
    totalRounds?: number;
    game?: ArchiveGame;
    /** Google-index provenance (methods "google" / "google-lead"). */
    sourceUrl?: string;
    /** In-window games against handles known to belong to this section. */
    sectionOverlap?: number;
    /** 0..1 attribute-match score (profile vs USCF record), when computed. */
    attrScore?: number;
    /** How many DIFFERENT direct opponents' games independently named this handle
     *  as their round-vs-target opponent (cross-corroborated single-edge reveal). */
    crossVotes?: number;
  }

  const foundKeys = new Set<string>();

  const recordTarget = async (platform: OnlinePlatform, profile: VerifiedProfile, via: FoundVia): Promise<boolean> => {
    // FIDE-ID gate: a linked FIDE ID that contradicts the target's rejects the
    // candidate outright; a match is near-decisive.
    if (targetFideId && profile.fideId && digits(profile.fideId) !== targetFideId) {
      log(`Rejected @${profile.username}: profile links FIDE ID ${profile.fideId}, but ${targetName}'s is ${targetFideId}.`);
      return false;
    }
    // USCF-ID gate: same logic for a USCF member ID the owner published on the
    // profile — an exact match is near-conclusive, someone else's ID is fatal.
    if (digits(profile.uscfId) && digits(profile.uscfId) !== targetId) {
      log(`Rejected @${profile.username}: profile publishes USCF ID ${profile.uscfId}, but ${targetName} is #${targetId}.`);
      return false;
    }
    // One handle = one person. An account already mapped to a DIFFERENT
    // crosstable player (or claimed by several — a hyperactive casual account
    // that partial alignments keep locking onto) cannot also be the target.
    // Observed live: a 2/10 partial alignment crowned an account 99% that the
    // same run had ALREADY mapped to another section player.
    if (handleDisqualified(platform, profile.username)) {
      log(
        `Rejected @${profile.username} as ${targetName}: that account is already mapped to another crosstable player (or several) — a shared/casual account, not the target.`
      );
      return false;
    }
    const key = `${platform}:${profile.username.toLowerCase()}`;

    const ev = via.event;
    const evidence: Evidence[] = [];
    const dateStr = via.game ? new Date(via.game.endMs).toISOString().slice(0, 10) : (ev.startDate || "").slice(0, 10);

    switch (via.method) {
      case "pairing":
        evidence.push({
          kind: "shared-opponent",
          weight: graphDiscoveryWeight(true, via.crossVotes || 1),
          label: `Round ${via.round}: the crosstable pairs ${targetName} with ${via.viaName}, and @${via.viaHandle}'s game that round was against @${profile.username}`,
          source: "uscf-graph",
        });
        if (via.crossVotes && via.crossVotes >= 2) {
          evidence.push({
            kind: "shared-opponent",
            weight: Math.min(2.0, 0.9 * via.crossVotes),
            label: `${via.crossVotes} of ${targetName}'s crosstable opponents independently played @${profile.username} in the exact round they faced ${targetName}`,
            source: "uscf-graph",
          });
        }
        if (via.checkedRounds) {
          evidence.push({
            kind: "cross-reference",
            weight: Math.min(1.6, 0.5 + 0.18 * via.checkedRounds),
            label: `${via.checkedRounds}/${via.totalRounds ?? via.checkedRounds} round results match the USCF crosstable exactly`,
            source: "uscf-graph",
          });
        }
        if (via.chain && via.chain.length > 1) {
          evidence.push({
            kind: "cross-reference",
            weight: 0.4,
            label: `Reached through a verified pairing chain: ${via.chain.join(" → ")}`,
            source: "uscf-graph",
          });
        }
        break;
      case "roster-name":
        evidence.push({
          kind: "name-match",
          weight: nameMatchWeight(nameSimilarity(targetName, profile.displayName || profile.username)) + (profile.displayName ? 0.3 : 0),
          label: `Participant @${profile.username}'s profile name "${profile.displayName || profile.username}" matches ${targetName}`,
          source: "uscf-graph",
        });
        break;
      case "elimination":
        evidence.push({
          kind: "cross-reference",
          weight: 1.8,
          label: `Every other crosstable player matched a participant — the one handle left, @${profile.username}, must be ${targetName}`,
          source: "uscf-graph",
        });
        break;
      case "opponent-archive":
        evidence.push({
          kind: "name-match",
          weight: nameMatchWeight(nameSimilarity(targetName, profile.displayName || profile.username)) + (profile.displayName ? 0.3 : 0),
          label: `${platformLabel(platform)} name "${profile.displayName || profile.username}" matches "${targetName}"`,
          source: "uscf-graph",
        });
        evidence.push({
          kind: "shared-opponent",
          weight: graphDiscoveryWeight(!!via.game, 1),
          label: `Played USCF opponent ${via.viaName} (@${via.viaHandle}) during "${ev.name}"`,
          source: "uscf-graph",
        });
        break;
      case "google":
        evidence.push({
          kind: "name-match",
          weight: 1.8,
          label: `Google index ties "${targetName}" to @${profile.username}${via.sourceUrl ? ` (${via.sourceUrl})` : ""}`,
          source: "uscf-graph",
        });
        if (via.checkedRounds) {
          evidence.push({
            kind: "cross-reference",
            weight: Math.min(1.8, 0.6 + 0.2 * via.checkedRounds),
            label: `${via.checkedRounds}/${via.totalRounds ?? via.checkedRounds} round results match the USCF crosstable exactly`,
            source: "uscf-graph",
          });
        }
        if (via.sectionOverlap) {
          evidence.push({
            kind: "shared-opponent",
            weight: Math.min(1.6, 0.8 * via.sectionOverlap),
            label: `${via.sectionOverlap} in-window game(s) against confirmed section players`,
            source: "uscf-graph",
          });
        }
        break;
      case "google-lead":
        evidence.push({
          kind: "name-match",
          weight: 1.4,
          label: `Google index ties "${targetName}" to @${profile.username}${via.sourceUrl ? ` (${via.sourceUrl})` : ""}`,
          source: "uscf-graph",
        });
        evidence.push({
          kind: "other",
          weight: -0.4,
          // "namesake" must appear verbatim: the UI withholds the confirmed
          // shield from any account whose evidence carries that caveat.
          label: `Has games during "${ev.name}" but none could be tied to the event itself yet — could still be a namesake`,
          source: "uscf-graph",
        });
        break;
    }
    if (typeof via.attrScore === "number") {
      // Map the 0..1 attribute-match score to a bounded log-odds nudge.
      const w = Math.max(-0.6, Math.min(1.0, (via.attrScore - 0.5) * 2));
      evidence.push({
        kind: "cross-reference",
        weight: w,
        label: `Profile attributes (name, rating, country, location, account age) match the USCF record at ${Math.round(
          via.attrScore * 100
        )}%`,
        source: "uscf-graph",
      });
    }

    if (via.link) {
      evidence.push({
        kind: "tournament-overlap",
        weight: 1.6,
        label: `Confirmed inside the ${platformLabel(platform)} tournament hosting "${ev.name}" (${ev.ratingSystem})`,
        source: "uscf-graph",
      });
    } else if (via.game) {
      evidence.push({
        kind: "tournament-overlap",
        weight: 1.0,
        label: `Game dated ${dateStr} falls inside "${ev.name}" (${ev.ratingSystem})`,
        source: "uscf-graph",
      });
    }

    // Positive-only name corroboration for structural methods (a pairing hit
    // must not be sunk by a missing/whimsical display name). NOT for
    // google-lead: the lead exists BECAUSE of the name, so "the profile name
    // corroborates" is circular — it stacked a namesake to 99% once.
    if (via.method === "pairing" || via.method === "elimination" || via.method === "google") {
      const sim = nameSimilarity(targetName, profile.displayName || "");
      if (profile.displayName && sim >= 0.6) {
        evidence.push({
          kind: "name-match",
          weight: nameMatchWeight(sim),
          label: `Profile name "${profile.displayName}" corroborates ${targetName}`,
          source: "uscf-graph",
        });
      }
    }
    if (targetFideId && profile.fideId && digits(profile.fideId) === targetFideId) {
      evidence.push({ kind: "fide-id-match", weight: 4.0, label: `Profile links FIDE ID ${profile.fideId} — exact match`, source: "uscf-graph" });
    }
    if (digits(profile.uscfId) === targetId) {
      evidence.push({
        kind: "uscf-id-match",
        weight: 4.0,
        label: `Profile publishes USCF ID ${profile.uscfId} — exact match`,
        source: "uscf-graph",
      });
    }
    // Location vs the target's USCF state of record: naming the right state
    // corroborates; confidently naming a DIFFERENT one is namesake-shaped.
    if (graph.rootState && profile.location) {
      if (locationMatchesState(profile.location, graph.rootState)) {
        evidence.push({
          kind: "state-match",
          weight: 0.6,
          label: `Profile location "${profile.location}" matches the player's ${graph.rootState}`,
          source: "uscf-graph",
        });
      } else {
        const other = strictStateOf(profile.location);
        if (other && other !== graph.rootState.trim().toUpperCase()) {
          evidence.push({
            kind: "state-match",
            weight: -0.9,
            label: `Profile location "${profile.location}" is in ${other}, not the player's ${graph.rootState}`,
            source: "uscf-graph",
          });
        }
      }
    }
    // Club membership tied to the event's organiser or region — the kind of
    // corroboration a careful human checks (e.g. a PNWCC club member playing
    // a PNWCC event).
    const clubs = await fetchClubs(platform, profile.username, signal);
    for (const club of clubs) {
      const tie = clubEventTie(club, ev.name, [graph.rootState]);
      if (tie) {
        evidence.push({ kind: "cross-reference", weight: 0.9, label: `Account's ${tie}`, source: "uscf-graph" });
        break;
      }
    }
    if (effTargetRating && profile.uscfRating && Math.abs(profile.uscfRating - effTargetRating) <= 200) {
      evidence.push({
        kind: "cross-reference",
        weight: 0.8,
        label: `Profile lists USCF rating ${profile.uscfRating} (target ~${effTargetRating})`,
        source: "uscf-graph",
      });
    }
    // Country sanity: a USCF (US federation) member's account normally flies a
    // US flag or none at all. A confident foreign flag is a HEAVY strike — it
    // is how wrong-person accounts sneak in — but never fatal on its own,
    // because structural proof must be able to overrule it (a verified WA
    // junior's account was observed flying a Canada flag).
    if (isUsCountry(profile.country)) {
      evidence.push({
        kind: "country-match",
        weight: 0.3,
        label: "Profile country US matches the US Chess federation",
        source: "uscf-graph",
      });
    } else if (isForeignCountry(profile.country)) {
      evidence.push({
        kind: "country-match",
        weight: -0.9,
        label: `Profile claims country ${profile.country} for a US Chess member`,
        source: "uscf-graph",
      });
    }
    evidence.push({ kind: "account-verified", weight: 0.5, label: `Account confirmed live via ${platformLabel(platform)} API`, source: "uscf-graph" });
    if (effTargetRating && profile.rating) {
      evidence.push({
        kind: "rating-match",
        weight: onlineRatingMatchWeight(effTargetRating, profile.rating),
        label: `${platformLabel(platform)} rating ${profile.rating} vs ~${effTargetRating} USCF`,
        source: "uscf-graph",
      });
    }

    const account: DiscoveredAccount = {
      platform,
      username: profile.username,
      displayName: profile.displayName,
      title: profile.title,
      rating: profile.rating,
      ratings: profile.ratings,
      country: profile.country,
      fideId: profile.fideId,
      gamesFound: profile.gamesFound,
      lastActive: profile.lastActiveMs ? new Date(profile.lastActiveMs).toISOString() : undefined,
      profileUrl: profile.profileUrl,
      verified: true,
      // A google-lead is BY DEFINITION unproven (games in the window, no
      // structural tie) — its confidence is hard-capped below the "confirmed"
      // range no matter how well the name and attributes stack, because every
      // input to that stack is name-derived and namesakes ace it. Structural
      // methods keep the full score.
      confidence:
        via.method === "google-lead"
          ? Math.min(0.65, scoreFromEvidence(evidence, -0.5))
          : scoreFromEvidence(evidence, -0.5),
      evidence,
    };

    // A structural identification ends the whole hunt — flip the global flag
    // the MOMENT it lands so every in-flight agent (rosters mid-verification,
    // seed scouts, sibling event agents, deep dives) stands down immediately
    // instead of finishing now-pointless work. A capped "google-lead" is not
    // an identification, so it keeps the search running.
    if (via.method !== "google-lead") found = true;

    if (foundKeys.has(key)) {
      // Already recorded — keep whichever evidence trail is stronger (a
      // google-lead upgraded by a later structural proof, or vice versa).
      const idx = accounts.findIndex((a) => a.platform === platform && a.username.toLowerCase() === profile.username.toLowerCase());
      if (idx >= 0 && account.confidence > accounts[idx].confidence) accounts[idx] = account;
      else if (idx < 0) accounts.push(account);
      return true;
    }
    foundKeys.add(key);
    accounts.push(account);
    const how =
      via.method === "pairing"
        ? `pairing chain ${(via.chain || []).concat(via.viaName || "").filter(Boolean).join(" → ")} in "${ev.name}"`
        : via.method === "elimination"
        ? `elimination over the tournament roster of "${ev.name}"`
        : via.method === "roster-name"
        ? `the participant roster of "${ev.name}"`
        : via.method === "google"
        ? `the Google index, verified against "${ev.name}"'s games`
        : via.method === "google-lead"
        ? `the Google index (games in the "${ev.name}" window; structural proof still pending)`
        : `tracing ${via.viaName}'s games in "${ev.name}"`;
    if (via.method === "google-lead") {
      log(`Google-index lead: ${targetName} may play ${platformLabel(platform)} as @${profile.username} — found via ${how}.`);
    } else {
      log(`✔ Match! ${targetName} plays ${platformLabel(platform)} as @${profile.username} — found via ${how}.`);
    }
    return true;
  };

  // ---------------------------------------------------------------------------
  // Roster shortcut: match a platform tournament's participants to a crosstable.
  // ---------------------------------------------------------------------------
  const rosterTried = new Set<string>();

  const tryRoster = async (
    ev: GraphEvent,
    link: EventLink,
    localDeadline: number,
    state?: EventState
  ): Promise<boolean> => {
    // Trust decides how much a roster may do (see linkTrusted): an untrusted
    // games-derived link only gets a TARGET scan — no member mapping, no
    // elimination, no tournament evidence. Keyed per trust tier so a link
    // that earns trust later gets its full matching pass then.
    const trusted = linkTrusted(state, link);
    const key = `${ev.eventId}|${linkKey(link)}|${trusted ? "t" : "u"}`;
    if (rosterTried.has(key)) return false;
    rosterTried.add(key);

    const handles = await fetchRoster(link, signal);
    if (!handles.length) return false;
    const roster = ev.players.map((p) => ({ uscfId: p.uscfId, name: p.name }));
    // A roster VASTLY bigger than the crosstable is a public arena strangers
    // pool, not this USCF event (observed: a 250-participant tournament
    // "linked" to a 22-player section by two casual games). Name-matching 250
    // strangers against 22 real names is a namesake factory, and scoping the
    // game pool to that link discards the real event games — mark it junk.
    if (handles.length >= 100 && handles.length > 4 * roster.length) {
      state?.junkLinks.add(linkKey(link));
      log(
        `"${ev.name}": the linked ${platformLabel(link.platform)} ${
          link.kind === "chesscom-tournament" ? "tournament" : link.kind.replace("lichess-", "")
        } has ${handles.length} participants for a ${roster.length}-player crosstable — a public pool, not this event; ignoring the link.`
      );
      return false;
    }
    log(
      `"${ev.name}" is linked to a ${platformLabel(link.platform)} ${
        link.kind === "chesscom-tournament" ? "tournament" : link.kind.replace("lichess-", "")
      } with ${handles.length} participants — ${
        trusted
          ? `matching them to the ${roster.length}-player crosstable…`
          : `only one section player ties to it so far, so it is NOT yet proven to be this event — scanning it for ${targetName} only.`
      }`
    );

    const memberClaimed = new Set<string>();
    const handleClaimed = new Set<string>();
    // Seed the bookkeeping with mappings we already trust — and credit them to
    // the link's trust ledger (a mapped section player among the participants
    // ties the tournament to this crosstable).
    for (const [mid, per] of mapped) {
      const m = per.get(link.platform);
      if (m && handles.some((h) => h.toLowerCase() === m.profile.username.toLowerCase())) {
        memberClaimed.add(mid);
        handleClaimed.add(m.profile.username.toLowerCase());
        if (state) {
          const srcs = state.linkSources.get(linkKey(link)) || new Set<string>();
          srcs.add(mid);
          state.linkSources.set(linkKey(link), srcs);
        }
      }
    }

    let rosterHit = false;
    await pool(
      handles,
      VERIFY_POOL,
      async (handle) => {
        if (rosterHit || stopNow(localDeadline)) return;
        if (handleClaimed.has(handle.toLowerCase())) return;
        const prof = await verifyOn(link.platform, handle);
        if (!prof?.displayName) return;
        let best: { uscfId: string; name: string } | null = null;
        let bestSim = 0;
        for (const m of roster) {
          const sim = nameSimilarity(m.name, prof.displayName);
          if (sim > bestSim) {
            bestSim = sim;
            best = m;
          }
        }
        if (!best || bestSim < 0.78) return;
        if (digits(prof.uscfId) && digits(prof.uscfId) !== best.uscfId) return; // publishes someone else's USCF ID
        if (best.uscfId === targetId) {
          // The target's own REAL name on a participant profile is evidence in
          // itself; the tournament tie only counts as evidence when trusted.
          if (await recordTarget(link.platform, prof, { method: "roster-name", event: ev, link: trusted ? link : undefined }))
            rosterHit = true;
          return;
        }
        // A high-confidence name tie credits the trust ledger even before the
        // link is trusted (two such ties promote it); MAPPING the member waits
        // for the trusted pass — a 0.78 tie in a wrong-tournament roster is a
        // namesake factory.
        if (state && bestSim >= 0.86) {
          const srcs = state.linkSources.get(linkKey(link)) || new Set<string>();
          srcs.add(best.uscfId);
          state.linkSources.set(linkKey(link), srcs);
        }
        if (!trusted) return;
        memberClaimed.add(best.uscfId);
        handleClaimed.add(handle.toLowerCase());
        setMapping(best.uscfId, link.platform, { profile: prof, how: "roster", chain: [] });
        // Roster-matched members are prime pairing-BFS fuel.
        if (state) enqueue(state, { memberId: best.uscfId, platform: link.platform, mapping: mapped.get(best.uscfId)!.get(link.platform)! });
      },
      () => rosterHit || stopNow(localDeadline)
    );
    if (rosterHit) return true;

    if (!trusted) {
      // If the scan itself earned the link trust (≥2 strong name ties), run
      // the full matching pass right away.
      if (linkTrusted(state, link) && !stopNow(localDeadline)) return tryRoster(ev, link, localDeadline, state);
      return false;
    }

    // Elimination: every crosstable player except the target matched a
    // participant, and exactly one participant handle is unclaimed. Only a
    // TRUSTED link may do this — elimination over a wrong tournament's roster
    // would crown a total stranger.
    const unmatchedMembers = roster.filter((m) => m.uscfId !== targetId && !memberClaimed.has(m.uscfId));
    const unclaimed = handles.filter((h) => !handleClaimed.has(h.toLowerCase()));
    if (unmatchedMembers.length === 0 && unclaimed.length === 1) {
      const prof = await verifyOn(link.platform, unclaimed[0]);
      if (prof && (await recordTarget(link.platform, prof, { method: "elimination", event: ev, link }))) return true;
    } else if (memberClaimed.size) {
      log(
        `Roster matched ${memberClaimed.size}/${roster.length - 1} crosstable players so far (${unclaimed.length} participant handles unclaimed) — continuing with pairing analysis.`
      );
    }
    return false;
  };

  // ---------------------------------------------------------------------------
  // Trace from one mapped source inside one event: linkage discovery, pairing
  // alignment, and a name-scan over the same fetched games.
  // ---------------------------------------------------------------------------
  interface EventState {
    links: Map<string, EventLink>;
    /** Links whose fetched roster proved to be a giant public pool unrelated
     *  to this crosstable (e.g. a 250-player arena vs a 22-player section) —
     *  they must neither scope game pools nor feed roster name-matching. */
    junkLinks: Set<string>;
    /** Which DISTINCT crosstable members' window games carry each link. A
     *  games-derived link is only TRUSTED as "the event's tournament" once
     *  TWO independent section players tie to it — a single source can be a
     *  plausibly-sized same-weekend tournament that is NOT this event
     *  (observed live: one seed's 25-player tournament cascaded five wrong
     *  mappings into a 99% wrong crown). Until trusted, a games-derived link
     *  never scopes pools, never relaxes alignment, never maps roster
     *  members, never runs elimination and never counts as tournament
     *  evidence. Flyer-sourced links are the event by construction. */
    linkSources: Map<string, Set<string>>;
    frontier: { memberId: string; platform: OnlinePlatform; mapping: Mapping }[];
    visited: Set<string>;
    /** How many sources' event-scoped games each opponent handle appeared in —
     *  a handle seen from several section players is almost surely a section
     *  player itself, so it gets verified first. */
    oppSeen: Map<string, number>;
    /** Cross-corroboration ledger for the TARGET's handle: lowercased handle →
     *  the set of DIFFERENT direct opponents whose round-vs-target game named it,
     *  plus a representative game. Two independent voters (or a FIDE match)
     *  clinches the target even when no single opponent fully aligned. */
    targetEdgeVotes?: Map<string, { voters: Set<string>; game: ArchiveGame; viaName: string; viaHandle: string; round: number }>;
    /** Seed queue (present on real event states; duds get requeued here). */
    seedOrder?: string[];
  }

  /** Queue a mapped member for tracing — the target's own opponents go FIRST:
   *  their games contain the target's handle on the other side of the board. */
  const enqueue = (state: EventState, entry: { memberId: string; platform: OnlinePlatform; mapping: Mapping }) => {
    if (directOpponents.has(entry.memberId)) state.frontier.unshift(entry);
    else state.frontier.push(entry);
  };

  // Handles that verified for a member but turned out to have no games in the
  // event window (a namesake or abandoned account). resolveMemberOn skips
  // them so the member's REAL account can surface on a retry.
  const dudHandles = new Set<string>();
  const dudCount = new Map<string, number>();
  // Bounded re-trace budget for archive-shard holes (member:platform:event) —
  // a hard-down shard must not spin the tracer forever.
  const holeRetries = new Map<string, number>();

  const traceFromSource = async (
    ev: GraphEvent,
    state: EventState,
    memberId: string,
    platform: OnlinePlatform,
    mapping: Mapping,
    localDeadline: number
  ): Promise<boolean> => {
    const app = (appearances.get(memberId) || []).find((a) => a.event.eventId === ev.eventId);
    if (!app) return false;
    const srcName = memberName.get(memberId) || "player";
    const handle = mapping.profile.username;
    log(`Pulling @${handle}'s (${srcName}) ${platformLabel(platform)} games from the "${ev.name}" date window…`);
    const games = await windowGames(platform, handle, app.startMs, app.endMs);
    if (!games.length) {
      if (archiveHole(platform, handle, app.startMs, app.endMs)) {
        // The shard failed — we know NOTHING about this window. Blacklisting
        // the handle here is how one flaked GET destroys a correct mapping
        // (and with it the whole pairing chain). Keep the mapping and re-queue
        // the trace (bounded) so it re-runs if the shard comes back.
        const hk = `${memberId}:${platform}:${ev.eventId}`;
        const n = holeRetries.get(hk) || 0;
        log(
          `Couldn't fetch @${handle}'s (${srcName}) archive for the "${ev.name}" window — chess.com shard failure, not a namesake verdict; ${
            n < 2 ? "keeping the mapping and retrying" : "keeping the mapping (retries exhausted here)"
          }.`
        );
        if (n < 2) {
          holeRetries.set(hk, n + 1);
          state.visited.delete(`${memberId}:${platform}`);
          enqueue(state, { memberId, platform, mapping });
        }
        return false;
      }
      log(`@${handle} (${srcName}) played no ${platformLabel(platform)} games in that window — likely a namesake or second account.`);
      // A seed that never played the event is a dud: blacklist the handle,
      // unmap, and — for the target's own opponents, the highest-value
      // sources — requeue the member so their REAL account can win.
      if (mapping.how === "seed" && (dudCount.get(memberId) || 0) < 3) {
        dudCount.set(memberId, (dudCount.get(memberId) || 0) + 1);
        dudHandles.add(`${platform}:${handle.toLowerCase()}`);
        // Seed resolutions are cached per event — clear them all so the next
        // attempt can move past the blacklisted handle.
        for (const k of Array.from(seedCache.keys())) {
          if (k.startsWith(`${memberId}:${platform}:`)) seedCache.delete(k);
        }
        unsetMapping(memberId, platform);
        if (directOpponents.has(memberId)) {
          // Retrying is worth it only when there's a genuinely fresh lead to try.
          // A member the Google index has candidates for may have their REAL
          // account deeper in that list — keep going. But when the only source
          // was name-shaped handle GUESSING (no Google leads), each retry just
          // surfaces the next same-name stranger, so don't re-derive past the
          // first miss — that is pure budget burn with no path to the answer.
          const hadGoogleLeads = (await googleCandidatesFor(memberId, ev)).length > 0;
          if (hadGoogleLeads || (dudCount.get(memberId) || 0) < 2) {
            state.seedOrder?.push(memberId);
            log(`Retrying ${srcName} with their remaining ${hadGoogleLeads ? "Google leads and " : ""}handle guesses…`);
          } else {
            log(`${srcName}'s name-guess accounts keep coming up empty here and the index has no lead — not re-deriving further.`);
          }
        }
      }
      return false;
    }

    // (a) New tournament linkage revealed by the source's games? Record this
    // member in each link's trust ledger FIRST — a games-derived link is only
    // trusted once two distinct crosstable members tie to it. A link the
    // source played only ONE game in is almost always a public arena they
    // dipped into once, not the USCF event — registering it (and worse, fetching
    // its whole roster to name-match) burns the budget on strangers. Only chase
    // a games-derived link the source actually played several games in.
    for (const link of linksFromGames(games)) {
      if (outOfTime(localDeadline)) break;
      const lk = linkKey(link);
      const srcs = state.linkSources.get(lk) || new Set<string>();
      srcs.add(memberId);
      state.linkSources.set(lk, srcs);
      if (!state.links.has(lk)) state.links.set(lk, link);
      if (state.junkLinks.has(lk)) continue;
      if (games.filter((g) => gameInLink(g, link)).length < 2) continue;
      if (await tryRoster(ev, link, localDeadline, state)) return true;
    }

    // (b) Pairing alignment: source's crosstable rounds ↔ event-scoped games.
    const { scoped, viaLink, viaTc } = scopeToEvent(games, state, platform, ev);
    const alignment = alignWithRetry(app.rounds, scoped, !!viaLink, platform);
    if (!alignment && app.rounds.length) {
      log(
        `Couldn't align @${handle}'s ${scoped.length} in-window game(s) with ${srcName}'s ${app.rounds.length} crosstable rounds${
          viaLink ? " (tournament-scoped)" : viaTc ? ` (${viaTc.label}-scoped)` : ""
        } — relying on roster and name evidence instead.`
      );
    }
    if (alignment) {
      // A board may name the TARGET only when the assignment is UNAMBIGUOUS: the
      // opponent is FULLY aligned (every crosstable round matched a game, so the
      // round they played the target maps to exactly one game) OR the games were
      // scoped by a real tournament link (no casual pool to confuse the round).
      // A PARTIAL alignment leaves the unpinned target round free to lock onto a
      // stray casual game (observed: a 3-of-11 alignment mislabelled the target).
      // Partial alignments still map section players (BFS fuel) and feed the
      // cross-corroboration vote below — they just can't crown the target alone.
      // A tournament link used to be enough licence on its own, but a SPARSE
      // link-scoped alignment (observed: 2/10) still assigns round labels
      // near-arbitrarily inside a busy arena pool and can crown a stranger —
      // so even with a link the alignment must be complete up to one missing
      // round (a bye/forfeit) before a board may name the target.
      const nearlyFull = alignment.pairs.length >= app.rounds.length - 1;
      const targetReadable = alignment.pairs.length >= app.rounds.length || (!!viaLink && nearlyFull);
      log(
        `Aligned @${handle}'s ${alignment.pairs.length} of ${srcName}'s ${app.rounds.length} crosstable rounds (${alignment.checked} results verified${
          viaTc ? `, ${viaTc.label}-scoped` : viaLink ? ", tournament-scoped" : ""
        })${targetReadable ? "" : " — partial, so it can map opponents but not crown the target alone"} — reading the other side of each board…`
      );
      // Verify the other side of every aligned board CONCURRENTLY — each hit
      // maps one more crosstable player (or IS the target).
      let pairingHit = false;
      await pool(
        alignment.pairs,
        VERIFY_POOL,
        async ({ round, game }) => {
          if (pairingHit || stopNow(localDeadline)) return;
          const oppId = round.opponentUscfId;
          const prof = await verifyOn(platform, game.oppHandle);
          if (!prof) return;
          if (oppId === targetId) {
            if (
              targetReadable &&
              (await recordTarget(platform, prof, {
                method: "pairing",
                event: ev,
                link: viaLink,
                chain: mapping.chain.concat(srcName),
                viaName: srcName,
                viaHandle: handle,
                round: round.round,
                checkedRounds: alignment.checked,
                totalRounds: app.rounds.length,
                game,
              }))
            )
              pairingHit = true;
            return;
          }
          if (!mapped.get(oppId)?.has(platform)) {
            // A board from a PARTIAL alignment may only name a player when the
            // account doesn't contradict the USCF record (or a corroborator
            // vouches for it) — a fully-determined alignment is its own proof.
            const gate = await mapGate(oppId, prof, platform, ev, targetReadable);
            if (!gate.ok) {
              log(
                `NOT mapping ${memberName.get(oppId) || oppId} to @${prof.username} from a partial alignment: ${gate.why}.`
              );
              return;
            }
            setMapping(oppId, platform, { profile: prof, how: "pairing", chain: mapping.chain.concat(srcName) });
            enqueue(state, { memberId: oppId, platform, mapping: mapped.get(oppId)!.get(platform)! });
            log(
              `Pairing chain: round ${round.round} maps ${memberName.get(oppId) || oppId} to @${prof.username}${
                directOpponents.has(oppId) ? ` — they played ${targetName}; tracing them FIRST.` : " — following them next."
              }`
            );
          }
        },
        () => pairingHit || stopNow(localDeadline)
      );
      if (pairingHit) return true;
    }

    // (b2) Cross-corroborated TARGET edge. This source is a direct opponent of
    // the target; the crosstable says which round they faced. If (b) above didn't
    // already resolve the target from a fully-aligned board, that same round's
    // game STILL names the target on the other side — but one loosely-aligned
    // game is not proof (any casual game can share a W/L/D), so we require
    // CORROBORATION: the identical handle named by ≥2 DIFFERENT direct opponents
    // in the exact round each played the target, or a FIDE-id match. A single
    // outcome-only game with no such anchor is never accepted. (A fully-aligned
    // opponent already resolves the target through (b); this closes the gap for
    // partial / unaligned opponents — the @brilliant_knight case.)
    if (!found && !stopNow(localDeadline)) {
      const tr = app.rounds.find((r) => r.opponentUscfId === targetId);
      if (tr) {
        // Handles this source's OTHER rounds already account for (aligned boards
        // + any already-mapped section-mate on this platform) can't be the target.
        const claimed = new Set<string>();
        if (alignment) for (const p of alignment.pairs) claimed.add(p.game.oppHandle.toLowerCase());
        for (const per of mapped.values()) {
          const h = per.get(platform)?.profile.username;
          if (h) claimed.add(h.toLowerCase());
        }
        // The target's game this source played: outcome MUST be known and match
        // this source's crosstable result vs the target (the anchor); colour must
        // agree when both know it; opponent must be otherwise unaccounted-for.
        const cands = targetEdgeCandidates(tr, scoped, handle.toLowerCase(), claimed);
        // Only an UNAMBIGUOUS single candidate is this source's vote — two equally
        // plausible games mean we can't tell which board was the target's.
        if (cands.length === 1) {
          const votes = (state.targetEdgeVotes ??= new Map());
          const k = cands[0].oppHandle.toLowerCase();
          const entry =
            votes.get(k) || { voters: new Set<string>(), game: cands[0], viaName: srcName, viaHandle: handle, round: tr.round };
          entry.voters.add(memberId);
          votes.set(k, entry);
          if (entry.voters.size >= 2 || targetFideId) {
            const prof = await verifyOn(platform, cands[0].oppHandle);
            const fideOk = !!(prof?.fideId && targetFideId && digits(prof.fideId) === targetFideId);
            if (prof && (entry.voters.size >= 2 || fideOk)) {
              if (
                await recordTarget(platform, prof, {
                  method: "pairing",
                  event: ev,
                  link: viaLink && gameInLink(entry.game, viaLink) ? viaLink : undefined,
                  chain: mapping.chain.concat(srcName),
                  viaName: entry.viaName,
                  viaHandle: entry.viaHandle,
                  round: entry.round,
                  game: entry.game,
                  crossVotes: entry.voters.size,
                })
              )
                return true;
            }
          } else {
            log(
              `@${cands[0].oppHandle} looks like ${targetName}'s round-${tr.round} opponent from ${srcName}'s game, but one edge isn't proof — holding for a second opponent to corroborate.`
            );
          }
        }
      }
    }

    // (c) Name-scan the same games: the target's own account may show a real
    // name. Verification order is everything here — a busy junior can have 50+
    // distinct opponents even inside the event window, so rank candidates by:
    //   • how many DIFFERENT section players' scoped games they appear in
    //     (recurring handles are almost surely section players),
    //   • whether the source's result against them equals the source's
    //     crosstable result against the TARGET (we know how their game went!),
    //   • being a rated game of the event's expected time class.
    const scopedKeys = new Set(scoped.map((g) => g.oppHandle.toLowerCase()));
    const byHandle = new Map<string, ArchiveGame>();
    for (const g of [...scoped, ...games]) {
      const k = g.oppHandle.toLowerCase();
      if (!byHandle.has(k)) byHandle.set(k, g); // scoped instance wins
    }
    const srcVsTarget = app.rounds.find((r) => r.opponentUscfId === targetId);
    const scoreCand = (k: string, g: ArchiveGame): number => {
      let s = 0;
      if (scopedKeys.has(k)) s += 1;
      // Unrated + expected class is the signature of a manually-paired USCF
      // event game (rated ones would double-rate the players).
      if (scopedKeys.has(k) && !g.rated) s += 0.5;
      if (srcVsTarget && g.sourceOutcome && g.sourceOutcome === srcVsTarget.outcome) s += 1.5;
      s += 2 * Math.min(2, state.oppSeen.get(k) || 0);
      return s;
    };
    const candidates = Array.from(byHandle.entries())
      .map(([k, g]) => ({ g, s: scoreCand(k, g) }))
      .sort((a, b) => b.s - a.s)
      .map((c) => c.g);
    // Record this source's scoped opponents for later sources' ranking.
    for (const k of scopedKeys) state.oppSeen.set(k, (state.oppSeen.get(k) || 0) + 1);

    const roster = ev.players;
    let scanHit = false;
    await pool(
      candidates,
      VERIFY_POOL,
      async (g) => {
        if (scanHit || stopNow(localDeadline)) return;
        const prof = await verifyOn(platform, g.oppHandle);
        if (!prof) return;
        // Only a REAL name on the profile counts — a username that merely
        // resembles the target's name is how namesakes sneak in.
        const simTarget = prof.displayName ? nameSimilarity(targetName, prof.displayName) : 0;
        if (prof.displayName && simTarget >= 0.78) {
          if (
            await recordTarget(platform, prof, {
              method: "opponent-archive",
              event: ev,
              // Only claim tournament membership if THIS game was in the link.
              link: viaLink && gameInLink(g, viaLink) ? viaLink : undefined,
              viaName: srcName,
              viaHandle: handle,
              game: g,
            })
          ) {
            found = true;
            return;
          }
        }
        // Map other roster members we happen to recognise (free BFS fuel).
        if (prof.displayName) {
          for (const m of roster) {
            if (m.uscfId === targetId || mapped.get(m.uscfId)?.has(platform)) continue;
            if (digits(prof.uscfId) && digits(prof.uscfId) !== m.uscfId) continue; // publishes someone else's USCF ID
            if (nameSimilarity(m.name, prof.displayName) >= 0.82) {
              setMapping(m.uscfId, platform, { profile: prof, how: "pairing", chain: mapping.chain.concat(srcName) });
              enqueue(state, { memberId: m.uscfId, platform, mapping: mapped.get(m.uscfId)!.get(platform)! });
              break;
            }
          }
        }
      },
      () => found || outOfTime(localDeadline)
    );
    return found;
  };

  // ---------------------------------------------------------------------------
  // The target via the Google index: search once, then test the leads against
  // EVERY event — the right username must have games inside the event's date
  // window; alignment with the target's own crosstable rounds, membership in
  // the event's linked platform tournament, or games against confirmed section
  // players then upgrade the lead into a confirmed match. A lead whose games
  // don't fit keeps the search going — never stop on an unverified result.
  // ---------------------------------------------------------------------------
  const googleTargetPassDone = new Set<string>(); // `${eventId}:${phase}`
  const googleTargetRejects = new Set<string>(); // hard rejects (FIDE mismatch)

  const tryGoogleTarget = async (
    ev: GraphEvent,
    state: EventState,
    platforms: OnlinePlatform[],
    localDeadline: number,
    phase: "early" | "late"
  ): Promise<boolean> => {
    if (!hooks.findUsernames) return false;
    const passKey = `${ev.eventId}:${phase}`;
    if (googleTargetPassDone.has(passKey)) return false;
    googleTargetPassDone.add(passKey);
    const app = (appearances.get(targetId) || []).find((a) => a.event.eventId === ev.eventId);
    if (!app) return false;

    const cands = await googleCandidatesFor(targetId, ev);
    if (!cands.length) {
      if (phase === "early") log(`The Google index has no username candidates for ${targetName} yet — proceeding with the tournament traversal.`);
      return false;
    }
    if (phase === "early") {
      log(`Google index produced ${cands.length} username lead(s) for ${targetName} — verifying each against "${ev.name}"'s dates…`);
    }

    // Both platforms are worked CONCURRENTLY (their verifications never
    // contend — different APIs); within each, candidates are still judged
    // strictly best-attribute-first.
    const platformHits = await Promise.all(
      platforms.map(async (platform): Promise<boolean> => {
        // Verify and attribute-score EVERY candidate first (real name, rating
        // offset, country, state/location, account age, activity), then work
        // the shortlist best-first — the first Google hit is often a namesake.
        const scored: { cand: UsernameCandidate; prof: VerifiedProfile; score: number }[] = [];
        await pool(
          candidatesForPlatform(cands, platform),
          VERIFY_POOL,
          async (cand) => {
            if (stopNow(localDeadline)) return;
            const rejectKey = `${platform}:${cand.username.toLowerCase()}`;
            if (googleTargetRejects.has(rejectKey)) return;
            const prof = await verifyOn(platform, cand.username);
            if (!prof) return;
            if (targetFideId && prof.fideId && digits(prof.fideId) !== targetFideId) {
              googleTargetRejects.add(rejectKey);
              log(`Google lead @${prof.username} links FIDE ID ${prof.fideId} — contradicts ${targetName}'s (${targetFideId}); rejected.`);
              return;
            }
            const attr = attributeMatch(targetName, effTargetRating, graph.rootState, prof, cand, app.startMs, app.endMs, targetId);
            if (!attr) {
              googleTargetRejects.add(rejectKey);
              log(
                `Google lead @${prof.username} is impossible for "${ev.name}" (created after it ended, or publishes a different USCF ID) — rejected.`
              );
              return;
            }
            scored.push({ cand, prof, score: attr.score });
          },
          () => stopNow(localDeadline)
        );
        scored.sort((a, b) => b.score - a.score);
        if (phase === "early" && scored.length) {
          log(
            `${targetName}: ${scored.length} Google lead(s) on ${platformLabel(platform)} — attribute scores: ${scored
              .slice(0, 4)
              .map((s) => `@${s.prof.username} ${Math.round(s.score * 100)}%`)
              .join(", ")}${scored.length > 4 ? ", …" : ""}.`
          );
        }

        // Prefetch the whole shortlist's window games in one burst, then judge
        // best-first — the exact same accept order as a serial scan.
        const shortlist = scored.filter((s) => s.score >= ATTR_SHORTLIST);
        for (const s of shortlist) void windowGames(platform, s.prof.username, app.startMs, app.endMs);

        for (const { cand, prof, score } of shortlist) {
          if (stopNow(localDeadline)) return false;
          const games = await windowGames(platform, prof.username, app.startMs, app.endMs);
          if (!games.length) {
            if (phase === "early") {
              log(
                `Google lead @${prof.username} (${Math.round(score * 100)}% attributes) played no ${platformLabel(
                  platform
                )} games during "${ev.name}" — not the right username for this event; continuing the search.`
              );
            }
            continue;
          }
          // The lead's own games can reveal the event's tournament link — free
          // fuel for the roster/elimination path even if the lead is wrong.
          for (const link of linksFromGames(games)) {
            if (!state.links.has(linkKey(link))) state.links.set(linkKey(link), link);
          }
          const { scoped, viaLink, viaTc } = scopeToEvent(games, state, platform, ev);
          const alignment = alignWithRetry(app.rounds, scoped, !!viaLink, platform);
          // Do the lead's in-window opponents include handles already proven to
          // be section players? Only CONFIRMED (mapped) section handles count —
          // "seen in another source's pool" is casual-noise-grade in link-less
          // events and must not settle an identity.
          const knownSectionHandles = new Set<string>();
          for (const p of ev.players) {
            const m = mapped.get(p.uscfId)?.get(platform);
            if (m) knownSectionHandles.add(m.profile.username.toLowerCase());
          }
          const overlap = scoped.filter((g) => knownSectionHandles.has(g.oppHandle.toLowerCase())).length;

          // An alignment is only PROOF when nearly every crosstable round's
          // result was verified against a game. A sparse match (observed live:
          // 4/6 over a namesake's casual pool) is exactly the outcome-checksum
          // coincidence alignRounds warns about — it stays a lead, not a match.
          const alignmentProof = !!alignment && alignment.checked >= app.rounds.length - 1;

          if (alignmentProof || viaLink || overlap > 0) {
            // Structural proof (round alignment / the linked tournament / games
            // against confirmed section players) settles it outright.
            if (
              await recordTarget(platform, prof, {
                method: "google",
                event: ev,
                link: viaLink,
                game: scoped[0] || games[0],
                checkedRounds: alignment?.checked,
                totalRounds: app.rounds.length,
                sourceUrl: cand.sourceUrl,
                sectionOverlap: overlap || undefined,
                attrScore: score,
              })
            )
              return true;
            continue;
          }
          // Games in the window but no structural tie yet: only an attribute
          // score past the acceptance bar earns a capped "lead" record; the late
          // phase re-tests once links and mapped handles are richer. An account
          // whose window games include NONE at the event's known time control is
          // most likely a namesake who merely played that day — no lead at all.
          const evTc = parseEventTc(ev.timeControl);
          if (evTc && !viaTc) {
            if (phase === "early") {
              log(
                `Google lead @${prof.username} has ${games.length} in-window game(s) but none at the event's ${evTc.label} control — not recording a lead.`
              );
            }
            continue;
          }
          if (score >= ATTR_ACCEPT) {
            await recordTarget(platform, prof, {
              method: "google-lead",
              event: ev,
              game: scoped[0] || games[0],
              sourceUrl: cand.sourceUrl,
              attrScore: score,
            });
          }
        }
        return false;
      })
    );
    return platformHits.some(Boolean);
  };

  // ---------------------------------------------------------------------------
  // Work one event to exhaustion (platform → roster → seeds → pairing BFS).
  // ---------------------------------------------------------------------------
  interface WorkState extends EventState {
    seedOrder: string[];
    platforms: OnlinePlatform[] | null;
    seedIdx: number;
    /** No seeds left and nothing queued — revisiting is pointless. */
    exhausted: boolean;
  }
  // Event work survives across passes: when the first sweep leaves budget on
  // the table, we come back and resume exactly where each event stopped.
  const workStates = new Map<string, WorkState>();

  const workEvent = async (ev: GraphEvent, localDeadline: number): Promise<boolean> => {
    const roster = ev.players;
    let ws = workStates.get(ev.eventId);
    if (ws?.exhausted) return false;
    const resuming = !!ws;
    if (!ws) {
      ws = {
        links: new Map(),
        junkLinks: new Set(),
        linkSources: new Map(),
        frontier: [],
        visited: new Set(),
        oppSeen: new Map(),
        seedOrder: [],
        platforms: null,
        seedIdx: 0,
        exhausted: false,
      };
      workStates.set(ev.eventId, ws);
    }
    const state: EventState = ws;

    // 1. Which platform hosted it?
    let platforms: OnlinePlatform[] = ws.platforms || [];
    const guess = (ev.platformGuess || "").toLowerCase();
    if (guess === "icc" || guess === "chesskid") {
      // No public game/tournament API on these — the event can't be traced.
      log(`"${ev.name}" was hosted on ${guess === "icc" ? "ICC" : "ChessKid"}, which has no public API — skipping it.`);
      ws.exhausted = true;
      return false;
    }
    if (!platforms.length && (guess === "chesscom" || guess === "lichess")) platforms = [guess as OnlinePlatform];

    /** Flyer/TLA web search → concrete links + platform hint for this event. */
    const collectFlyerLinks = async (): Promise<OnlinePlatform[]> => {
      if (!hooks.discoverPlatform) return [];
      log(`Searching the web for the flyer/announcement of "${ev.name}" to learn where it was hosted…`);
      const info = await discover(ev);
      if (!info) return [];
      for (const slug of info.chesscomSlugs || []) {
        const l: EventLink = { platform: "chesscom", kind: "chesscom-tournament", id: slug, source: "flyer" };
        state.links.set(linkKey(l), l);
      }
      for (const id of info.lichessSwissIds || []) {
        const l: EventLink = { platform: "lichess", kind: "lichess-swiss", id, source: "flyer" };
        state.links.set(linkKey(l), l);
      }
      for (const id of info.lichessArenaIds || []) {
        const l: EventLink = { platform: "lichess", kind: "lichess-arena", id, source: "flyer" };
        state.links.set(linkKey(l), l);
      }
      if (info.platform === "chesscom" || info.platform === "lichess") {
        log(`Web search says "${ev.name}" ran on ${platformLabel(info.platform)}${info.note ? ` (${info.note})` : ""}.`);
        return [info.platform];
      }
      return Array.from(new Set(Array.from(state.links.values()).map((l) => l.platform)));
    };

    if (!platforms.length && !outOfTime(localDeadline)) {
      const discovered = await collectFlyerLinks();
      if (discovered.length) platforms = discovered;
    }
    if (!platforms.length) platforms = ["chesscom", "lichess"];
    ws.platforms = platforms;

    // 2. Flyer-derived rosters first — they can end the search outright.
    {
      let rosterHit = false;
      await pool(
        Array.from(state.links.values()),
        3,
        async (link) => {
          if (rosterHit || stopNow(localDeadline)) return;
          if (await tryRoster(ev, link, localDeadline, state)) rosterHit = true;
        },
        () => rosterHit || stopNow(localDeadline)
      );
      if (rosterHit) return true;
    }

    // 2b. The target straight from the Google index — the cheapest possible
    // win. Every lead is verified against this event's date window before it
    // counts; unverified leads just keep the traversal going.
    if (await tryGoogleTarget(ev, state, platforms, localDeadline, "early")) return true;

    // 3. Free seeds: members already mapped (in other events, or since the last
    // visit here) who are in this section and haven't been traced yet.
    for (const p of roster) {
      const per = mapped.get(p.uscfId);
      if (!per) continue;
      for (const platform of platforms) {
        const m = per.get(platform);
        if (m && !state.visited.has(`${p.uscfId}:${platform}`)) enqueue(state, { memberId: p.uscfId, platform, mapping: m });
      }
    }

    const targetRounds = (appearances.get(targetId) || []).find((a) => a.event.eventId === ev.eventId)?.rounds || [];
    const oppHere = new Set(targetRounds.map((r) => r.opponentUscfId));
    if (!resuming) {
      // Seed candidate order: the target's direct opponents in THIS event, then
      // every other section player — each group sorted by NAME UNIQUENESS, so
      // "Ujwal Garine" (a sharp Google key) is worked before "John Smith"
      // (a swamp of namesakes).
      const byUniqueness = (a: string, b: string) => uniquenessOf(b) - uniquenessOf(a);
      ws.seedOrder = [
        ...roster.filter((p) => oppHere.has(p.uscfId)).map((p) => p.uscfId).sort(byUniqueness),
        ...roster.filter((p) => p.uscfId !== targetId && !oppHere.has(p.uscfId)).map((p) => p.uscfId).sort(byUniqueness),
      ].filter((id, i, arr) => arr.indexOf(id) === i);
      log(
        `Working "${ev.name}"${ev.sectionName ? ` — ${ev.sectionName}` : ""} (${ev.ratingSystem}${
          ev.startDate ? `, ${ev.startDate}` : ""
        }): ${roster.length} players, ${oppHere.size} direct opponents, platform ${platforms.map(platformLabel).join(" + ")}. Working the most unique names first.`
      );
    } else {
      log(`Back to "${ev.name}" with time to spare — resuming where we left off.`);
    }

    // 4. BFS run by parallel agents. No seed caps: every section player is
    // fair game until the event is genuinely exhausted. SEED SCOUTS resolve
    // section players (Google-first) continuously while PAIRING TRACERS drain
    // the frontier — a fresh mapping is traced the moment it lands, and the
    // frontier never starves waiting on a single slow seed.
    const order = [...platforms].sort((a, b) => (a === "chesscom" ? -1 : 0) - (b === "chesscom" ? -1 : 0));
    let eventFound = false;
    const stopEv = () => eventFound || stopNow(localDeadline);

    /** Next seed candidate still unmapped on some platform (consuming). */
    const nextSeedId = (): string | undefined => {
      while (ws.seedIdx < ws.seedOrder.length) {
        const id = ws.seedOrder[ws.seedIdx++];
        if (platforms.some((p) => !mapped.get(id)?.has(p))) return id;
      }
      return undefined;
    };
    /** Non-consuming peek: is there any seed candidate left at all? */
    const seedsRemain = (): boolean => {
      for (let j = ws.seedIdx; j < ws.seedOrder.length; j++) {
        if (platforms.some((p) => !mapped.get(ws.seedOrder[j])?.has(p))) return true;
      }
      return false;
    };

    const runAgents = async (seedScouts: boolean): Promise<boolean> => {
      let tracing = 0;
      let seeding = 0;
      const running = new Set<Promise<void>>();
      const launch = (task: () => Promise<void>) => {
        const p = task()
          .catch(() => {})
          .finally(() => void running.delete(p));
        running.add(p);
      };

      while (!stopEv()) {
        // Tracer agents: pull mapped sources off the frontier.
        while (tracing < TRACE_AGENTS && state.frontier.length && !stopEv()) {
          const src = state.frontier.shift()!;
          const vkey = `${src.memberId}:${src.platform}`;
          if (state.visited.has(vkey)) continue;
          state.visited.add(vkey);
          tracing++;
          launch(async () => {
            try {
              if (await traceFromSource(ev, state, src.memberId, src.platform, src.mapping, localDeadline)) eventFound = true;
            } finally {
              tracing--;
            }
          });
        }
        // Seed scouts: keep resolutions in flight (Google-first, sharpest
        // names first). When a finite deadline is set, keep a reserve for
        // TRACING the seeds we already have.
        if (seedScouts && !(isFinite(localDeadline) && localDeadline - Date.now() < 20_000)) {
          while (seeding < SEED_AGENTS && !stopEv()) {
            const memberId = nextSeedId();
            if (!memberId) break;
            seeding++;
            launch(async () => {
              try {
                // Chess.com first (fast, parallel-friendly); Lichess when it fails.
                for (const platform of order) {
                  if (stopEv()) return;
                  if (mapped.get(memberId)?.has(platform)) continue;
                  const prof = await resolveMemberOn(memberId, platform, ev, state, stopEv);
                  if (prof) {
                    setMapping(memberId, platform, { profile: prof, how: "seed", chain: [] });
                    enqueue(state, { memberId, platform, mapping: mapped.get(memberId)!.get(platform)! });
                    log(`Found ${platformLabel(platform)} @${prof.username} for section player ${memberName.get(memberId)} — tracing their event games…`);
                    return; // one platform is enough for a seed
                  }
                }
              } finally {
                seeding--;
              }
            });
          }
        }
        if (!running.size) {
          // Nothing in flight and nothing startable. If the event truly has
          // nothing left (vs. merely hitting the deadline reserve), mark it.
          if (seedScouts && !state.frontier.length && !seedsRemain()) ws.exhausted = true;
          break;
        }
        await Promise.race(running);
      }
      // Let in-flight agents finish (they observe the deadline themselves and
      // wind down fast) so a trace that was mid-flight when time ran out still
      // gets its result honored — exactly like the serial engine did.
      while (running.size) await Promise.all(Array.from(running));
      return eventFound;
    };

    if (await runAgents(true)) return true;

    // Last chance for this event: if the flyer search never ran (the platform
    // was already guessed), run it now — a flyer can hand us the exact
    // tournament page even when no seed could be resolved from names.
    if (!stopNow(localDeadline) && hooks.discoverPlatform && !discoverCache.has(ev.eventId)) {
      await collectFlyerLinks();
      let rosterHit = false;
      await pool(
        Array.from(state.links.values()),
        3,
        async (link) => {
          if (rosterHit || stopNow(localDeadline)) return;
          if (await tryRoster(ev, link, localDeadline, state)) rosterHit = true;
        },
        () => rosterHit || stopNow(localDeadline)
      );
      if (rosterHit) return true;
      // The roster may have mapped fresh sources — drain the pairing frontier.
      if (state.frontier.length && (await runAgents(false))) return true;
    }

    // Re-test the target's Google leads now that this event's links, rosters
    // and mapped section players are as rich as they will get.
    if (!outOfTime(localDeadline) && (await tryGoogleTarget(ev, state, platforms, localDeadline, "late"))) return true;
    return false;
  };

  // ---------------------------------------------------------------------------
  // Main loop: every online event, worked by a pool of EVENT AGENTS in the
  // most promising order — several events get the full treatment at once.
  // ---------------------------------------------------------------------------
  const events = [...graph.onlineEvents].sort((a, b) => {
    // Traceable platform first (icc/chesskid have no public API), then small
    // sections (rosters + elimination bite harder), then recency.
    const rank = (e: GraphEvent) => {
      const g = (e.platformGuess || "").toLowerCase();
      if (g === "chesscom" || g === "lichess") return 0;
      if (g === "icc" || g === "chesskid") return 2;
      return 1;
    };
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.players.length !== b.players.length) return a.players.length - b.players.length;
    return (b.startDate || "").localeCompare(a.startDate || "");
  });

  /** Fire the flyer/web search for upcoming unknown-platform events NOW so an
   *  event never has to sit and wait for it when its turn comes (memoized —
   *  this is the same search the event would run anyway). */
  const prefetchDiscover = (list: GraphEvent[], from: number, count: number) => {
    if (!hooks.discoverPlatform) return;
    for (let j = from; j < Math.min(list.length, from + count); j++) {
      const e = list[j];
      const g = (e.platformGuess || "").toLowerCase();
      if (g === "chesscom" || g === "lichess" || g === "icc" || g === "chesskid") continue;
      void discover(e);
    }
  };

  // The target's own Google-index search is the single highest-value lookup —
  // start it immediately so its leads are ready when the first event asks.
  if (hooks.findUsernames && events.length && (appearances.get(targetId) || []).length) {
    void googleCandidatesFor(targetId, events[0]);
  }

  const totalOpp = directOpponents.size;
  log(
    `Tournament-first search for ${targetName}: ${events.length} online event${events.length === 1 ? "" : "s"}, ${totalOpp} direct opponent${
      totalOpp === 1 ? "" : "s"
    } to work with — ${Math.min(EVENT_AGENTS, Math.max(1, events.length))} event agent(s), each running seed scouts and pairing tracers in parallel. Names resolve through the Google index and get date-verified; platform name search stays OFF unless the index has nothing.`
  );

  // TEST/DEBUG: pre-seed injected member→handle mappings (no-op in production).
  for (const s of opts.seedMappings || []) {
    if (s.memberId === targetId) continue; // never seed the target itself
    const prof = await verifyOn(s.platform, s.username);
    if (prof) {
      setMapping(s.memberId, s.platform, { profile: prof, how: "seed", chain: [] });
      log(`Injected seed: ${memberName.get(s.memberId) || s.memberId} → @${prof.username} (${platformLabel(s.platform)}).`);
    }
  }

  for (let pass = 0; pass < 4 && !found && !outOfTime(mainDeadline); pass++) {
    const pending = events.filter((e) => !workStates.get(e.eventId)?.exhausted);
    if (!pending.length) break;
    if (pass > 0) {
      const secsLeft = Math.round((mainDeadline - Date.now()) / 1000);
      log(
        `${pending.length} event(s) still have open leads — going back in${secsLeft < 3600 ? ` (${secsLeft}s left on the clock)` : ""}.`
      );
    }
    prefetchDiscover(pending, 0, EVENT_AGENTS + DISCOVER_LOOKAHEAD);
    let nextIdx = 0;
    const eventAgent = async () => {
      while (!found && !outOfTime(mainDeadline)) {
        const i = nextIdx++;
        if (i >= pending.length) return;
        prefetchDiscover(pending, i + EVENT_AGENTS, DISCOVER_LOOKAHEAD);
        const remaining = mainDeadline - Date.now();
        const batchesLeft = Math.max(1, Math.ceil((pending.length - i) / EVENT_AGENTS));
        const slice = Math.max(EVENT_MIN_MS, Math.floor(remaining / batchesLeft));
        if (await workEvent(pending[i], Math.min(mainDeadline, Date.now() + slice))) found = true;
        else if (!found && !outOfTime(mainDeadline) && pass === 0) log(`"${pending[i].name}" didn't give up the username yet — moving on for now.`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(EVENT_AGENTS, pending.length) }, eventAgent));
  }

  // ---------------------------------------------------------------------------
  // OPPONENT-PIVOT phase: the target's own account never fell out of their
  // events directly. Before any caller falls back to a platform name search
  // (the namesake trap), do what a careful human does by hand: rank the OTHER
  // players in the target's tournaments by how much online tournament history
  // of their OWN they have (most online events = most likely to have a
  // discoverable, well-connected account), resolve the strongest one's
  // username with the full engine, then read the target off the other side of
  // their shared event games. Direct opponents first (their games contain the
  // target directly); other section players second (their chains still reach
  // the target through the pairing frontier).
  // ---------------------------------------------------------------------------
  if (!found && depth === 0 && hooks.expandMember && deadline - Date.now() <= 35_000) {
    log(
      `No time left for the opponent-pivot stage (${Math.max(0, Math.round((deadline - Date.now()) / 1000))}s remaining) — a bigger budget would let it run.`
    );
  }
  if (!found && depth === 0 && hooks.expandMember && deadline - Date.now() > 35_000) {
    const deepStop = () => found || outOfTime() || deadline - Date.now() < 25_000;
    const RANK_WINDOW = 8; // graphs fetched per ranking window (MUIR-paced) — small enough that the first dives start fast

    /** Resolve one pivot candidate's own username, then trace shared events. */
    const divePivot = async (oppId: string, sub: TournamentGraph, ownEvents: number): Promise<void> => {
      const oppName = memberName.get(oppId) || "opponent";
      log(`Pivot: resolving ${oppName}'s own account first (${ownEvents} online event(s) of their own)…`);
      const subResult = await runGraphTraversal(sub, {
        targetName: oppName,
        targetRating: memberRating.get(oppId),
        signal,
        log,
        // Finding the username outranks the clock: a dive that has to chain
        // through the opponent's own opponents (no guessable seed anywhere)
        // regularly needs more than 5 minutes — observed live: a dive that
        // would have revealed the target's section was stood down at the old
        // 300s cap mid-chain.
        budgetMs: Math.min(600_000, Math.max(60_000, deadline - Date.now() - 15_000)),
        // Google-index + flyer search stay available; no further expansion.
        hooks: { discoverPlatform: hooks.discoverPlatform, findUsernames: hooks.findUsernames },
        depth: 1,
        shared,
        // The moment ANY pivot dive finds the real target, siblings stand down.
        stopWhen: () => found,
      });
      for (const acc of subResult.accounts) {
        if (found) break;
        // Only a structurally-proven account may pivot — a capped google-lead
        // is namesake-grade, and pivoting through it would launder that
        // uncertainty into "confirmed" pairing evidence for the target.
        if (acc.confidence < 0.7 || (acc.platform !== "chesscom" && acc.platform !== "lichess")) continue;
        const platform = acc.platform as OnlinePlatform;
        const prof = await verifyOn(platform, acc.username);
        if (!prof) continue;
        setMapping(oppId, platform, { profile: prof, how: "deep", chain: [] });
        // Trace the shared events from this hard-won seed.
        for (const app of appearances.get(oppId) || []) {
          if (found || outOfTime()) break;
          if (!(appearances.get(targetId) || []).some((ta) => ta.event.eventId === app.event.eventId)) continue;
          const state: EventState = { links: new Map(), junkLinks: new Set(), linkSources: new Map(), frontier: [], visited: new Set(), oppSeen: new Map() };
          if (await traceFromSource(app.event, state, oppId, platform, mapped.get(oppId)!.get(platform)!, deadline)) found = true;
          // Follow any frontier the trace opened up.
          while (!found && state.frontier.length && !outOfTime()) {
            const nxt = state.frontier.shift()!;
            const vkey = `${nxt.memberId}:${nxt.platform}`;
            if (state.visited.has(vkey)) continue;
            state.visited.add(vkey);
            if (await traceFromSource(app.event, state, nxt.memberId, nxt.platform, nxt.mapping, deadline)) found = true;
          }
        }
      }
    };

    /** Rank a candidate ring by REAL online volume (own graphs, windowed so a
     *  long list doesn't fetch everything before the first dive), dive best
     *  first. */
    const pivotRing = async (candidates: string[], ring: string): Promise<void> => {
      for (let w = 0; w < candidates.length && !deepStop(); w += RANK_WINDOW) {
        const windowIds = candidates.slice(w, w + RANK_WINDOW);
        const graphs = new Map<string, TournamentGraph | null>();
        await pool(
          windowIds,
          DEEP_AGENTS,
          async (id) => {
            if (deepStop()) return;
            const g = await hooks.expandMember!(id).catch(() => null);
            graphs.set(id, g);
            // Narrate each fetch: the ranking window can take a while (MUIR
            // paced) and a silent stretch reads as a wedged engine upstream.
            log(
              `Pivot: ${memberName.get(id) || id} has ${g?.onlineEvents.length || 0} online event(s) of their own${
                g?.onlineEvents.length ? "" : " — not a useful pivot"
              }.`
            );
          },
          deepStop
        );
        const ranked = windowIds
          .map((id) => {
            const g = graphs.get(id) || null;
            const events = g?.onlineEvents.length || 0;
            const rounds = g
              ? g.onlineEvents.reduce(
                  (n, e) => n + e.players.reduce((m, p) => (p.uscfId === id ? m + p.games.length : m), 0),
                  0
                )
              : 0;
            return { id, g, events, rounds };
          })
          .filter((r): r is typeof r & { g: TournamentGraph } => !!r.g && r.events > 0)
          .sort((a, b) => b.events - a.events || b.rounds - a.rounds);
        if (!ranked.length) continue;
        log(
          `Pivot ranking (${ring}): ${ranked
            .slice(0, 5)
            .map((r) => `${memberName.get(r.id) || r.id} — ${r.events} event(s)/${r.rounds} game(s)`)
            .join("; ")}${ranked.length > 5 ? "; …" : ""} — working the best-connected first.`
        );
        await pool(
          ranked,
          DEEP_AGENTS,
          async ({ id, g, events }) => {
            if (deepStop()) return;
            await divePivot(id, g, events);
          },
          deepStop
        );
      }
    };

    // Ring 1: unresolved direct opponents — their own games name the target.
    const ring1 = Array.from(directOpponents)
      .filter((id) => !mapped.has(id))
      .sort((a, b) => (appearances.get(b)?.length || 0) - (appearances.get(a)?.length || 0));
    if (ring1.length) {
      log(
        `Still nothing — pivoting through ${targetName}'s opponents: ranking ${ring1.length} unresolved direct opponent(s) by their own online tournament history.`
      );
      await pivotRing(ring1, "direct opponents");
    }
    // Ring 2: other unresolved section players (bounded) — their chains reach
    // the target through the shared-event pairing frontier. Only when the
    // direct ring genuinely exhausted with time to spare.
    if (!found && !deepStop() && deadline - Date.now() > 60_000) {
      const ring2 = Array.from(memberName.keys())
        .filter((id) => id !== targetId && !directOpponents.has(id) && !mapped.has(id))
        .sort((a, b) => (appearances.get(b)?.length || 0) - (appearances.get(a)?.length || 0))
        .slice(0, 24);
      if (ring2.length) {
        log(`Direct-opponent pivots exhausted — extending the pivot to ${ring2.length} other section player(s).`);
        await pivotRing(ring2, "section players");
      }
    }
  }

  accounts.sort((a, b) => b.confidence - a.confidence);
  const mappedOpponents = Array.from(mapped.values()).filter((per) => per.size > 0).length;
  if (accounts.length) {
    notes.push(`Traced ${accounts.length} online account(s) through the tournament graph.`);
  } else if (mappedOpponents > 0) {
    // We proved out N of the target's opponents' accounts but never closed the
    // last hop to the target — say so plainly rather than fall silent.
    notes.push(
      `Resolved ${mappedOpponents} of ${targetName}'s tournament opponent(s) to online accounts, but none of their games named ${targetName}'s own handle — their account may be on an untraceable platform (e.g. ChessKid) or a second account.`
    );
    if (depth === 0) log(`Mapped ${mappedOpponents} of ${targetName}'s opponents but couldn't confirm ${targetName}'s own account from their games.`);
  } else if (outOfTime() && !signal?.aborted) {
    notes.push("Tournament-graph traversal reached its time budget without a confident online match.");
    log("Reached the time budget — every avenue tried so far came up empty.");
  } else {
    notes.push("Exhausted the tournament graph; no online username could be traced from any event.");
    if (depth === 0) log("Exhausted every online event without a confident match.");
  }

  return { accounts, notes, found: accounts.length > 0, mappedOpponents };
}
