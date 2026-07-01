// ============================================================================
// USCF tournament-graph traversal — the multi-agent discovery engine
//
// This is the "detective" at the heart of ScoutTree. Online usernames rarely
// match real names, so guessing handles from a name fails for most players.
// Instead we replicate — and parallelise — the manual workflow a serious
// scout does by hand:
//
//   target → an online-rated USCF section they played → the crosstable gives
//   the EXACT opponents (USCF id + colour + round) → find one opponent's
//   Chess.com / Lichess account → pull that opponent's games from the event's
//   date window → the other side of their game against the target IS the
//   target's online account → verify by name and record it.
//
// The US Chess half (section rosters + per-game opponents) arrives from the
// edge function as the `tournamentGraph`. This module does the online half in
// the browser (Chess.com / Lichess APIs are CORS-friendly), fanning work across
// several concurrent "agents", caching aggressively, and narrating every step
// into the live search UI. Hard cases legitimately take 1–3 minutes.
//
// Phase 1 — trace the target's DIRECT opponents on both platforms (primary).
// Phase 2 — propagation / depth-2: use section-mates we *can* resolve to
//           uncover a hard-to-name direct opponent's handle, then trace them.
// ============================================================================

import type { DiscoveredAccount, Provider, PartialIdentity, Evidence, Platform } from "../types";
import {
  getTournamentGraph,
  type TournamentGraph,
  type GraphEvent,
  type GraphGame,
} from "./edgeClient";
import { verifyChesscom, verifyLichess, type VerifiedProfile } from "../verify";
import {
  nameSimilarity,
  nameMatchWeight,
  scoreFromEvidence,
  onlineRatingMatchWeight,
  graphDiscoveryWeight,
} from "../confidence";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const DEFAULT_BUDGET_MS = 110_000; // hard cases run long — this is the ceiling
const RESOLVE_CONCURRENCY = 6; // parallel "agents" resolving opponent accounts
const MAX_MEMBERS_RESOLVED = 70; // safety cap on distinct opponents we probe
const CANDIDATE_VERIFY_CAP = 26; // distinct opponent handles verified per archive
const DAY = 86_400_000;

type OnlinePlatform = "chesscom" | "lichess";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Bounded-concurrency map — our pool of "agents". Stops feeding on abort. */
async function pool<T>(items: T[], limit: number, fn: (t: T, i: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        if (signal?.aborted) return;
        await fn(items[idx], idx);
      }
    })
  );
}

/** Generate plausible Chess.com/Lichess handles from a real name. */
function guessHandles(name: string): string[] {
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
    add(`${first[0]}${last}`);
    add(`${last}${first}`);
    add(`${first}${last}1`);
    add(`${first}${last}chess`);
    add(`${last}${first[0]}`);
  }
  add(clean.replace(/\s/g, ""));
  if (first) add(first);
  if (last) add(last);
  return Array.from(g).slice(0, 10);
}

function platformLabel(p: OnlinePlatform): string {
  return p === "lichess" ? "Lichess" : "Chess.com";
}

const mirror = (c: GraphGame["color"]): "white" | "black" | undefined =>
  c === "white" ? "black" : c === "black" ? "white" : undefined;

/** Event date window in ms, generously padded (online events run for weeks). */
function windowFor(ev: GraphEvent): { startMs: number; endMs: number; label: string } {
  const start = ev.startDate ? Date.parse(ev.startDate) : NaN;
  const end = ev.endDate ? Date.parse(ev.endDate) : NaN;
  const s = isNaN(start) ? (isNaN(end) ? Date.now() - 120 * DAY : end - 45 * DAY) : start - 2 * DAY;
  const e = isNaN(end) ? (isNaN(start) ? Date.now() : start + 45 * DAY) : end + 2 * DAY;
  return { startMs: s, endMs: e, label: ev.startDate ? ev.startDate.slice(0, 7) : "the event window" };
}

// ---------------------------------------------------------------------------
// Date-windowed game fetchers (the "date-based game search")
// ---------------------------------------------------------------------------

