// ============================================================================
// School-based identity resolution — the social-graph engine.
//
// The fallback for a player with ZERO online USCF tournament history, where the
// tournament-graph engine has nothing to trace. It reconstructs the player's
// online account from their SCHOOL's social graph:
//
//   1. SCHOOL — resolve the target's school (NWSRS / state assns / registration
//      / LinkedIn / web) via injected hooks (server-backed; see school.ts).
//   2. COHORT — pull that school's roster and resolve the schoolmates to online
//      handles the SAME way the main engine resolves a player it has a USCF ID
//      for: look the schoolmate's USCF ID up by name + state (the public
//      ratings search), then run the identity engine's tournament-graph
//      traversal on that ID. Google-index username search + live verification
//      remains the fallback for mates the USCF route can't resolve. These are
//      the "known-school players the engine has already resolved".
//   3. SOCIAL GRAPH — for each resolved schoolmate, gather who they are
//      connected to, from three public/member-public signals:
//        • FRIENDS — chess.com's friends list (member-public; fetched through a
//          server hook with a session, since the endpoint needs auth and is
//          CORS-blocked from the browser). The strongest signal when available.
//        • GAME OVERLAP — their frequent opponents in public game archives.
//          A schoolmate's habitual opponents are, in practice, their friends /
//          clubmates. Fully public, keyless — the always-on default.
//        • CLUBS/TEAMS — chess.com clubs / lichess teams they share.
//   4. IDENTIFY — the account connected to MULTIPLE schoolmates (or dominating
//      one schoolmate's play) is the lead. Verify it, then confirm with rating
//      proximity, US/state location, cross-platform handle consistency and —
//      decisively — a federation-ID cross-check (a USCF/FIDE id published on the
//      candidate's profile that matches the target's). A high bar keeps this
//      from ever crowning the wrong same-cohort player.
//
// Dependency-light on purpose (net.ts / verify.ts / confidence.ts / cache.ts
// and two pure helpers from uscfGraphEngine.ts), so it runs in the browser,
// the Node CLI harness and tests alike — same discipline as uscfGraphEngine.ts.
// All the CORS-friendly platform work (archives, clubs, verification) happens
// here directly; the two things that need a server (school lookup,
// authenticated friends) come in as hooks.
//
// SPEED: schoolmate resolution is where the school fallback used to burn its
// minutes, so it now runs cheapest-first per mate — the search-wide
// resolved-identity cache, then a quick real-name guess-and-verify probe on
// Chess.com, and only then the full 60s tournament trace — with FOUR mates in
// flight (the global chess.com gate / edge-side MUIR throttle bound the actual
// request rate). The cohort archive crawl reuses the SAME memoized Chess.com
// months the traversals fill, fetched a few months at a time instead of one by
// one.
// ============================================================================

import type { DiscoveredAccount, Evidence, Platform } from "./types";
import type {
  OnlinePlatform,
  SchoolAffiliation,
  Schoolmate,
  SchoolLookupRequest,
} from "./schoolTypes";
import type { UsernameSearchRequest, UsernameCandidate, GraphEvent } from "./graphTypes";
import { politeFetch, pool } from "./net";
import type { Conductor } from "./conductor";
import { verifyChesscom, verifyLichess, type VerifiedProfile } from "./verify";
import { sharedChesscomMonthGames } from "./uscfGraphEngine";
import { getSharedTraversalCaches, getCachedIdentity, cacheIdentity } from "./cache";
import {
  scoreFromEvidence,
  nameSimilarity,
  nameMatchWeight,
  onlineRatingMatchWeight,
} from "./confidence";

// ---------------------------------------------------------------------------
// Tunables — parallelism and how much of each schoolmate's graph to walk.
// The only hard cap is the caller's budget; these keep a single crawl polite.
// ---------------------------------------------------------------------------

const SCHOOLMATE_RESOLVE_POOL = 6; // schoolmates resolved to handles concurrently
// The USCF-anchored phase runs the SAME tournament-graph engine the main search
// runs on its target — and the main search runs UNBOUNDED (it grinds until the
// graph is exhausted). Fixed per-mate budgets kept killing traces mid-flight:
// observed live, Tanush #16538484 resolved in 76-120s+ when two traces shared
// the rate-limit gates, and a 120s cap left the crawl with one anchor (or none),
// so the target's account was never seen. There are NO time budgets here any
// more — a trace ends when the engine exhausts the mate's graph, and the phase
// ends only when the WHOLE roster has been attempted. The caller's abort signal
// remains the only external stop.
//
// EVERY mate now earns a full tournament trace (the name-shaped Chess.com "fast
// probe" was removed — it crowned wrong handles like Austin Liu → @austinliu1
// when the real handle @ailopatricaliy only surfaces from the tournament graph,
// and a wrong anchor poisons the social crawl). The one remaining shortcut is
// the search-wide identity cache, whose entries are themselves ENGINE-CONFIRMED
// (written only by a completed traversal), so it never introduces a guess.
//
// USCF_MATE_POOL bounds how many unbounded traces run at once: each trace fans
// out MUIR + chess.com calls of its own, and more than a couple in flight earns
// 429s regardless of how warm the caches are. It is a concurrency governor, NOT
// a cap on how many mates we resolve — the pool drains the entire roster.
const USCF_MATE_POOL = 2; // unbounded traces in flight at once (rate-limit governor, not a count cap)
// A schoolmate's handle only needs to be USABLE FOR THE CRAWL — the target is
// crowned by the social graph's own evidence bar (≥2 mutuals + verification),
// not by this number. 50% keeps plausible mates in; a wrong mate contributes
// noise the ≥2-mutual candidate bar filters out anyway.
const USCF_MATE_MIN_CONFIDENCE = 0.5; // bar for accepting a schoolmate's handle
const CRAWL_POOL = 6; // schoolmate graphs walked concurrently
const CC_MONTH_POOL = 4; // archive months fetched at once per schoolmate (global gate still applies)
const CANDIDATE_VERIFY_POOL = 8; // candidate accounts verified concurrently
const CC_ARCHIVE_MONTHS = 24; // months of chess.com archive scanned per schoolmate (the last 2 years)
const LICHESS_GAMES = 200; // recent lichess games scanned per schoolmate
// Safety ceiling on roster size, not a "stop after N resolved" cap: we ATTEMPT
// every roster player (highest-rated — likeliest online-active — first), and
// only a pathologically large roster is trimmed here (logged when it happens).
// Realistic NWSRS school reports sit well under this.
const MAX_SCHOOLMATES = 250; // roster players we attempt to resolve (highest-rated first)
const MIN_OPP_GAMES = 3; // games vs a handle before it counts as a "connection"
const HEAVY_OPP_GAMES = 12; // one schoolmate playing a handle this much = strong tie
const MAX_CANDIDATES = 40; // candidate handles carried into verification
const BIG_CLUB_MEMBERS = 2000; // clubs bigger than this are too generic to link on
const SMALL_CLUB_FOR_MEMBERS = 200; // only surface members from a club this small

/** A purely-social identification (no federation-ID anchor) is capped here: it
 *  is a strong lead, but "the account your schoolmates all play" is not the same
 *  certainty as a matched USCF/FIDE id. The anchor lifts it past this. */
