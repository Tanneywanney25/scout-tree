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

/** Generate plausible Chess.com/Lichess handles from a real name. */
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
    add(`${first}${last}1`);
    add(`${first}${last}chess`);
    add(`${last}${first[0]}`);
  }
  add(clean.replace(/\s/g, ""));
  if (first) add(first);
  if (last) add(last);
  return Array.from(g).slice(0, 11);
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

function chesscomOutcome(myResult?: string, oppResult?: string): Outcome | undefined {
  if (myResult === "win") return "w";
  if (oppResult === "win") return "l";
  if (myResult && CC_DRAW_CODES.has(myResult)) return "d";
  return undefined;
}

/** One player's full Chess.com archive for one month, memoized in `cache` so
 *  overlapping event windows never refetch the same month. A failed month is
 *  evicted from the cache (a later window gets a fresh chance) — a silently
 *  cached miss would break pairing chains. */
function chesscomMonthGames(
  username: string,
  y: number,
  m: number,
  cache: Map<string, Promise<ArchiveGame[]>>,
  signal?: AbortSignal
): Promise<ArchiveGame[]> {
  const uLower = username.toLowerCase();
  const key = `${uLower}:${y}:${m}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async (): Promise<ArchiveGame[]> => {
    try {
      const res = await politeFetch(
        `https://api.chess.com/pub/player/${uLower}/games/${y}/${String(m).padStart(2, "0")}`,
        { headers: { Accept: "application/json" }, signal },
        "chesscom",
        20_000
      );
      if (!res.ok) {
        if (res.status !== 404) cache.delete(key);
        return [];
      }
      const data = await res.json();
      const out: ArchiveGame[] = [];
      for (const g of Array.isArray(data.games) ? data.games : []) {
        const endT = (g.end_time || 0) * 1000;
        const wU = g.white?.username?.toLowerCase();
        const sourceColor: "white" | "black" = wU === uLower ? "white" : "black";
        const me = sourceColor === "white" ? g.white : g.black;
        const them = sourceColor === "white" ? g.black : g.white;
        const opp = them?.username;
        if (!opp || opp.toLowerCase() === uLower) continue;
        out.push({
          oppHandle: opp,
          sourceColor,
          sourceOutcome: chesscomOutcome(me?.result, them?.result),
          endMs: endT,
          rated: g.rated !== false,
          timeClass: g.time_class,
          url: g.url,
          chesscomTournament: typeof g.tournament === "string" ? g.tournament : undefined,
        });
      }
      return out;
    } catch {
      cache.delete(key);
      return [];
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
  signal?: AbortSignal
): Promise<ArchiveGame[]> {
  const months = monthsBetween(startMs, endMs);
  const perMonth = await Promise.all(months.map(({ y, m }) => chesscomMonthGames(username, y, m, monthCache, signal)));
  return perMonth
    .flat()
    .filter((g) => g.endMs >= startMs && g.endMs <= endMs)
    .sort((a, b) => a.endMs - b.endMs);
}

