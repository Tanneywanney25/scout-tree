// ============================================================================
// Section-scoped level-order traversal.
//
// The unit of work is a SECTION, not a player: a USCF section and the online
// tournament that hosted it are two labelled copies of one pairing graph, so
// once ANY member of a section has a known handle, the section usually aligns
// whole (sectionAlign.ts) and every member gets a handle at once.
//
//   Level 0   the target's own online-rated sections on Chess.com / Lichess
//             (or an unknown host that may be either). ICC and ChessKid are
//             dropped: no public games to align against.
//   Level k+1 the other online sections of level-k members, ranked by their
//             portal footprint. Strictly level order: level k+1 is not
//             touched until level k is exhausted.
//
// Inside a section, every member is a pivot candidate, ranked on free portal
// data (footprint.ts on the edge): Chess.com/Lichess online-rated section
// count, a bonus for the section's own platform, and name rarity. Members with
// no Chess.com/Lichess/unknown-host history are excluded outright: they cannot
// be resolved by alignment and must not cost a request. Ranked pivots are
// resolved by the existing engine (uscfGraphEngine.runGraphTraversal) with:
// stored handles injected as seeds, the ranking as seed order, a cap on how
// many members may have handles guessed, and every alignment harvested.
//
// Backtracking. A section walked at level k is walked "for" the member who
// links it to its parent section (the bridge). When the bridge's handle
// becomes known — by alignment or by crown — the parent is re-walked with that
// handle as a seed, and so on up to the target's section. Any newly mapped
// member also re-opens every explored, unaligned section that lists them.
//
// Termination is by evidence (the target resolved), by frontier exhaustion,
// or by the request budget — never by a clock. The budget is adaptive: each
// level that makes progress (a newly aligned section or a new identity) earns
// more requests.
// ============================================================================

import type { DiscoveredAccount, Evidence } from "./types";
import type { GraphEvent, TournamentGraph, EventPlatformInfo, UsernameSearchRequest, UsernameCandidate } from "./graphTypes";
import {
  runGraphTraversal as runEngine,
  makeSharedCaches,
  nameUniqueness,
  type OnlinePlatform,
  type SharedCaches,
  type TraversalResult,
} from "./uscfGraphEngine";
import type { Conductor } from "./conductor";
import type { SectionAlignment } from "./sectionAlign";
import { getNetStats, allocatorSaturated, setSpeculativeBudget, speculativeBudgetState } from "./net";
import {
  fetchMemberFootprints,
  fetchSectionGraphs,
  fetchSectionNegatives,
  putSectionNegative,
  fetchSeedEdges,
  recordSectionAlignment,
  discoverEventPlatform,
  findUsernameCandidates,
  indexJoinSections,
  type IndexJoinSection,
  type MemberFootprint,
  type RecordAlignmentResult,
} from "./providers/edgeClient";

export type SectionKey = string; // `${eventId}#${sectionNumber}`
const keyOf = (eventId: string, sectionNumber?: number): SectionKey => `${eventId}#${sectionNumber ?? 0}`;
/** Same bar the baseline used for "resolved": a tournament-proven account. */
const RESOLVED_AT = 0.85;

/** Edge calls, injectable so tests and the CLI harness can stub them. */
export interface SectionBfsHooks {
  footprints(ids: string[], signal?: AbortSignal): Promise<Map<string, MemberFootprint>>;
  sectionGraphs(keys: { eventId: string; sectionNumber: number }[], signal?: AbortSignal): Promise<GraphEvent[]>;
  recordAlignment(req: {
    eventId: string;
    sectionNumber: number;
    kind: "chesscom-tournament" | "lichess-swiss" | "lichess-arena";
    tournamentId: string;
    targetUscfId?: string;
  }): Promise<RecordAlignmentResult | null>;
  negatives(keys: { eventId: string; sectionNumber: number }[]): Promise<{ eventId: string; sectionNumber: number }[]>;
  putNegative(row: { eventId: string; sectionNumber: number; reason: string; requests?: number }): Promise<boolean>;
  seedEdges(ids: string[], signal?: AbortSignal): Promise<{ uscfId: string; platform: string; username: string }[]>;
  discoverPlatform(ev: GraphEvent, signal?: AbortSignal): Promise<EventPlatformInfo | null>;
  findUsernames(req: UsernameSearchRequest, signal?: AbortSignal): Promise<UsernameCandidate[] | null>;
  /** Roster index: align sections against crawled rosters server-side;
   *  only `member`'s handle comes back. */
  indexJoin(keys: { eventId: string; sectionNumber: number }[], member: string, signal?: AbortSignal): Promise<IndexJoinSection[]>;
}

