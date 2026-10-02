// ============================================================================
// Whole-section alignment — the PURE core (no I/O), shared by the browser
// engine (src/lib/identity/sectionAlign.ts re-exports it) and the edge
// function (resolve-identity/harvest.ts), which re-runs every alignment it is
// asked to record so a browser can never write a handle it merely asserts.
//
// The method: a USCF crosstable and the hosting tournament's game list are two
// labelled copies of one pairing graph. Each player's round-by-round results
// admit only the handles whose games show the same results in the same rounds;
// a single admissible handle is assigned and every opponent collapses to the
// handle their game was against; repeat until stable.
// ============================================================================

/** The slice of a USCF section the alignment reads. Structural, so the
 *  client's graph event and the edge's online section both satisfy it. */
export interface AlignableSection {
  players: {
    uscfId: string;
    games: { round: number; color: string; outcome: string; opponentUscfId: string }[];
  }[];
}

type Outcome = "w" | "l" | "d";

/** One game of the hosting tournament, in neutral terms. */
export interface TournamentGameRow {
  id: string;
  whiteLower: string;
  blackLower: string;
  /** Result from white's point of view; undefined = unplayed/aborted. */
  whiteOutcome?: Outcome;
  startMs: number;
  endMs: number;
  /** Explicit round number when the platform gives one (Chess.com brackets). */
  round?: number;
}

export interface SectionAssignment {
  uscfId: string;
  handleLower: string;
  /** Rounds whose result matched between the crosstable and the games. */
  checkedRounds: number;
  /** Opponents of this player who are ALSO assigned and whose games agree. */
  corroboratingOpponents: number;
  /** How the handle was pinned. */
  how: "unique-signature" | "propagation";
}

export interface SectionAlignment {
  assignments: SectionAssignment[];
  /** Crosstable players left with several admissible handles. */
  unresolved: string[];
  /** Players whose games contradicted every handle (a wrong tournament, or a
   *  USCF result correction). */
  contradicted: string[];
  roundsDetected: number;
  handles: number;
  /** Assigned pairs whose mutual game exists in the games list (a consistency
   *  measure over the whole mapping). */
  consistentEdges: number;
  inconsistentEdges: number;
}

/** Chess.com tournament bracket games already fetched by the engine's walker,
 *  converted to neutral rows. `round` comes from the walker when it tags games
 *  by round; otherwise rounds are inferred from start-time clusters. */
