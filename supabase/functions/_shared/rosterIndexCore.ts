// ============================================================================
// Roster index — the PURE core (no I/O): decode stored result vectors and
// align a USCF section against every compatible stored tournament at once.
//
// The index (roster_tournament, filled by scripts/roster-crawler.mjs) holds,
// per platform tournament, the full roster and each player's result vector:
// per round, opponent index + colour + result. A section's crosstable carries
// the same three facts per round. Matching a whole crosstable against a stored
// tournament is therefore the existing whole-section alignment run on rows
// rebuilt from the vectors — no seed handle, no guessed handle, no platform
// request.
//
// Candidate selection is deliberately loose (date window, round count ±1, a
// size floor); the alignment and its trust test do the discriminating. Two
// trusted candidates for one section are reported as ambiguous, never picked
// between silently.
// ============================================================================

import {
  alignSectionBest,
  alignmentTrustworthy,
  type AlignableSection,
  type SectionAlignment,
  type TournamentGameRow,
} from "./sectionAlignCore.ts";

export interface StoredRoster {
  platform: "chesscom" | "lichess";
  tid: string;
  series?: string;
  name?: string | null;
  starts_at?: string | null;
  n_rounds?: number | null;
  n_players?: number | null;
  handles: string[];
  vectors: string;
}

const TOKEN = /^(\d+)([wb])([wld])$/;

/** Rebuild one row per game from the stored vectors (white's side only; the
 *  encoder writes both sides of every game). */
export function rosterGames(r: StoredRoster): TournamentGameRow[] {
  const out: TournamentGameRow[] = [];
  const players = (r.vectors || "").split(" ");
  for (let i = 0; i < players.length; i++) {
    const rounds = players[i].split(",");
    for (let k = 0; k < rounds.length; k++) {
      const m = TOKEN.exec(rounds[k]);
      if (!m || m[2] !== "w") continue;
      const j = Number(m[1]);
      const white = r.handles[i];
      const black = r.handles[j];
      if (!white || !black) continue;
      out.push({ id: `${r.tid}:${k + 1}:${i}`, whiteLower: white, blackLower: black, whiteOutcome: m[3] as "w" | "l" | "d", startMs: 0, endMs: 0, round: k + 1 });
    }
  }
  return out;
}

/** Crosstable players with at least one played (non-forfeit) game. */
export function playedCount(sec: AlignableSection): number {
  return sec.players.filter((p) => p.games.some((g) => /^(w|l|d)/i.test(g.outcome || "") && !/forfeit/i.test(g.outcome || ""))).length;
}

/** The date window and size bounds a stored tournament must meet to be tried
 *  against a section. Dates are US-local on the USCF side and UTC on the
 *  platform side, so the window pads 14 h either way. */
export function candidateWindow(sec: { startDate?: string; endDate?: string; roundCount?: number }, played: number) {
  const start = Date.parse(`${sec.startDate || sec.endDate}T00:00:00Z`);
  const end = Date.parse(`${sec.endDate || sec.startDate}T23:59:59Z`);
  return {
    from: new Date(start - 14 * 3600_000).toISOString(),
    to: new Date(end + 14 * 3600_000).toISOString(),
    minRounds: Math.max(1, (sec.roundCount || 1) - 1),
    maxRounds: (sec.roundCount || 30) + 1,
    // A platform roster contains every USCF player of the section (Phase 1:
    // 46 of 46), plus unrated entrants; the floor allows a few withdrawals.
    minPlayers: Math.max(2, Math.floor(played * 0.8)),
  };
}

export interface IndexCandidateResult {
  platform: StoredRoster["platform"];
  tid: string;
  series?: string;
  trusted: boolean;
  assigned: number;
  contradicted: number;
  inconsistentEdges: number;
  consistentEdges: number;
  quality: number;
}

export interface IndexJoinOutcome {
  /** The single trusted candidate, when there is exactly one (or one clearly best). */
  best: (IndexCandidateResult & { alignment: SectionAlignment; roster: StoredRoster }) | null;
  /** Every candidate tried, best first. */
  tried: IndexCandidateResult[];
  /** True when two or more candidates were trusted and none clearly won. */
  ambiguous: boolean;
  played: number;
}

const qualityOf = (a: SectionAlignment) => a.assignments.length * 10 + a.consistentEdges - 5 * a.inconsistentEdges - 3 * a.contradicted.length;

/** Align a section against every candidate roster; pick the trusted best. */
export function joinSection(sec: AlignableSection, candidates: StoredRoster[]): IndexJoinOutcome {
  const played = playedCount(sec);
  const scored: (IndexCandidateResult & { alignment: SectionAlignment; roster: StoredRoster })[] = [];
  for (const roster of candidates) {
    const rows = rosterGames(roster);
    if (!rows.length) continue;
    const a = alignSectionBest(sec, rows);
    scored.push({
      platform: roster.platform,
      tid: roster.tid,
      series: roster.series,
      trusted: alignmentTrustworthy(sec, a),
      assigned: a.assignments.length,
      contradicted: a.contradicted.length,
      inconsistentEdges: a.inconsistentEdges,
      consistentEdges: a.consistentEdges,
      quality: qualityOf(a),
      alignment: a,
      roster,
    });
  }
  scored.sort((x, y) => Number(y.trusted) - Number(x.trusted) || y.quality - x.quality);
  const trusted = scored.filter((s) => s.trusted);
  // Two trusted candidates: accept the leader only if it explains clearly more
  // of the crosstable (a duplicate upload of one event aligns identically).
  let ambiguous = false;
  let best = trusted[0] || null;
  if (trusted.length > 1) {
    const [a, b] = trusted;
    if (a.assigned - b.assigned < Math.max(2, Math.ceil(played * 0.1))) {
      ambiguous = true;
      best = null;
    }
  }
  return {
    best,
    tried: scored.map(({ alignment: _a, roster: _r, ...rest }) => rest),
    ambiguous,
    played,
  };
}