export const defaultSectionBfsHooks: SectionBfsHooks = {
  footprints: (ids, signal) => fetchMemberFootprints(ids, signal),
  sectionGraphs: (keys, signal) => fetchSectionGraphs(keys, "", signal),
  recordAlignment: (req) => recordSectionAlignment(req),
  negatives: (keys) => fetchSectionNegatives(keys),
  putNegative: (row) => putSectionNegative(row),
  seedEdges: (ids, signal) => fetchSeedEdges(ids, signal),
  // A platform named in the title only needs the STORED answer (it carries the
  // exact tournament); an unknown host may also be web-searched.
  discoverPlatform: (ev, signal) => {
    const g = (ev.platformGuess || "").toLowerCase();
    return discoverEventPlatform(ev, signal, { cacheOnly: g === "chesscom" || g === "lichess" });
  },
  findUsernames: (req, signal) => findUsernameCandidates({ ...req, maxQueries: req.maxQueries ?? 2 }, signal),
  indexJoin: (keys, member, signal) => indexJoinSections(keys, member, signal),
};

export interface SectionBfsProgress {
  level: number;
  sectionsWalked: number;
  frontier: number;
  alignedSections: number;
  identitiesHarvested: number;
  requests: number;
  budget: number;
}

export interface SectionBfsOptions {
  targetName: string;
  targetRating?: number;
  targetFideId?: string;
  signal?: AbortSignal;
  log: (message: string) => void;
  onProgress?: (p: SectionBfsProgress) => void;
  stopWhen?: () => boolean;
  conductor?: Conductor;
  hooks?: Partial<SectionBfsHooks>;
  shared?: SharedCaches;
  /** Initial platform-request budget (Chess.com + Lichess). Default 2,500. */
  requestBudget?: number;
  /** Ceiling the adaptive budget may grow to. Default 15,000. */
  maxRequestBudget?: number;
  /** Speculative requests (guessed handles, unverified probes) the whole
   *  search may SEND, across every section and level. Default 250. */
  speculativeRequestBudget?: number;
  /** Members whose handles may be guessed: in the level-0 run, per deeper
   *  section, and in the whole search. */
  guessCapLevel0?: number;
  guessCapDeeper?: number;
  guessBudget?: number;
  /** Most sections one bridge member may contribute to a level. */
  sectionsPerBridge?: number;
  /** Most sections admitted to one level of the frontier. */
  maxSectionsPerLevel?: number;
  /** Deepest level walked. Default 4. */
  maxLevel?: number;
  /** Section-mates ranked on portal data per level-0 search / deeper section. */
  footprintsLevel0?: number;
  footprintsPerDeepSection?: number;
  /** TEST affordance: pretend these member→handle pairs are stored. */
  seedMappings?: { memberId: string; platform: OnlinePlatform; username: string }[];
  /** TEST affordance: never scout these members (forces a longer chain). */
  excludeFromSeeding?: Set<string>;
  /** TEST affordance: the per-section engine (default: the real one). */
  engine?: typeof runEngine;
}

export interface SectionBfsResult extends TraversalResult {
  terminatedBy: "evidence" | "frontier" | "budget" | "stopped";
  levelReached: number;
  sectionsWalked: number;
  alignedSections: number;
  identitiesHarvested: number;
  harvestCalls: number;
  requests: { proven: number; speculative: number; total: number };
  firstAlignedAtMs?: number;
  /** 1-based rank of the first pivot whose handle resolved, per section run. */
  firstResolvedPivotRanks: number[];
  /** Backtracks that re-walked a shallower section with a new seed. */
  backtracks: number;
  /** Server verdict for the target, when its section was harvested. */
  targetHarvest?: { handle: string; tier: string; rounds: number; corroborating: number } | null;
  /** Roster-index joins: sections tried, resolved by the index, and how many
   *  of those spared an engine walk; not-covered = the index had no
   *  tournament in that section's date window at all. */
  index: { tried: number; resolved: number; notCovered: number; bridgesResolved: number; targetFound: boolean };
  /** The search-wide speculative request budget at the end of the search. */
  speculativeBudget: { limit: number; used: number; denied: number } | null;
  /** Per expanded level: sections admitted, distinct bridges, the most
   *  sections any one bridge contributed, and how many were held back. */
  levels: { level: number; sections: number; bridges: number; maxPerBridge: number; heldBack: number }[];
}

interface SectionNode {
  key: SectionKey;
  eventId: string;
  sectionNumber: number;
  level: number;
  ev?: GraphEvent;
  /** The member linking this section to its parent (absent at level 0). */
  bridge?: string;
  parent?: SectionKey;
  platform: "chesscom" | "lichess" | "unknown";
  status: "pending" | "walked" | "aligned";
  negative?: boolean;
}

const platformsOf = (p: SectionNode["platform"]): OnlinePlatform[] => (p === "unknown" ? ["chesscom", "lichess"] : [p]);

function sectionPlatform(ev: GraphEvent): SectionNode["platform"] {
  const g = (ev.platformGuess || "").toLowerCase();
  return g === "chesscom" || g === "lichess" ? g : "unknown";
}

const untraceable = (ev: GraphEvent) => {
  const g = (ev.platformGuess || "").toLowerCase();
  return g === "icc" || g === "chesskid";
};

