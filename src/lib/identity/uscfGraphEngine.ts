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
//   3. Seed hunt — resolve ANY section player's account (direct opponents
//      first, then the whole roster) by careful name→handle guessing, with the
//      strict rule that a guess only counts when the profile's real name
//      matches. Seeds are never the answer — they are entry points.
//   4. Pairing-chain BFS — from each seed, pull their games from the event's
//      date window (Chess.com monthly archives / Lichess since-until export),
//      keep the games scoped to the event (tournament/swiss linkage, else
//      rated + expected time control), and align them 1:1 against that
//      player's crosstable rounds by checking the win/loss/draw sequence.
//      Every aligned game maps one more crosstable player to their handle —
//      player 22 reveals player 10, who reveals player 15, … — until a chain
//      reaches the target. No name needed at any hop: the pairing itself is
//      the proof.
//   5. If every event fails, recurse (depth 1) into a few direct opponents'
//      OWN online histories via the `expandMember` hook to pin *their*
//      handles, then come back and trace the shared event.
//
// A FIDE ID linked on a candidate profile is compared against the target's
// USCF-registered FIDE ID: a match is near-decisive, a hard mismatch rejects.
//
// The US Chess half (crosstables) arrives via the edge function as the
// `tournamentGraph`; this module does the online half wherever fetch exists
// (browser, or Node for the CLI harness). Hard cases legitimately take minutes.
// ============================================================================

import type { DiscoveredAccount, Evidence } from "./types";
import type { TournamentGraph, GraphEvent, GraphGame, EventPlatformInfo } from "./graphTypes";
import { verifyChesscom, verifyLichess, type VerifiedProfile } from "./verify";
import {
  nameSimilarity,
  nameMatchWeight,
  scoreFromEvidence,
  onlineRatingMatchWeight,
  graphDiscoveryWeight,
} from "./confidence";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_MS = 210_000; // exhaustive by design — the UI can abort
const EVENT_MIN_MS = 30_000; // minimum slice each event gets before moving on
const SEED_BATCH = 4; // seed candidates resolved in parallel when starving
const MAX_SEEDS_PER_EVENT = 30; // roster members we try to resolve per event
const MAX_MEMBERS_RESOLVED = 90; // global cap on name→handle seed attempts
const ROSTER_VERIFY_CAP = 40; // roster handles verified per tournament roster
const SCAN_VERIFY_CAP = 24; // opponent handles verified per archive name-scan
const DEEP_OPPONENTS = 3; // opponents whose own history we expand at depth 0
const DAY = 86_400_000;

export type OnlinePlatform = "chesscom" | "lichess";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Bounded-concurrency map — our pool of "agents". Stops feeding on abort. */
async function pool<T>(
  items: T[],
  limit: number,
  fn: (t: T, i: number) => Promise<void>,
  stop?: () => boolean
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        if (stop?.()) return;
        await fn(items[idx], idx);
      }
    })
  );
}

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
  while (d.getTime() <= last.getTime() && out.length < 6) {
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

// Lichess enforces per-IP rate limits and answers bursts with 429s (or a
// temporary ban). Space its calls out — Chess.com's CDN-backed pub API copes
// with the engine's modest parallelism as-is.
let lichessNextSlot = 0;
async function lichessThrottle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, lichessNextSlot - now);
  lichessNextSlot = Math.max(now, lichessNextSlot) + 250;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const CC_DRAW_CODES = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);

function chesscomOutcome(myResult?: string, oppResult?: string): Outcome | undefined {
  if (myResult === "win") return "w";
  if (oppResult === "win") return "l";
  if (myResult && CC_DRAW_CODES.has(myResult)) return "d";
  return undefined;
}

