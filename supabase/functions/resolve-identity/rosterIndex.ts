// ============================================================================
// indexJoin — resolve whole USCF sections from the roster index, with no seed
// handle, no guessed handle and no Chess.com / Lichess request.
//
// For each requested section: read the crosstable (muir_cache), pull every
// crawled tournament compatible with its date, round count and size, align the
// crosstable against each one's stored result vectors (rosterIndexCore.ts), and
// on a single trusted match record the alignment exactly as the harvest does
// (identity_edge for every member, section_link, event/series platform).
//
// Disclosure: only the member named as targetUscfId gets a handle back — the
// same single-member disclosure as storedIdentity / recordAlignment. Everyone
// else is written to the store, where seedEdges (signed-in only) can read it.
//
// Cost per section: one crosstable read (usually cached), one PostgREST query
// returning at most 80 compact rosters, and milliseconds of CPU.
// ============================================================================

import { candidateWindow, joinSection, playedCount, type StoredRoster } from "../_shared/rosterIndexCore.ts";
import { assignmentTier } from "../_shared/sectionAlignCore.ts";
import { getRosterCandidates, putSectionLink, rosterIndexCovers } from "../_shared/identityStore.ts";
import { fetchSectionGraph } from "./uscf.ts";
import { recordVerifiedAlignment } from "./harvest.ts";

export type IndexJoinVerdict = "resolved" | "none" | "ambiguous" | "not-covered" | "untraceable" | "no-crosstable" | "store-unavailable";

export interface IndexJoinSectionOut {
  eventId: string;
  sectionNumber: number;
  verdict: IndexJoinVerdict;
  platform?: string;
  tournamentId?: string;
  played?: number;
  assigned?: number;
  candidates?: number;
  stored?: number | null;
  target?: { handle: string; platform: string; tier: string; rounds: number; corroborating: number } | null;
  ms: number;
}

export async function indexJoinSection(eventId: string, sectionNumber: number, targetUscfId: string): Promise<IndexJoinSectionOut> {
  const t0 = Date.now();
  const base = { eventId, sectionNumber };
  const sec = await fetchSectionGraph(eventId, sectionNumber, targetUscfId);
  if (!sec) return { ...base, verdict: "no-crosstable", ms: Date.now() - t0 };
  const guess = (sec.platformGuess || "").toLowerCase();
  if (guess === "icc" || guess === "chesskid") return { ...base, verdict: "untraceable", ms: Date.now() - t0 };
  const played = playedCount(sec);
  const w = candidateWindow({ startDate: sec.startDate, endDate: sec.endDate, roundCount: sec.roundCount }, played);
  const rows = await getRosterCandidates({ ...w, platform: guess === "chesscom" || guess === "lichess" ? guess : undefined });
  if (rows === null) return { ...base, verdict: "store-unavailable", ms: Date.now() - t0 };
  if (!rows.length) {
    const covered = await rosterIndexCovers(w.from, w.to);
    return { ...base, verdict: covered === false ? "not-covered" : "none", played, candidates: 0, ms: Date.now() - t0 };
  }
  const j = joinSection(sec, rows as StoredRoster[]);
  if (!j.best) return { ...base, verdict: j.ambiguous ? "ambiguous" : "none", played, candidates: rows.length, ms: Date.now() - t0 };

  const kind = j.best.platform === "chesscom" ? "chesscom-tournament" : "lichess-swiss";
  void putSectionLink({
    eventId,
    sectionNo: sectionNumber,
    platform: j.best.platform,
    tournamentId: j.best.tid,
    status: "verified",
    assigned: j.best.assigned,
    nPlayers: played,
    contradicted: j.best.contradicted,
    inconsistentEdges: j.best.inconsistentEdges,
    source: "index",
  });
  const { stored } = await recordVerifiedAlignment(sec, j.best.alignment, { eventId, sectionNumber, kind, tournamentId: j.best.tid });
  const t = targetUscfId ? j.best.alignment.assignments.find((x) => x.uscfId === targetUscfId) : undefined;
  console.log(
    "[resolve-identity] indexJoin:",
    JSON.stringify({ eventId, section: sectionNumber, platform: j.best.platform, assigned: j.best.assigned, played, candidates: rows.length, written: stored?.written ?? null, ms: Date.now() - t0 })
  );
  return {
    ...base,
    verdict: "resolved",
    platform: j.best.platform,
    tournamentId: j.best.tid,
    played,
    assigned: j.best.assigned,
    candidates: rows.length,
    stored: stored?.written ?? null,
    target: t
      ? { handle: t.handleLower, platform: j.best.platform, tier: assignmentTier(t, true), rounds: t.checkedRounds, corroborating: t.corroboratingOpponents }
      : null,
    ms: Date.now() - t0,
  };
}

/** Mode handler: up to 12 sections per call, sequentially (MUIR is paced). */
export async function handleIndexJoin(req: { sections?: unknown; targetUscfId?: unknown }): Promise<Record<string, unknown>> {
  const target = typeof req.targetUscfId === "string" ? req.targetUscfId.replace(/\D/g, "") : "";
  const list = Array.isArray(req.sections) ? req.sections.slice(0, 12) : [];
  const out: IndexJoinSectionOut[] = [];
  for (const s of list) {
    const o = s as { eventId?: unknown; sectionNumber?: unknown };
    const eventId = typeof o.eventId === "string" ? o.eventId.replace(/\D/g, "") : "";
    const n = typeof o.sectionNumber === "number" ? Math.floor(o.sectionNumber) : NaN;
    if (!eventId || !Number.isFinite(n) || n < 1 || n > 99) continue;
    out.push(await indexJoinSection(eventId, n, target));
  }
  return { available: true, sections: out };
}
