// Proof that the cross-corroborated single-edge target reveal (Task 1) gates
// correctly: a single loose edge is HELD, two independent direct-opponents
// clinch it, ambiguous edges abstain, and disagreeing votes never accumulate.
// Candidate selection is exercised on REAL Grigor Dilanyan archive data.
import { readFileSync } from "node:fs";
import path from "node:path";
import { targetEdgeCandidates } from "../src/lib/identity/uscfGraphEngine";

type Outcome = "w" | "l" | "d";
interface ArchiveGame { oppHandle: string; sourceColor: "white" | "black"; sourceOutcome?: Outcome; endMs: number; rated: boolean; timeClass?: string }

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

// --- Real data: Grigor Dilanyan's 9 event games (Black/Win vs Owen = nwchess2016 in R8). ---
const fx = JSON.parse(readFileSync(path.join(process.cwd(), "scripts", "align-fixture.json"), "utf8"));
const grigor: ArchiveGame[] = (fx.scoped as ArchiveGame[]).slice(1); // drop the warm-up
// Grigor's crosstable result vs Owen: Black, Win.
const trVsOwen = { outcome: "w" as Outcome, color: "black" as const };

console.log("=== Candidate selection on real data ===");
// With nothing claimed, {black,win} is ambiguous (adi0708 R4 AND nwchess2016 R8) → no vote.
const rawCands = targetEdgeCandidates(trVsOwen, grigor as never, "grigordilanyan", new Set());
check("ambiguous target signature yields >1 candidate → source abstains", rawCands.length > 1, `${rawCands.length} candidates`);

// Once the OTHER black/win board (adi0708, R4 vs Aditya) is claimed by alignment,
// the target's handle is the unique remaining candidate.
const claimed = new Set(["adi0708"]);
const uniq = targetEdgeCandidates(trVsOwen, grigor as never, "grigordilanyan", claimed);
check("with the sibling board claimed, exactly ONE candidate remains", uniq.length === 1, uniq.map((g) => g.oppHandle).join(","));
check("that candidate is the true target handle (nwchess2016)", uniq[0]?.oppHandle === "nwchess2016");

// Anchor must bite: a wrong expected outcome finds nothing.
check("wrong outcome anchor → no candidate", targetEdgeCandidates({ outcome: "l", color: "black" }, [uniq[0]] as never, "grigordilanyan", new Set()).length === 0);
check("colour contradiction → no candidate", targetEdgeCandidates({ outcome: "w", color: "white" }, [uniq[0]] as never, "grigordilanyan", new Set()).length === 0);
check("already-claimed handle → no candidate", targetEdgeCandidates(trVsOwen, [uniq[0]] as never, "grigordilanyan", new Set(["nwchess2016"])).length === 0);
check("outcome-unknown game is never a candidate", targetEdgeCandidates(trVsOwen, [{ ...uniq[0], sourceOutcome: undefined }] as never, "grigordilanyan", new Set()).length === 0);

// --- Vote accumulation gate (mirrors the engine's targetEdgeVotes ledger exactly). ---
console.log("\n=== Corroboration gate (2 independent voters, or FIDE) ===");
type Verdict = "accept" | "hold" | "abstain";
function simulate(sources: { id: string; handle: string; scoped: ArchiveGame[]; tr: { outcome: Outcome; color: "white" | "black" | "unknown" }; claimed: Set<string> }[], fideMatchHandle?: string): { handle: string | null; verdict: Verdict } {
  const votes = new Map<string, Set<string>>();
  for (const s of sources) {
    const cands = targetEdgeCandidates(s.tr, s.scoped as never, s.handle.toLowerCase(), s.claimed);
    if (cands.length !== 1) continue; // ambiguous / none → abstain
    const k = cands[0].oppHandle.toLowerCase();
    const set = votes.get(k) || new Set<string>();
    set.add(s.id);
    votes.set(k, set);
    const fideOk = fideMatchHandle ? k === fideMatchHandle.toLowerCase() : false;
    if (set.size >= 2 || fideOk) return { handle: k, verdict: "accept" };
  }
  const any = [...votes.values()].some((v) => v.size >= 1);
  return { handle: null, verdict: any ? "hold" : "abstain" };
}

const owenGame: ArchiveGame = uniq[0];
const src = (id: string, trOutcome: Outcome) => ({ id, handle: `opp_${id}`, scoped: [owenGame], tr: { outcome: trOutcome, color: "unknown" as const }, claimed: new Set<string>() });

check("ONE direct opponent naming the target → HOLD (not accepted)", simulate([src("d1", "w")]).verdict === "hold");
check("TWO independent direct opponents naming the same handle → ACCEPT", (() => { const r = simulate([src("d1", "w"), src("d2", "w")]); return r.verdict === "accept" && r.handle === "nwchess2016"; })());
// Two voters but pointing at DIFFERENT handles must NOT accumulate.
const otherGame: ArchiveGame = { oppHandle: "someone_else", sourceColor: "black", sourceOutcome: "w", endMs: 1, rated: false, timeClass: "blitz" };
check("two opponents naming DIFFERENT handles → never accept", simulate([{ id: "d1", handle: "opp_d1", scoped: [owenGame], tr: { outcome: "w", color: "unknown" }, claimed: new Set() }, { id: "d2", handle: "opp_d2", scoped: [otherGame], tr: { outcome: "w", color: "unknown" }, claimed: new Set() }]).verdict === "hold");
check("single opponent + FIDE-id match on that handle → ACCEPT", simulate([src("d1", "w")], "nwchess2016").verdict === "accept");
check("the SAME opponent voting twice does NOT self-corroborate", simulate([src("dup", "w"), src("dup", "w")]).verdict === "hold");

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
