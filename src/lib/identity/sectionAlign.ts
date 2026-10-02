// ============================================================================
// Whole-section alignment — map EVERY crosstable player of a USCF section to
// their platform handle in one shot, from the hosting tournament's full game
// list.
//
// Once an event is tied to its exact tournament object (a Lichess swiss/arena
// id or a Chess.com tournament slug), the platform hands us every game of the
// event: who played whom, in which round, with what result. The USCF crosstable
// says the same thing in real names. Two labelled copies of ONE pairing graph —
// so the handle↔name correspondence is the graph isomorphism between them, and
// it is found by constraint propagation, not by guessing names:
//
//   1. Each crosstable player's round-by-round results (W/L/D per round) admit
//      only the handles whose games show the SAME results in the SAME rounds.
//   2. A player with a single admissible handle is assigned; every opponent of
//      that player then collapses to the handle their game was against.
//   3. Repeat until stable. A 7-player K-5 section resolves completely from a
//      single request; a 60-player open resolves nearly completely.
//
// No profile lookups, no name similarity, no per-handle archive pulls. The
// only network cost is the one games export per tournament. The module is
// pure (fetch + arithmetic) so the engine can run it as its first step for any
// event that has a located tournament.
// ============================================================================

import { politeFetch, lichessExportLane } from "./net";

import type { TournamentGameRow } from "../../../supabase/functions/_shared/sectionAlignCore.ts";

// The alignment itself is pure and lives in the shared core, so the edge
// function can re-run it before recording anything (see that file's header).
export {
  alignSection,
  alignSectionBest,
  alignmentTrustworthy,
  assignmentTier,
  chesscomBracketRows,
  inferRounds,
  type AlignableSection,
  type SectionAlignment,
  type SectionAssignment,
  type TournamentGameRow,
} from "../../../supabase/functions/_shared/sectionAlignCore.ts";

type Outcome = "w" | "l" | "d";

// ---------------------------------------------------------------------------
// Fetching the games of a located tournament
// ---------------------------------------------------------------------------

const gamesMemo = new Map<string, Promise<TournamentGameRow[]>>();
/** Why the last export for a tournament came back empty (HTTP status or error). */
export const lastExportFailure = new Map<string, string>();

const lichessOutcome = (winner: unknown, status: unknown): Outcome | undefined => {
  const st = String(status || "");
  if (st === "noStart" || st === "aborted" || st === "unknownFinish" || st === "created" || st === "started") return undefined;
  if (winner === "white") return "w";
  if (winner === "black") return "l";
  if (st === "draw" || st === "stalemate") return "d";
  // "mate"/"resign"/"outoftime"/"timeout" with no winner shouldn't happen; treat as unknown.
  return undefined;
};

/** All games of a Lichess swiss or arena (one NDJSON export, memoized). */
export function fetchLichessTournamentGames(kind: "lichess-swiss" | "lichess-arena", id: string, signal?: AbortSignal): Promise<TournamentGameRow[]> {
  const key = `${kind}:${id}`;
  const hit = gamesMemo.get(key);
  if (hit) return hit;
  const p = (async (): Promise<TournamentGameRow[]> => {
    const path = kind === "lichess-swiss" ? `swiss/${id}/games` : `tournament/${id}/games`;
    try {
      // One export at a time, body fully read inside the lane (the export is
      // streamed server-side; overlapping several of them is what earns a 429).
      const text = await lichessExportLane.run(async () => {
        const res = await politeFetch(
          `https://lichess.org/api/${path}?moves=false&tags=false&clocks=false&evals=false&opening=false`,
          { headers: { Accept: "application/x-ndjson" }, signal },
          "lichess",
          45_000
        );
        if (!res.ok) {
          lastExportFailure.set(key, `HTTP ${res.status}`);
          return "";
        }
        return res.text();
      });
      if (!text) {
        if (!lastExportFailure.has(key)) lastExportFailure.set(key, "empty body");
        return [];
      }
      lastExportFailure.delete(key);
      const out: TournamentGameRow[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const g = JSON.parse(line) as Record<string, unknown>;
          const players = g.players as { white?: { user?: { id?: string; name?: string } }; black?: { user?: { id?: string; name?: string } } } | undefined;
          const w = (players?.white?.user?.id || players?.white?.user?.name || "").toLowerCase();
          const b = (players?.black?.user?.id || players?.black?.user?.name || "").toLowerCase();
          if (!w || !b) continue;
          const created = typeof g.createdAt === "number" ? g.createdAt : 0;
          const last = typeof g.lastMoveAt === "number" ? g.lastMoveAt : created;
          out.push({ id: String(g.id || ""), whiteLower: w, blackLower: b, whiteOutcome: lichessOutcome(g.winner, g.status), startMs: created, endMs: last });
        } catch {
          /* skip row */
        }
      }
      return out;
    } catch (e) {
      lastExportFailure.set(key, e instanceof Error ? e.message : String(e));
      return [];
    }
  })();
  gamesMemo.set(key, p);
  void p.then((rows) => {
    if (!rows.length && gamesMemo.get(key) === p) gamesMemo.delete(key); // don't remember a failed export
  });
  return p;
}

