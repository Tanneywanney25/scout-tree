import type { StructureReport } from "./structureStats";
import type { EndgameReport } from "./endgameStats";
import type { OpponentProfile } from "./opponentProfiling";

interface OpeningNode {
  san: string;
  count: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  children?: OpeningNode[];
}

export interface OpeningPick {
  line: string;        // formatted, e.g. "1.e4 e5 2.Nf3"
  plies: string[];
  games: number;
  winRate: number;     // from the OPPONENT's perspective (lower = better for you)
}

export interface GamePlan {
  headline: string;
  targetLines: OpeningPick[];
  mainLines: OpeningPick[];
  weaknesses: string[];
  endgameTips: string[];
  structureTips: string[];
  ratingNote: string | null;
}

export interface GamePlanInput {
  openingTree: OpeningNode | null;
  profile: OpponentProfile | null;
  structureReport: StructureReport | null;
  endgameReport: EndgameReport | null;
  opponentName: string;
  userRating?: number | null;
}

function formatLine(plies: string[]): string {
  let out = "";
  for (let i = 0; i < plies.length; i++) {
    if (i % 2 === 0) out += `${Math.floor(i / 2) + 1}.`;
    out += plies[i] + " ";
  }
  return out.trim();
}

// Walk the opening tree and collect candidate lines with enough games.
function collectLines(
  node: OpeningNode | null,
  minGames: number,
  maxPlies: number,
  path: string[] = [],
  out: OpeningPick[] = []
): OpeningPick[] {
  if (!node?.children) return out;
  for (const child of node.children) {
    const plies = [...path, child.san];
    if (child.count >= minGames && plies.length >= 2) {
      out.push({ line: formatLine(plies), plies, games: child.count, winRate: child.winRate });
    }
    if (plies.length < maxPlies) collectLines(child, minGames, maxPlies, plies, out);
  }
  return out;
}

// Keep the deepest/most-specific lines and avoid near-duplicate prefixes.
function dedupePrefixes(picks: OpeningPick[]): OpeningPick[] {
  const kept: OpeningPick[] = [];
  for (const p of picks) {
    const isPrefixOfKept = kept.some(
      (k) => k.plies.join(" ").startsWith(p.plies.join(" ")) || p.plies.join(" ").startsWith(k.plies.join(" "))
    );
    if (!isPrefixOfKept) kept.push(p);
  }
  return kept;
}

function ratingNote(rating?: number | null): string | null {
  if (!rating) return null;
  if (rating < 1200) return "At your level, focus on safe development and not hanging pieces — let them go wrong first.";
  if (rating < 1800) return "Tuned for your level: steer toward the structures below and convert small edges patiently.";
  if (rating < 2200) return "You can play sharply here — prepare a couple of these lines a few moves deep.";
  return "Deep prep recommended: memorise the critical lines below and aim for their pet weaknesses.";
}

export function buildGamePlan(input: GamePlanInput): GamePlan {
  const { openingTree, profile, structureReport, endgameReport, opponentName, userRating } = input;

  const rootGames = openingTree?.count ?? 0;
  const minGames = Math.max(3, Math.round(rootGames * 0.04));
  const all = collectLines(openingTree, minGames, 6);

  // Opponent's worst-performing lines = your best chances. Require a real sample.
  const targetCandidates = [...all]
    .filter((l) => l.games >= minGames)
    .sort((a, b) => a.winRate - b.winRate || b.games - a.games);
  const targetLines = dedupePrefixes(targetCandidates).slice(0, 4);

  // Their go-to lines (most frequent) to be ready for.
  const mainLines = dedupePrefixes([...all].sort((a, b) => b.games - a.games)).slice(0, 3);

  const weaknesses: string[] = [];
  if (profile) {
    weaknesses.push(...(profile.exploitableWeaknesses || []));
    for (const ins of profile.keyInsights || []) {
      if (weaknesses.length < 5) weaknesses.push(ins);
    }
  }

  const endgameTips: string[] = [];
  for (const eg of endgameReport?.worstEndgames || []) {
    endgameTips.push(
      `Steer toward ${eg.info.label.toLowerCase()} — they win only ${Math.round(eg.winRate * 100)}% of these.`
    );
  }

  const structureTips: string[] = [];
  for (const st of structureReport?.weakestStructures || []) {
    structureTips.push(
      `Aim for ${st.structure.label.toLowerCase()} positions — they score just ${Math.round(st.winRate * 100)}%.`
    );
  }

  // Headline
  let headline = `Game plan vs ${opponentName}`;
  if (targetLines.length > 0) {
    headline = `Push ${opponentName} into ${targetLines[0].line} — they score only ${Math.round(
      targetLines[0].winRate * 100
    )}% there.`;
  } else if (weaknesses.length > 0) {
    headline = `Beat ${opponentName} by exploiting: ${weaknesses[0]}`;
  }

  return {
    headline,
    targetLines,
    mainLines,
    weaknesses: weaknesses.slice(0, 5),
    endgameTips: endgameTips.slice(0, 2),
    structureTips: structureTips.slice(0, 2),
    ratingNote: ratingNote(userRating),
  };
}
