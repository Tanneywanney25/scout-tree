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
import type { UsernameSearchRequest, UsernameCandidate } from "./graphTypes";
import { politeFetch, pool } from "./net";
import { verifyChesscom, verifyLichess, type VerifiedProfile } from "./verify";
import { guessHandles, sharedChesscomMonthGames } from "./uscfGraphEngine";
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
// runs on its target. Two things changed the arithmetic since the 2×120s era:
// the fast path below lands most mates without any trace at all, and every
// trace now shares the SESSION-WIDE fetch caches (cache.ts), so the second and
// later traces run largely warm — 60s is the observed budget a warm trace
// needs (Tanush #16538484 resolves in under 60s). Four traces in flight do not
// multiply 429s the way raw fan-out would: every chess.com call still queues
// behind net.ts's global gate and every MUIR call behind the edge throttle.
const USCF_MATE_POOL = 4; // schoolmates traced at once
const USCF_MATE_SPACING_MS = 1_000; // pause between successive traces per worker (rate-limit hygiene)
const USCF_MATE_TIMEOUT_MS = 60_000; // one schoolmate's identity-engine budget (warm-cache pace)
const USCF_MATE_PHASE_MS = 120_000; // the whole USCF-anchored resolution phase — after this, fall back
const USCF_MATE_TARGET = 3; // resolved schoolmates are enough to crawl on — stop here
const USCF_MATE_EARLY_TARGET = 2; // …or settle for 2 once the phase runs long
const USCF_MATE_EARLY_MS = 90_000; // "long" = 90s into the phase
// A schoolmate's handle only needs to be USABLE FOR THE CRAWL — the target is
// crowned by the social graph's own evidence bar (≥2 mutuals + verification),
// not by this number. 50% keeps plausible mates in; a wrong mate contributes
// noise the ≥2-mutual candidate bar filters out anyway.
const USCF_MATE_MIN_CONFIDENCE = 0.5; // bar for accepting a schoolmate's handle
// FAST PATH: before a mate earns a 60s tournament trace, probe a handful of
// name-shaped Chess.com handles and accept one ONLY when the profile's REAL
// name matches the roster name (a namey username alone proves nothing — the
// main engine's discipline). The unsuffixed shapes carry nearly all the hit
// rate, so the probe stays tiny.
const FAST_PROBE_HANDLES = 8; // guessHandles() shapes checked per mate
const FAST_PROBE_POOL = 4; // probe verifications in flight per mate
const FAST_PROBE_MIN_CONFIDENCE = 0.7; // bar to skip the tournament trace
const CRAWL_POOL = 6; // schoolmate graphs walked concurrently
const CC_MONTH_POOL = 4; // archive months fetched at once per schoolmate (global gate still applies)
const CANDIDATE_VERIFY_POOL = 8; // candidate accounts verified concurrently
const CC_ARCHIVE_MONTHS = 24; // months of chess.com archive scanned per schoolmate (the last 2 years)
const LICHESS_GAMES = 200; // recent lichess games scanned per schoolmate
const MAX_SCHOOLMATES = 24; // roster players we try to resolve (highest-rated first)
const MIN_OPP_GAMES = 3; // games vs a handle before it counts as a "connection"
const HEAVY_OPP_GAMES = 12; // one schoolmate playing a handle this much = strong tie
const MAX_CANDIDATES = 40; // candidate handles carried into verification
const BIG_CLUB_MEMBERS = 2000; // clubs bigger than this are too generic to link on
const SMALL_CLUB_FOR_MEMBERS = 200; // only surface members from a club this small
const DEFAULT_SCHOOL_BUDGET_MS = 6 * 60_000; // wall-clock ceiling for the whole crawl (≥ the 120s anchor phase + a parallel archive crawl)

/** A purely-social identification (no federation-ID anchor) is capped here: it
 *  is a strong lead, but "the account your schoolmates all play" is not the same
 *  certainty as a matched USCF/FIDE id. The anchor lifts it past this. */