/**
 * Pivot rank (brief item 2.2). Higher is better; -Infinity = excluded.
 *
 *   3.0 · log2(1 + sections on THIS section's platform)
 *   1.0 · log2(1 + sections on the other supported platform)
 *   0.5 · log2(1 + unknown-host sections)
 *   1.0 · name rarity (nameUniqueness, ~0–1.35)
 *   + 1000 when a handle is already known (free, always first)
 *
 * Why these weights. (1) A pivot is only useful in this section through its
 * handle ON THIS PLATFORM: a Lichess handle cannot seed a Chess.com bracket.
 * (2) Footprint is log-scaled because it is extreme (median 11 online
 * sections among online members, p99 507 — investigation §5.3). (3) Rarity
 * only sharpens the search channel, which has a budget of 0 queries today
 * (no Programmable Search key, grounding off; Phase 0.4), and name-derived
 * guessing accepts the true handle for 4.7% of Chess.com players whatever the
 * name (investigation §3.3) — so it breaks ties, it does not lead. Unknown
 * hosts count at half weight because they may turn out to be ICC.
 */
export function pivotRank(
  fp: MemberFootprint | undefined,
  sectionPlat: SectionNode["platform"],
  name: string,
  known: boolean
): number {
  if (known) return 1000;
  const rarity = nameUniqueness(name);
  if (!fp) return 0.5 * rarity; // footprint not fetched: below anyone measured
  const same = sectionPlat === "unknown" ? fp.chesscom + fp.lichess : sectionPlat === "chesscom" ? fp.chesscom : fp.lichess;
  const other = sectionPlat === "unknown" ? 0 : sectionPlat === "chesscom" ? fp.lichess : fp.chesscom;
  if (same + other + fp.unknown === 0) return -Infinity;
  return 3 * Math.log2(1 + same) + 1 * Math.log2(1 + other) + 0.5 * Math.log2(1 + fp.unknown) + rarity;
}