export function chesscomBracketRows(raw: unknown[], roundOf?: (g: unknown) => number | undefined): TournamentGameRow[] {
  const out: TournamentGameRow[] = [];
  const DRAW = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);
  for (const g of raw) {
    const r = g as Record<string, unknown>;
    const white = r.white as { username?: string; result?: string } | undefined;
    const black = r.black as { username?: string; result?: string } | undefined;
    const w = (white?.username || "").toLowerCase();
    const b = (black?.username || "").toLowerCase();
    if (!w || !b) continue;
    const wr = String(white?.result || "");
    const br = String(black?.result || "");
    let whiteOutcome: Outcome | undefined;
    if (wr === "win") whiteOutcome = "w";
    else if (br === "win") whiteOutcome = "l";
    else if (DRAW.has(wr) || DRAW.has(br)) whiteOutcome = "d";
    const end = typeof r.end_time === "number" ? r.end_time * 1000 : 0;
    const start = typeof r.start_time === "number" ? r.start_time * 1000 : end;
    out.push({ id: String(r.url || r.uuid || ""), whiteLower: w, blackLower: b, whiteOutcome, startMs: start, endMs: end, round: roundOf?.(g) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Round inference: swiss games of one round all start within seconds of each
// other; consecutive rounds are minutes apart.
// ---------------------------------------------------------------------------

const ROUND_GAP_MS = 3 * 60_000;

/** Assign a 1-based round index to every game. Uses explicit rounds when all
 *  games have them; otherwise clusters by start time. */
export function inferRounds(games: TournamentGameRow[]): { roundOf: Map<string, number>; rounds: number } {
  const roundOf = new Map<string, number>();
  if (games.length && games.every((g) => typeof g.round === "number")) {
    let max = 0;
    for (const g of games) {
      roundOf.set(g.id, g.round!);
      max = Math.max(max, g.round!);
    }
    return { roundOf, rounds: max };
  }
  const sorted = [...games].sort((a, b) => a.startMs - b.startMs);
  let round = 0;
  let lastStart = -Infinity;
  for (const g of sorted) {
    if (g.startMs - lastStart > ROUND_GAP_MS) round++;
    lastStart = Math.max(lastStart, g.startMs);
    roundOf.set(g.id, round);
  }
  return { roundOf, rounds: round };
}

// ---------------------------------------------------------------------------
// The alignment
// ---------------------------------------------------------------------------

interface HandleRound {
  outcome: Outcome;
  color: "white" | "black";
  oppLower: string;
}

interface MemberRound {
  round: number;
  outcome: Outcome;
  color: "white" | "black" | "unknown";
  opponentUscfId: string;
}

const normOutcome = (raw: string): Outcome | null => {
  const t = (raw || "").toLowerCase();
  if (!t) return null;
  if (/forfeit|bye|unplayed|not\s*played|no\s*result/.test(t)) return null;
  if (t.startsWith("w")) return "w";
  if (t.startsWith("l")) return "l";
  if (t.startsWith("d")) return "d";
  return null;
};

/**
 * Align a USCF section's crosstable with the hosting tournament's games.
 * `roundOffset` handles a crosstable whose round numbering doesn't start at
 * the games' first cluster (rare; tried automatically when 0 fails).
 */
export function alignSection(ev: AlignableSection, games: TournamentGameRow[], opts: { roundOffset?: number } = {}): SectionAlignment {
  const { roundOf, rounds } = inferRounds(games);
  const offset = opts.roundOffset ?? 0;

  // Per handle: round → its game.
  const byHandle = new Map<string, Map<number, HandleRound>>();
  const gamesByPair = new Map<string, TournamentGameRow>(); // "round|a|b" (sorted) → game
  for (const g of games) {
    if (!g.whiteOutcome) continue; // unplayed / aborted — no evidence either way
    const r = roundOf.get(g.id);
    if (!r) continue;
    const wMap = byHandle.get(g.whiteLower) || new Map<number, HandleRound>();
    wMap.set(r, { outcome: g.whiteOutcome, color: "white", oppLower: g.blackLower });
    byHandle.set(g.whiteLower, wMap);
    const bMap = byHandle.get(g.blackLower) || new Map<number, HandleRound>();
    const bo: Outcome = g.whiteOutcome === "w" ? "l" : g.whiteOutcome === "l" ? "w" : "d";
    bMap.set(r, { outcome: bo, color: "black", oppLower: g.whiteLower });
    byHandle.set(g.blackLower, bMap);
    const [a, b] = [g.whiteLower, g.blackLower].sort();
    gamesByPair.set(`${r}|${a}|${b}`, g);
  }
  const handles = Array.from(byHandle.keys());

  // Per member: played rounds.
  const memberRounds = new Map<string, MemberRound[]>();
  for (const p of ev.players) {
    const rs: MemberRound[] = [];
    for (const g of p.games) {
      const o = normOutcome(g.outcome);
      if (!o || !g.opponentUscfId) continue;
      const color = g.color === "white" || g.color === "black" ? g.color : "unknown";
      rs.push({ round: g.round + offset, outcome: o, color, opponentUscfId: g.opponentUscfId });
    }
    rs.sort((a, b) => a.round - b.round);
    memberRounds.set(p.uscfId, rs);
  }

  // Signature admissibility: a handle fits a member when every played round
  // of the member has a game for the handle in that round with the same
  // outcome (and colour, when the crosstable knows it).
  const fits = (uscfId: string, h: string): boolean => {
    const rs = memberRounds.get(uscfId) || [];
    if (!rs.length) return false;
    const hm = byHandle.get(h);
    if (!hm) return false;
    for (const r of rs) {
      const hg = hm.get(r.round);
      if (!hg || hg.outcome !== r.outcome) return false;
      if (r.color !== "unknown" && hg.color !== r.color) return false;
    }
    return true;
  };

  const candidates = new Map<string, Set<string>>();
  const contradicted: string[] = [];
  for (const p of ev.players) {
    const rs = memberRounds.get(p.uscfId) || [];
    if (!rs.length) continue; // nothing to align (all byes/forfeits)
    const set = new Set<string>();
    for (const h of handles) if (fits(p.uscfId, h)) set.add(h);
    if (!set.size) contradicted.push(p.uscfId);
    else candidates.set(p.uscfId, set);
  }

  // Constraint propagation.
  const assigned = new Map<string, string>(); // uscfId → handle
  const handleOwner = new Map<string, string>(); // handle → uscfId
  const how = new Map<string, SectionAssignment["how"]>();
  const assign = (uscfId: string, h: string, why: SectionAssignment["how"]) => {
    if (assigned.has(uscfId) || handleOwner.has(h)) return false;
    assigned.set(uscfId, h);
    handleOwner.set(h, uscfId);
    how.set(uscfId, why);
    candidates.set(uscfId, new Set([h]));
    for (const [id, set] of candidates) if (id !== uscfId) set.delete(h);
    // Opponents collapse to the handle's opponent in that round.
    const hm = byHandle.get(h)!;
    for (const r of memberRounds.get(uscfId) || []) {
      const hg = hm.get(r.round);
      if (!hg) continue;
      const oppSet = candidates.get(r.opponentUscfId);
      if (!oppSet) continue;
      if (oppSet.has(hg.oppLower)) {
        for (const x of Array.from(oppSet)) if (x !== hg.oppLower) oppSet.delete(x);
      } else {
        oppSet.clear(); // the games say otherwise — leave the opponent unresolved rather than force a bad pin
      }
    }
    return true;
  };
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 200) {
    changed = false;
    // Members with a single admissible handle.
    for (const [id, set] of candidates) {
      if (assigned.has(id) || set.size !== 1) continue;
      const h = Array.from(set)[0];
      if (handleOwner.has(h)) continue;
      if (assign(id, h, "unique-signature")) changed = true;
    }
    // Handles admissible for exactly one unassigned member.
    const admissibleFor = new Map<string, string[]>();
    for (const [id, set] of candidates) {
      if (assigned.has(id)) continue;
      for (const h of set) {
        if (handleOwner.has(h)) continue;
        const list = admissibleFor.get(h) || [];
        list.push(id);
        admissibleFor.set(h, list);
      }
    }
    for (const [h, ids] of admissibleFor) {
      if (ids.length !== 1 || assigned.has(ids[0])) continue;
      if (assign(ids[0], h, "propagation")) changed = true;
    }
  }

  // Consistency over assigned pairs.
  let consistentEdges = 0;
  let inconsistentEdges = 0;
  const corroborating = new Map<string, number>();
  for (const [id, h] of assigned) {
    let n = 0;
    for (const r of memberRounds.get(id) || []) {
      const oppH = assigned.get(r.opponentUscfId);
      if (!oppH) continue;
      const [a, b] = [h, oppH].sort();
      if (gamesByPair.has(`${r.round}|${a}|${b}`)) {
        consistentEdges++;
        n++;
      } else inconsistentEdges++;
    }
    corroborating.set(id, n);
  }

  const assignments: SectionAssignment[] = [];
  for (const [id, h] of assigned) {
    assignments.push({
      uscfId: id,
      handleLower: h,
      checkedRounds: (memberRounds.get(id) || []).length,
      corroboratingOpponents: corroborating.get(id) || 0,
      how: how.get(id) || "propagation",
    });
  }
  const unresolved = Array.from(candidates.keys()).filter((id) => !assigned.has(id) && (candidates.get(id)?.size || 0) !== 0);
  for (const [id, set] of candidates) if (!assigned.has(id) && set.size === 0 && !contradicted.includes(id)) contradicted.push(id);
  return { assignments, unresolved, contradicted, roundsDetected: rounds, handles: handles.length, consistentEdges, inconsistentEdges };
}

/**
 * Try the alignment at round offset 0, then ±1 (a crosstable whose round 1 is
 * the games' round 2 — e.g. an unrated warm-up round the platform recorded).
 * Returns the offset whose alignment explains the most players consistently.
 */
export function alignSectionBest(ev: AlignableSection, games: TournamentGameRow[]): SectionAlignment {
  let best: SectionAlignment | null = null;
  for (const off of [0, 1, -1]) {
    const a = alignSection(ev, games, { roundOffset: off });
    const quality = a.assignments.length * 10 + a.consistentEdges - 5 * a.inconsistentEdges - 3 * a.contradicted.length;
    const bestQ = best ? best.assignments.length * 10 + best.consistentEdges - 5 * best.inconsistentEdges - 3 * best.contradicted.length : -Infinity;
    if (!best || quality > bestQ) best = a;
    if (off === 0 && a.assignments.length >= Math.max(2, Math.floor(ev.players.length * 0.6)) && !a.inconsistentEdges) break;
  }
  return best!;
}

/** Is this alignment trustworthy enough to act on? The tournament must
 *  explain a real share of the crosstable with no internal contradictions. */
export function alignmentTrustworthy(ev: AlignableSection, a: SectionAlignment): boolean {
  const n = ev.players.filter((p) => p.games.some((g) => normOutcome(g.outcome))).length;
  if (!n) return false;
  if (a.inconsistentEdges > 0 && a.inconsistentEdges * 4 > a.consistentEdges) return false;
  if (a.contradicted.length > Math.max(1, Math.floor(n * 0.34))) return false;
  return a.assignments.length >= Math.max(2, Math.ceil(n * 0.5));
}

/** Evidence tier of one assignment. Measured on 45 re-aligned sections:
 *  strong pairs disagreed across sections 0.99% of the time, weak ~3.5%;
 *  with 5–20% of games missing, strong assignments were never wrong in 6,451
 *  trials while weak ones were wrong 6–21% of the time
 *  (docs/traversal-investigation.md §6.1). */
export function assignmentTier(a: SectionAssignment, sectionTrusted: boolean): "strong" | "weak" {
  return sectionTrusted && a.checkedRounds >= 3 && a.corroboratingOpponents >= 2 ? "strong" : "weak";
}