/** Chess.com: pull monthly archives spanning the window, keep in-window games. */
async function chesscomWindowGames(username: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<ArchiveGame[]> {
  const uLower = username.toLowerCase();
  const out: ArchiveGame[] = [];
  for (const { y, m } of monthsBetween(startMs, endMs)) {
    if (signal?.aborted) break;
    try {
      const res = await fetch(`https://api.chess.com/pub/player/${uLower}/games/${y}/${String(m).padStart(2, "0")}`, {
        headers: { Accept: "application/json" },
        signal,
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const g of Array.isArray(data.games) ? data.games : []) {
        const endT = (g.end_time || 0) * 1000;
        if (endT < startMs || endT > endMs) continue;
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
    } catch {
      /* skip this month */
    }
  }
  return out;
}

/** Lichess: pull games in the [since, until] window as NDJSON. */
async function lichessWindowGames(username: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<ArchiveGame[]> {
  const uLower = username.toLowerCase();
  const out: ArchiveGame[] = [];
  try {
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?since=${Math.floor(startMs)}&until=${Math.ceil(
      endMs
    )}&max=300&pgnInJson=false&clocks=false&evals=false&opening=false`;
    await lichessThrottle();
    let res = await fetch(url, { headers: { Accept: "application/x-ndjson" }, signal });
    if (res.status === 429 && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 2500));
      res = await fetch(url, { headers: { Accept: "application/x-ndjson" }, signal });
    }
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
  return out;
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
        const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
        if (!res.ok) return [];
        const data = await res.json();
        const players = Array.isArray(data.players) ? data.players : [];
        return players.map((p: { username?: string }) => String(p.username)).filter(Boolean);
      }
      const path = link.kind === "lichess-swiss" ? `swiss/${link.id}/results` : `tournament/${link.id}/results`;
      await lichessThrottle();
      const res = await fetch(`https://lichess.org/api/${path}?nb=400`, { headers: { Accept: "application/x-ndjson" }, signal });
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
    await lichessThrottle();
    const res = await fetch(`https://lichess.org/api/player/autocomplete?term=${encodeURIComponent(term)}&object=true`, {
      headers: { Accept: "application/json" },
      signal,
    });
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
 * Align a player's crosstable rounds with their event-scoped archive games by
 * playing order, validating the win/loss/draw sequence (and colours when the
 * crosstable knows them). Returns null unless the alignment is trustworthy.
 */
function alignRounds(rounds: RoundGame[], scoped: ArchiveGame[], viaLinkage: boolean): { pairs: AlignedPair[]; checked: number } | null {
  if (!rounds.length || rounds.length !== scoped.length) return null;
  if (!viaLinkage && rounds.length < 3) return null; // too little signal without a tournament link
  const games = [...scoped].sort((a, b) => a.endMs - b.endMs);

  let mismatches = 0;
  let checked = 0;
  const pairs: AlignedPair[] = [];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const g = games[i];
    let bad = false;
    if (g.sourceOutcome) {
      checked++;
      if (g.sourceOutcome !== r.outcome) bad = true;
    }
    if (r.color === "white" || r.color === "black") {
      if (g.sourceColor !== r.color) bad = true;
    }
    if (bad) mismatches++;
    else pairs.push({ round: r, game: g });
  }

  const allowed = viaLinkage && rounds.length >= 6 ? 1 : 0;
  if (mismatches > allowed) return null;
  if (!viaLinkage && checked < 3) return null; // outcome checksum must actually bite
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
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const outOfTime = (localDeadline?: number) => Date.now() > (localDeadline ?? deadline) || !!signal?.aborted;

  const targetId = graph.rootUscfId;
  const targetFideId = digits(opts.targetFideId) || undefined;
  const notes: string[] = [];
  const accounts: DiscoveredAccount[] = [];

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

  const directOpponents = new Set<string>();
  for (const app of appearances.get(targetId) || []) {
    for (const r of app.rounds) if (r.opponentUscfId !== targetId) directOpponents.add(r.opponentUscfId);
  }

  // --- Shared caches ----------------------------------------------------------
  const verifyCache = new Map<string, Promise<VerifiedProfile | null>>();
  const verifyOn = (platform: OnlinePlatform, handle: string): Promise<VerifiedProfile | null> => {
    const key = `${platform}:${handle.toLowerCase()}`;
    const hit = verifyCache.get(key);
    if (hit) return hit;
    const p =
      platform === "chesscom"
        ? verifyChesscom(handle, signal)
        : lichessThrottle().then(() => verifyLichess(handle, signal));
    verifyCache.set(key, p);
    return p;
  };

  const gamesCache = new Map<string, Promise<ArchiveGame[]>>();
  const windowGames = (platform: OnlinePlatform, handle: string, startMs: number, endMs: number): Promise<ArchiveGame[]> => {
    const key = `${platform}:${handle.toLowerCase()}:${Math.round(startMs / DAY)}:${Math.round(endMs / DAY)}`;
    const hit = gamesCache.get(key);
    if (hit) return hit;
    const p =
      platform === "chesscom"
        ? chesscomWindowGames(handle, startMs, endMs, signal)
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

  let seedAttempts = 0;
  const seedCache = new Map<string, Promise<VerifiedProfile | null>>();

  /** Resolve a NON-target member's account by name (guesses + autocomplete).
   *  Strictly gated on the profile's real name so a random handle can't sneak in. */
  const resolveMemberOn = (memberId: string, platform: OnlinePlatform): Promise<VerifiedProfile | null> => {
    const key = `${memberId}:${platform}`;
    const hit = seedCache.get(key);
    if (hit) return hit;
    const name = memberName.get(memberId) || "";
    const promise = (async (): Promise<VerifiedProfile | null> => {
      if (!name || memberId === targetId) return null;
      if (seedAttempts >= MAX_MEMBERS_RESOLVED) return null;
      seedAttempts++;
      const gate = (prof: VerifiedProfile): boolean => {
        const sim = prof.displayName ? nameSimilarity(name, prof.displayName) : 0;
        const handleSim = nameSimilarity(name, prof.username);
        return sim >= 0.72 || handleSim >= 0.9;
      };
      for (const h of guessHandles(name)) {
        if (outOfTime()) return null;
        if (dudHandles.has(`${platform}:${h.toLowerCase()}`)) continue;
        const prof = await verifyOn(platform, h);
        if (prof && gate(prof) && !dudHandles.has(`${platform}:${prof.username.toLowerCase()}`)) return prof;
      }
      if (platform === "lichess") {
        // Lichess offers autocomplete — still only a SEED finder for opponents.
        const t = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
        const terms = new Set<string>();
        if (t.length >= 2) terms.add(`${t[0]}${t[t.length - 1]}`.slice(0, 20));
        const last = t[t.length - 1];
        if (last && last.length >= 4) terms.add(last);
        for (const term of terms) {
          if (outOfTime()) return null;
          const handles = (await lichessAutocomplete(term, signal)).slice(0, 5);
          for (const h of handles) {
            if (outOfTime()) return null;
            if (dudHandles.has(`lichess:${h.toLowerCase()}`)) continue;
            const prof = await verifyOn("lichess", h);
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
    method: "pairing" | "roster-name" | "elimination" | "opponent-archive";
    event: GraphEvent;
    link?: EventLink;
    chain?: string[];
    viaName?: string;
    viaHandle?: string;
    round?: number;
    checkedRounds?: number;
    totalRounds?: number;
    game?: ArchiveGame;
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
    if (foundKeys.has(key)) return true;
    foundKeys.add(key);

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
    if (via.method === "pairing" || via.method === "elimination") {
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
    evidence.push({ kind: "account-verified", weight: 0.5, label: `Account confirmed live via ${platformLabel(platform)} API`, source: "uscf-graph" });
    if (effTargetRating && profile.rating) {
      evidence.push({
        kind: "rating-match",
        weight: onlineRatingMatchWeight(effTargetRating, profile.rating),
        label: `${platformLabel(platform)} rating ${profile.rating} vs ~${effTargetRating} USCF`,
        source: "uscf-graph",
      });
    }

    accounts.push({
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
    });
    const how =
      via.method === "pairing"
        ? `pairing chain ${(via.chain || []).concat(via.viaName || "").filter(Boolean).join(" → ")} in "${ev.name}"`
        : via.method === "elimination"
        ? `elimination over the tournament roster of "${ev.name}"`
        : via.method === "roster-name"
        ? `the participant roster of "${ev.name}"`
        : `tracing ${via.viaName}'s games in "${ev.name}"`;
    log(`✔ Match! ${targetName} plays ${platformLabel(platform)} as @${profile.username} — found via ${how}.`);
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

    let found = false;
    await pool(
      handles.slice(0, ROSTER_VERIFY_CAP),
      5,
      async (handle) => {
        if (found || outOfTime(localDeadline)) return;
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
          if (recordTarget(link.platform, prof, { method: "roster-name", event: ev, link })) found = true;
          return;
        }
        memberClaimed.add(best.uscfId);
        handleClaimed.add(handle.toLowerCase());
        setMapping(best.uscfId, link.platform, { profile: prof, how: "roster", chain: [] });
        // Roster-matched members are prime pairing-BFS fuel.
        if (state) enqueue(state, { memberId: best.uscfId, platform: link.platform, mapping: mapped.get(best.uscfId)!.get(link.platform)! });
      },
      () => found || outOfTime(localDeadline)
    );
    if (found) return true;

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
    /** Consecutive dud seeds per platform — a long streak with no live source
     *  means the event wasn't hosted there (e.g. it secretly ran on ICC). */
    dudStreak?: Map<OnlinePlatform, number>;
    /** Platforms where at least one section player HAS games in the window. */
    liveSources?: Set<OnlinePlatform>;
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
      state.dudStreak?.set(platform, (state.dudStreak.get(platform) || 0) + 1);
      // A name-guessed seed that never played the event is a dud: blacklist the
      // handle, unmap, and — for the target's own opponents, the highest-value
      // sources — requeue the member so their REAL account can win.
      if (mapping.how === "seed" && (dudCount.get(memberId) || 0) < 2) {
        dudCount.set(memberId, (dudCount.get(memberId) || 0) + 1);
        dudHandles.add(`${platform}:${handle.toLowerCase()}`);
        seedCache.delete(`${memberId}:${platform}`);
        mapped.get(memberId)?.delete(platform);
        if (directOpponents.has(memberId)) {
          state.seedOrder?.push(memberId);
          log(`Retrying ${srcName} with different handle guesses…`);
        }
      }
      return false;
    }
    state.liveSources?.add(platform);
    state.dudStreak?.set(platform, 0);

    // (a) New tournament linkage revealed by the source's games?
    for (const link of linksFromGames(games)) {
      if (outOfTime(localDeadline)) break;
      if (state.links.has(linkKey(link))) continue;
      state.links.set(linkKey(link), link);
      if (await tryRoster(ev, link, localDeadline, state)) return true;
    }

    // (b) Pairing alignment: source's crosstable rounds ↔ event-scoped games.
    let scoped: ArchiveGame[] = [];
    let viaLink: EventLink | undefined;
    for (const link of state.links.values()) {
      if (link.platform !== platform) continue;
      const inLink = games.filter((g) => gameInLink(g, link));
      if (inLink.length) {
        scoped = inLink;
        viaLink = link;
        break;
      }
    }
    if (!scoped.length) {
      // USCF events hosted as manual pairings were usually played as UNRATED
      // casual challenges (so they wouldn't double-rate), while the surrounding
      // noise (kids' bullet marathons) is mostly rated — so do NOT require
      // rated here; the expected time class is the useful filter.
      const classes = expectedTimeClasses(ev);
      scoped = games.filter((g) => !g.timeClass || classes.has(g.timeClass));
    }

    let alignment = alignRounds(app.rounds, scoped, !!viaLink);
    if (!alignment && !viaLink) {
      // Second try: only the unrated games — manually-paired USCF events were
      // played unrated, so this strips the rated casual noise around them.
      const unrated = scoped.filter((g) => !g.rated);
      if (unrated.length && unrated.length !== scoped.length) {
        alignment = alignRounds(app.rounds, unrated, false);
      }
    }
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
      for (const { round, game } of alignment.pairs) {
        if (outOfTime(localDeadline)) break;
        const oppId = round.opponentUscfId;
        const prof = await verifyOn(platform, game.oppHandle);
        if (!prof) continue;
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
            return true;
          continue;
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
      .slice(0, SCAN_VERIFY_CAP)
      .map((c) => c.g);
    // Record this source's scoped opponents for later sources' ranking.
    for (const k of scopedKeys) state.oppSeen.set(k, (state.oppSeen.get(k) || 0) + 1);

    const roster = ev.players;
    let found = false;
    await pool(
      candidates,
      5,
      async (g) => {
        if (found || outOfTime(localDeadline)) return;
        const prof = await verifyOn(platform, g.oppHandle);
        if (!prof) return;
        const nm = prof.displayName || prof.username;
        const simTarget = nameSimilarity(targetName, nm);
        if ((prof.displayName && simTarget >= 0.78) || (!prof.displayName && simTarget >= 0.9)) {
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
  // Work one event to exhaustion (platform → roster → seeds → pairing BFS).
  // ---------------------------------------------------------------------------
  interface WorkState extends EventState {
    seedOrder: string[];
    platforms: OnlinePlatform[] | null;
    seedIdx: number;
    seedsTried: number;
    lichessSeedMisses: number;
    lichessSeedHits: number;
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
        seedsTried: 0,
        lichessSeedMisses: 0,
        lichessSeedHits: 0,
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
    for (const link of Array.from(state.links.values())) {
      if (outOfTime(localDeadline)) return false;
      if (await tryRoster(ev, link, localDeadline, state)) return true;
    }

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
      // every other section player — the full brute-force sweep hard cases need.
      ws.seedOrder = [
        ...roster.filter((p) => oppHere.has(p.uscfId)).map((p) => p.uscfId),
        ...roster.filter((p) => p.uscfId !== targetId && !oppHere.has(p.uscfId)).map((p) => p.uscfId),
      ].filter((id, i, arr) => arr.indexOf(id) === i);
      log(
        `Working "${ev.name}"${ev.sectionName ? ` — ${ev.sectionName}` : ""} (${ev.ratingSystem}${
          ev.startDate ? `, ${ev.startDate}` : ""
        }): ${roster.length} players, ${oppHere.size} direct opponents, platform ${platforms.map(platformLabel).join(" + ")}.`
      );
    } else {
      log(`Back to "${ev.name}" with time to spare — resuming where we left off.`);
    }

    // 4. BFS with lazy seeding.
    while (!outOfTime(localDeadline)) {
      if (!state.frontier.length) {
        // Starving — resolve the next batch of seed candidates by name. Keep a
        // healthy reserve of the event slice for actually TRACING the seeds
        // (resolution is the expensive, throttled part and must not eat it all).
        if (localDeadline - Date.now() < 20_000) break;
        const batch: string[] = [];
        while (batch.length < SEED_BATCH && ws.seedIdx < ws.seedOrder.length && ws.seedsTried < MAX_SEEDS_PER_EVENT) {
          const memberId = ws.seedOrder[ws.seedIdx++];
          ws.seedsTried++;
          if (platforms.some((p) => !mapped.get(memberId)?.has(p))) batch.push(memberId);
        }
        if (!batch.length) {
          // No seeds left AND nothing queued — this event has nothing more to give.
          ws.exhausted = true;
          break;
        }
        const order = [...platforms].sort((a, b) => (a === "chesscom" ? -1 : 0) - (b === "chesscom" ? -1 : 0));
        await Promise.all(
          batch.map(async (memberId) => {
            // Chess.com first (fast, parallel-friendly); Lichess only when it
            // fails — Lichess's per-IP limits make speculative guessing dear.
            for (const platform of order) {
              if (outOfTime(localDeadline)) return;
              if (mapped.get(memberId)?.has(platform)) continue;
              if (platform === "lichess" && platforms.length > 1 && ws.lichessSeedMisses >= 5 && ws.lichessSeedHits === 0) continue;
              const prof = await resolveMemberOn(memberId, platform);
              if (prof) {
                if (platform === "lichess") ws.lichessSeedHits++;
                setMapping(memberId, platform, { profile: prof, how: "seed", chain: [] });
                enqueue(state, { memberId, platform, mapping: mapped.get(memberId)!.get(platform)! });
                log(`Found ${platformLabel(platform)} @${prof.username} for section player ${memberName.get(memberId)} — tracing their event games…`);
                return; // one platform is enough for a seed
              }
              if (platform === "lichess") ws.lichessSeedMisses++;
            }
          })
        );
        continue;
      }

      const src = state.frontier.shift()!;
      const vkey = `${src.memberId}:${src.platform}`;
      if (state.visited.has(vkey)) continue;
      state.visited.add(vkey);
      if (await traceFromSource(ev, state, src.memberId, src.platform, src.mapping, localDeadline)) return true;
    }

    // Last chance for this event: if the flyer search never ran (the platform
    // was already guessed), run it now — a flyer can hand us the exact
    // tournament page even when no seed could be resolved from names.
    if (!outOfTime(localDeadline) && hooks.discoverPlatform && !discoverCache.has(ev.eventId)) {
      await collectFlyerLinks();
      for (const link of Array.from(state.links.values())) {
        if (outOfTime(localDeadline)) break;
        if (await tryRoster(ev, link, localDeadline, state)) return true;
      }
      // The roster may have mapped fresh sources — drain the pairing frontier.
      while (!outOfTime(localDeadline) && state.frontier.length) {
        const src = state.frontier.shift()!;
        const vkey = `${src.memberId}:${src.platform}`;
        if (state.visited.has(vkey)) continue;
        state.visited.add(vkey);
        if (await traceFromSource(ev, state, src.memberId, src.platform, src.mapping, localDeadline)) return true;
      }
    }
    return false;
  };

  // ---------------------------------------------------------------------------
  // Main loop: every online event, one by one, in the most promising order.
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

  const totalOpp = directOpponents.size;
  log(
    `Tournament-first search for ${targetName}: ${events.length} online event${events.length === 1 ? "" : "s"}, ${totalOpp} direct opponent${
      totalOpp === 1 ? "" : "s"
    } to work with. Name-based platform search stays OFF unless every event is exhausted.`
  );

  let found = false;
  for (let pass = 0; pass < 4 && !found && !outOfTime(); pass++) {
    const pending = events.filter((e) => !workStates.get(e.eventId)?.exhausted);
    if (!pending.length) break;
    if (pass > 0) {
      log(
        `${Math.round((deadline - Date.now()) / 1000)}s left on the clock and ${pending.length} event(s) still have open leads — going back in.`
      );
    }
    for (let i = 0; i < pending.length && !found; i++) {
      if (outOfTime()) break;
      const remaining = deadline - Date.now();
      const slice = Math.max(EVENT_MIN_MS, Math.floor(remaining / (pending.length - i)));
      found = await workEvent(pending[i], Math.min(deadline, Date.now() + slice));
      if (!found && !outOfTime() && pass === 0) log(`"${pending[i].name}" didn't give up the username yet — moving on for now.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Deep phase: recurse into direct opponents' own online histories.
  // ---------------------------------------------------------------------------
  if (!found && depth === 0 && hooks.expandMember && deadline - Date.now() > 35_000) {
    const oppByPresence = Array.from(directOpponents)
      .filter((id) => !mapped.has(id))
      .sort((a, b) => (appearances.get(b)?.length || 0) - (appearances.get(a)?.length || 0))
      .slice(0, DEEP_OPPONENTS);
    if (oppByPresence.length) {
      log(`Still nothing — going deeper: exploring ${oppByPresence.length} opponents' own tournament histories to pin their usernames first.`);
    }
    for (const oppId of oppByPresence) {
      if (found || outOfTime() || deadline - Date.now() < 25_000) break;
      const oppName = memberName.get(oppId) || "opponent";
      const sub = await hooks.expandMember(oppId).catch(() => null);
      if (!sub || !sub.onlineEvents.length) continue;
      log(`Deep dive: ${oppName} played ${sub.onlineEvents.length} online event(s) of their own — tracing those…`);
      const subResult = await runGraphTraversal(sub, {
        targetName: oppName,
        targetRating: memberRating.get(oppId),
        signal,
        log,
        budgetMs: Math.min(60_000, deadline - Date.now() - 15_000),
        hooks: { discoverPlatform: hooks.discoverPlatform }, // no further expansion
        depth: 1,
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
          found = await traceFromSource(app.event, state, oppId, platform, mapped.get(oppId)!.get(platform)!, deadline);
          // Follow any frontier the trace opened up.
          while (!found && state.frontier.length && !outOfTime()) {
            const nxt = state.frontier.shift()!;
            const vkey = `${nxt.memberId}:${nxt.platform}`;
            if (state.visited.has(vkey)) continue;
            state.visited.add(vkey);
            found = await traceFromSource(app.event, state, nxt.memberId, nxt.platform, nxt.mapping, deadline);
          }
        }
      }
    }
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
