// ============================================================================
// Harvest — persist everything a section alignment proves.
//
// The browser tells this mode only WHICH tournament it believes hosted a USCF
// section. The server then fetches the crosstable (muir_cache) and the
// tournament's games itself, re-runs the whole-section alignment, and records
// the result: every assignment with its tier, the section ↔ tournament verdict
// (verified or rejected), the event's platform and its series. A browser can
// never write a handle here that the public game record does not prove.
//
// Cost per call: one Lichess export, or a Chess.com bracket walk of at most
// BRACKET_MAX_GETS requests (the measured mean is ~9), paced at ~8/s from the
// edge address, well under the ~300-per-window Chess.com rule.
// ============================================================================

import {
  alignSectionBest,
  alignmentTrustworthy,
  assignmentTier,
  chesscomBracketRows,
  type TournamentGameRow,
} from "../_shared/sectionAlignCore.ts";
import { fetchSectionGraph, seriesKey } from "./uscf.ts";
import {
  recordIdentityEdges,
  putSectionLink,
  putEventPlatform,
  putSeriesPlatform,
  type IdentityEdgeInput,
} from "../_shared/identityStore.ts";

const UA = "ScoutTree/1.0 (+https://chess-scout.vercel.app)";
const BRACKET_MAX_GETS = 40;
const BRACKET_GAP_MS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 429) {
        await sleep(3_000);
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      await sleep(500);
    }
  }
  return null;
}

/** Every game of a Chess.com tournament bracket, each tagged with its round. */
async function chesscomBracket(slug: string): Promise<TournamentGameRow[]> {
  const raw: unknown[] = [];
  const roundOf = new Map<unknown, number>();
  let gets = 0;
  const get = async (url: string) => {
    if (gets >= BRACKET_MAX_GETS) return null;
    gets++;
    if (gets > 1) await sleep(BRACKET_GAP_MS);
    return getJson(url);
  };
  const root = await get(`https://api.chess.com/pub/tournament/${encodeURIComponent(slug)}`);
  const rounds = Array.isArray(root?.rounds) ? (root!.rounds as string[]) : [];
  for (const [ri, roundUrl] of rounds.entries()) {
    const round = await get(String(roundUrl));
    if (!round) continue;
    const take = (list: unknown) => {
      for (const g of Array.isArray(list) ? list : []) {
        raw.push(g);
        roundOf.set(g, ri + 1);
      }
    };
    take(round.games);
    for (const groupUrl of Array.isArray(round.groups) ? (round.groups as string[]) : []) {
      const group = await get(String(groupUrl));
      take(group?.games);
    }
  }
  return chesscomBracketRows(raw, (g) => roundOf.get(g));
}