const SCHOOL_SOCIAL_MAX_CONFIDENCE = 0.9;

// ---------------------------------------------------------------------------
// Hooks + options
// ---------------------------------------------------------------------------

export interface SchoolResolverHooks {
  /** Resolve the target's school(s). Server-backed (school.ts via the edge). */
  findSchool?: (req: SchoolLookupRequest) => Promise<SchoolAffiliation[] | null>;
  /** Fetch a school's roster (schoolmates). Server-backed. `schoolCode` is the
   *  regional roster key (NWSRS: the id's three-letter school code, "SKN") —
   *  the school report is queried by it, not by the school's name. */
  findSchoolmates?: (
    school: string,
    state: string | undefined,
    source: string | undefined,
    schoolCode?: string
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
    /** The engine's per-mate allowance. Implementations should run the
     *  traversal with (slightly under) this — the SAME machinery and discovery
     *  hooks as the main search, just time-boxed — so it winds down and returns
     *  before the caller's outer timeout drops the late result. */
    budgetMs?: number;
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
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
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

/** Resolve to null after `ms` — one expensive schoolmate resolution must never
 *  pin the whole phase. The late result is dropped, not awaited. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      }
    );
  });
}

async function verify(platform: OnlinePlatform, username: string, signal?: AbortSignal): Promise<VerifiedProfile | null> {
  const p = platform === "lichess" ? await verifyLichess(username, signal) : await verifyChesscom(username, signal);
  return p || null; // null-or-undefined both mean "not usable here"
}

interface FastProbeHit {
  platform: OnlinePlatform;
  profile: VerifiedProfile;
  confidence: number;
}

/** FAST PATH probe: a schoolmate with a simple real-name handle resolves in a
 *  few profile GETs instead of a 60s tournament trace. Chess.com has no name
 *  search, so this is guess-and-verify over the top name shapes — and a guess
 *  only counts when the profile's REAL name matches the roster name (and it
 *  isn't confidently foreign). A state-naming location lifts the confidence.
 *  The tournament trace remains the fallback for every non-obvious handle. */
async function fastNameProbe(
  name: string,
  state: string | undefined,
  signal?: AbortSignal
): Promise<FastProbeHit | null> {
  const guesses = guessHandles(name).slice(0, FAST_PROBE_HANDLES);
  if (!guesses.length) return null;
  let best: FastProbeHit | null = null;
  await pool(
    guesses,
    FAST_PROBE_POOL,
    async (g) => {
      if (signal?.aborted) return;
      const profile = await verify("chesscom", g, signal);
      if (!profile || !profile.displayName || isForeign(profile.country)) return;
      const sim = nameSimilarity(name, profile.displayName);
      if (sim < 0.85) return; // only a real-name match may claim the mate
      let confidence = sim >= 0.95 ? 0.75 : 0.7;
      if (locationNamesState(profile.location, state)) confidence += 0.05;
      if (!best || confidence > best.confidence) best = { platform: "chesscom", profile, confidence };
    },
    () => !!signal?.aborted
  );
  return best && (best as FastProbeHit).confidence >= FAST_PROBE_MIN_CONFIDENCE ? best : null;
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
  // Verify leads in the index's order; keep the first live, non-foreign hit.
  for (const lead of leads.slice(0, 8)) {
    if (signal?.aborted) break;
    const profile = await verify(lead.platform, lead.username, signal);
    if (profile && !isForeign(profile.country)) {
      return { name: mate.name, platform: lead.platform, username: profile.username, profile };
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
// The engine
// ---------------------------------------------------------------------------

export async function runSchoolResolution(
  input: SchoolResolverInput,
  options: SchoolResolverOptions
): Promise<SchoolResolverResult> {
  const { signal, log, hooks = {} } = options;
  const notes: string[] = [];
  const exclude = new Set((input.excludeHandles || []).map(lc));
  const t0 = Date.now();
  const since = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  // Wall-clock ceiling for the whole crawl (the school phase iterates finite
  // lists, but a full roster × months of archives can still run long). Stops
  // gracefully — whatever was found so far is still ranked and returned.
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_SCHOOL_BUDGET_MS);
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
        .findSchoolmates(affiliations[0].school, affiliations[0].state, affiliations[0].source, affiliations[0].schoolCode)
        .catch(() => null)) || [];
    for (const m of roster) if (!sameName(m.name, input.name)) mates.push(m);
  }
  // Highest-rated roster players first (likeliest to be online-active), capped.
  mates.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const pickedMates = mates.slice(0, MAX_SCHOOLMATES);
  log(`School resolver: ${school} roster has ${mates.length} other player(s); resolving the top ${pickedMates.length} to online handles…`);

  const resolved: ResolvedMate[] = [];
  // Seeded (already-known) schoolmates go in directly, verified for enrichment.
  for (const s of input.seedSchoolmates || []) {
    const profile = await verify(s.platform, s.username, signal);
    if (profile) resolved.push({ name: s.name || s.username, platform: s.platform, username: profile.username, profile });
  }

  // 2a. USCF-ANCHORED RESOLUTION (primary): roster name + state → USCF member
  //     ID (the public ratings search) → the identity engine's tournament-graph
  //     traversal — the same route the main search takes once it has a USCF ID.
  //     Runs a few mates at a time, each on a hard timeout (the engine is
  //     expensive), and stops as soon as the crawl has enough anchors.
  if (hooks.findUscfId && hooks.resolveUscfIdentity && resolved.length < USCF_MATE_TARGET && !halted()) {
    const phaseStart = Date.now();
    const phaseDeadline = phaseStart + USCF_MATE_PHASE_MS;
    // Enough anchors to crawl on: the full target, or the early target once
    // the phase runs long — 2 good seeds beat a third that costs another 60s.
    const enoughMates = () =>
      resolved.length >= USCF_MATE_TARGET ||
      (resolved.length >= USCF_MATE_EARLY_TARGET && Date.now() - phaseStart > USCF_MATE_EARLY_MS);
    const phaseHalted = () => halted() || Date.now() > phaseDeadline || enoughMates();
    log(
      `School resolver: USCF-anchored resolution — ${USCF_MATE_POOL} mate(s) at a time, ` +
        `fast path (cache + real-name probe) before each ${Math.round(USCF_MATE_TIMEOUT_MS / 1000)}s trace, ` +
        `phase cap ${Math.round(USCF_MATE_PHASE_MS / 1000)}s, stopping at ${USCF_MATE_TARGET} resolved ` +
        `(${USCF_MATE_EARLY_TARGET} after ${Math.round(USCF_MATE_EARLY_MS / 1000)}s).`
    );
    await pool(
      pickedMates,
      USCF_MATE_POOL,
      async (mate, idx) => {
        // Space successive traces out — each one fans out its own MUIR and
        // chess.com requests, and back-to-back starts invite 429s.
        if (idx >= USCF_MATE_POOL) await sleep(USCF_MATE_SPACING_MS);
        const parts = splitName(mate.name);
        if (!parts) return;
        const mateState = mate.state || affiliations[0]?.state || input.state;
        const found = await hooks
          .findUscfId!({ firstName: parts.first, lastName: parts.last, state: mateState, rating: mate.rating })
          .catch(() => null);
        if (!found) {
          log(`School resolver: no USCF member found for ${mate.name}${mateState ? ` (${mateState})` : ""} — skipping.`);
          return;
        }
        log(`School resolver: found USCF ID ${found.uscfId} for ${mate.name}${found.rating ? ` (~${found.rating} USCF)` : ""}.`);
        if (phaseHalted()) return;

        // FAST PATH 1: the search-wide resolved-identity store — a mate any
        // traversal already confirmed (this search or an earlier one) costs
        // one verification, not a trace.
        const known = getCachedIdentity(found.uscfId);
        if (known && known.confidence >= USCF_MATE_MIN_CONFIDENCE) {
          if (resolved.some((x) => x.platform === known.platform && lc(x.username) === lc(known.username))) return;
          const profile = await verify(known.platform, known.username, signal);
          if (profile && !enoughMates()) {
            resolved.push({
              name: mate.name,
              platform: known.platform,
              username: profile.username,
              profile,
              uscfId: found.uscfId,
              confidence: known.confidence,
            });
            log(
              `School resolver: resolved ${mate.name} to @${profile.username} from the search-wide cache ` +
                `(${Math.round(known.confidence * 100)}%, no trace needed).`
            );
            return;
          }
          if (enoughMates()) return;
          // Cached handle didn't verify live — fall through to the probes.
        }

        // FAST PATH 2: quick real-name guess-and-verify on Chess.com — lands
        // simple handles in a few profile GETs instead of a tournament trace.
        const fast = await fastNameProbe(mate.name, mateState, signal);
        if (fast) {
          if (resolved.some((x) => x.platform === fast.platform && lc(x.username) === lc(fast.profile.username))) return;
          if (enoughMates()) return;
          resolved.push({
            name: mate.name,
            platform: fast.platform,
            username: fast.profile.username,
            profile: fast.profile,
            uscfId: found.uscfId,
            confidence: fast.confidence,
          });
          cacheIdentity(found.uscfId, { platform: fast.platform, username: fast.profile.username, confidence: fast.confidence });
          log(
            `School resolver: fast path resolved ${mate.name} to @${fast.profile.username} ` +
              `(real profile name matches, ${Math.round(fast.confidence * 100)}%) — no tournament trace needed.`
          );
          return;
        }
        if (phaseHalted()) return;
        log(
          `School resolver: resolveUscfIdentity(uscfId=${found.uscfId}, name="${mate.name}", ` +
            `rating=${found.rating ?? mate.rating ?? "?"}, budgetMs=${USCF_MATE_TIMEOUT_MS})…`
        );
        const t0 = Date.now();
        const hit = await withTimeout(
          hooks.resolveUscfIdentity!({
            uscfId: found.uscfId,
            name: mate.name,
            rating: found.rating ?? mate.rating,
            budgetMs: USCF_MATE_TIMEOUT_MS,
          }),
          USCF_MATE_TIMEOUT_MS
        );
        const secs = Math.round((Date.now() - t0) / 1000);
        if (!hit) {
          const timedOut = Date.now() - t0 >= USCF_MATE_TIMEOUT_MS;
          log(
            `School resolver: couldn't trace USCF #${found.uscfId} (${mate.name}) to an online handle ` +
              `after ${secs}s${timedOut ? " — timed out" : ""} — continuing.`
          );
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
        if (enoughMates()) return; // target filled while we verified
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
      },
      phaseHalted
    );
    log(
      `School resolver: USCF-anchored phase finished in ${Math.round((Date.now() - phaseStart) / 1000)}s — ` +
        `${resolved.length} schoolmate(s) resolved.`
    );
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
  for (const r of resolved) exclude.add(lc(r.username));

  // --- 3. Social-graph crawl -------------------------------------------------
  // For each resolved schoolmate: friends (if a session hook exists) + frequent
  // game opponents + clubs. Aggregate into per-candidate connection counts.
  log(
    `School resolver: crawling ${resolved.length} schoolmate graph(s) — signals: ` +
      `authenticated chess.com friends ${hooks.fetchFriends ? "hook wired (used when the server has CHESSCOM_COOKIE)" : "unavailable"}, ` +
      `public game archives (last ${CC_ARCHIVE_MONTHS} months), shared clubs.`
  );
  const conns = new Map<string, Conn>(); // candidate handle → connection record
  const get = (h: string): Conn => {
    let c = conns.get(h);
    if (!c) conns.set(h, (c = { weight: new Map(), friends: new Set(), sharedClubs: new Set(), clubs: new Map() }));
    return c;
  };

  await pool(
    resolved,
    CRAWL_POOL,
    async (mate) => {
      if (signal?.aborted) return;
      const opp = mate.platform === "lichess" ? await lichessOpponents(mate.username, signal) : await chesscomOpponents(mate.username, signal);
      for (const [h, n] of opp) {
        if (n < MIN_OPP_GAMES) continue;
        const c = get(h);
        c.weight.set(mate.username, (c.weight.get(mate.username) || 0) + n);
      }
      // Authoritative friends (member-public, server-fetched) — strongest tie.
      if (hooks.fetchFriends) {
        const friends = (await hooks.fetchFriends(mate.platform, mate.username).catch(() => null)) || [];
        for (const f of friends) {
          const h = lc(f);
          if (!h) continue;
          const c = get(h);
          c.friends.add(mate.username);
          if (!c.weight.has(mate.username)) c.weight.set(mate.username, MIN_OPP_GAMES); // register the tie
        }
        if (friends.length) log(`School resolver: @${mate.username} has ${friends.length} chess.com friend(s).`);
      }
      // Shared clubs — chess.com only, since that is the one platform whose
      // club member lists are public (lichess team rosters aren't walked here,
      // so fetching them would be wasted work). A mate's small clubs are noted;
      // their members are folded in below.
      if (mate.platform === "chesscom") {
        const clubs = await fetchClubs("chesscom", mate.username, signal);
        for (const [id, members] of clubs) {
          if (members && members > BIG_CLUB_MEMBERS) continue;
          get(`club:chesscom:${id}`).clubs.set(mate.username, members);
        }
      }
    },
    halted
  );

  // Fold small-club co-membership into candidate connections: every member of a
  // schoolmate's small chess.com club becomes a candidate with a (weak) tie to
  // each schoolmate in that club — so someone in the school's own small club
  // with 2+ schoolmates clears the bar even if they never showed up as a game
  // opponent. Capped to genuinely small clubs so a big regional club (which
  // links nobody) can't flood the candidate pool.
  for (const [key, rec] of [...conns]) {
    if (!key.startsWith("club:")) continue;
    conns.delete(key);
    if (halted()) continue;
    const [, platform, clubId] = key.split(":");
    if (platform !== "chesscom") continue;
    const members = await chesscomClubMembers(clubId, signal);
    if (!members.length || members.length > SMALL_CLUB_FOR_MEMBERS) continue;
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
  }

  log(`School resolver: cohort graph crawl done ${since()} into the school phase.`);

  // --- 4. Candidates → verify → score ---------------------------------------
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
  log(`School resolver: ${candidates.length} candidate account(s) socially tied to the cohort; verifying the top ${shortlist.length}…`);

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
      // came from, but a handle live on both is a stronger identity.
      const cc = await verify("chesscom", cand.handle, signal);
      const li = await verify("lichess", cand.handle, signal);
      if (!cc && !li) {
        log(`School resolver: candidate @${cand.handle} — connected to ${[...cand.mates].join(", ")} via ${via} — no live account, dropped.`);
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
      log(
        `School resolver: candidate @${cand.handle} — connected to ${[...cand.mates].join(", ")} via ${via} — ` +
          `${Math.round(best.account.confidence * 100)}%${best.anchored ? " (federation-ID anchored)" : ""}.`
      );
    },
    halted
  );

  // Keep the strongest account per handle+platform; then per identity dedupe is
  // the resolver's job. Sort by confidence, anchored first.
  scored.sort((a, b) => Number(b.anchored) - Number(a.anchored) || b.account.confidence - a.account.confidence);
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