const SCHOOL_SOCIAL_MAX_CONFIDENCE = 0.9;

// Platforms the tournament-graph engine cannot trace: ICC and ChessKid publish
// no public game/tournament API, so a section played on one is a dead end for
// username discovery (uscfGraphEngine skips such events outright). Chess.com,
// Lichess, and events whose platform the name doesn't reveal (the engine probes
// those as chess.com + lichess) are all traceable.
const NO_PUBLIC_API_PLATFORMS = new Set(["icc", "chesskid"]);

/** True when a member's online graph holds at least one section the engine can
 *  actually trace. A schoolmate whose ENTIRE online footprint is on no-public-API
 *  platforms (ICC / ChessKid) gives the engine nothing but the expensive
 *  opponent-pivot to fall back on, which isn't worth the minutes for a single
 *  social-graph anchor — the school phase skips them immediately. A mate with ANY
 *  traceable section still earns a full trace, so real online history is never
 *  dropped. */
export function hasTraceableOnlineHistory(events: GraphEvent[]): boolean {
  return events.some((e) => !NO_PUBLIC_API_PLATFORMS.has((e.platformGuess || "").toLowerCase()));
}

// ---------------------------------------------------------------------------
// Hooks + options
// ---------------------------------------------------------------------------

export interface SchoolResolverHooks {
  /** Resolve the target's school(s). Server-backed (school.ts via the edge). */
  findSchool?: (req: SchoolLookupRequest) => Promise<SchoolAffiliation[] | null>;
  /** Fetch a school's roster (schoolmates). Server-backed. `schoolCode` is the
   *  regional roster key (NWSRS: the id's three-letter school code, "SKN") —
   *  the school report is queried by it, not by the school's name. `sourceId`
   *  names the adapter that found the school, so the roster comes from the
   *  same source (WSCF list, results archive, …). */
  findSchoolmates?: (
    school: string,
    state: string | undefined,
    source: string | undefined,
    schoolCode?: string,
    sourceId?: string
  ) => Promise<Schoolmate[] | null>;
  /** Google-index username discovery — the FALLBACK way a name resolves to a
   *  handle (many schoolmates use non-obvious handles no index ties to their
   *  real name). Reused verbatim from the main engine (edge `findUsername`). */
  findUsernames?: (req: UsernameSearchRequest) => Promise<UsernameCandidate[] | null>;
  /** Name + state → USCF member ID, via the public USCF ratings search (the
   *  same lookup the main search runs when given a name instead of an ID;
   *  server-backed because MUIR sends no CORS headers). The bridge that lets
   *  the engine run the ID-based identity resolution on a schoolmate known
   *  only as a roster name. */
  findUscfId?: (req: {
    firstName: string;
    lastName: string;
    state?: string;
    rating?: number;
  }) => Promise<{ uscfId: string; rating?: number } | null>;
  /** USCF ID → best verified online handle, via the identity engine's
   *  tournament-graph traversal — the exact machinery that resolves the main
   *  search's target once a USCF ID is known (e.g. #16538484 → the member's
   *  online events → @tanneywanney25). Bounded by the caller; returns the
   *  strongest account with its confidence, or null when nothing traces. */
  resolveUscfIdentity?: (req: {
    uscfId: string;
    name: string;
    rating?: number;
    /** Cooperative stand-down: once the phase has enough anchors, an in-flight
     *  trace should wind down instead of running its graph to exhaustion —
     *  without this, the anchor phase blocked on stragglers for minutes after
     *  the answer was already in hand. */
    stopWhen?: () => boolean;
    /** Sign-of-life channel: the wrapped traversal pings this on every log
     *  line (incl. its 25s heartbeat), so the conductor's stall detector can
     *  tell a healthy grinding trace from a wedged one. */
    onActivity?: () => void;
  }) => Promise<{ platform: OnlinePlatform; username: string; confidence: number } | null>;
  /** A player's chess.com friends (member-public; needs an authenticated
   *  session, so it is fetched server-side). Returns friend usernames, or []
   *  when no session is configured — the crawl then leans on game overlap. */
  fetchFriends?: (platform: OnlinePlatform, username: string) => Promise<string[] | null>;
}

export interface SchoolResolverInput {
  name: string;
  state?: string;
  city?: string;
  uscfId?: string;
  /** The target's USCF (or approx) rating, for the corroborating rating check. */
  targetRating?: number;
  targetFideId?: string;
  /** Handles the target is already known NOT to be (their own resolved-elsewhere
   *  accounts / the schoolmates) — excluded from candidates. */
  excludeHandles?: string[];
  /** TEST/DEV: known schoolmate handles to seed the crawl directly. Mirrors
   *  "schoolmates the engine already resolved" — NOT the target. Lets the
   *  social crawl + ranking be validated without live name→handle discovery. */
  seedSchoolmates?: { platform: OnlinePlatform; username: string; name?: string }[];
}

export interface SchoolResolverOptions {
  signal?: AbortSignal;
  log: (message: string) => void;
  hooks?: SchoolResolverHooks;
  budgetMs?: number;
  /** Optional proactive-intelligence layer (conductor.ts). When attached the
   *  anchor phase gains three autonomous behaviours — stalled mate traces are
   *  stood down and skipped, the social graph is probed mid-phase once enough
   *  anchors land, and a federation-ID-anchored ≥90% candidate ends the whole
   *  phase early. Absent → the phase runs exactly as before. */
  conductor?: Conductor;
}