/** Every game of a Lichess swiss or arena (one NDJSON export). */
async function lichessGames(kind: "lichess-swiss" | "lichess-arena", id: string): Promise<TournamentGameRow[]> {
  const path = kind === "lichess-swiss" ? `swiss/${id}/games` : `tournament/${id}/games`;
  try {
    const res = await fetch(`https://lichess.org/api/${path}?moves=false&tags=false&clocks=false&evals=false&opening=false`, {
      headers: { "User-Agent": UA, Accept: "application/x-ndjson" },
    });
    if (!res.ok) return [];
    const out: TournamentGameRow[] = [];
    for (const line of (await res.text()).split("\n")) {
      if (!line.trim()) continue;
      try {
        const g = JSON.parse(line);
        const w = String(g.players?.white?.user?.id || g.players?.white?.user?.name || "").toLowerCase();
        const b = String(g.players?.black?.user?.id || g.players?.black?.user?.name || "").toLowerCase();
        if (!w || !b) continue;
        const st = String(g.status || "");
        const done = !["noStart", "aborted", "unknownFinish", "created", "started"].includes(st);
        const whiteOutcome =
          !done ? undefined : g.winner === "white" ? "w" : g.winner === "black" ? "l" : st === "draw" || st === "stalemate" ? "d" : undefined;
        const created = typeof g.createdAt === "number" ? g.createdAt : 0;
        out.push({
          id: String(g.id || ""),
          whiteLower: w,
          blackLower: b,
          whiteOutcome,
          startMs: created,
          endMs: typeof g.lastMoveAt === "number" ? g.lastMoveAt : created,
        });
      } catch {
        /* skip row */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export type TournamentKind = "chesscom-tournament" | "lichess-swiss" | "lichess-arena";

export interface RecordAlignmentRequest {
  eventId: string;
  sectionNumber: number;
  kind: TournamentKind;
  tournamentId: string;
  /** Optional: the member the caller searched for; their own assignment (and
   *  only theirs) is echoed back. */
  targetUscfId?: string;
}

/** Validate a caller-supplied request; null when malformed. */
export function parseRecordAlignment(body: Record<string, unknown>): RecordAlignmentRequest | null {
  const eventId = typeof body.eventId === "string" ? body.eventId.replace(/\D/g, "") : "";
  const sectionNumber = typeof body.sectionNumber === "number" ? Math.floor(body.sectionNumber) : NaN;
  const kind = body.kind as TournamentKind;
  let tid = typeof body.tournamentId === "string" ? body.tournamentId.trim() : "";
  if (!eventId || !Number.isFinite(sectionNumber) || sectionNumber < 1 || sectionNumber > 99) return null;
  if (kind === "chesscom-tournament") {
    tid = (tid.split("/").filter(Boolean).pop() || "").toLowerCase();
    // Chess.com slugs may start with a dash ("-us-chess-15--10-rapid-1234567").
    if (!/^[a-z0-9-]{3,150}$/.test(tid) || !/[a-z0-9]/.test(tid)) return null;
  } else if (kind === "lichess-swiss" || kind === "lichess-arena") {
    if (!/^[A-Za-z0-9]{8}$/.test(tid)) return null;
  } else return null;
  const target = typeof body.targetUscfId === "string" ? body.targetUscfId.replace(/\D/g, "") : undefined;
  return { eventId, sectionNumber, kind, tournamentId: tid, targetUscfId: target || undefined };
}

export async function handleRecordAlignment(req: RecordAlignmentRequest): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const sec = await fetchSectionGraph(req.eventId, req.sectionNumber, req.targetUscfId || "");
  if (!sec) return { available: true, recorded: false, reason: "crosstable unavailable" };
  const platform = req.kind === "chesscom-tournament" ? "chesscom" : "lichess";
  const rows =
    req.kind === "chesscom-tournament" ? await chesscomBracket(req.tournamentId) : await lichessGames(req.kind, req.tournamentId);
  if (!rows.length) return { available: true, recorded: false, reason: "tournament returned no games", ms: Date.now() - t0 };

  const a = alignSectionBest(sec, rows);
  const trusted = alignmentTrustworthy(sec, a);
  const n = sec.players.filter((p) => p.games.some((g) => /^(w|l|d)/i.test(g.outcome || ""))).length;
  void putSectionLink({
    eventId: req.eventId,
    sectionNo: req.sectionNumber,
    platform,
    tournamentId: req.tournamentId,
    status: trusted ? "verified" : "rejected",
    assigned: a.assignments.length,
    nPlayers: n,
    contradicted: a.contradicted.length,
    inconsistentEdges: a.inconsistentEdges,
    source: "harvest",
  });
  if (!trusted) {
    return {
      available: true,
      recorded: false,
      verified: false,
      assigned: a.assignments.length,
      players: n,
      contradicted: a.contradicted.length,
      inconsistentEdges: a.inconsistentEdges,
      ms: Date.now() - t0,
    };
  }

  const at = new Date().toISOString();
  const edges: IdentityEdgeInput[] = a.assignments.map((x) => {
    const tier = assignmentTier(x, true);
    return {
      uscf_id: x.uscfId,
      platform,
      handle: x.handleLower,
      tier,
      rounds: x.checkedRounds,
      corroborating: x.corroboratingOpponents,
      section: {
        eventId: req.eventId,
        section: req.sectionNumber,
        platform,
        tournament: req.tournamentId,
        tier,
        rounds: x.checkedRounds,
        corroborating: x.corroboratingOpponents,
        at,
      },
    };
  });
  const stored = await recordIdentityEdges(edges);
  const info =
    platform === "chesscom"
      ? { platform, chesscomSlugs: [req.tournamentId], lichessSwissIds: [], lichessArenaIds: [], confidence: 1, note: "verified by whole-section alignment" }
      : {
          platform,
          chesscomSlugs: [],
          lichessSwissIds: req.kind === "lichess-swiss" ? [req.tournamentId] : [],
          lichessArenaIds: req.kind === "lichess-arena" ? [req.tournamentId] : [],
          confidence: 1,
          note: "verified by whole-section alignment",
        };
  void putEventPlatform(req.eventId, platform, info, "alignment");
  const sk = seriesKey(sec.name);
  if (sk) void putSeriesPlatform(sk, platform);

  const strong = edges.filter((e) => e.tier === "strong").length;
  const target = req.targetUscfId ? a.assignments.find((x) => x.uscfId === req.targetUscfId) : undefined;
  console.log(
    "[resolve-identity] recordAlignment:",
    JSON.stringify({ eventId: req.eventId, section: req.sectionNumber, platform, assigned: edges.length, strong, players: n, stored, ms: Date.now() - t0 })
  );
  return {
    available: true,
    recorded: !!stored,
    verified: true,
    players: n,
    assigned: edges.length,
    strong,
    weak: edges.length - strong,
    store: stored,
    target: target
      ? { handle: target.handleLower, tier: assignmentTier(target, true), rounds: target.checkedRounds, corroborating: target.corroboratingOpponents }
      : null,
    ms: Date.now() - t0,
  };
}