export async function runSectionBfs(rootGraph: TournamentGraph, opts: SectionBfsOptions): Promise<SectionBfsResult> {
  const hooks: SectionBfsHooks = { ...defaultSectionBfsHooks, ...(opts.hooks || {}) };
  const { signal, log } = opts;
  const T = rootGraph.rootUscfId;
  const shared = opts.shared ?? makeSharedCaches();
  const t0 = Date.now();
  const startStats = getNetStats();
  const reqBase = {
    proven: startStats.chesscom.proven.requests + startStats.lichess.proven.requests,
    speculative: startStats.chesscom.speculative.requests + startStats.lichess.speculative.requests,
  };
  const requestsSoFar = () => {
    const s = getNetStats();
    const proven = s.chesscom.proven.requests + s.lichess.proven.requests - reqBase.proven;
    const speculative = s.chesscom.speculative.requests + s.lichess.speculative.requests - reqBase.speculative;
    return { proven, speculative, total: proven + speculative };
  };
  // A fresh speculative budget for this search (4.1).
  setSpeculativeBudget(opts.speculativeRequestBudget ?? 250);
  const levelStats: SectionBfsResult["levels"] = [];
  let budget = opts.requestBudget ?? 2_500;
  const maxBudget = opts.maxRequestBudget ?? 15_000;
  const budgetSpent = () => requestsSoFar().total >= budget;
  const stopped = () => !!signal?.aborted || !!opts.stopWhen?.();

  // Search-scoped knowledge.
  const known = new Map<string, Map<OnlinePlatform, string>>();
  const memberName = new Map<string, string>();
  const sectionsOfMember = new Map<string, Set<SectionKey>>();
  const footprints = new Map<string, MemberFootprint>();
  const nodes = new Map<SectionKey, SectionNode>();
  const harvestedSections = new Set<SectionKey>();
  let identitiesHarvested = 0;
  let harvestCalls = 0;
  let alignedSections = 0;
  let firstAlignedAtMs: number | undefined;
  let backtracks = 0;
  let sectionsWalked = 0;
  let found = false;
  let targetHarvest: SectionBfsResult["targetHarvest"] = null;
  const accounts: DiscoveredAccount[] = [];
  const notes: string[] = [];
  const firstResolvedPivotRanks: number[] = [];
  const index = { tried: 0, resolved: 0, notCovered: 0, bridgesResolved: 0, targetFound: false };

  /** Order item 1 of 4 (docs/roster-index.md 2.4): the roster index. A
   *  resolved section is aligned without a platform request; `member`'s handle
   *  (the target or the bridge) is learned when it played there. */
  const joinFromIndex = async (keys: { eventId: string; sectionNumber: number }[], member: string) => {
    if (!keys.length) return new Map<SectionKey, IndexJoinSection>();
    const rows = await hooks.indexJoin(keys, member, signal).catch(() => [] as IndexJoinSection[]);
    const out = new Map<SectionKey, IndexJoinSection>();
    for (const r of rows) {
      index.tried++;
      if (r.verdict === "not-covered") index.notCovered++;
      const k = keyOf(r.eventId, r.sectionNumber);
      out.set(k, r);
      if (r.verdict !== "resolved") continue;
      index.resolved++;
      const node = nodes.get(k);
      if (node && node.status !== "aligned") {
        node.status = "aligned";
        alignedSections++;
        firstAlignedAtMs ??= Date.now() - t0;
      }
      harvestedSections.add(k);
      identitiesHarvested += r.stored || 0;
      progressedThisLevel = true;
      if (r.target && (r.target.platform === "chesscom" || r.target.platform === "lichess")) {
        if (member === T) {
          index.targetFound = true;
          targetHarvest = { handle: r.target.handle, tier: r.target.tier, rounds: r.target.rounds, corroborating: r.target.corroborating };
          const strong = r.target.tier === "strong";
          const acc: DiscoveredAccount = {
            platform: r.target.platform,
            username: r.target.handle,
            profileUrl:
              r.target.platform === "lichess" ? `https://lichess.org/@/${r.target.handle}` : `https://www.chess.com/member/${r.target.handle}`,
            verified: true,
            confidence: strong ? 0.99 : 0.93,
            evidence: [
              {
                kind: "tournament-overlap",
                weight: strong ? 4 : 1,
                label: `Roster index: the whole section aligned against the crawled tournament (${r.target.tier}, ${r.target.rounds} verified round(s), ${r.target.corroborating} corroborating opponent(s))`,
                source: "uscf-graph",
              },
            ],
          };
          recordTargetFind({ accounts: [acc], notes: [], found: strong, mappedOpponents: 0 });
        } else if (learnHandle(member, r.target.platform, r.target.handle)) {
          index.bridgesResolved++;
        }
      }
    }
    return out;
  };
  let progressedThisLevel = false;
  let level = 0;
  // Speculative budget for the whole search. Smoke data: a per-section cap
  // alone compounded to 628 guessed-profile probes over 38 level-1 sections.
  let guessesLeft = opts.guessBudget ?? 24;
  const pendingBacktracks: { node: SectionKey; seed: string }[] = [];
  const harvestPromises: Promise<void>[] = [];
  /** Wait (briefly) for in-flight harvest writes so the result can report them. */
  const end = async (t: SectionBfsResult["terminatedBy"]): Promise<SectionBfsResult> => {
    await Promise.race([Promise.allSettled(harvestPromises), new Promise((r) => setTimeout(r, 8_000))]);
    return finish(t);
  };

  const progress = () => {
    try {
      opts.onProgress?.({
        level,
        sectionsWalked,
        frontier: [...nodes.values()].filter((n) => n.status === "pending").length,
        alignedSections,
        identitiesHarvested,
        requests: requestsSoFar().total,
        budget,
      });
    } catch {
      /* a UI bug must never break the search */
    }
  };

  const learnHandle = (memberId: string, platform: OnlinePlatform, username: string): boolean => {
    const per = known.get(memberId) || new Map<OnlinePlatform, string>();
    if (per.get(platform)) return false;
    per.set(platform, username.toLowerCase());
    known.set(memberId, per);
    progressedThisLevel = true;
    // Collapse: every explored, unaligned section listing this member can now
    // be walked from a proven seed.
    for (const k of sectionsOfMember.get(memberId) || []) {
      const n = nodes.get(k);
      if (n && n.status === "walked" && n.ev) pendingBacktracks.push({ node: k, seed: memberId });
    }
    return true;
  };

  const registerSection = (ev: GraphEvent) => {
    const k = keyOf(ev.eventId, ev.sectionNumber);
    for (const p of ev.players) {
      if (!memberName.has(p.uscfId)) memberName.set(p.uscfId, p.name);
      const set = sectionsOfMember.get(p.uscfId) || new Set<SectionKey>();
      set.add(k);
      sectionsOfMember.set(p.uscfId, set);
    }
  };

  const ensureFootprints = async (ids: string[]) => {
    const need = ids.filter((id) => !footprints.has(id) && id !== T);
    if (!need.length) return;
    const got = await hooks.footprints(need, signal);
    for (const [id, fp] of got) footprints.set(id, fp);
  };

  const harvest = (ev: GraphEvent, link: { kind: string; id: string }, a: SectionAlignment, trusted: boolean) => {
    if (!trusted) return;
    const k = keyOf(ev.eventId, ev.sectionNumber);
    const platform: OnlinePlatform = link.kind === "chesscom-tournament" ? "chesscom" : "lichess";
    for (const x of a.assignments) learnHandle(x.uscfId, platform, x.handleLower);
    const node = nodes.get(k);
    if (node && node.status !== "aligned") {
      node.status = "aligned";
      alignedSections++;
      firstAlignedAtMs ??= Date.now() - t0;
    }
    if (harvestedSections.has(k) || typeof ev.sectionNumber !== "number") return;
    harvestedSections.add(k);
    harvestCalls++;
    const hp = hooks
      .recordAlignment({
        eventId: ev.eventId,
        sectionNumber: ev.sectionNumber,
        kind: link.kind as "chesscom-tournament" | "lichess-swiss" | "lichess-arena",
        tournamentId: link.id,
        targetUscfId: ev.players.some((p) => p.uscfId === T) ? T : undefined,
      })
      .then((r) => {
        if (r?.store?.written) identitiesHarvested += r.store.written;
        if (r?.target) targetHarvest = r.target;
      })
      .catch(() => undefined);
    harvestPromises.push(hp);
  };

  /** One engine run over `events`, resolving `root`. */
  const runOn = async (
    root: string,
    events: GraphEvent[],
    guessCapWanted: number,
    stopOnAlign: boolean
  ): Promise<TraversalResult> => {
    const guessCap = Math.max(0, Math.min(guessCapWanted, guessesLeft));
    // Ranks are computed LIVE (footprints keep arriving while the run works):
    // a member in several of these sections takes their best rank.
    const platsOf = new Map<string, SectionNode["platform"][]>();
    const nameOf = new Map<string, string>();
    for (const ev of events) {
      for (const p of ev.players) {
        if (p.uscfId === root) continue;
        platsOf.set(p.uscfId, [...(platsOf.get(p.uscfId) || []), sectionPlatform(ev)]);
        nameOf.set(p.uscfId, p.name);
      }
    }
    const liveRank = (id: string): number => {
      if (id === root || opts.excludeFromSeeding?.has(id)) return -Infinity;
      const plats = platsOf.get(id);
      if (!plats) return -Infinity;
      let best = -Infinity;
      for (const pl of plats) best = Math.max(best, pivotRank(footprints.get(id), pl, nameOf.get(id) || "", known.has(id)));
      return best;
    };
    const seeds: { memberId: string; platform: OnlinePlatform; username: string }[] = [];
    for (const ev of events) {
      for (const p of ev.players) {
        if (p.uscfId === root) continue;
        for (const [platform, username] of known.get(p.uscfId) || []) seeds.push({ memberId: p.uscfId, platform, username });
      }
    }
    let alignedHere = false;
    let firstPivotRankNoted = false;
    const result = await (opts.engine ?? runEngine)(
      { rootUscfId: root, rootName: memberName.get(root) || (root === T ? opts.targetName : root), onlineEvents: events, graphTraversalReady: true },
      {
        targetName: root === T ? opts.targetName : memberName.get(root) || root,
        targetRating: root === T ? opts.targetRating : undefined,
        targetFideId: root === T ? opts.targetFideId : undefined,
        signal,
        log,
        budgetMs: 6 * 60 * 60_000, // runaway guard only; the request budget and evidence end the walk
        conductor: opts.conductor,
        shared,
        seedMappings: seeds,
        seedPolicy: { rank: liveRank, maxGuessMembers: guessCap },
        hooks: {
          discoverPlatform: (ev) => hooks.discoverPlatform(ev, signal),
          findUsernames: (req) => hooks.findUsernames(req, signal),
        },
        onMapping: (m) => {
          // The first SCOUTED pivot's position in the order the engine scouts
          // in: 1 + the number of still-unknown, eligible members ranked above
          // it, read BEFORE the mapping (afterwards its rank jumps to 1000).
          // Members already known are not pivots to be found — counting them
          // (rank 1000 each) inflated the position by the number of stored
          // seeds; members ranked -Infinity are never scouted.
          const wasKnown = known.has(m.memberId);
          const mine = wasKnown ? Infinity : liveRank(m.memberId);
          const others = wasKnown
            ? []
            : [...platsOf.keys()].filter((id) => id !== m.memberId && !known.has(id)).map((id) => liveRank(id));
          const fresh = learnHandle(m.memberId, m.platform, m.username);
          if (fresh && m.how === "seed" && !firstPivotRankNoted) {
            firstPivotRankNoted = true;
            firstResolvedPivotRanks.push(others.filter((r) => r > mine).length + 1);
          }
        },
        onSectionAligned: (ev, link, a, trusted) => {
          harvest(ev, link, a, trusted);
          if (trusted) alignedHere = true;
        },
        stopWhen: () => stopped() || budgetSpent() || found || (stopOnAlign && (alignedHere || known.has(root))),
      }
    );
    guessesLeft = Math.max(0, guessesLeft - (result.guessedMembers ?? 0));
    // A bridge crowned by the engine is a mapping like any other (the engine
    // keeps its target out of its own mapping table).
    if (root !== T) {
      for (const acc of result.accounts) {
        if ((acc.platform === "chesscom" || acc.platform === "lichess") && acc.confidence >= RESOLVED_AT) {
          learnHandle(root, acc.platform, acc.username);
        }
      }
    }
    progress();
    return result;
  };

  const recordTargetFind = (r: TraversalResult) => {
    for (const acc of r.accounts) if (!accounts.some((x) => x.platform === acc.platform && x.username === acc.username)) accounts.push(acc);
    // Evidence ends the search only at the resolved threshold; a capped lead
    // keeps it going so a second section can confirm or replace it.
    if (r.accounts.some((a) => a.confidence >= RESOLVED_AT)) found = true;
  };

  /** Re-walk a shallower section now that one of its members is known. */
  const backtrack = async (k: SectionKey): Promise<void> => {
    const n = nodes.get(k);
    if (!n || !n.ev || n.status === "aligned" || found || stopped()) return;
    backtracks++;
    log(`Backtrack: re-walking "${n.ev.name}" (level ${n.level}) with a newly proven section-mate as a seed.`);
    if (n.level === 0) {
      recordTargetFind(await runOn(T, [n.ev], opts.guessCapDeeper ?? 3, false));
      return;
    }
    const b = n.bridge!;
    await runOn(b, [n.ev], opts.guessCapDeeper ?? 3, true);
    if (known.has(b) && n.parent) await backtrack(n.parent);
  };

  const drainBacktracks = async () => {
    while (pendingBacktracks.length && !found && !stopped()) {
      const { node } = pendingBacktracks.shift()!;
      await backtrack(node);
    }
  };

  // ---- Level 0 --------------------------------------------------------------
  const level0 = rootGraph.onlineEvents.filter((ev) => !untraceable(ev));
  if (!level0.length) {
    log(
      `${opts.targetName} has no online-rated section on Chess.com or Lichess (only ICC/ChessKid) — nothing a game record can be aligned against.`
    );
    notes.push("No alignable online-rated section (only ICC/ChessKid).");
    return end("frontier");
  }
  for (const ev of rootGraph.onlineEvents) registerSection(ev);
  for (const ev of level0) {
    const k = keyOf(ev.eventId, ev.sectionNumber);
    nodes.set(k, { key: k, eventId: ev.eventId, sectionNumber: ev.sectionNumber ?? 0, level: 0, ev, platform: sectionPlatform(ev), status: "pending" });
  }
  for (const s of opts.seedMappings || []) learnHandle(s.memberId, s.platform, s.username);
  const level0Members = [...new Set(level0.flatMap((ev) => ev.players.map((p) => p.uscfId)))].filter((id) => id !== T);
  try {
    for (const s of await hooks.seedEdges(level0Members, signal)) {
      if (s.platform === "chesscom" || s.platform === "lichess") learnHandle(s.uscfId, s.platform, s.username);
    }
  } catch {
    /* anonymous callers get no seeds */
  }
  log(
    `Section-scoped search for ${opts.targetName}: ${level0.length} online section(s) on Chess.com/Lichess at level 0, ${level0Members.length} section-mate(s) to rank by their US Chess online history.`
  );
  // Direct opponents first, then crosstable order. The first batch is awaited
  // (it decides who gets guessed); the rest stream in behind it and feed the
  // live ranking and the next level's expansion.
  const direct = new Set(
    level0.flatMap((ev) => ev.players.find((p) => p.uscfId === T)?.games.map((g) => g.opponentUscfId) ?? [])
  );
  const rankingOrder = [...level0Members.filter((id) => direct.has(id)), ...level0Members.filter((id) => !direct.has(id))];
  const level0Cap = opts.footprintsLevel0 ?? 160;
  await ensureFootprints(rankingOrder.slice(0, 30));
  const restOfRanking = ensureFootprints(rankingOrder.slice(30, level0Cap)).catch(() => undefined);
  const excluded = rankingOrder.filter((id) => {
    const fp = footprints.get(id);
    return fp && fp.chesscom + fp.lichess + fp.unknown === 0;
  }).length;
  log(
    `Ranked ${footprints.size} section-mate(s) on US Chess data alone (${Math.max(0, Math.min(level0Cap, rankingOrder.length) - footprints.size)} more on the way); ${excluded} have no Chess.com/Lichess history and will not cost a single request.`
  );
  progress();

  level = 0;
  const level0Index = await joinFromIndex(
    level0.filter((ev) => typeof ev.sectionNumber === "number").map((ev) => ({ eventId: ev.eventId, sectionNumber: ev.sectionNumber! })),
    T
  );
  if (level0Index.size) {
    log(
      `Roster index: ${[...level0Index.values()].filter((r) => r.verdict === "resolved").length} of ${level0Index.size} level-0 section(s) aligned from crawled rosters with no platform request` +
        `${index.targetFound ? ` — ${opts.targetName}'s handle among them` : ""}.`
    );
  }
  // Order items 2–4: stored handles as seeds, the section walk, guessing within
  // the budget — only over level-0 sections the index did not align.
  const level0Walk = level0.filter((ev) => nodes.get(keyOf(ev.eventId, ev.sectionNumber))?.status !== "aligned");
  if (!found && level0Walk.length) recordTargetFind(await runOn(T, level0Walk, opts.guessCapLevel0 ?? 8, false));
  for (const ev of level0) {
    const n = nodes.get(keyOf(ev.eventId, ev.sectionNumber))!;
    if (n.status !== "aligned") n.status = "walked";
    sectionsWalked++;
  }
  await drainBacktracks();
  // The rest of the ranking only feeds the next level; a found target must
  // not wait for it (smoke run: 25 s of footprint fetches after the match).
  if (!found && !stopped()) await restOfRanking;

  // ---- Levels 1..maxLevel ---------------------------------------------------
  const maxLevel = opts.maxLevel ?? 4;
  const perLevel = opts.maxSectionsPerLevel ?? 60;
  while (!found && !stopped() && level < maxLevel) {
    if (budgetSpent()) {
      if (progressedThisLevel && budget < maxBudget) {
        budget = Math.min(maxBudget, budget + 2_000);
        log(`Level ${level} made progress — request budget raised to ${budget}.`);
      } else break;
    }
    progressedThisLevel = false;
    // Expand: the other online sections of this level's members, best-ranked
    // members first, newest sections first, deduplicated against everything
    // already explored.
    // Round-robin over bridges in rank order, at most sectionsPerBridge each,
    // so a level spreads across members instead of being filled by the one
    // hub with the most history (smoke data: 60 of 60 level-1 sections came
    // from a single member, 2,368 held back).
    const current = [...nodes.values()].filter((n) => n.level === level && n.ev);
    const perBridge = opts.sectionsPerBridge ?? 4;
    const bridges: { id: string; r: number; parent: SectionKey; plat: SectionNode["platform"] }[] = [];
    const bridgeSeen = new Set<string>();
    for (const n of current) {
      for (const p of n.ev!.players) {
        if (p.uscfId === T || bridgeSeen.has(p.uscfId) || !footprints.has(p.uscfId)) continue;
        const r = pivotRank(footprints.get(p.uscfId), n.platform, p.name, known.has(p.uscfId));
        if (r === -Infinity) continue;
        bridgeSeen.add(p.uscfId);
        bridges.push({ id: p.uscfId, r, parent: n.key, plat: n.platform });
      }
    }
    bridges.sort((a, b) => b.r - a.r);
    const candidates: SectionNode[] = [];
    const seen = new Set(nodes.keys());
    const queues = bridges.map((b) => ({ b, secs: footprints.get(b.id)!.sections.slice(), taken: 0 }));
    for (let progressed = true; progressed; ) {
      progressed = false;
      for (const q of queues) {
        while (q.taken < perBridge && q.secs.length) {
          const s = q.secs.shift()!;
          const k = keyOf(s.eventId, s.section);
          if (seen.has(k)) continue;
          seen.add(k);
          q.taken++;
          progressed = true;
          candidates.push({
            key: k,
            eventId: s.eventId,
            sectionNumber: s.section,
            level: level + 1,
            bridge: q.b.id,
            parent: q.b.parent,
            platform: s.platform,
            status: "pending",
          });
          break; // one section per bridge per round
        }
      }
    }
    if (!candidates.length) {
      log(`Level ${level + 1}: the frontier is empty — every reachable online section has been walked.`);
      return end("frontier");
    }
    // Negative cache: sections walked out recently go to the back of the level.
    try {
      const neg = new Set(
        (await hooks.negatives(candidates.map((c) => ({ eventId: c.eventId, sectionNumber: c.sectionNumber })))).map((r) =>
          keyOf(r.eventId, r.sectionNumber)
        )
      );
      for (const c of candidates) c.negative = neg.has(c.key);
    } catch {
      /* fail soft */
    }
    candidates.sort((a, b) => Number(!!a.negative) - Number(!!b.negative));
    const levelNodes = candidates.slice(0, perLevel);
    {
      const per = new Map<string, number>();
      for (const c of levelNodes) per.set(c.bridge!, (per.get(c.bridge!) || 0) + 1);
      levelStats.push({
        level: level + 1,
        sections: levelNodes.length,
        bridges: per.size,
        maxPerBridge: Math.max(0, ...per.values()),
        heldBack: candidates.length - levelNodes.length,
      });
    }
    level++;
    for (const c of levelNodes) nodes.set(c.key, c);
    log(
      `Level ${level}: ${levelNodes.length} section(s) reached through ${new Set(levelNodes.map((c) => c.bridge)).size} section-mate(s)` +
        `${candidates.length > levelNodes.length ? ` (${candidates.length - levelNodes.length} more held back)` : ""}` +
        `${levelNodes.some((c) => c.negative) ? `; ${levelNodes.filter((c) => c.negative).length} walked out recently, queued last` : ""}.`
    );
    progress();

    // Fan out across the level's sections. The allocator, not a worker count,
    // bounds the fan-out: a new section starts only while proven requests are
    // not already queuing (allocatorSaturated).
    let next = 0;
    const running = new Set<Promise<void>>();
    const MAX_WORKERS = 6;
    const walk = async (n: SectionNode) => {
      const bridgeKnown = known.has(n.bridge!);
      if (bridgeKnown) {
        // Already proven elsewhere: no need to walk this section for it.
        n.status = "walked";
        if (n.parent) pendingBacktracks.push({ node: n.parent, seed: n.bridge! });
        return;
      }
      const evs = await hooks.sectionGraphs([{ eventId: n.eventId, sectionNumber: n.sectionNumber }], signal);
      const ev = evs[0];
      if (!ev || untraceable(ev)) {
        n.status = "walked";
        return;
      }
      ev.sectionNumber ??= n.sectionNumber;
      n.ev = ev;
      registerSection(ev);
      // Order item 1: the roster index. A section it aligns needs no walk.
      await joinFromIndex([{ eventId: n.eventId, sectionNumber: n.sectionNumber }], n.bridge!);
      if (n.status === "aligned") {
        sectionsWalked++;
        if (known.has(n.bridge!) && n.parent) pendingBacktracks.push({ node: n.parent, seed: n.bridge! });
        return;
      }
      // Deeper sections rank fewer members: MUIR allows ~100 requests a
      // minute per address and a cold footprint costs up to five.
      await ensureFootprints(ev.players.map((p) => p.uscfId).slice(0, opts.footprintsPerDeepSection ?? 15));
      sectionsWalked++;
      const before = requestsSoFar().total;
      await runOn(n.bridge!, [ev], opts.guessCapDeeper ?? 3, true);
      // runOn may align the section through the harvest callback.
      const alignedNow = (n.status as SectionNode["status"]) === "aligned";
      if (!alignedNow) n.status = "walked";
      if (known.has(n.bridge!) && n.parent) {
        pendingBacktracks.push({ node: n.parent, seed: n.bridge! });
      } else if (!alignedNow) {
        void hooks.putNegative({
          eventId: n.eventId,
          sectionNumber: n.sectionNumber,
          reason: "walked without a resolution",
          requests: requestsSoFar().total - before,
        });
      }
    };
    while ((next < levelNodes.length || running.size) && !found && !stopped() && !budgetSpent()) {
      await drainBacktracks();
      if (found) break;
      while (next < levelNodes.length && running.size < MAX_WORKERS && (!running.size || !allocatorSaturated()) && !budgetSpent()) {
        const n = levelNodes[next++];
        const p = walk(n)
          .catch((e: unknown) => {
            if (!signal?.aborted) log(`⚠ Section walk failed: ${String(e instanceof Error ? e.message : e).slice(0, 160)}`);
          })
          .finally(() => void running.delete(p));
        running.add(p);
      }
      if (!running.size) break;
      await Promise.race(running);
    }
    while (running.size) await Promise.all(running);
    await drainBacktracks();
  }
  if (found) return end("evidence");
  if (stopped()) return end("stopped");
  if (budgetSpent()) return end("budget");
  return end(level >= maxLevel ? "budget" : "frontier");

  function finish(terminatedBy: SectionBfsResult["terminatedBy"]): SectionBfsResult {
    if (found) terminatedBy = "evidence";
    const req = requestsSoFar();
    const tierNote =
      targetHarvest && accounts.length
        ? targetHarvest.tier === "strong"
          ? "verdict"
          : "lead"
        : undefined;
    // Confidence model (brief item 4.6): a STRONG server-verified alignment is
    // a verdict (0.99); a weak one is a lead (0.93) until a second section
    // agrees. Measured disagreement: strong 0.99%, weak ~3.5%.
    for (const acc of accounts) {
      if (targetHarvest && acc.username.toLowerCase() === targetHarvest.handle) {
        const strong = targetHarvest.tier === "strong";
        acc.confidence = strong ? Math.max(acc.confidence, 0.99) : Math.min(acc.confidence, 0.93);
        const ev: Evidence = {
          kind: "tournament-overlap",
          weight: strong ? 4 : 1,
          label: `Server re-ran the whole-section alignment: ${targetHarvest.tier} (${targetHarvest.rounds} verified round(s), ${targetHarvest.corroborating} corroborating opponent(s))`,
          source: "uscf-graph",
        };
        acc.evidence = [...acc.evidence, ev];
      }
    }
    if (tierNote) notes.push(`Target resolved by alignment (${tierNote}).`);
    notes.push(
      `Section search: ${terminatedBy}; level ${level}, ${sectionsWalked} section(s) walked, ${alignedSections} aligned, ${identitiesHarvested} identities stored, ${req.total} platform requests (${req.speculative} speculative).`
    );
    log(
      `Section search ended (${terminatedBy}): level ${level} reached, ${sectionsWalked} section(s) walked, ${alignedSections} aligned, ${backtracks} backtrack(s), ${req.total} platform requests (${req.proven} proven, ${req.speculative} speculative).`
    );
    const mappedOpponents = [...known.keys()].filter((id) => id !== T).length;
    return {
      accounts,
      notes,
      found,
      mappedOpponents,
      terminatedBy,
      levelReached: level,
      sectionsWalked,
      alignedSections,
      identitiesHarvested,
      harvestCalls,
      requests: req,
      firstAlignedAtMs,
      firstResolvedPivotRanks,
      backtracks,
      targetHarvest,
      index,
      speculativeBudget: speculativeBudgetState(),
      levels: levelStats,
    };
  }
}
