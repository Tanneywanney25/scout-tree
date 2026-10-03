// ============================================================================
// Proof for the first-resolved-pivot-rank metric (docs/roster-index.md 6.1).
//
//   node scripts/test-pivotrank.mjs
//
// A level-0 section with six section-mates whose portal footprints fix their
// rank order (A > B > K > C > D; E has no Chess.com/Lichess history and is
// never scouted); in scenario 2, K's handle is already stored. A scripted engine reports
// mappings in a chosen order; the metric must report the scouted pivot's
// position among the still-unknown, eligible members — not counting K, not
// counting E, and read before the mapping lifts its rank to 1000.
// ============================================================================

import { runSectionBfs, type SectionBfsHooks } from "../src/lib/identity/sectionBfs";
import type { GraphEvent, TournamentGraph } from "../src/lib/identity/graphTypes";
import type { MemberFootprint } from "../src/lib/identity/providers/edgeClient";

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`  ✔ ${msg}`);
  else {
    failures++;
    console.error(`  ✘ ${msg}`);
  }
};

const fp = (id: string, chesscom: number): MemberFootprint => ({
  uscfId: id,
  total: chesscom,
  chesscom,
  lichess: 0,
  other: chesscom ? 0 : 3,
  unknown: 0,
  pagesRead: 1,
  truncated: false,
  sections: [],
});
const FOOT: Record<string, number> = { A: 120, B: 60, C: 25, D: 6, E: 0, K: 40 };
const player = (id: string, name: string) => ({ uscfId: id, name, games: [] as GraphEvent["players"][number]["games"] });
const ev: GraphEvent = {
  eventId: "202601010001",
  sectionNumber: 1,
  name: "Test Rapid on Chess.com",
  startDate: "2026-01-01",
  platformGuess: "chesscom",
  players: [player("T", "Target Person"), player("A", "Alpha Aa"), player("B", "Bravo Bb"), player("C", "Charlie Cc"), player("D", "Delta Dd"), player("E", "Echo Ee"), player("K", "Kilo Kk")],
} as unknown as GraphEvent;
const graph: TournamentGraph = { rootUscfId: "T", rootName: "Target Person", onlineEvents: [ev], graphTraversalReady: true } as TournamentGraph;

function hooks(stored: { uscfId: string; platform: string; username: string }[]): Partial<SectionBfsHooks> {
  return {
    footprints: async (ids) => new Map(ids.filter((id) => id in FOOT).map((id) => [id, fp(id, FOOT[id])])),
    seedEdges: async () => stored,
    indexJoin: async () => [],
    negatives: async () => [],
    putNegative: async () => true,
    recordAlignment: async () => null,
    sectionGraphs: async () => [],
    discoverPlatform: async () => null,
    findUsernames: async () => null,
  };
}

/** A scripted engine: reports the given mappings in order, then returns. */
function scriptedEngine(mappings: { memberId: string; how: string }[]) {
  return (async (_g: TournamentGraph, o: any) => {
    for (const m of mappings) o.onMapping?.({ memberId: m.memberId, platform: "chesscom", username: `${m.memberId.toLowerCase()}_handle`, how: m.how });
    return { accounts: [], notes: [], found: false, mappedOpponents: mappings.length, guessedMembers: 0 };
  }) as any;
}

async function run(name: string, stored: { uscfId: string; platform: string; username: string }[], mappings: { memberId: string; how: string }[]) {
  const r = await runSectionBfs(graph, {
    targetName: "Target Person",
    log: () => {},
    hooks: hooks(stored),
    engine: scriptedEngine(mappings),
    maxLevel: 0,
  });
  console.log(`${name}: firstResolvedPivotRanks = ${JSON.stringify(r.firstResolvedPivotRanks)}`);
  return r.firstResolvedPivotRanks;
}

console.log("Scenario 1: no stored handles; the engine scouts C first");
assert(JSON.stringify(await run("s1", [], [{ memberId: "C", how: "seed" }])) === "[4]", "C is 4th (A, B and K rank above it)");

console.log("Scenario 2: K stored (rank 1000); the injected seed and then C");
const r2 = await run("s2", [{ uscfId: "K", platform: "chesscom", username: "k_handle" }], [
  { memberId: "K", how: "seed" },
  { memberId: "C", how: "seed" },
]);
assert(JSON.stringify(r2) === "[3]", "K is stored, so it is not a pivot: C is 3rd (the old code counted K at rank 1000 and read 4)");

console.log("Scenario 3: a pairing/alignment mapping is not a scouted pivot; the first SEED is");
assert(JSON.stringify(await run("s3", [], [{ memberId: "A", how: "pairing" }, { memberId: "D", how: "seed" }])) === "[4]", "A mapped by pairing first is not a scouted pivot; D is then 4th among the unknown (B, K, C above)");

console.log("Scenario 4: E (no Chess.com/Lichess history) never counts above anyone");
assert(JSON.stringify(await run("s4", [], [{ memberId: "D", how: "seed" }])) === "[5]", "D is 5th (A, B, K, C above; E, ranked -Infinity, is not)");

console.log(failures ? `\n${failures} assertion(s) FAILED.` : "\nAll pivot-rank scenarios passed.");
process.exit(failures ? 1 : 0);