export interface SchoolResolverResult {
  accounts: DiscoveredAccount[];
  notes: string[];
  found: boolean;
  /** The school the identification hung on, for the UI / logs. */
  school?: string;
  /** How many schoolmates we resolved to real online accounts. */
  schoolmatesResolved: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const lc = (s: string) => s.trim().toLowerCase();
const digits = (s?: string) => (s ? s.replace(/\D/g, "") : "");
const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

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

const US_LIKE = new Set(["US", "PR", "GU", "VI", "AS", "MP"]);
function countryClaim(country?: string): string | undefined {
  const m = /^([A-Za-z]{2})/.exec((country || "").trim());
  const code = m ? m[1].toUpperCase() : undefined;
  return code && code !== "XX" ? code : undefined;
}
const isUs = (c?: string) => {
  const k = countryClaim(c);
  return !!k && US_LIKE.has(k);
};
const isForeign = (c?: string) => {
  const k = countryClaim(c);
  return !!k && !US_LIKE.has(k);
};

function locationNamesState(location: string | undefined, state: string | undefined): boolean {
  if (!location || !state) return false;
  const code = state.trim().toUpperCase();
  if (code.length !== 2) return false;
  if (new RegExp(`(^|[^A-Za-z])${code}([^A-Za-z]|$)`).test(location)) return true;
  const full = US_STATE_NAMES[code];
  return !!full && location.toLowerCase().includes(full);
}

/** A USCF member id published in free profile text (bio/links). Same strict
 *  rule verify.ts uses: only trust a number in an unmistakably-USCF context. */
function uscfIdFromText(text?: string): string | undefined {
  if (!text) return undefined;
  const url = /uschess\.org\/(?:msa\/MbrDtlMain\.php\?|player\/|members?\/)(\d{6,8})/i.exec(text);
  if (url) return url[1];
  const near = /\b(?:uscf|us\s*chess)\b[^0-9]{0,24}(\d{6,8})\b/i.exec(text);
  return near ? near[1] : undefined;
}

// ---------------------------------------------------------------------------
// CORS-friendly platform crawls (run anywhere — browser / Node / edge)
// ---------------------------------------------------------------------------

interface Conn {
  /** Handles this schoolmate is connected to, and how strongly (game count;
   *  a friend / clubmate with no games still registers as 1). */
  weight: Map<string, number>;
  /** Of those, which came from the authoritative friends list. */
  friends: Set<string>;
  /** Small clubs/teams this handle shares with the cohort. */
  sharedClubs: Set<string>;
  /** For a `club:*` bookkeeping entry: schoolmate → the club's member count. */
  clubs: Map<string, number>;
}

/** Chess.com: tally a player's opponents across their recent monthly archives.
 *  Months go through the SESSION-WIDE month cache (cache.ts), so a month any
 *  traversal — or an earlier crawl — already fetched costs nothing here, and a
 *  few months are fetched at once (the global chess.com gate still bounds the
 *  real request rate). */
async function chesscomOpponents(handle: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const tally = new Map<string, number>();
  try {
    const res = await politeFetch(
      `https://api.chess.com/pub/player/${encodeURIComponent(lc(handle))}/games/archives`,
      { headers: { Accept: "application/json" }, signal },
      "chesscom",
      15000
    );
    if (!res.ok) return tally;
    const data = await res.json();
    const months = (Array.isArray(data?.archives) ? data.archives : [])
      .map((url: unknown) => /\/(\d{4})\/(\d{2})$/.exec(String(url)))
      .filter((m: RegExpExecArray | null): m is RegExpExecArray => !!m)
      .map((m: RegExpExecArray) => ({ y: parseInt(m[1], 10), m: parseInt(m[2], 10) }))
      .slice(-CC_ARCHIVE_MONTHS);
    const shared = getSharedTraversalCaches();
    await pool(
      months,
      CC_MONTH_POOL,
      async ({ y, m }) => {
        if (signal?.aborted) return;
        const games = await sharedChesscomMonthGames(handle, y, m, shared, signal).catch(() => []);
        for (const g of games) {
          const u = lc(g.oppHandle);
          if (u && u !== lc(handle)) tally.set(u, (tally.get(u) || 0) + 1);
        }
      },
      () => !!signal?.aborted
    );
  } catch {
    /* archives unreachable — no opponents from this schoolmate */
  }
  return tally;
}

/** Lichess: tally a player's opponents across their recent games (ndjson). */
async function lichessOpponents(handle: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const tally = new Map<string, number>();
  try {
    const res = await politeFetch(
      `https://lichess.org/api/games/user/${encodeURIComponent(handle)}?max=${LICHESS_GAMES}&moves=false&pgnInJson=false&tags=false`,
      { headers: { Accept: "application/x-ndjson" }, signal },
      "lichess",
      25000
    );
    if (!res.ok) return tally;
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const g = JSON.parse(line);
        for (const side of ["white", "black"] as const) {
          const u = lc(String(g?.players?.[side]?.user?.name || g?.players?.[side]?.user?.id || ""));
          if (u && u !== lc(handle)) tally.set(u, (tally.get(u) || 0) + 1);
        }
      } catch {
        /* skip row */
      }
    }
  } catch {
    /* unreachable */
  }
  return tally;
}

/** Clubs/teams a handle belongs to (id → rough member count for genericness). */
async function fetchClubs(platform: OnlinePlatform, handle: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    if (platform === "chesscom") {
      const res = await politeFetch(
        `https://api.chess.com/pub/player/${encodeURIComponent(lc(handle))}/clubs`,
        { headers: { Accept: "application/json" }, signal },
        "chesscom"
      );
      if (!res.ok) return out;
      const data = await res.json();
      for (const c of Array.isArray(data?.clubs) ? data.clubs : []) {
        const id = String(c?.["@id"] || "").split("/").pop();
        if (id) out.set(id, 0);
      }
    } else {
      const res = await politeFetch(
        `https://lichess.org/api/team/of/${encodeURIComponent(handle)}`,
        { headers: { Accept: "application/json" }, signal },
        "lichess"
      );
      if (!res.ok) return out;
      const data = await res.json();
      for (const t of Array.isArray(data) ? data : []) {
        const id = String(t?.id || t?.name || "");
        const members = typeof t?.nbMembers === "number" ? t.nbMembers : 0;
        if (id) out.set(id, members);
      }
    }
  } catch {
    /* no clubs */
  }
  return out;
}

/** Members of a chess.com club (public), capped — used to surface additional
 *  candidates from a small, school/region-specific club. */
