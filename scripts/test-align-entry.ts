// A/B proof for the tolerant alignRounds fix, run against REAL ground-truth data
// (scripts/align-fixture.json: Grigor Dilanyan's WASHINGTON CLASS BLITZ crosstable
// vs his real chess.com archive). Bundled + run by scripts/test-align.mjs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { alignRounds } from "../src/lib/identity/uscfGraphEngine";

type Outcome = "w" | "l" | "d";
interface RoundGame { round: number; color: "white" | "black" | "unknown"; outcome: Outcome; opponentUscfId: string; opponentName: string }
interface ArchiveGame { oppHandle: string; sourceColor: "white" | "black"; sourceOutcome?: Outcome; endMs: number; rated: boolean; timeClass?: string }

// The OLD implementation, verbatim, so the A/B is self-contained.
function alignRoundsOLD(rounds: RoundGame[], scoped: ArchiveGame[], viaLinkage: boolean) {
  if (!rounds.length || rounds.length !== scoped.length) return null;
  if (!viaLinkage && rounds.length < 3) return null;
  const games = [...scoped].sort((a, b) => a.endMs - b.endMs);
  let mismatches = 0, checked = 0;
  const pairs: { round: RoundGame; game: ArchiveGame }[] = [];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i], g = games[i];
    let bad = false;
    if (g.sourceOutcome) { checked++; if (g.sourceOutcome !== r.outcome) bad = true; }
    if (r.color === "white" || r.color === "black") { if (g.sourceColor !== r.color) bad = true; }
    if (bad) mismatches++; else pairs.push({ round: r, game: g });
  }
  const allowed = viaLinkage && rounds.length >= 6 ? 1 : 0;
  if (mismatches > allowed) return null;
  if (!viaLinkage && checked < 3) return null;
  return { pairs, checked };
}

const fx = JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "align-fixture.json"), "utf8"));
const rounds: RoundGame[] = fx.rounds;
const scoped: ArchiveGame[] = fx.scoped;

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

console.log("=== Real ground truth: 10 archive games vs 9 crosstable rounds (no tournament link) ===");
const oldRes = alignRoundsOLD(rounds, scoped, false);
check("OLD exact-count alignment discards the whole edge", oldRes === null, `got ${oldRes ? oldRes.pairs.length + " pairs" : "null"}`);

const newRes = alignRounds(rounds as never, scoped as never, false);
check("NEW tolerant alignment recovers the edge", newRes !== null);
if (newRes) {
  check("NEW aligns all 9 rounds", newRes.pairs.length === 9, `matched ${newRes.pairs.length}`);
  const handles = newRes.pairs.map((p) => (p.game as ArchiveGame).oppHandle);
  const expected: string[] = fx.expected.opponentHandles;
  check("NEW maps the correct opponent handle for every round", JSON.stringify(handles) === JSON.stringify(expected), handles.join(","));
  // Every matched pair must be result-consistent (that IS the checksum).
  const allConsistent = newRes.pairs.every((p) => {
    const g = p.game as ArchiveGame, r = p.round as RoundGame;
    return (!g.sourceOutcome || g.sourceOutcome === r.outcome) && (r.color === "unknown" || g.sourceColor === r.color);
  });
  check("NEW pairs are all colour+outcome consistent", allConsistent);
  check("NEW dropped exactly the warm-up game (Shahinyan_ChessMood)", !handles.includes("Shahinyan_ChessMood"));
}

console.log("\n=== Safety: a big casual pool with few rounds must NOT false-align ===");
// 4 rounds, 20 unrelated casual games with arbitrary outcomes — outcome-only
// matching over such a pool is meaningless; the guard must bail.
const rounds4: RoundGame[] = rounds.slice(0, 4).map((r, i) => ({ ...r, round: i + 1 }));
const pool20: ArchiveGame[] = Array.from({ length: 20 }, (_, i) => ({
  oppHandle: `rando${i}`, sourceColor: i % 2 ? "white" : "black",
  sourceOutcome: (["w", "l", "d"] as Outcome[])[i % 3], endMs: 1600000000000 + i * 600000, rated: true, timeClass: "blitz",
}));
check("NEW bails on a 20-game pool for 4 rounds (no link, no anchors)", alignRounds(rounds4 as never, pool20 as never, false) === null);

console.log("\n=== Anchors: a known-handle pin makes even a loose pool safe to align ===");
// Same loose pool, but insert the 4 true games and pin 2 opponents to handles.
const trueGames: ArchiveGame[] = rounds4.map((r, i) => ({
  oppHandle: `real${i}`, sourceColor: r.color === "unknown" ? "white" : r.color, sourceOutcome: r.outcome,
  endMs: 1600100000000 + i * 600000, rated: true, timeClass: "blitz",
}));
const mixed = [...pool20, ...trueGames].sort((a, b) => a.endMs - b.endMs);
const pins = new Map<string, string>([
  [rounds4[1].opponentUscfId, "real1"],
  [rounds4[3].opponentUscfId, "real3"],
]);
const anchored = alignRounds(rounds4 as never, mixed as never, false, pins);
check("NEW aligns the pinned rounds within a loose pool", !!anchored && anchored.pairs.length >= 2);
if (anchored) {
  const byRound = new Map(anchored.pairs.map((p) => [(p.round as RoundGame).opponentUscfId, (p.game as ArchiveGame).oppHandle]));
  check("pinned round #1 → real1", byRound.get(rounds4[1].opponentUscfId) === "real1");
  check("pinned round #3 → real3", byRound.get(rounds4[3].opponentUscfId) === "real3");
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