interface ArchiveGame {
  oppHandle: string; // the OTHER player's username
  sourceColor: "white" | "black"; // colour the source account had
  endMs: number;
  rated: boolean;
  timeClass?: string;
  url?: string;
  /** Chess.com tournament this game belonged to, if any (the golden signal). */
  tournament?: string;
}

function monthsBetween(startMs: number, endMs: number): { y: number; m: number }[] {
  const out: { y: number; m: number }[] = [];
  const d = new Date(startMs);
  d.setUTCDate(1);
  const last = new Date(endMs);
  while (d.getTime() <= last.getTime() && out.length < 6) {
    out.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
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
        const opp = sourceColor === "white" ? g.black?.username : g.white?.username;
        if (!opp || opp.toLowerCase() === uLower) continue;
        out.push({
          oppHandle: opp,
          sourceColor,
          endMs: endT,
          rated: g.rated !== false,
          timeClass: g.time_class,
          url: g.url,
          tournament: typeof g.tournament === "string" ? g.tournament : undefined,
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
    const res = await fetch(url, { headers: { Accept: "application/x-ndjson" }, signal });
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
      const w = g.players?.white?.user;
      const b = g.players?.black?.user;
      const wId = (w?.id || w?.name || "").toLowerCase();
      const sourceColor: "white" | "black" = wId === uLower ? "white" : "black";
      const oppUser = sourceColor === "white" ? b : w;
      const oppHandle = oppUser?.name || oppUser?.id;
      if (!oppHandle || oppHandle.toLowerCase() === uLower) continue;
      const endT = g.lastMoveAt || g.createdAt || 0;
      out.push({ oppHandle, sourceColor, endMs: endT, rated: g.rated !== false, timeClass: g.speed });
    }
  } catch {
    /* rate-limited or blocked — degrade */
  }
  return out;
}

function windowGames(platform: OnlinePlatform, username: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<ArchiveGame[]> {
  return platform === "chesscom"
    ? chesscomWindowGames(username, startMs, endMs, signal)
    : lichessWindowGames(username, startMs, endMs, signal);
}

// Many USCF online events were run as Chess.com tournaments whose slug mirrors
// the event name. A single tournament-flagged game in an opponent's archive
// reveals the slug, and this endpoint then hands us the EXACT participant list
// — i.e. every section-mate's real online handle, however cryptic. This is the
// most reliable link we have from a USCF crosstable to online usernames.
const tournamentCache = new Map<string, Promise<string[]>>();

function chesscomTournamentPlayers(tournamentUrl: string, signal?: AbortSignal): Promise<string[]> {
  const cached = tournamentCache.get(tournamentUrl);
  if (cached) return cached;
  const p = (async (): Promise<string[]> => {
    try {
      // Games carry the API url already (https://api.chess.com/pub/tournament/<slug>).
      const url = tournamentUrl.startsWith("http") ? tournamentUrl : `https://api.chess.com/pub/tournament/${tournamentUrl}`;
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
      if (!res.ok) return [];
      const data = await res.json();
      const players = Array.isArray(data.players) ? data.players : [];
      return players.map((p: { username?: string }) => String(p.username)).filter(Boolean);
    } catch {
      return [];
    }
  })();
  tournamentCache.set(tournamentUrl, p);
  return p;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** One appearance of a member in an online section: window + who they faced. */
interface Appearance {
  event: GraphEvent;
  startMs: number;
  endMs: number;
  opponents: { uscfId: string; name: string; color: GraphGame["color"] }[];
}

export interface TraversalOptions {
  targetName: string;
  /** The target's USCF online rating (or approx rating), for corroboration. */
  targetRating?: number;
  signal?: AbortSignal;
  log: (message: string) => void;
  budgetMs?: number;
}

export interface TraversalResult {
  accounts: DiscoveredAccount[];
  notes: string[];
  /** Whether at least one online account was traced back to the target. */
  found: boolean;
}

export async function runGraphTraversal(graph: TournamentGraph, opts: TraversalOptions): Promise<TraversalResult> {
  const { targetName, signal, log } = opts;
  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const outOfTime = () => Date.now() > deadline || !!signal?.aborted;

  const targetId = graph.rootUscfId;
  const notes: string[] = [];
  const accounts: DiscoveredAccount[] = [];
  const foundKeys = new Set<string>(); // platform:handle already recorded

  // --- Build indices over the whole online mesh ------------------------------
  const memberName = new Map<string, string>();
  const memberRating = new Map<string, number>();
  const appearances = new Map<string, Appearance[]>(); // memberId → appearances
  for (const ev of graph.onlineEvents) {
    const { startMs, endMs } = windowFor(ev);
    for (const p of ev.players) {
      memberName.set(p.uscfId, p.name);
      if (p.rating) memberRating.set(p.uscfId, p.rating);
      const app: Appearance = {
        event: ev,
        startMs,
        endMs,
        opponents: p.games.map((g) => ({ uscfId: g.opponentUscfId, name: g.opponentName, color: g.color })),
      };
      const list = appearances.get(p.uscfId) || [];
      list.push(app);
      appearances.set(p.uscfId, list);
    }
  }

  // The target's own USCF online rating (from their crosstable row) is a good
  // fallback for corroborating a discovered account when no rating was passed in.
  const effTargetRating = opts.targetRating ?? memberRating.get(targetId);

  // Direct opponents of the target (union across all their online sections).
  const directOpponents = new Set<string>();
  for (const app of appearances.get(targetId) || []) {
    for (const o of app.opponents) if (o.uscfId && o.uscfId !== targetId) directOpponents.add(o.uscfId);
  }

  const totalOpp = directOpponents.size;
  const eventCount = graph.onlineEvents.length;
  log(
    `Tracing ${eventCount} online event${eventCount > 1 ? "s" : ""} and ${totalOpp} direct opponent${
      totalOpp === 1 ? "" : "s"
    } of ${targetName}…`
  );

  // --- Shared caches (avoid re-fetching the same account/handle) -------------
  const resolveCache = new Map<string, Promise<{ chesscom?: VerifiedProfile; lichess?: VerifiedProfile }>>();
  const verifyCache = new Map<string, Promise<VerifiedProfile | null>>();
  let resolvedCount = 0;

  const verifyOn = (platform: OnlinePlatform, handle: string): Promise<VerifiedProfile | null> => {
    const key = `${platform}:${handle.toLowerCase()}`;
    const hit = verifyCache.get(key);
    if (hit) return hit;
    const p = platform === "chesscom" ? verifyChesscom(handle, signal) : verifyLichess(handle, signal);
    verifyCache.set(key, p);
    return p;
  };

  /** Resolve a member's Chess.com + Lichess accounts by name (gated on name). */
  const resolveMember = (memberId: string): Promise<{ chesscom?: VerifiedProfile; lichess?: VerifiedProfile }> => {
    const cached = resolveCache.get(memberId);
    if (cached) return cached;
    const name = memberName.get(memberId) || "";
    const promise = (async () => {
      const result: { chesscom?: VerifiedProfile; lichess?: VerifiedProfile } = {};
      if (!name || resolvedCount >= MAX_MEMBERS_RESOLVED) return result;
      resolvedCount++;
      const handles = guessHandles(name);
      for (const platform of ["chesscom", "lichess"] as OnlinePlatform[]) {
        if (outOfTime()) break;
        for (const h of handles) {
          if (outOfTime()) break;
          const prof = await verifyOn(platform, h);
          if (!prof) continue;
          const sim = prof.displayName ? nameSimilarity(name, prof.displayName) : 0;
          const handleSim = nameSimilarity(name, prof.username);
          // Accept only if we're reasonably sure this handle IS this opponent:
          // a matching real name, or a handle that clearly encodes the name.
          if (sim >= 0.72 || handleSim >= 0.9) {
            result[platform] = prof;
            break;
          }
        }
      }
      return result;
    })();
    resolveCache.set(memberId, promise);
    return promise;
  };

  // --- Record a discovered target account ------------------------------------
  const recordTarget = (
    platform: OnlinePlatform,
    profile: VerifiedProfile,
    via: { name: string; handle: string; tournament?: string; eliminated?: boolean },
    ev: GraphEvent,
    game: ArchiveGame | undefined,
    sim: number
  ) => {
    const key = `${platform}:${profile.username.toLowerCase()}`;
    if (foundKeys.has(key)) return;
    foundKeys.add(key);

    const dateStr = game ? new Date(game.endMs).toISOString().slice(0, 10) : (ev.startDate || "").slice(0, 10);
    // The target's colour vs this opponent, mirrored, should equal the opponent's
    // colour in the archived game (only checkable when we have the game).
    const colorOk =
      !!game &&
      (() => {
        const tGame = (appearances.get(targetId) || [])
          .find((a) => a.event.eventId === ev.eventId)
          ?.opponents.find((o) => o.name === via.name || memberName.get(o.uscfId) === via.name);
        const want = tGame ? mirror(tGame.color) : undefined;
        return want ? want === game.sourceColor : false;
      })();

    const evidence: Evidence[] = [];
    if (!via.eliminated) {
      evidence.push({
        kind: "name-match",
        weight: nameMatchWeight(sim) + (profile.displayName ? 0.3 : 0),
        label: profile.displayName
          ? `${platformLabel(platform)} name "${profile.displayName}" matches "${targetName}"`
          : `${platformLabel(platform)} handle "${profile.username}" matches "${targetName}"`,
        source: "uscf-graph",
      });
    }
    evidence.push({
      kind: "shared-opponent",
      weight: graphDiscoveryWeight(true, via.tournament ? 2 : 1),
      label: via.tournament
        ? `Faced USCF opponent ${via.name} (@${via.handle}) in the Chess.com tournament hosting "${ev.name}"`
        : `Played USCF online opponent ${via.name} (@${via.handle}) in "${ev.name}"`,
      source: "uscf-graph",
    });
    if (via.tournament) {
      evidence.push({
        kind: "tournament-overlap",
        weight: 1.6,
        label: `Confirmed participant of the Chess.com tournament that hosted "${ev.name}" (${ev.ratingSystem})`,
        source: "uscf-graph",
      });
    } else if (game) {
      evidence.push({
        kind: "tournament-overlap",
        weight: 1.0,
        label: `Game dated ${dateStr} falls inside "${ev.name}" (${ev.ratingSystem})`,
        source: "uscf-graph",
      });
    }
    if (via.eliminated) {
      evidence.push({
        kind: "cross-reference",
        weight: 1.6,
        label: `The only tournament participant left unmatched to the crosstable — by elimination, ${targetName}`,
        source: "uscf-graph",
      });
    }
    if (colorOk) {
      evidence.push({ kind: "cross-reference", weight: 0.5, label: "Colours match the crosstable pairing", source: "uscf-graph" });
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
      gamesFound: profile.gamesFound,
      lastActive: profile.lastActiveMs ? new Date(profile.lastActiveMs).toISOString() : undefined,
      profileUrl: profile.profileUrl,
      verified: true,
      confidence: scoreFromEvidence(evidence, -0.5),
      evidence,
    });
    log(
      `✔ Match! ${targetName} plays ${platformLabel(platform)} as @${profile.username} — ${
        via.eliminated ? `identified by elimination in ${via.name}'s tournament` : `traced via ${via.name}`
      }.`
    );
  };

  interface ScanHit {
    profile: VerifiedProfile;
    game?: ArchiveGame;
    sim: number;
    tournament?: string;
    eliminated?: boolean;
  }

  /**
   * Scan `source`'s window games for the `wanted` members. Two mechanisms:
   *   1. Chess.com tournament linkage — if any in-window game belonged to a
   *      Chess.com tournament (most USCF online events were), pull the tournament's
   *      exact participant list and match those handles to the crosstable. This
   *      recovers even cryptic handles, and pins the target by *elimination* when
   *      every other participant is matched.
   *   2. Direct name match — verify in-window opponent handles and match their
   *      real names to the wanted members (works on both platforms).
   */
  const scanArchiveFor = async (
    platform: OnlinePlatform,
    source: VerifiedProfile,
    windows: { startMs: number; endMs: number }[],
    wanted: { uscfId: string; name: string }[],
    ctx?: { roster?: { uscfId: string; name: string }[]; sourceMemberId?: string }
  ): Promise<Map<string, ScanHit>> => {
    const hits = new Map<string, ScanHit>();
    if (!wanted.length) return hits;

    // Merge windows, fetch games.
    const games: ArchiveGame[] = [];
    const seenSpan = new Set<string>();
    for (const w of windows) {
      const span = `${Math.round(w.startMs / DAY)}:${Math.round(w.endMs / DAY)}`;
      if (seenSpan.has(span)) continue;
      seenSpan.add(span);
      if (outOfTime()) break;
      games.push(...(await windowGames(platform, source.username, w.startMs, w.endMs, signal)));
    }
    if (!games.length) return hits;

    const byHandle = new Map<string, ArchiveGame>();
    for (const g of games.sort((a, b) => Number(b.rated) - Number(a.rated))) {
      const k = g.oppHandle.toLowerCase();
      if (!byHandle.has(k)) byHandle.set(k, g);
    }

    // (1) Chess.com tournament participants — the golden handle set.
    const tournamentByHandle = new Map<string, string>();
    const participantHandles: string[] = [];
    let tournamentUsed: string | undefined;
    if (platform === "chesscom") {
      const tUrls = Array.from(new Set(games.map((g) => g.tournament).filter(Boolean))).slice(0, 4) as string[];
      for (const tu of tUrls) {
        if (outOfTime()) break;
        const players = await chesscomTournamentPlayers(tu, signal);
        if (!players.length) continue;
        tournamentUsed ||= tu;
        for (const h of players) {
          const k = h.toLowerCase();
          if (k === source.username.toLowerCase()) continue;
          if (!tournamentByHandle.has(k)) {
            tournamentByHandle.set(k, tu);
            participantHandles.push(h);
          }
        }
      }
      if (participantHandles.length) {
        log(`Linked to a Chess.com tournament — matching its ${participantHandles.length} participants to the crosstable…`);
      }
    }

    // Candidate handles: tournament participants first, then in-window opponents.
    const candMap = new Map<string, { handle: string; game?: ArchiveGame }>();
    for (const h of participantHandles) candMap.set(h.toLowerCase(), { handle: h, game: byHandle.get(h.toLowerCase()) });
    for (const [k, g] of byHandle) if (!candMap.has(k)) candMap.set(k, { handle: g.oppHandle, game: g });
    const candidates = Array.from(candMap.values()).slice(0, CANDIDATE_VERIFY_CAP + participantHandles.length);
    if (!participantHandles.length) {
      log(`Scanning ${candidates.length} of @${source.username}'s ${platformLabel(platform)} games from the event window…`);
    }

    // Elimination bookkeeping: which roster members / participant handles got claimed.
    const roster = ctx?.roster || [];
    const memberClaimed = new Set<string>(ctx?.sourceMemberId ? [ctx.sourceMemberId] : []);
    const handleClaimed = new Set<string>();

    await pool(
      candidates,
      5,
      async ({ handle, game }) => {
        if (outOfTime()) return;
        const prof = await verifyOn(platform, handle);
        if (!prof) return;
        const nm = prof.displayName || prof.username;
        const isParticipant = tournamentByHandle.has(handle.toLowerCase());
        // Match against the target(s) we're hunting.
        for (const w of wanted) {
          const sim = nameSimilarity(w.name, nm);
          const ok = prof.displayName ? sim >= 0.78 : sim >= 0.9;
          if (ok) {
            const prev = hits.get(w.uscfId);
            if (!prev || sim > prev.sim) {
              hits.set(w.uscfId, { profile: prof, game, sim, tournament: isParticipant ? tournamentByHandle.get(handle.toLowerCase()) : undefined });
            }
          }
        }
        // Elimination bookkeeping — match participants to roster members by name.
        if (isParticipant && roster.length && prof.displayName) {
          for (const m of roster) {
            if (nameSimilarity(m.name, prof.displayName) >= 0.78) {
              memberClaimed.add(m.uscfId);
              handleClaimed.add(handle.toLowerCase());
            }
          }
        }
      },
      signal
    );

    // (2b) Elimination: if this is a tournament and every roster member but the
    // target is matched to a participant, the lone leftover handle IS the target.
    if (tournamentUsed && roster.length) {
      for (const w of wanted) {
        if (hits.has(w.uscfId) || !roster.some((m) => m.uscfId === w.uscfId)) continue;
        const unmatchedMembers = roster.filter((m) => m.uscfId !== w.uscfId && !memberClaimed.has(m.uscfId));
        const unclaimed = participantHandles.filter((h) => !handleClaimed.has(h.toLowerCase()));
        if (unmatchedMembers.length === 0 && unclaimed.length === 1) {
          const prof = await verifyOn(platform, unclaimed[0]);
          if (prof) hits.set(w.uscfId, { profile: prof, sim: 0, tournament: tournamentUsed, eliminated: true });
        }
      }
    }
    return hits;
  };

  // --- PHASE 1: trace the target's direct opponents --------------------------
  const opponentList = Array.from(directOpponents);
  await pool(
    opponentList,
    RESOLVE_CONCURRENCY,
    async (oppId) => {
      if (outOfTime() || accounts.length) return;
      const oppName = memberName.get(oppId) || "opponent";
      const apps = (appearances.get(oppId) || []).filter((a) =>
        (appearances.get(targetId) || []).some((ta) => ta.event.eventId === a.event.eventId)
      );
      if (!apps.length) return;

      const acc = await resolveMember(oppId);
      if (!acc.chesscom && !acc.lichess) {
        log(`No online account found for opponent ${oppName}.`);
        return;
      }
      for (const platform of ["chesscom", "lichess"] as OnlinePlatform[]) {
        if (outOfTime() || accounts.length) break;
        const profile = acc[platform];
        if (!profile) continue;
        log(`Found ${platformLabel(platform)} @${profile.username} for opponent ${oppName} — checking their games for ${targetName}…`);
        // Scan per shared event so the crosstable roster (for tournament
        // matching / elimination) lines up with the games' date window.
        for (const app of apps) {
          if (outOfTime() || accounts.length) break;
          const ev = app.event;
          const roster = ev.players.map((p) => ({ uscfId: p.uscfId, name: p.name }));
          const hits = await scanArchiveFor(
            platform,
            profile,
            [{ startMs: app.startMs, endMs: app.endMs }],
            [{ uscfId: targetId, name: targetName }],
            { roster, sourceMemberId: oppId }
          );
          const hit = hits.get(targetId);
          if (hit) {
            recordTarget(
              platform,
              hit.profile,
              { name: oppName, handle: profile.username, tournament: hit.tournament, eliminated: hit.eliminated },
              ev,
              hit.game,
              hit.sim
            );
            break;
          }
        }
      }
    },
    signal
  );

  // --- PHASE 2: propagation / depth-2 ----------------------------------------
  // If no direct opponent could be resolved by name, use the section-mates we
  // *can* resolve to reveal a hard-to-name opponent's handle, then trace them.
  if (!accounts.length && !outOfTime()) {
    // Candidate "helper" section-mates: everyone in the target's sections who is
    // not the target. Resolving them can reveal a direct opponent's handle we
    // couldn't guess from their name alone.
    const helpers = new Set<string>();
    for (const app of appearances.get(targetId) || []) {
      for (const p of app.event.players) {
        if (p.uscfId !== targetId) helpers.add(p.uscfId);
      }
    }
    const helperList = Array.from(helpers).slice(0, MAX_MEMBERS_RESOLVED);
    if (helperList.length) log(`Expanding the search: resolving ${helperList.length} section-mates to uncover hidden opponents…`);

    await pool(
      helperList,
      RESOLVE_CONCURRENCY,
      async (helperId) => {
        if (outOfTime() || accounts.length) return;
        const acc = await resolveMember(helperId);
        for (const platform of ["chesscom", "lichess"] as OnlinePlatform[]) {
          if (outOfTime() || accounts.length) break;
          const profile = acc[platform];
          if (!profile) continue;
          // Which of THIS helper's opponents are unresolved direct opponents of T?
          const helperApps = appearances.get(helperId) || [];
          const wanted: { uscfId: string; name: string }[] = [];
          for (const a of helperApps) {
            for (const o of a.opponents) {
              if (directOpponents.has(o.uscfId)) wanted.push({ uscfId: o.uscfId, name: o.name });
            }
          }
          if (!wanted.length) continue;
          const windows = helperApps.map((a) => ({ startMs: a.startMs, endMs: a.endMs }));
          const helperRoster = new Map<string, { uscfId: string; name: string }>();
          for (const a of helperApps) for (const p of a.event.players) helperRoster.set(p.uscfId, { uscfId: p.uscfId, name: p.name });
          const found = await scanArchiveFor(platform, profile, windows, wanted, {
            roster: Array.from(helperRoster.values()),
            sourceMemberId: helperId,
          });
          // Each uncovered direct opponent → trace THEM for the target.
          for (const [oppId, info] of found) {
            if (outOfTime() || accounts.length) break;
            const oppName = memberName.get(oppId) || "opponent";
            log(`Uncovered opponent ${oppName} as @${info.profile.username} via a section-mate — tracing them…`);
            const oppApps = (appearances.get(oppId) || []).filter((a) =>
              (appearances.get(targetId) || []).some((ta) => ta.event.eventId === a.event.eventId)
            );
            for (const app of oppApps) {
              if (outOfTime() || accounts.length) break;
              const ev = app.event;
              const roster = ev.players.map((p) => ({ uscfId: p.uscfId, name: p.name }));
              const hits = await scanArchiveFor(
                platform,
                info.profile,
                [{ startMs: app.startMs, endMs: app.endMs }],
                [{ uscfId: targetId, name: targetName }],
                { roster, sourceMemberId: oppId }
              );
              const hit = hits.get(targetId);
              if (hit) {
                recordTarget(
                  platform,
                  hit.profile,
                  { name: oppName, handle: info.profile.username, tournament: hit.tournament, eliminated: hit.eliminated },
                  ev,
                  hit.game,
                  hit.sim
                );
                break;
              }
            }
          }
        }
      },
      signal
    );
  }

  accounts.sort((a, b) => b.confidence - a.confidence);
  if (accounts.length) {
    notes.push(`Traced ${accounts.length} online account(s) via tournament-graph opponents.`);
  } else if (outOfTime() && !signal?.aborted) {
    notes.push("Tournament-graph traversal reached its time budget without a confident online match.");
    log("Reached the time budget — no confident online username from the graph yet.");
  } else {
    notes.push("Traversed the tournament graph; no online username inferred from opponents' games.");
  }

  return { accounts, notes, found: accounts.length > 0 };
}

// ---------------------------------------------------------------------------
// Provider wrapper (kept for the resolver's DEEP_PROVIDERS registration and any
// direct provider use). The resolver also calls runGraphTraversal directly to
// make traversal the *primary* discovery path.
// ---------------------------------------------------------------------------

export const uscfGraphProvider: Provider = {
  name: "uscf-graph",
  label: "Tournament graph",
  enabled: () => true,
  async run({ query, signal, log }) {
    const graph = await getTournamentGraph(query, signal).catch(() => null);
    if (!graph || !graph.graphTraversalReady || graph.onlineEvents.length === 0) {
      return {
        provider: "uscf-graph",
        identities: [],
        accounts: [],
        unavailable: true,
        notes: ["No online tournament graph to traverse."],
      };
    }

    const { accounts, notes } = await runGraphTraversal(graph, {
      targetName: graph.rootName || query.name,
      targetRating: query.approxRating,
      signal,
      log,
    });

    const identities: PartialIdentity[] = accounts.length
      ? [
          {
            name: accounts[0].displayName || graph.rootName || query.name,
            estimatedRating: accounts[0].rating,
            suggestedAccounts: accounts.map((a) => ({ platform: a.platform as Platform, username: a.username })),
            evidence: accounts[0].evidence,
            reasoning: "Discovered by tracing a known USCF opponent's online games (tournament-graph traversal).",
            source: "chessresults",
          },
        ]
      : [];

    return { provider: "uscf-graph", identities, accounts, notes };
  },
};