async function chesscomClubMembers(clubId: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await politeFetch(
      `https://api.chess.com/pub/club/${encodeURIComponent(clubId)}/members`,
      { headers: { Accept: "application/json" }, signal },
      "chesscom",
      15000
    );
    if (!res.ok) return [];
    const data = await res.json();
    const out: string[] = [];
    for (const bucket of ["weekly", "monthly", "all_time"] as const) {
      for (const m of Array.isArray(data?.[bucket]) ? data[bucket] : []) {
        const u = typeof m?.username === "string" ? m.username : "";
        if (u) out.push(u);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Schoolmate → handle resolution (the same route the main engine uses)
// ---------------------------------------------------------------------------

interface ResolvedMate {
  name: string;
  platform: OnlinePlatform;
  username: string;
  profile: VerifiedProfile;
  /** Set when the mate was resolved through their USCF ID (the anchored route). */
  uscfId?: string;
  /** The identity engine's confidence in the name→handle link, when it ran. */
  confidence?: number;
}

/** Roster names are "First [Middle] Last" — split for the USCF search. */
function splitName(name: string): { first: string; last: string } | null {
  const t = name.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (t.length < 2) return null;
  return { first: t[0], last: t[t.length - 1] };
}

async function verify(platform: OnlinePlatform, username: string, signal?: AbortSignal): Promise<VerifiedProfile | null> {
  const p = platform === "lichess" ? await verifyLichess(username, signal) : await verifyChesscom(username, signal);
  return p || null; // null-or-undefined both mean "not usable here"
}

/** Resolve one schoolmate name to their best verified online handle via the
 *  Google-index discovery hook. A resolved schoolmate must be a live US-plausible
 *  account — a foreign-flagged namesake is not this WA junior's classmate. */
async function resolveSchoolmate(
  mate: Schoolmate,
  school: string,
  input: SchoolResolverInput,
  hooks: SchoolResolverHooks,
  signal?: AbortSignal
): Promise<ResolvedMate | null> {
  if (mate.knownUsernames?.length) {
    for (const k of mate.knownUsernames) {
      const profile = await verify(k.platform, k.username, signal);
      if (profile && !isForeign(profile.country)) return { name: mate.name, platform: k.platform, username: profile.username, profile };
    }
  }
  if (!hooks.findUsernames) return null;
  const leads = (await hooks
    .findUsernames({ name: mate.name, state: input.state, clubOrSchool: school, uscfRating: mate.rating })
    .catch(() => null)) || [];
  // Verify every lead concurrently, then ACCEPT in the index's order — same
  // winner as the old serial walk, without paying one round-trip per lead.
  const top: UsernameCandidate[] = leads.slice(0, 8);
  const profiles = new Array<Awaited<ReturnType<typeof verify>>>(top.length);
  await pool(
    top,
    4,
    async (lead, i) => {
      if (signal?.aborted) return;
      profiles[i] = await verify(lead.platform, lead.username, signal);
    },
    () => !!signal?.aborted
  );
  for (let i = 0; i < top.length; i++) {
    const profile = profiles[i];
    if (profile && !isForeign(profile.country)) {
      return { name: mate.name, platform: top[i].platform, username: profile.username, profile };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Candidate scoring
// ---------------------------------------------------------------------------

interface Candidate {
  handle: string;
  /** Distinct resolved schoolmates connected to this handle. */
  mates: Set<string>;
  /** Total games this handle played vs the cohort. */
  gamesWithCohort: number;
  /** Of the connecting schoolmates, how many via the authoritative friends list. */
  friendOf: number;
  /** Small clubs/teams this handle shares with the cohort. */
  sharedClubs: Set<string>;
}

interface ScoredAccount {
  account: DiscoveredAccount;
  anchored: boolean; // a federation-ID match confirmed it
}

/** Score one candidate handle (already verified on `platform`) as the target. */
function scoreCandidate(
  cand: Candidate,
  profile: VerifiedProfile,
  platform: OnlinePlatform,
  input: SchoolResolverInput,
  school: string,
  crossPlatform: VerifiedProfile | null
): ScoredAccount {
  const evidence: Evidence[] = [];
  const source = "school-graph";
  const mates = [...cand.mates];

  // --- The social tie: the discovery signal. Connection to MULTIPLE
  //     schoolmates (or heavy play with one) is what singles this account out.
  const mutual = cand.mates.size;
  const friendWord = cand.friendOf > 0 ? "friend/opponent" : "frequent opponent";
  let socialWeight: number;
  if (mutual >= 3) socialWeight = 2.8;
  else if (mutual === 2) socialWeight = 2.2;
  else socialWeight = cand.gamesWithCohort >= HEAVY_OPP_GAMES ? 1.5 : 0.8;
  // Friends-list corroboration (authoritative) adds on top of the raw tie.
  if (cand.friendOf >= 2) socialWeight += 0.5;
  else if (cand.friendOf === 1) socialWeight += 0.25;
  evidence.push({
    kind: "shared-opponent",
    weight: socialWeight,
    label:
      `Connected to ${mutual} ${school} player${mutual > 1 ? "s" : ""} as a ${friendWord}` +
      (cand.gamesWithCohort ? ` (${cand.gamesWithCohort} games vs the cohort: ${mates.slice(0, 3).join(", ")}${mates.length > 3 ? "…" : ""})` : "") +
      (cand.friendOf ? `; on ${cand.friendOf} of their friends lists` : ""),
    source,
  });

  if (cand.sharedClubs.size) {
    evidence.push({
      kind: "club-match",
      weight: Math.min(0.9, 0.5 + 0.2 * cand.sharedClubs.size),
      label: `Shares ${cand.sharedClubs.size} club/team with the cohort (${[...cand.sharedClubs].slice(0, 2).join(", ")})`,
      source,
    });
  }

  // --- School context (soft — the school is WHY we are looking here).
  evidence.push({ kind: "school-match", weight: 0.3, label: `Identified via ${school}'s social graph`, source });

  // --- Rating proximity (loose: online vs USCF OTB are different systems).
  if (input.targetRating && profile.rating) {
    evidence.push({
      kind: "rating-match",
      weight: onlineRatingMatchWeight(input.targetRating, profile.rating),
      label: `${platform === "lichess" ? "Lichess" : "Chess.com"} rating ${profile.rating} vs target ~${input.targetRating} USCF`,
      source,
    });
  }

  // --- Location: US corroborates, a confidently-foreign flag counts against.
  if (isUs(profile.country)) {
    evidence.push({ kind: "country-match", weight: 0.8, label: `Profile country is US`, source });
  } else if (isForeign(profile.country)) {
    evidence.push({ kind: "country-match", weight: -1.5, label: `Profile flies a non-US flag (${countryClaim(profile.country)})`, source });
  }
  if (locationNamesState(profile.location, input.state)) {
    evidence.push({ kind: "state-match", weight: 0.8, label: `Profile location names ${input.state} ("${profile.location}")`, source });
  }

  // --- Cross-platform handle consistency: the same handle live on BOTH
  //     platforms is a real corroborator (people reuse handles).
  if (crossPlatform) {
    evidence.push({
      kind: "cross-reference",
      weight: 0.8,
      label: `Same handle @${cand.handle} also verified on ${platform === "lichess" ? "Chess.com" : "Lichess"}`,
      source,
    });
  }

  // --- Federation-ID cross-reference: the decisive anchor. A USCF/FIDE id the
  //     candidate published (Lichess exposes bio/links; chess.com does not) that
  //     matches the target's is near-conclusive; a different valid id is fatal.
  let anchored = false;
  const profFide = digits(profile.fideId);
  const targetFide = digits(input.targetFideId);
  if (targetFide && profFide) {
    const match = profFide === targetFide;
    if (match) anchored = true;
    evidence.push({
      kind: "fide-id-match",
      weight: match ? 4.0 : -3.0,
      label: match ? `Profile links FIDE ID ${profFide} — exact match` : `Profile FIDE ID ${profFide} contradicts target ${targetFide}`,
      source,
    });
  }
  // verify.ts already extracts a USCF id published in the profile's bio/links
  // into profile.uscfId; also scan the free-text location as a backstop.
  const bioUscf = profile.uscfId || uscfIdFromText(profile.location);
  const targetUscf = digits(input.uscfId);
  if (targetUscf && bioUscf) {
    const match = digits(bioUscf) === targetUscf;
    if (match) anchored = true;
    evidence.push({
      kind: "uscf-id-match",
      weight: match ? 4.5 : -3.0,
      label: match ? `Profile publishes USCF ID ${targetUscf} — exact match` : `Profile USCF ID ${bioUscf} contradicts target ${targetUscf}`,
      source,
    });
  }
  // A USCF rating printed on the profile that matches the target's is STRONG
  // corroboration — but ratings cluster within a school cohort (many teammates
  // sit within a few dozen points), so a rating match is NOT unique enough to
  // anchor near-certainty on its own; only a matching federation ID does that.
  // It adds weight; the 2+-mutual bar still governs how high confidence may go.
  if (input.targetRating && typeof profile.uscfRating === "number") {
    const diff = Math.abs(profile.uscfRating - input.targetRating);
    if (diff <= 150) {
      evidence.push({ kind: "cross-reference", weight: diff <= 60 ? 2.0 : 1.0, label: `Profile shows USCF ${profile.uscfRating} ≈ target ${input.targetRating}`, source });
    }
  }

  // --- Name: usually neutral (these handles are not real names). Only a real
  //     name on the profile matching moves the needle; a namey handle does not.
  if (profile.displayName) {
    const sim = nameSimilarity(input.name, profile.displayName);
    if (sim >= 0.6) evidence.push({ kind: "name-match", weight: nameMatchWeight(sim), label: `Profile name "${profile.displayName}" ~ "${input.name}"`, source });
  }

  evidence.push({ kind: "account-verified", weight: 0.4, label: `Account @${profile.username} confirmed live`, source });

  let confidence = scoreFromEvidence(evidence, -1.2);
  // Confidence ceiling — the guard against crowning the wrong same-cohort
  // player. A matching federation ID (unique) is near-certainty; a purely-social
  // tie to TWO+ schoolmates is high but not certain; a tie to a SINGLE
  // schoolmate (even a heavy one, even with a matching rating) is a strong lead
  // only, kept below the UI "high" band (0.75). This mirrors the "2+ mutuals +
  // rating + platform-verified" bar the fallback must clear, and matches the
  // manual method (identify by MULTIPLE mutual connections, not a lone tie).
  const cap = anchored ? 0.985 : cand.mates.size >= 2 ? SCHOOL_SOCIAL_MAX_CONFIDENCE : 0.72;
  confidence = Math.min(confidence, cap);

  return {
    account: {
      platform: platform as Platform,
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
      confidence,
      evidence,
    },
    anchored,
  };
}

// ---------------------------------------------------------------------------
// Cohort crawl + candidate scoring — one reusable pass.
//
// Extracted from the tail of runSchoolResolution so the conductor can PROBE
// mid-phase: once enough anchors have resolved, the same crawl+score runs over
// the anchors in hand — concurrently with the still-running mate traces — and
// a federation-ID-anchored ≥90% hit ends the phase right there. Every fetch is
// memoized in the per-run CrawlMemo, so a probe's work is never wasted: the
// final pass (or the next probe) reuses the same promises instead of
// re-hitting the network.
// ---------------------------------------------------------------------------

interface CrawlMemo {
  opp: Map<string, Promise<Map<string, number>>>;
  clubs: Map<string, Promise<Map<string, number>>>;
  members: Map<string, Promise<string[]>>;
  friends: Map<string, Promise<string[] | null>>;
  profile: Map<string, Promise<VerifiedProfile | null>>;
}

export function makeCrawlMemo(): CrawlMemo {
  return { opp: new Map(), clubs: new Map(), members: new Map(), friends: new Map(), profile: new Map() };
}

const memoized = <T>(store: Map<string, Promise<T>>, key: string, fn: () => Promise<T>): Promise<T> => {
  const hit = store.get(key);
  if (hit) return hit;
  const p = fn();
  store.set(key, p);
  return p;
};

async function crawlCohort(
  mates: ResolvedMate[],
  input: SchoolResolverInput,
  school: string,
  hooks: SchoolResolverHooks,
  memo: CrawlMemo,
  halted: () => boolean,
  log: (message: string) => void,
  quiet: boolean,
  signal?: AbortSignal
): Promise<ScoredAccount[]> {
  const say = quiet ? (_: string) => {} : log;
  const exclude = new Set((input.excludeHandles || []).map(lc));
  for (const r of mates) exclude.add(lc(r.username));

  const mOpp = (mate: ResolvedMate) =>
    memoized(memo.opp, `${mate.platform}:${lc(mate.username)}`, () =>
      mate.platform === "lichess" ? lichessOpponents(mate.username, signal) : chesscomOpponents(mate.username, signal)
    );
  const mFriends = (mate: ResolvedMate): Promise<string[] | null> =>
    hooks.fetchFriends
      ? memoized(memo.friends, `${mate.platform}:${lc(mate.username)}`, () =>
          hooks.fetchFriends!(mate.platform, mate.username).catch(() => null)
        )
      : Promise.resolve(null);
  const mClubs = (mate: ResolvedMate): Promise<Map<string, number>> =>
    mate.platform === "chesscom"
      ? memoized(memo.clubs, `chesscom:${lc(mate.username)}`, () => fetchClubs("chesscom", mate.username, signal))
      : Promise.resolve(new Map<string, number>());
  const mMembers = (clubId: string) => memoized(memo.members, clubId, () => chesscomClubMembers(clubId, signal));
  const mVerify = (platform: OnlinePlatform, handle: string) =>
    memoized(memo.profile, `${platform}:${lc(handle)}`, () => verify(platform, handle, signal));

  // --- Social-graph crawl ------------------------------------------------------
  // For each resolved schoolmate: friends (if a session hook exists) + frequent
  // game opponents + clubs. Aggregate into per-candidate connection counts.
  say(
    `School resolver: crawling ${mates.length} schoolmate graph(s) — signals: ` +
      `authenticated chess.com friends ${hooks.fetchFriends ? "hook wired (used when the server has CHESSCOM_COOKIE)" : "unavailable"}, ` +
      `public game archives (last ${CC_ARCHIVE_MONTHS} months), shared clubs.`
  );
  const conns = new Map<string, Conn>(); // candidate handle → connection record
  const get = (h: string): Conn => {
    let c = conns.get(h);
    if (!c) conns.set(h, (c = { weight: new Map(), friends: new Set(), sharedClubs: new Set(), clubs: new Map() }));
    return c;
  };
  let totalFriends = 0; // friends fetched across the whole cohort (dedup counts per mate)
  let matesWithFriends = 0; // schoolmates the friends hook returned a non-empty list for

  await pool(
    mates,
    CRAWL_POOL,
    async (mate) => {
      if (signal?.aborted) return;
      // The three signals (archive opponents, friends list, clubs) hit
      // independent endpoints — fetch them together instead of back-to-back
      // (the serial order tripled each mate's crawl latency for no ordering
      // benefit; results are folded into `conns` identically either way).
      const [opp, friends, clubs] = await Promise.all([mOpp(mate), mFriends(mate), mClubs(mate)]);
      const oppTied = [...opp.values()].filter((n) => n >= MIN_OPP_GAMES).length;
      for (const [h, n] of opp) {
        if (n < MIN_OPP_GAMES) continue;
        const c = get(h);
        c.weight.set(mate.username, (c.weight.get(mate.username) || 0) + n);
      }
      // Authoritative friends (member-public, server-fetched) — strongest tie.
      for (const f of friends || []) {
        const h = lc(f);
        if (!h) continue;
        const c = get(h);
        c.friends.add(mate.username);
        if (!c.weight.has(mate.username)) c.weight.set(mate.username, MIN_OPP_GAMES); // register the tie
      }
      const clubCount = [...clubs].filter(([, members]) => !(members && members > BIG_CLUB_MEMBERS)).length;
      // A mate's small clubs are noted; their members are folded in below.
      for (const [id, members] of clubs) {
        if (members && members > BIG_CLUB_MEMBERS) continue;
        get(`club:chesscom:${id}`).clubs.set(mate.username, members);
      }
      if (friends?.length) {
        totalFriends += friends.length;
        matesWithFriends++;
      }
      // Per-mate signal summary — makes it clear, for each anchor, how much of
      // each signal fed the graph (and whether the friends list came back full).
      say(
        `School resolver: crawled @${mate.username} (${mate.name}) — ` +
          `${friends ? `${friends.length} friend(s)` : "friends n/a"}, ` +
          `${oppTied} frequent opponent(s) (≥${MIN_OPP_GAMES} games), ${clubCount} small club(s).`
      );
    },
    halted
  );
  if (hooks.fetchFriends) {
    say(
      `School resolver: chess.com friends signal — ${totalFriends} friend link(s) across ` +
        `${matesWithFriends}/${mates.length} schoolmate(s) (full lists, not just top-friends).`
    );
  }

  // Fold small-club co-membership into candidate connections: every member of a
  // schoolmate's small chess.com club becomes a candidate with a (weak) tie to
  // each schoolmate in that club — so someone in the school's own small club
  // with 2+ schoolmates clears the bar even if they never showed up as a game
  // opponent. Capped to genuinely small clubs so a big regional club (which
  // links nobody) can't flood the candidate pool.
  {
    const clubEntries = [...conns].filter(([key]) => key.startsWith("club:"));
    for (const [key] of clubEntries) conns.delete(key);
    // Member lists are independent fetches — pull several at once (was one
    // club at a time; the chess.com gate is the real flood control).
    await pool(
      clubEntries,
      4,
      async ([key, rec]) => {
        if (halted()) return;
        const [, platform, clubId] = key.split(":");
        if (platform !== "chesscom") return;
        const members = await mMembers(clubId);
        if (!members.length || members.length > SMALL_CLUB_FOR_MEMBERS) return;
        const clubSchoolmates = [...rec.clubs.keys()]; // schoolmates in this small club
        for (const m of members) {
          const h = lc(m);
          if (exclude.has(h)) continue;
          const c = get(h);
          for (const mate of clubSchoolmates) {
            if (!c.weight.has(mate)) c.weight.set(mate, MIN_OPP_GAMES); // register the (weak) club tie
            c.sharedClubs.add(clubId);
          }
        }
      },
      halted
    );
  }

  say(`School resolver: cohort graph crawl done — ranking the socially-tied candidates.`);

  // --- Candidates → verify → score ---------------------------------------------
  const candidates: Candidate[] = [];
  for (const [handle, rec] of conns) {
    if (handle.startsWith("club:")) continue;
    if (exclude.has(handle)) continue; // schoolmates / known target accounts
    const mateSet = new Set(rec.weight.keys());
    const gamesWithCohort = [...rec.weight.values()].reduce((a, b) => a + b, 0);
    const sharedClubs = rec.sharedClubs;
    // The bar to even verify: connected to ≥2 schoolmates, OR heavily to one,
    // OR a friend + a shared club. Keeps verification focused and false leads out.
    const qualifies = mateSet.size >= 2 || gamesWithCohort >= HEAVY_OPP_GAMES || (rec.friends.size >= 1 && sharedClubs.size >= 1);
    if (!qualifies) continue;
    candidates.push({ handle, mates: mateSet, gamesWithCohort, friendOf: rec.friends.size, sharedClubs });
  }
  // Rank by social strength before the (bounded) verification pass.
  candidates.sort((a, b) => b.mates.size - a.mates.size || b.friendOf - a.friendOf || b.gamesWithCohort - a.gamesWithCohort);
  const shortlist = candidates.slice(0, MAX_CANDIDATES);
  say(`School resolver: ${candidates.length} candidate account(s) socially tied to the cohort; verifying the top ${shortlist.length}…`);

  const scored: ScoredAccount[] = [];
  await pool(
    shortlist,
    CANDIDATE_VERIFY_POOL,
    async (cand) => {
      if (signal?.aborted) return;
      const via = [
        cand.friendOf ? `${cand.friendOf} friends list(s)` : "",
        cand.gamesWithCohort ? `${cand.gamesWithCohort} archive game(s)` : "",
        cand.sharedClubs.size ? `${cand.sharedClubs.size} shared club(s)` : "",
      ]
        .filter(Boolean)
        .join(", ");
      // Verify on both platforms: whichever the target is on, plus the
      // cross-platform consistency check. Prefer the platform the connections
      // came from, but a handle live on both is a stronger identity. The two
      // lookups are independent — fetch them together.
      const [cc, li] = await Promise.all([mVerify("chesscom", cand.handle), mVerify("lichess", cand.handle)]);
      if (!cc && !li) {
        say(`School resolver: candidate @${cand.handle} — connected to ${[...cand.mates].join(", ")} via ${via} — no live account, dropped.`);
        return;
      }
      // Lichess is where a USCF/FIDE id can actually live (bio/links), so if the
      // account exists there, score that one (it carries the anchor); keep the
      // chess.com account too when present.
      const scores: ScoredAccount[] = [];
      if (li) scores.push(scoreCandidate(cand, li, "lichess", input, school, cc));
      if (cc) scores.push(scoreCandidate(cand, cc, "chesscom", input, school, li));
      scored.push(...scores);
      const best = scores.sort((a, b) => b.account.confidence - a.account.confidence)[0];
      say(
        `School resolver: candidate @${cand.handle} — connected to ${[...cand.mates].join(", ")} via ${via} — ` +
          `${Math.round(best.account.confidence * 100)}%${best.anchored ? " (federation-ID anchored)" : ""}.`
      );
    },
    halted
  );

  // Keep the strongest account per handle+platform; then per identity dedupe is
  // the resolver's job. Sort by confidence, anchored first.
  scored.sort((a, b) => Number(b.anchored) - Number(a.anchored) || b.account.confidence - a.account.confidence);
  return scored;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export async function runSchoolResolution(
  input: SchoolResolverInput,
  options: SchoolResolverOptions
): Promise<SchoolResolverResult> {
  const { signal, log, hooks = {} } = options;
  const notes: string[] = [];
  const t0 = Date.now();
  const since = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  // NO time budget by default: the school route is the LAST deterministic chance
  // for a zero-history player, and fixed deadlines kept cutting mate traces off
  // seconds from an answer. The abort signal is the only stop. A caller may pass
  // an explicit budgetMs (tests / a bounded batch job) to opt back into a
  // wall-clock ceiling; production passes none, so `deadline` is Infinity.
  const deadline = options.budgetMs ? Date.now() + options.budgetMs : Infinity;
  const halted = () => !!signal?.aborted || Date.now() > deadline;

  // --- 1. School -------------------------------------------------------------
  let affiliations: SchoolAffiliation[] = [];
  if (hooks.findSchool) {
    affiliations =
      (await hooks
        .findSchool({ name: input.name, state: input.state, city: input.city, uscfId: input.uscfId, uscfRating: input.targetRating, fideId: input.targetFideId })
        .catch(() => null)) || [];
  }
  // Only trust a school whose state matches the target's (when we know it).
  if (input.state) {
    const st = input.state.trim().toUpperCase();
    affiliations = affiliations.filter((a) => !a.state || a.state.trim().toUpperCase() === st);
  }
  if (!affiliations.length && !input.seedSchoolmates?.length) {
    log("School resolver: no school affiliation found — nothing to trace.");
    return { accounts: [], notes: ["No school affiliation found."], found: false, schoolmatesResolved: 0 };
  }
  const school = affiliations[0]?.school || "the target's school";
  if (affiliations.length) log(`School resolver: target attends ${school} (${affiliations[0].sourceLabel}, ${Math.round(affiliations[0].confidence * 100)}%).`);

  // --- 2. Cohort → resolved schoolmate handles -------------------------------
  const mates: Schoolmate[] = [];
  if (hooks.findSchoolmates && affiliations[0]) {
    const roster =
      (await hooks
        .findSchoolmates(
          affiliations[0].school,
          affiliations[0].state,
          affiliations[0].source,
          affiliations[0].schoolCode,
          affiliations[0].sourceId
        )
        .catch(() => null)) || [];
    for (const m of roster) if (!sameName(m.name, input.name)) mates.push(m);
  }
  // Highest-rated roster players first (likeliest to be online-active). We
  // attempt the WHOLE roster — only a pathologically large one is trimmed to
  // the safety ceiling (logged), never a "stop after N" cap.
  mates.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const pickedMates = mates.slice(0, MAX_SCHOOLMATES);
  if (mates.length > pickedMates.length) {
    log(
      `School resolver: ${school} roster has ${mates.length} other player(s) — attempting the top ${pickedMates.length} ` +
        `(safety ceiling ${MAX_SCHOOLMATES}; the rest are skipped).`
    );
  } else {
    log(`School resolver: ${school} roster has ${mates.length} other player(s); attempting to resolve ALL of them to online handles…`);
  }

  const resolved: ResolvedMate[] = [];
  // Seeded (already-known) schoolmates go in directly, verified for enrichment.
  for (const s of input.seedSchoolmates || []) {
    const profile = await verify(s.platform, s.username, signal);
    if (profile) resolved.push({ name: s.name || s.username, platform: s.platform, username: profile.username, profile });
  }

  // --- Conductor scaffolding (proactive intelligence) ------------------------
  // The anchor phase is where the school route spends its minutes, so it is
  // where the conductor earns its keep: every mate trace registers for stall
  // detection, every resolved anchor counts toward the probe threshold, and a
  // mid-phase probe that lands a federation-ID-anchored ≥90% candidate wins
  // the phase on the spot — the remaining traces stand down and the answer
  // ships without waiting for the rest of the roster. The probe runs
  // CONCURRENTLY with the mate pool (never blocking it), and its fetches land
  // in the shared memo, so probe work is reused by the final pass rather than
  // repeated.
  const conductor = options.conductor;
  const SCHOOL_SCOPE = "school-anchor";
  const memo = makeCrawlMemo();
  const won = () => !!conductor?.phaseWon(SCHOOL_SCOPE);
  let probeInFlight: Promise<void> | null = null;
  let earlyScored: ScoredAccount[] | null = null;
  const maybeProbe = () => {
    if (!conductor || probeInFlight || won() || halted()) return;
    if (!conductor.wantsProbe(SCHOOL_SCOPE)) return;
    conductor.probeStarted(SCHOOL_SCOPE);
    const snapshot = [...resolved];
    log(`School resolver: conductor probe — crawling the ${snapshot.length} anchor(s) in hand while the roster continues…`);
    probeInFlight = (async () => {
      try {
        const scored = await crawlCohort(snapshot, input, school, hooks, memo, halted, log, true, signal);
        const best = scored.find((s) => s.anchored); // sorted anchored-first, strongest first
        if (best) {
          conductor.reportCandidate(SCHOOL_SCOPE, {
            confidence: best.account.confidence,
            anchored: true,
            label: `@${best.account.username} on ${best.account.platform}`,
          });
          if (conductor.phaseWon(SCHOOL_SCOPE)) earlyScored = scored;
        } else {
          log("School resolver: the probe found no federation-ID-anchored candidate yet — continuing to resolve the roster.");
        }
      } catch {
        /* the probe is best-effort — the final pass still runs */
      } finally {
        conductor.probeEnded(SCHOOL_SCOPE);
        probeInFlight = null;
      }
    })();
  };

  // 2a. USCF-ANCHORED RESOLUTION (primary): roster name + state → USCF member
  //     ID (the public ratings search) → the identity engine's tournament-graph
  //     traversal — the SAME route (and the same full engine) the main search
  //     takes once it has a USCF ID. Every mate earns a full, unbounded trace;
  //     the ONLY shortcut is the engine-confirmed identity cache. Runs
  //     USCF_MATE_POOL traces at a time (a rate-limit governor) and drains the
  //     ENTIRE roster — the more mates resolved, the stronger the social graph.
  if (hooks.findUscfId && hooks.resolveUscfIdentity && !halted()) {
    const phaseStart = Date.now();
    let attempted = 0;
    let noUscf = 0;
    let traced = 0;
    let fromCache = 0;
    log(
      `School resolver: USCF-anchored resolution — the FULL identity engine on every mate ` +
        `(${USCF_MATE_POOL} unbounded trace(s) in flight; same engine + discovery as the main search), ` +
        `attempting all ${pickedMates.length} roster player(s). No fast name-guess path, no count cap, no time budget.`
    );
    await pool(
      pickedMates,
      USCF_MATE_POOL,
      async (mate) => {
        attempted++;
        // (No spacing sleep here: the adaptive MUIR pacer and the platform gates
        // in net.ts are the flood control, and they see every request — a blind
        // 1s stagger only added latency on top of them.)
        const parts = splitName(mate.name);
        if (!parts) return;
        const mateState = mate.state || affiliations[0]?.state || input.state;
        const found = await hooks
          .findUscfId!({ firstName: parts.first, lastName: parts.last, state: mateState, rating: mate.rating })
          .catch(() => null);
        if (!found) {
          noUscf++;
          log(`School resolver: no USCF member found for ${mate.name}${mateState ? ` (${mateState})` : ""} — skipping.`);
          return;
        }
        log(`School resolver: found USCF ID ${found.uscfId} for ${mate.name}${found.rating ? ` (~${found.rating} USCF)` : ""}.`);
        if (halted() || won()) return;

        // SHORTCUT (engine-confirmed only): the search-wide resolved-identity
        // store holds handles a COMPLETED traversal produced (this search, a
        // sibling mate trace, or an earlier search this session). Reusing one is
        // reusing the full engine's own output — never a guess — so it costs one
        // verification instead of re-running an identical trace.
        const known = getCachedIdentity(found.uscfId);
        if (known && known.confidence >= USCF_MATE_MIN_CONFIDENCE) {
          if (resolved.some((x) => x.platform === known.platform && lc(x.username) === lc(known.username))) return;
          const profile = await verify(known.platform, known.username, signal);
          if (profile) {
            fromCache++;
            resolved.push({
              name: mate.name,
              platform: known.platform,
              username: profile.username,
              profile,
              uscfId: found.uscfId,
              confidence: known.confidence,
            });
            log(
              `School resolver: resolved ${mate.name} to @${profile.username} from the engine-confirmed identity cache ` +
                `(${Math.round(known.confidence * 100)}%, trace already run earlier).`
            );
            conductor?.anchorResolved(SCHOOL_SCOPE);
            maybeProbe();
            return;
          }
          // Cached handle didn't verify live — fall through to a fresh trace.
        }

        if (halted() || won()) return;
        log(
          `School resolver: resolveUscfIdentity(uscfId=${found.uscfId}, name="${mate.name}", ` +
            `rating=${found.rating ?? mate.rating ?? "?"}) — full engine, no time budget, tracing until the graph is exhausted…`
        );
        const traceStart = Date.now();
        // Register with the conductor's stall detector: activity pings come
        // from the traversal's own log lines (incl. its 25s heartbeat), so
        // only a genuinely wedged trace can be stood down. The composed
        // stopWhen also winds this trace down the moment a probe wins the
        // phase — a stood-down trace still keeps anything it already found.
        const traceId = conductor?.traceStarted(SCHOOL_SCOPE, mate.name);
        const hit = await hooks
          .resolveUscfIdentity!({
            uscfId: found.uscfId,
            name: mate.name,
            rating: found.rating ?? mate.rating,
            stopWhen: () => halted() || won() || (traceId !== undefined && conductor!.shouldStandDown(traceId)),
            onActivity: traceId !== undefined ? () => conductor!.traceActivity(traceId) : undefined,
          })
          .catch(() => null);
        const secs = Math.round((Date.now() - traceStart) / 1000);
        if (traceId !== undefined) {
          conductor!.traceEnded(traceId, hit ? "resolved" : conductor!.wasStoodDown(traceId) ? "stood-down" : "empty");
        }
        if (!hit) {
          if (traceId !== undefined && conductor!.wasStoodDown(traceId)) {
            log(`School resolver: cancelled ${mate.name}'s trace (stalled, ${secs}s with no result) — moving on with the rest of the roster.`);
          } else {
            log(`School resolver: couldn't trace USCF #${found.uscfId} (${mate.name}) to an online handle after ${secs}s — continuing.`);
          }
          return;
        }
        log(
          `School resolver: resolveUscfIdentity for ${mate.name} returned @${hit.username} (${hit.platform}) ` +
            `at ${Math.round(hit.confidence * 100)}% in ${secs}s.`
        );
        if (hit.confidence < USCF_MATE_MIN_CONFIDENCE) {
          log(
            `School resolver: @${hit.username} for ${mate.name} scored ${Math.round(hit.confidence * 100)}% — below the ` +
              `${Math.round(USCF_MATE_MIN_CONFIDENCE * 100)}% bar, discarded.`
          );
          return;
        }
        if (resolved.some((x) => x.platform === hit.platform && lc(x.username) === lc(hit.username))) return;
        const profile = await verify(hit.platform, hit.username, signal);
        if (!profile) {
          log(`School resolver: @${hit.username} (${mate.name}) did not verify live — skipping.`);
          return;
        }
        traced++;
        resolved.push({
          name: mate.name,
          platform: hit.platform,
          username: profile.username,
          profile,
          uscfId: found.uscfId,
          confidence: hit.confidence,
        });
        cacheIdentity(found.uscfId, { platform: hit.platform, username: profile.username, confidence: hit.confidence });
        log(`School resolver: resolved ${mate.name} to @${profile.username} at ${Math.round(hit.confidence * 100)}% (USCF #${found.uscfId}).`);
        conductor?.anchorResolved(SCHOOL_SCOPE);
        maybeProbe();
      },
      () => halted() || won()
    );
    // A probe may still be crawling when the pool drains (or it just won the
    // phase) — settle it before deciding between the early exit and the full
    // pass, so its memoized fetches and verdict are in hand either way.
    if (probeInFlight) await probeInFlight;
    log(
      `School resolver: USCF-anchored phase — attempted ${attempted}, no USCF record ${noUscf}, ` +
        `${fromCache} from cache, ${traced} freshly traced.`
    );
    log(
      `School resolver: USCF-anchored phase finished in ${Math.round((Date.now() - phaseStart) / 1000)}s — ` +
        `${resolved.length} schoolmate(s) resolved.`
    );
  }

  // --- Conductor early exit ---------------------------------------------------
  // A mid-phase probe produced a federation-ID-anchored ≥90% candidate: that
  // evidence class is terminal (a unique federation ID cannot be out-scored by
  // resolving more schoolmates), so ship the probe's own scored results now.
  if (earlyScored) {
    const accounts = (earlyScored as ScoredAccount[]).map((s) => s.account).filter((a) => a.confidence >= 0.5);
    if (accounts.length) {
      const top = accounts[0];
      log(
        `School resolver: early exit — @${top.username} confirmed at ${Math.round(top.confidence * 100)}% with only ` +
          `${resolved.length}/${pickedMates.length} schoolmates resolved; the remaining traces were stood down.`
      );
      notes.push(
        `Identified via ${school}'s social graph (early exit: federation-ID-anchored match after ${resolved.length} of ${pickedMates.length} schoolmates).`
      );
      return { accounts: accounts.slice(0, 6), notes, found: true, school, schoolmatesResolved: resolved.length };
    }
  }

  // 2b. FALLBACK: Google-index / platform name search, only when the anchored
  //     route resolved nobody (non-obvious handles rarely index by real name,
  //     which is exactly why 2a exists — but a mate with no USCF record can
  //     still surface here).
  if (!resolved.length) {
    if (hooks.findUscfId && hooks.resolveUscfIdentity) {
      log("School resolver: the USCF route resolved no schoolmate — falling back to name-based handle discovery.");
    }
    await pool(
      pickedMates,
      SCHOOLMATE_RESOLVE_POOL,
      async (mate) => {
        const r = await resolveSchoolmate(mate, school, input, hooks, signal);
        if (r && !resolved.some((x) => x.platform === r.platform && lc(x.username) === lc(r.username))) resolved.push(r);
      },
      halted
    );
  }
  if (!resolved.length) {
    log("School resolver: couldn't resolve any schoolmate to an online handle — cannot trace the social graph.");
    return { accounts: [], notes: [`Found school (${school}) but resolved no schoolmate handles.`], found: false, school, schoolmatesResolved: 0 };
  }
  log(`School resolver: resolved ${resolved.length} schoolmate account(s): ${resolved.map((r) => `@${r.username}`).slice(0, 8).join(", ")}${resolved.length > 8 ? "…" : ""}.`);

  // --- 3+4. Social-graph crawl → candidates → verify → score -----------------
  // One reusable pass (crawlCohort) — the same code path the conductor's
  // mid-phase probe runs; thanks to the shared memo, anything a probe already
  // fetched costs nothing again here.
  const scored = await crawlCohort(resolved, input, school, hooks, memo, halted, log, false, signal);
  const accounts = scored.map((s) => s.account).filter((a) => a.confidence >= 0.5);

  const found = accounts.length > 0;
  log(`School resolver: whole school phase took ${since()}.`);
  if (found) {
    const top = accounts[0];
    log(`School resolver: strongest match @${top.username} on ${top.platform} — ${Math.round(top.confidence * 100)}% confidence.`);
    notes.push(`Identified via ${school}'s social graph (${resolved.length} schoolmate accounts crawled).`);
  } else {
    notes.push(`Crawled ${school}'s social graph (${resolved.length} schoolmates) but no candidate cleared the bar.`);
  }

  return { accounts: accounts.slice(0, 6), notes, found, school, schoolmatesResolved: resolved.length };
}

/** Same-person name check (surname + compatible first name), reused for the
 *  "exclude the target from their own roster" filter. */
function sameName(a: string, b: string): boolean {
  const ta = norm(a).split(" ").filter(Boolean);
  const tb = norm(b).split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const la = ta[ta.length - 1];
  const lb = tb[tb.length - 1];
  if (la !== lb) return false;
  return ta[0] === tb[0] || ta[0].startsWith(tb[0]) || tb[0].startsWith(ta[0]);
}