/** Lichess: pull games in the [since, until] window as NDJSON. */
async function lichessWindowGames(username: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<ArchiveGame[]> {
  const uLower = username.toLowerCase();
  const out: ArchiveGame[] = [];
  try {
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?since=${Math.floor(startMs)}&until=${Math.ceil(
      endMs
    )}&max=300&pgnInJson=false&clocks=false&evals=false&opening=false`;
    // politeFetch paces the call and retries 429s with hard backoff — a 429
    // means "slow down", never "no games"; losing games here silently breaks
    // the traversal.
    const res = await politeFetch(url, { headers: { Accept: "application/x-ndjson" }, signal }, "lichess", 20_000);
    if (!res.ok) return out;
    const text = await res.text();
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
        // Current exports use swissTour/arenaTour objects; older ones used
        // flat swiss/tournament id strings. Accept both.
        lichessSwiss: g.swissTour?.id || (typeof g.swiss === "string" ? g.swiss : undefined),
        lichessArena: g.arenaTour?.id || (typeof g.tournament === "string" ? g.tournament : undefined),
      });
    }
  } catch {
    /* rate-limited or blocked — degrade */
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
}

export function makeSharedCaches(): SharedCaches {
  return { verify: new Map(), games: new Map(), ccMonths: new Map(), google: new Map() };
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
}

export interface TraversalResult {
  accounts: DiscoveredAccount[];
  notes: string[];
  /** Whether at least one online account was traced back to the target. */
  found: boolean;
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
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
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
  const appearances = new Map<string, Appearance[]>();
  for (const ev of graph.onlineEvents) {
    const { startMs, endMs } = windowFor(ev);
    for (const p of ev.players) {
      if (!memberName.has(p.uscfId)) memberName.set(p.uscfId, p.name);
      if (p.rating && !memberRating.has(p.uscfId)) memberRating.set(p.uscfId, p.rating);
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
  const windowGames = (platform: OnlinePlatform, handle: string, startMs: number, endMs: number): Promise<ArchiveGame[]> => {
    const key = `${platform}:${handle.toLowerCase()}:${Math.round(startMs / DAY)}:${Math.round(endMs / DAY)}`;
    const hit = gamesCache.get(key);
    if (hit) return hit;
    const p =
      platform === "chesscom"
        ? chesscomWindowGames(handle, startMs, endMs, shared.ccMonths, signal)
        : lichessWindowGames(handle, startMs, endMs, signal);
    gamesCache.set(key, p);
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
  const setMapping = (memberId: string, platform: OnlinePlatform, m: Mapping) => {
    const per = mapped.get(memberId) || new Map<OnlinePlatform, Mapping>();
    if (!per.has(platform)) per.set(platform, m);
    mapped.set(memberId, per);
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
      state: memberId === targetId ? graph.rootState : undefined,
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

  /** null = hard reject: the account was created after the event ended. */
  const attributeMatch = (
    name: string,
    rating: number | undefined,
    state: string | undefined,
    prof: VerifiedProfile,
    viaGoogle: UsernameCandidate | null,
    startMs: number,
    endMs: number
  ): AttrResult | null => {
    if (prof.joinedMs && prof.joinedMs > endMs + DAY) return null;
    const evi: Evidence[] = [];
    const push = (weight: number, label: string) =>
      evi.push({ kind: "cross-reference", weight, label, source: "uscf-graph" });

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
    if (prof.country) {
      const isUs = prof.country.trim().slice(-2).toUpperCase() === "US";
      push(isUs ? 0.3 : -0.5, isUs ? "Profile country US matches US Chess" : `Profile country ${prof.country} for a US Chess member`);
    }
    if (state && prof.location && locationMatchesState(prof.location, state)) {
      push(0.6, `Profile location "${prof.location}" matches ${state}`);
    }
    if (!prof.gamesFound) push(-0.8, "Account has no games at all");
    if (prof.lastActiveMs && prof.lastActiveMs < startMs) {
      push(-1.0, "Account went inactive before the event even started");
    }
    return { score: scoreFromEvidence(evi, 0), evidence: evi };
  };

  /** Scope archive games to an event: the best-fitting known tournament link,
   *  else the event's expected time classes.
   *
   *  A games-derived "link" is only the event if the player played SEVERAL of
   *  their games there. A single game tagged with a tournament id is almost
   *  always a giant public arena the player dipped into once (empirically: a
   *  "1|0 Bullet" arena of 25 strangers matched a 26-player scholastic
   *  crosstable at 0 overlap) — scoping to it strands the real games. So we pick
   *  the platform link that explains the MOST of the player's games and only
   *  trust a games-derived link that carries ≥2 of them; a flyer-sourced link is
   *  the event by construction and is trusted even at one game. */
  const scopeToEvent = (
    games: ArchiveGame[],
    links: Map<string, EventLink> | undefined,
    platform: OnlinePlatform,
    ev: GraphEvent
  ): { scoped: ArchiveGame[]; viaLink?: EventLink } => {
    if (links) {
      let best: { link: EventLink; inLink: ArchiveGame[] } | null = null;
      for (const link of links.values()) {
        if (link.platform !== platform) continue;
        const inLink = games.filter((g) => gameInLink(g, link));
        if (inLink.length && (!best || inLink.length > best.inLink.length)) best = { link, inLink };
      }
      if (best && (best.link.source === "flyer" || best.inLink.length >= 2)) {
        return { scoped: best.inLink, viaLink: best.link };
      }
    }
    // Manually-paired USCF events were usually played as UNRATED casual
    // challenges, so don't require rated — the time class is the useful filter.
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
    state?: EventState
  ): Promise<VerifiedProfile | null> => {
    const key = `${memberId}:${platform}:${ev.eventId}`;
    const hit = seedCache.get(key);
    if (hit) return hit;
    const name = memberName.get(memberId) || "";
    const promise = (async (): Promise<VerifiedProfile | null> => {
      if (!name || memberId === targetId) return null;
      const app = (appearances.get(memberId) || []).find((a) => a.event.eventId === ev.eventId);
      const win = app ?? { startMs: windowFor(ev).startMs, endMs: windowFor(ev).endMs, rounds: [] as RoundGame[] };

      // 1. PRIMARY: the Google index — never settle for the first hit.
      const leads = candidatesForPlatform(await googleCandidatesFor(memberId, ev), platform);
      if (leads.length && !stopNow()) {
        const scored: { cand: UsernameCandidate; prof: VerifiedProfile; score: number }[] = [];
        await pool(
          leads,
          VERIFY_POOL,
          async (cand) => {
            if (stopNow()) return;
            if (dudHandles.has(`${platform}:${cand.username.toLowerCase()}`)) return;
            const prof = await verifyOn(platform, cand.username);
            if (!prof || dudHandles.has(`${platform}:${prof.username.toLowerCase()}`)) return;
            const attr = attributeMatch(name, memberRating.get(memberId), undefined, prof, cand, win.startMs, win.endMs);
            if (!attr) return; // account created after the event — impossible
            scored.push({ cand, prof, score: attr.score });
          },
          () => stopNow()
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
        for (const { prof, score } of shortlist) {
          if (stopNow()) break;
          const games = await windowGames(platform, prof.username, win.startMs, win.endMs);
          if (!games.length) {
            log(
              `Google lead @${prof.username} (${name}, ${Math.round(score * 100)}% attributes) played no ${platformLabel(
                platform
              )} games during "${ev.name}" — wrong account for this event; trying the next lead.`
            );
            continue;
          }
          // Crosstable check: do the in-window games line up with the member's
          // actual rounds (result sequence + tournament linkage)?
          const { scoped, viaLink } = scopeToEvent(games, state?.links, platform, ev);
          const alignment = app ? alignWithRetry(app.rounds, scoped, !!viaLink, platform) : null;
          if (alignment) {
            log(
              `Google index: ${name} → @${prof.username} (${platformLabel(platform)}) — ${Math.round(
                score * 100
              )}% attributes AND their event games align with the crosstable.`
            );
            return prof;
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
      // Every guess is verified CONCURRENTLY, then judged in guess order —
      // deterministic: the same handle wins as in a serial scan.
      const gate = (prof: VerifiedProfile): boolean =>
        !!prof.displayName && nameSimilarity(name, prof.displayName) >= 0.72;
      const guesses = guessHandles(name).filter((h) => !dudHandles.has(`${platform}:${h.toLowerCase()}`));
      const guessProfs = new Map<string, VerifiedProfile | null>();
      await pool(
        guesses,
        6,
        async (h) => {
          if (stopNow()) return;
          guessProfs.set(h, await verifyOn(platform, h));
        },
        () => stopNow()
      );
      for (const h of guesses) {
        const prof = guessProfs.get(h);
        if (prof && gate(prof) && !dudHandles.has(`${platform}:${prof.username.toLowerCase()}`)) return prof;
      }
      if (platform === "lichess" && !stopNow()) {
        // Lichess offers autocomplete — still only a SEED finder for opponents.
        const t = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
        const terms = new Set<string>();
        if (t.length >= 2) terms.add(`${t[0]}${t[t.length - 1]}`.slice(0, 20));
        const last = t[t.length - 1];
        if (last && last.length >= 4) terms.add(last);
        for (const term of terms) {
          if (stopNow()) return null;
          const handles = (await lichessAutocomplete(term, signal)).slice(0, 5).filter((h) => !dudHandles.has(`lichess:${h.toLowerCase()}`));
          const acProfs = new Map<string, VerifiedProfile | null>();
          await pool(
            handles,
            4,
            async (h) => {
              if (stopNow()) return;
              acProfs.set(h, await verifyOn("lichess", h));
            },
            () => stopNow()
          );
          for (const h of handles) {
            const prof = acProfs.get(h);
            if (prof && prof.displayName && nameSimilarity(name, prof.displayName) >= 0.78) return prof;
          }
        }
      }
      return null;
    })();
    seedCache.set(key, promise);
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
  }

  const foundKeys = new Set<string>();

  const recordTarget = (platform: OnlinePlatform, profile: VerifiedProfile, via: FoundVia): boolean => {
    // FIDE-ID gate: a linked FIDE ID that contradicts the target's rejects the
    // candidate outright; a match is near-decisive.
    if (targetFideId && profile.fideId && digits(profile.fideId) !== targetFideId) {
      log(`Rejected @${profile.username}: profile links FIDE ID ${profile.fideId}, but ${targetName}'s is ${targetFideId}.`);
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
          weight: graphDiscoveryWeight(true, 1),
          label: `Round ${via.round}: the crosstable pairs ${targetName} with ${via.viaName}, and @${via.viaHandle}'s game that round was against @${profile.username}`,
          source: "uscf-graph",
        });
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
          label: `Has games during "${ev.name}" but none could be tied to the event itself yet`,
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
    // must not be sunk by a missing/whimsical display name).
    if (via.method === "pairing" || via.method === "elimination" || via.method === "google" || via.method === "google-lead") {
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
    if (effTargetRating && profile.uscfRating && Math.abs(profile.uscfRating - effTargetRating) <= 200) {
      evidence.push({
        kind: "cross-reference",
        weight: 0.8,
        label: `Profile lists USCF rating ${profile.uscfRating} (target ~${effTargetRating})`,
        source: "uscf-graph",
      });
    }
    // Country sanity: a USCF (US federation) member's account normally flies a
    // US flag or none at all — a different flag is a mild strike, never fatal
    // (dual-federation players exist).
    if (profile.country) {
      const isUs = profile.country.trim().slice(-2).toUpperCase() === "US";
      evidence.push({
        kind: "country-match",
        weight: isUs ? 0.3 : -0.35,
        label: isUs
          ? "Profile country US matches the US Chess federation"
          : `Profile lists country ${profile.country} for a US Chess member`,
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
      confidence: scoreFromEvidence(evidence, -0.5),
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
    const key = `${ev.eventId}|${linkKey(link)}`;
    if (rosterTried.has(key)) return false;
    rosterTried.add(key);

    const handles = await fetchRoster(link, signal);
    if (!handles.length) return false;
    const roster = ev.players.map((p) => ({ uscfId: p.uscfId, name: p.name }));
    log(
      `"${ev.name}" is linked to a ${platformLabel(link.platform)} ${
        link.kind === "chesscom-tournament" ? "tournament" : link.kind.replace("lichess-", "")
      } with ${handles.length} participants — matching them to the ${roster.length}-player crosstable…`
    );

    const memberClaimed = new Set<string>();
    const handleClaimed = new Set<string>();
    // Seed the bookkeeping with mappings we already trust.
    for (const [mid, per] of mapped) {
      const m = per.get(link.platform);
      if (m && handles.some((h) => h.toLowerCase() === m.profile.username.toLowerCase())) {
        memberClaimed.add(mid);
        handleClaimed.add(m.profile.username.toLowerCase());
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
        if (best.uscfId === targetId) {
          if (recordTarget(link.platform, prof, { method: "roster-name", event: ev, link })) rosterHit = true;
          return;
        }
        memberClaimed.add(best.uscfId);
        handleClaimed.add(handle.toLowerCase());
        setMapping(best.uscfId, link.platform, { profile: prof, how: "roster", chain: [] });
        // Roster-matched members are prime pairing-BFS fuel.
        if (state) enqueue(state, { memberId: best.uscfId, platform: link.platform, mapping: mapped.get(best.uscfId)!.get(link.platform)! });
      },
      () => rosterHit || stopNow(localDeadline)
    );
    if (rosterHit) return true;

    // Elimination: every crosstable player except the target matched a
    // participant, and exactly one participant handle is unclaimed.
    const unmatchedMembers = roster.filter((m) => m.uscfId !== targetId && !memberClaimed.has(m.uscfId));
    const unclaimed = handles.filter((h) => !handleClaimed.has(h.toLowerCase()));
    if (unmatchedMembers.length === 0 && unclaimed.length === 1) {
      const prof = await verifyOn(link.platform, unclaimed[0]);
      if (prof && recordTarget(link.platform, prof, { method: "elimination", event: ev, link })) return true;
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
    frontier: { memberId: string; platform: OnlinePlatform; mapping: Mapping }[];
    visited: Set<string>;
    /** How many sources' event-scoped games each opponent handle appeared in —
     *  a handle seen from several section players is almost surely a section
     *  player itself, so it gets verified first. */
    oppSeen: Map<string, number>;
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
        mapped.get(memberId)?.delete(platform);
        if (directOpponents.has(memberId)) {
          state.seedOrder?.push(memberId);
          log(`Retrying ${srcName} with their remaining Google leads and handle guesses…`);
        }
      }
      return false;
    }

    // (a) New tournament linkage revealed by the source's games? A link the
    // source played only ONE game in is almost always a public arena they
    // dipped into once, not the USCF event — registering it (and worse, fetching
    // its whole roster to name-match) burns the budget on strangers. Only chase
    // a games-derived link the source actually played several games in.
    for (const link of linksFromGames(games)) {
      if (outOfTime(localDeadline)) break;
      if (state.links.has(linkKey(link))) continue;
      state.links.set(linkKey(link), link);
      if (games.filter((g) => gameInLink(g, link)).length < 2) continue;
      if (await tryRoster(ev, link, localDeadline, state)) return true;
    }

    // (b) Pairing alignment: source's crosstable rounds ↔ event-scoped games.
    const { scoped, viaLink } = scopeToEvent(games, state.links, platform, ev);
    const alignment = alignWithRetry(app.rounds, scoped, !!viaLink, platform);
    if (!alignment && app.rounds.length) {
      log(
        `Couldn't align @${handle}'s ${scoped.length} in-window game(s) with ${srcName}'s ${app.rounds.length} crosstable rounds${
          viaLink ? " (tournament-scoped)" : ""
        } — relying on roster and name evidence instead.`
      );
    }
    if (alignment) {
      log(
        `Aligned @${handle}'s ${alignment.pairs.length} event games to ${srcName}'s crosstable rounds (${alignment.checked} results verified) — reading the other side of each board…`
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
              recordTarget(platform, prof, {
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
              })
            )
              pairingHit = true;
            return;
          }
          if (!mapped.get(oppId)?.has(platform)) {
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
            recordTarget(platform, prof, {
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
            const attr = attributeMatch(targetName, effTargetRating, graph.rootState, prof, cand, app.startMs, app.endMs);
            if (!attr) {
              googleTargetRejects.add(rejectKey);
              log(`Google lead @${prof.username} was created after "${ev.name}" ended — impossible; rejected.`);
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
          const { scoped, viaLink } = scopeToEvent(games, state.links, platform, ev);
          const alignment = alignWithRetry(app.rounds, scoped, !!viaLink, platform);
          // Do the lead's in-window opponents include handles already proven to
          // be section players?
          const knownSectionHandles = new Set<string>();
          for (const p of ev.players) {
            const m = mapped.get(p.uscfId)?.get(platform);
            if (m) knownSectionHandles.add(m.profile.username.toLowerCase());
          }
          const overlap = scoped.filter(
            (g) => knownSectionHandles.has(g.oppHandle.toLowerCase()) || (state.oppSeen.get(g.oppHandle.toLowerCase()) || 0) > 0
          ).length;

          if (alignment || viaLink || overlap > 0) {
            // Structural proof (round alignment / the linked tournament / games
            // against confirmed section players) settles it outright.
            if (
              recordTarget(platform, prof, {
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
          // phase re-tests once links and mapped handles are richer.
          if (score >= ATTR_ACCEPT) {
            recordTarget(platform, prof, {
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
                  const prof = await resolveMemberOn(memberId, platform, ev, state);
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

  for (let pass = 0; pass < 4 && !found && !outOfTime(); pass++) {
    const pending = events.filter((e) => !workStates.get(e.eventId)?.exhausted);
    if (!pending.length) break;
    if (pass > 0) {
      const secsLeft = Math.round((deadline - Date.now()) / 1000);
      log(
        `${pending.length} event(s) still have open leads — going back in${secsLeft < 3600 ? ` (${secsLeft}s left on the clock)` : ""}.`
      );
    }
    prefetchDiscover(pending, 0, EVENT_AGENTS + DISCOVER_LOOKAHEAD);
    let nextIdx = 0;
    const eventAgent = async () => {
      while (!found && !outOfTime()) {
        const i = nextIdx++;
        if (i >= pending.length) return;
        prefetchDiscover(pending, i + EVENT_AGENTS, DISCOVER_LOOKAHEAD);
        const remaining = deadline - Date.now();
        const batchesLeft = Math.max(1, Math.ceil((pending.length - i) / EVENT_AGENTS));
        const slice = Math.max(EVENT_MIN_MS, Math.floor(remaining / batchesLeft));
        if (await workEvent(pending[i], Math.min(deadline, Date.now() + slice))) found = true;
        else if (!found && !outOfTime() && pass === 0) log(`"${pending[i].name}" didn't give up the username yet — moving on for now.`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(EVENT_AGENTS, pending.length) }, eventAgent));
  }

  // ---------------------------------------------------------------------------
  // Deep phase: recurse into direct opponents' own online histories — several
  // opponents expanded AT ONCE, each sub-traversal reusing the search-wide
  // fetch caches so nothing already verified or downloaded is fetched again.
  // ---------------------------------------------------------------------------
  if (!found && depth === 0 && hooks.expandMember && deadline - Date.now() > 35_000) {
    // Every unmapped direct opponent is worth a deep dive — most-present first.
    const oppByPresence = Array.from(directOpponents)
      .filter((id) => !mapped.has(id))
      .sort((a, b) => (appearances.get(b)?.length || 0) - (appearances.get(a)?.length || 0));
    if (oppByPresence.length) {
      log(
        `Still nothing — going deeper: exploring ${oppByPresence.length} opponents' own tournament histories (${DEEP_AGENTS} at a time) to pin their usernames first.`
      );
    }
    const deepStop = () => found || outOfTime() || deadline - Date.now() < 25_000;
    await pool(
      oppByPresence,
      DEEP_AGENTS,
      async (oppId) => {
        if (deepStop()) return;
        const oppName = memberName.get(oppId) || "opponent";
        const sub = await hooks.expandMember!(oppId).catch(() => null);
        if (!sub || !sub.onlineEvents.length || deepStop()) return;
        log(`Deep dive: ${oppName} played ${sub.onlineEvents.length} online event(s) of their own — tracing those…`);
        const subResult = await runGraphTraversal(sub, {
          targetName: oppName,
          targetRating: memberRating.get(oppId),
          signal,
          log,
          budgetMs: Math.min(300_000, Math.max(60_000, deadline - Date.now() - 15_000)),
          // Google-index + flyer search stay available; no further expansion.
          hooks: { discoverPlatform: hooks.discoverPlatform, findUsernames: hooks.findUsernames },
          depth: 1,
          shared,
          // The moment ANY deep dive finds the real target, siblings stand down.
          stopWhen: () => found,
        });
        for (const acc of subResult.accounts) {
          if (found) break;
          if (acc.confidence < 0.5 || (acc.platform !== "chesscom" && acc.platform !== "lichess")) continue;
          const platform = acc.platform as OnlinePlatform;
          const prof = await verifyOn(platform, acc.username);
          if (!prof) continue;
          setMapping(oppId, platform, { profile: prof, how: "deep", chain: [] });
          // Trace the shared events from this hard-won seed.
          for (const app of appearances.get(oppId) || []) {
            if (found || outOfTime()) break;
            if (!(appearances.get(targetId) || []).some((ta) => ta.event.eventId === app.event.eventId)) continue;
            const state: EventState = { links: new Map(), frontier: [], visited: new Set(), oppSeen: new Map() };
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
      },
      deepStop
    );
  }

  accounts.sort((a, b) => b.confidence - a.confidence);
  if (accounts.length) {
    notes.push(`Traced ${accounts.length} online account(s) through the tournament graph.`);
  } else if (outOfTime() && !signal?.aborted) {
    notes.push("Tournament-graph traversal reached its time budget without a confident online match.");
    log("Reached the time budget — every avenue tried so far came up empty.");
  } else {
    notes.push("Exhausted the tournament graph; no online username could be traced from any event.");
    if (depth === 0) log("Exhausted every online event without a confident match.");
  }

  return { accounts, notes, found: accounts.length > 0 };
}
