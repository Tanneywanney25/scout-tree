// ============================================================================
// Identity Resolution Engine — the resolver
//
// Orchestrates every Provider in a strict trust order, then turns their raw
// output into ranked, explainable identities:
//
//   1. ANCHOR PHASE — real-world sources (US Chess, FIDE, AI reasoning,
//      tournament archives) run concurrently and establish WHO the person is
//      (IDs, state, ratings, online-rated history). Any explicit username the
//      *user* supplied is verified here too — that's their knowledge, not a
//      guess.
//   2. PRIMARY DISCOVERY — the tournament-graph traversal. Every online-rated
//      USCF event the target played is worked to exhaustion (host-platform
//      discovery via web flyers, tournament rosters + elimination, opponent
//      seeds, pairing-chain BFS through the crosstable, and a deep dive into
//      opponents' own histories). Usernames found here are anchored to real
//      games the person provably played.
//   3. FALLBACKS, in strict trust order — only when the traversal finds
//      nothing: FIRST the Google index (site:-restricted searches tying the
//      real name to indexed profile pages), and only if that yields nothing
//      verifiable, platform name search (autocomplete / handle guesses / AI
//      suggestions) as the absolute last resort. Everything found down here is
//      capped and explicitly flagged: without a tournament-verified game it
//      can still be a namesake — the 200-rated John Smith is not the
//      2000-rated one you're scouting.
//   4. Cluster the real-world identity fragments with the discovered accounts,
//      score each cluster's confidence in log-odds space, and rank.
//
// The result is 0..N candidate identities, each with its discovered accounts
// and the evidence behind every number.
// ============================================================================

import type {
  PlayerQuery,
  ResolutionResult,
  ResolvedIdentity,
  DiscoveredAccount,
  PartialIdentity,
  Evidence,
  Platform,
  SearchEvent,
  ProviderResult,
  Provider,
} from "./types";
import { PROVIDERS, NAME_FALLBACK_PROVIDERS } from "./providers";
import { getTournamentGraph, findUsernameCandidates } from "./providers/edgeClient";
import { runGraphTraversal, type TraversalResult } from "./providers/uscfGraph";
import { runSchoolResolver } from "./providers/schoolResolver";
import {
  scoreFromEvidence,
  nameSimilarity,
  nameMatchWeight,
  ratingMatchWeight,
  normalizeName,
} from "./confidence";
import { verifyAccount } from "./verify";
import { pool as runPool } from "./net";

export interface ResolveOptions {
  signal?: AbortSignal;
  /** Live narration callback for the full-screen detective UI. */
  onEvent?: (event: SearchEvent) => void;
}

// Real-world sources that can "anchor" an identity (a person, not just a handle).
const ANCHOR_SOURCES = new Set(["uscf", "fide", "ai", "chessresults"]);

// Evidence kinds that describe a single fact about the person — only the
// strongest instance should count toward the score (avoid double-counting three
// providers all saying "name matches"). Everything else is additive.
const SINGLE_VALUED = new Set<Evidence["kind"]>([
  "name-match",
  "rating-match",
  "country-match",
  "state-match",
  "federation-match",
  "uscf-id-match",
  "fide-id-match",
  "title-match",
  "activity-recency",
  "username-hint",
]);

/** Cap on what a purely name-based (last-resort) account may claim. */
const NAME_FALLBACK_MAX_CONFIDENCE = 0.62;

/** Cap for a Google-index find with no tournament-verified game behind it —
 *  more trustworthy than platform name search (an indexed page ties the name
 *  to the handle) but still short of a tournament-anchored identification. */
const GOOGLE_FALLBACK_MAX_CONFIDENCE = 0.7;

function collapseForScoring(evidence: Evidence[]): Evidence[] {
  const best = new Map<string, Evidence>();
  const additive: Evidence[] = [];
  for (const e of evidence) {
    if (SINGLE_VALUED.has(e.kind)) {
      const prev = best.get(e.kind);
      if (!prev || Math.abs(e.weight) > Math.abs(prev.weight)) best.set(e.kind, e);
    } else {
      additive.push(e);
    }
  }
  return [...best.values(), ...additive];
}

interface PooledAccount {
  account: DiscoveredAccount;
  /** Name of the identity fragment that suggested this account (for clustering). */
  attachName?: string;
}

interface Cluster {
  name: string;
  federation?: PartialIdentity["federation"];
  country?: string;
  state?: string;
  uscfId?: string;
  fideId?: string;
  title?: string;
  estimatedRating?: number;
  estimatedRatingSource?: string;
  ratings?: Record<string, number>;
  evidence: Evidence[];
  reasoning?: string;
  sources: Set<string>;
  accounts: DiscoveredAccount[];
  anchor: boolean;
}

const idDigits = (s?: string) => (s ? s.replace(/\D/g, "") : "");

function fragmentsMatch(a: { name: string; uscfId?: string; fideId?: string }, b: { name: string; uscfId?: string; fideId?: string }): boolean {
  if (a.uscfId && b.uscfId && idDigits(a.uscfId) === idDigits(b.uscfId)) return true;
  if (a.fideId && b.fideId && idDigits(a.fideId) === idDigits(b.fideId)) return true;
  return nameSimilarity(a.name, b.name) >= 0.72;
}

let eventCounter = 0;

/** The target's best USCF rating to corroborate online accounts with — prefer
 *  the Online Regular rating (closest system to online play) when we have it. */
function pickTargetRating(fragments: PartialIdentity[], query: PlayerQuery): number | undefined {
  const uscf = fragments.find((f) => f.source === "uscf");
  if (uscf?.ratings) {
    const key =
      Object.keys(uscf.ratings).find((k) => /online regular/i.test(k)) ||
      Object.keys(uscf.ratings).find((k) => /online/i.test(k));
    if (key) return uscf.ratings[key];
  }
  return uscf?.estimatedRating ?? query.approxRating;
}

/** Handle-looking tokens the user explicitly typed as a username hint. */
function extractHintHandles(hint?: string): string[] {
  if (!hint) return [];
  const tokens = hint.match(/[A-Za-z0-9_-]{3,25}/g) || [];
  const stop =
    /^(the|and|with|chess|com|org|username|handle|account|name|player|starts|start|their|they|think|maybe|something|lichess|chesscom|like|about)$/i;
  const out: string[] = [];
  for (const t of tokens) {
    if (stop.test(t)) continue;
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, 4);
}

export async function resolveIdentity(
  query: PlayerQuery,
  options: ResolveOptions = {}
): Promise<ResolutionResult> {
  const { signal, onEvent } = options;
  const start = performance.now();

  const emit = (message: string, status: SearchEvent["status"] = "info", provider?: string) => {
    onEvent?.({ id: ++eventCounter, message, status, provider, timestamp: Date.now() });
  };

  if (!query.name || !query.name.trim()) {
    throw new Error("A player name is required to start a search.");
  }

  emit("Starting identity resolution…", "info");

  // Per-phase wall-clock, ms — the profiling trail that tells us WHERE a slow
  // search spent its time (anchors vs traversal vs fallbacks). Returned on the
  // result and summarised in the narration at the end.
  const timings: Record<string, number> = {};
  const phaseTimer = (name: string) => {
    const p0 = performance.now();
    return () => {
      timings[name] = Math.round(performance.now() - p0);
    };
  };

  const results: ProviderResult[] = [];
  const providerStatus: ResolutionResult["providerStatus"] = [];

  const runProviders = async (providers: Provider[]) => {
    const enabled = providers.filter((p) => p.enabled(query));
    const settled = await Promise.allSettled(
      enabled.map((p) =>
        p
          .run({ query, signal, log: (m) => emit(m, "running", p.name) })
          .then((r) => {
            if (!r.unavailable) emit(`${p.label} done.`, "done", p.name);
            return r;
          })
      )
    );
    const batch: ProviderResult[] = [];
    settled.forEach((s, i) => {
      const p = enabled[i];
      if (s.status === "fulfilled") {
        batch.push(s.value);
        results.push(s.value);
        providerStatus.push({ name: p.name, label: p.label, available: !s.value.unavailable, notes: s.value.notes });
      } else {
        providerStatus.push({ name: p.name, label: p.label, available: false, notes: ["Provider error."] });
      }
    });
    return batch;
  };

  // --- 1. ANCHOR PHASE: who is this person? ----------------------------------
  {
    const done = phaseTimer("anchors");
    await runProviders(PROVIDERS);
    done();
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  const fragments: PartialIdentity[] = results.flatMap((r) => r.identities);
  const targetFideId = idDigits(fragments.find((f) => f.source === "uscf")?.fideId) || idDigits(query.fideId) || undefined;
  const targetRating = pickTargetRating(fragments, query);

  const pool: PooledAccount[] = [];
  const poolKey = (platform: Platform, username: string) => `${platform}:${username.toLowerCase()}`;
  const inPool = new Set<string>();
  const addToPool = (account: DiscoveredAccount, attachName?: string) => {
    const key = poolKey(account.platform, account.username);
    if (inPool.has(key)) return;
    inPool.add(key);
    pool.push({ account, attachName });
  };

  for (const r of results) for (const acc of r.accounts) addToPool(acc);

  /** Verify one suggested/hinted handle and score it as an account. */
  const verifyCandidate = async (
    platform: Platform,
    username: string,
    opts: { attachName?: string; hinted?: boolean }
  ): Promise<DiscoveredAccount | null> => {
    const profile = await verifyAccount(platform, username, signal);
    if (!profile) return null;
    const evidence: Evidence[] = [];
    // Name evidence comes from the profile's REAL name only. A username that
    // merely looks like the player's name is NOT a match — real-name handles
    // are rare, namesake accounts are not — so it never adds confidence (and
    // counts slightly against when it is the only "signal").
    const sim = profile.displayName
      ? Math.max(
          opts.attachName ? nameSimilarity(opts.attachName, profile.displayName) : 0,
          nameSimilarity(query.name, profile.displayName)
        )
      : 0;
    if (opts.hinted) {
      evidence.push({
        kind: "username-hint",
        weight: 1.6,
        label: `User-supplied handle "${profile.username}" exists`,
        source: "verification",
      });
      // A whimsical display name must not sink a handle the user typed in.
      if (profile.displayName) {
        evidence.push({
          kind: "name-match",
          weight: Math.max(-0.4, nameMatchWeight(sim)),
          label: `Profile name "${profile.displayName}" vs "${query.name}"`,
          source: "verification",
        });
      }
    } else if (profile.displayName) {
      evidence.push({
        kind: "name-match",
        weight: nameMatchWeight(sim),
        label: `Profile name "${profile.displayName}" ${sim >= 0.8 ? "matches" : "resembles"} "${query.name}"`,
        source: "verification",
      });
    } else {
      const handleSim = nameSimilarity(query.name, profile.username);
      evidence.push({
        kind: "name-match",
        weight: handleSim >= 0.8 ? -0.3 : 0,
        label:
          handleSim >= 0.8
            ? `Username @${profile.username} merely resembles the name — a weak negative, not a match`
            : "Profile shows no real name",
        source: "verification",
      });
    }
    if (targetRating && profile.rating) {
      evidence.push({
        kind: "rating-match",
        weight: ratingMatchWeight(targetRating, profile.rating),
        label: `Rating ${profile.rating} vs expected ~${targetRating}`,
        source: "verification",
      });
    }
    if (targetFideId && profile.fideId) {
      const match = idDigits(profile.fideId) === targetFideId;
      evidence.push({
        kind: "fide-id-match",
        weight: match ? 4.0 : -3.0,
        label: match
          ? `Profile links FIDE ID ${profile.fideId} — exact match`
          : `Profile links FIDE ID ${profile.fideId}, which contradicts the target's (${targetFideId})`,
        source: "verification",
      });
    }
    evidence.push({
      kind: "account-verified",
      weight: opts.hinted ? 0.5 : 0.6,
      label: opts.hinted ? "Hinted account confirmed live" : "Suggested account confirmed live",
      source: "verification",
    });
    return {
      platform: profile.platform,
      username: profile.username,
      displayName: profile.displayName,
      title: profile.title,
      rating: profile.rating,
      ratings: profile.ratings,
      country: profile.country,
      fideId: profile.fideId,
      gamesFound: profile.gamesFound,
      lastActive: profile.lastActiveMs ? new Date(profile.lastActiveMs).toISOString() : undefined,
      profileUrl: profile.profileUrl,
      verified: true,
      confidence: scoreFromEvidence(evidence),
      evidence,
    };
  };

  // --- 1b. Hint probe: handles the USER explicitly gave us --------------------
  const hintHandles = extractHintHandles(query.usernameHint);
  let hintStrong = false;
  if (hintHandles.length && !signal?.aborted) {
    const done = phaseTimer("hint-probe");
    emit(`Checking the username hint (${hintHandles.map((h) => `"${h}"`).join(", ")})…`, "running");
    // Every handle × platform combination verified concurrently.
    const combos = hintHandles.flatMap((h) => (["chesscom", "lichess"] as Platform[]).map((platform) => ({ h, platform })));
    const verified = await Promise.all(
      combos.map(({ h, platform }) => (signal?.aborted ? null : verifyCandidate(platform, h, { hinted: true })))
    );
    for (const acc of verified) {
      if (!acc) continue;
      addToPool(acc, query.name);
      const sim = nameSimilarity(query.name, acc.displayName || "");
      const fideMatch = !!(targetFideId && acc.fideId && idDigits(acc.fideId) === targetFideId);
      if (fideMatch || sim >= 0.92) hintStrong = true;
    }
    if (hintStrong) emit("The user-supplied handle checks out against the player's identity.", "done");
    done();
  }

  // --- 2. PRIMARY DISCOVERY: tournament-graph traversal ------------------------
  // The main event for any player with online USCF history: work every online
  // event they played (platform flyers, tournament rosters, opponent seeds,
  // pairing chains, deep opponent recursion) until a username falls out.
  // Name-based platform search stays OFF unless all of this comes up empty.
  let traversalFound = false;
  let graphAvailable = false;
  let partialOpponents = 0;
  const traversalDone = phaseTimer("traversal");
  if (!hintStrong && !signal?.aborted) {
    const graph = await getTournamentGraph(query, signal).catch(() => null);
    if (graph && graph.graphTraversalReady && graph.onlineEvents.length) {
      graphAvailable = true;
      emit("Tracing the player's USCF online events to uncover their real usernames…", "running", "uscf-graph");

      // FINDING THE USERNAME MATTERS MORE THAN WALL-CLOCK. The traversal runs
      // until it is genuinely exhausted — the engine ends itself once every
      // avenue (events, retries, the opponent pivot) is spent. A tight budget
      // is how the pivot stage got starved into ranking-then-quitting, and how
      // seed judgments got clock-poisoned into fake namesake verdicts. The
      // guards that remain protect against WEDGING, not slowness:
      //   1. a stall watchdog — if the engine emits NO log line for a while
      //      (a wedged step, a silent retry loop), it is stood down gracefully
      //      via stopWhen, keeping any accounts it already traced;
      //   2. a very generous hard ceiling + race as the last-ditch backstop,
      //      in case the engine somehow never returns at all.
      const TRAVERSAL_BUDGET_MS = 60 * 60_000; // hard ceiling — effectively unbounded
      const TRAVERSAL_STALL_MS = 90_000; // no log line for 90s = wedged
      let lastLogAt = Date.now();
      let abandoned = false;
      let stallAnnounced = false;
      const stalledOrAbandoned = () => {
        if (abandoned) return true;
        if (Date.now() - lastLogAt <= TRAVERSAL_STALL_MS) return false;
        if (!stallAnnounced) {
          stallAnnounced = true;
          emit("The tournament trace went quiet — standing it down and moving on to fallback discovery.", "info", "uscf-graph");
        }
        return true;
      };

      let traversal: TraversalResult;
      let hardTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        traversal = await Promise.race([
          runGraphTraversal(graph, {
            targetName: graph.rootName || query.name,
            targetRating,
            targetFideId,
            signal,
            budgetMs: TRAVERSAL_BUDGET_MS,
            stopWhen: stalledOrAbandoned,
            log: (m) => {
              lastLogAt = Date.now();
              emit(m, "running", "uscf-graph");
            },
          }),
          new Promise<TraversalResult>((resolve) => {
            hardTimer = setTimeout(() => {
              abandoned = true; // stands the still-running engine down too
              emit("The tournament trace ran out of time — moving on to fallback discovery.", "info", "uscf-graph");
              resolve({ accounts: [], notes: ["Traversal exceeded its hard time limit."], found: false, mappedOpponents: 0 });
            }, TRAVERSAL_BUDGET_MS + 30_000);
          }),
        ]);
      } catch {
        traversal = { accounts: [], notes: ["Tournament-graph traversal failed."], found: false, mappedOpponents: 0 };
      } finally {
        if (hardTimer !== undefined) clearTimeout(hardTimer);
      }
      providerStatus.push({ name: "uscf-graph", label: "Tournament graph", available: true, notes: traversal.notes });

      for (const acc of traversal.accounts) addToPool(acc, graph.rootName);
      traversalFound = traversal.accounts.length > 0;
      if (traversalFound) {
        emit(`Traced ${traversal.accounts.length} online account(s) through the player's own tournaments.`, "done", "uscf-graph");
      } else if (traversal.mappedOpponents > 0) {
        // Honest partial progress: we proved out opponents but not the target.
        // Anything the fallbacks surface below is a same-name lead, not this.
        partialOpponents = traversal.mappedOpponents;
        emit(
          `Mapped ${traversal.mappedOpponents} of ${query.name}'s tournament opponents, but their games never named ${query.name}'s own account — it may be on an untraceable platform. Any handle below is a same-name guess, not a tournament-confirmed match.`,
          "info",
          "uscf-graph"
        );
      }
    } else {
      emit("No online USCF tournament history to trace for this player.", "info", "uscf-graph");
    }
  } else if (hintStrong) {
    emit("Skipping the tournament trace — the user-supplied handle already identifies the account.", "info", "uscf-graph");
  }
  traversalDone();

  // --- 3. LAST RESORT: name-based platform search -----------------------------
  // Only when no tournament-verified username exists. Everything found here is
  // capped and carries an explicit namesake warning — it is a lead, not an
  // identification.
  const suggestions: { platform: Platform; username: string; attachName: string }[] = [];
  {
    const seen = new Set<string>();
    for (const frag of fragments) {
      for (const s of frag.suggestedAccounts || []) {
        const key = poolKey(s.platform, s.username);
        if (inPool.has(key) || seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ ...s, attachName: frag.name });
      }
    }
  }

  if (!traversalFound && !hintStrong && !signal?.aborted) {
    // --- 3a. GOOGLE INDEX (primary fallback) ---------------------------------
    // site:-restricted searches tying the real name to indexed profile pages.
    // Platform name search only runs if this yields nothing verifiable.
    emit(
      graphAvailable
        ? "Every tournament avenue came up empty — asking the Google index for the username before any name search."
        : "No tournament history to trace — asking the Google index for the username before any name search.",
      "info"
    );

    let googleVerified = 0;
    const googleDone = phaseTimer("google-index");
    try {
      const leads = await findUsernameCandidates(
        {
          name: query.name,
          state: query.state,
          clubOrSchool: query.club || query.school,
          uscfRating: targetRating,
          fideId: targetFideId,
          eventName: query.tournamentName,
        },
        signal
      );
      if (leads.length) {
        emit(`Google index returned ${leads.length} candidate handle(s) — verifying against the live platforms…`, "running");
        // Verify every lead concurrently, then add them in the index's own
        // order so downstream clustering sees the same sequence as before.
        const verified = new Array<Awaited<ReturnType<typeof verifyCandidate>>>(leads.length);
        await runPool(
          leads,
          10,
          async (lead, i) => {
            verified[i] = await verifyCandidate(lead.platform, lead.username, { attachName: query.name });
          },
          () => !!signal?.aborted
        );
        leads.forEach((lead, i) => {
          const acc = verified[i];
          if (!acc) return;
          const evidence: Evidence[] = [
            ...acc.evidence,
            {
              kind: "cross-reference",
              weight: 1.2,
              label: `Google index ties "${query.name}" to this profile${lead.sourceUrl ? ` (${lead.sourceUrl})` : ""}`,
              source: "resolver",
            },
            {
              kind: "other",
              weight: -0.5,
              label: "Not verified through any tournament game — could still be a namesake",
              source: "resolver",
            },
          ];
          addToPool(
            { ...acc, evidence, confidence: Math.min(scoreFromEvidence(evidence), GOOGLE_FALLBACK_MAX_CONFIDENCE) },
            query.name
          );
          googleVerified++;
        });
        if (googleVerified) emit(`Verified ${googleVerified} Google-indexed handle(s).`, "done");
      }
    } catch {
      /* Google fallback is best-effort */
    }
    googleDone();

    // --- 3a½. SCHOOL-BASED SOCIAL-GRAPH FALLBACK -----------------------------
    // For a player with no online tournament history AND no Google-indexed
    // handle, trace them through their SCHOOL: find the school, resolve
    // schoolmates to handles, and identify the account socially tied to that
    // cohort (friends / frequent opponents / clubs), confirmed by rating,
    // location and a federation-ID cross-check. Runs before name search because
    // a social-graph identification is far stronger than a same-name guess.
    let schoolVerified = 0;
    if (googleVerified === 0 && !signal?.aborted) {
      const schoolDone = phaseTimer("school-graph");
      const targetUscfId = idDigits(fragments.find((f) => f.source === "uscf")?.uscfId) || idDigits(query.uscfId) || undefined;
      const schoolState = query.state || fragments.find((f) => f.source === "uscf")?.state;
      emit("Nothing indexed either — tracing the player through their school's social graph…", "info", "school-graph");
      try {
        const school = await runSchoolResolver(
          {
            name: query.name,
            state: schoolState,
            city: undefined,
            uscfId: targetUscfId,
            targetRating,
            targetFideId,
            excludeHandles: pool.map((p) => p.account.username),
          },
          // Room for the 120s USCF-anchored schoolmate phase plus a full
          // archive/clubs crawl (now warm-cached and month-parallel — 4min
          // used to starve the crawl when the anchor phase ran 180s).
          { signal, budgetMs: 6 * 60_000, log: (m) => emit(m, "running", "school-graph") }
        );
        for (const acc of school.accounts) {
          addToPool(acc, query.name);
          schoolVerified++;
        }
        providerStatus.push({ name: "school-graph", label: "School social graph", available: true, notes: school.notes });
        if (schoolVerified) emit(`Identified ${schoolVerified} account(s) via ${school.school || "the school"}'s social graph.`, "done", "school-graph");
        else emit("The school social graph produced no confident match.", "info", "school-graph");
      } catch {
        providerStatus.push({ name: "school-graph", label: "School social graph", available: false, notes: ["School resolver error."] });
      }
      schoolDone();
    }

    // --- 3b. ABSOLUTE LAST RESORT: platform name search ----------------------
    if (googleVerified === 0 && schoolVerified === 0 && !signal?.aborted) {
      const nameSearchDone = phaseTimer("name-search");
      emit("The Google index gave nothing verifiable — falling back to platform name search (results may be a namesake).", "info");

      const demote = (acc: DiscoveredAccount): DiscoveredAccount => {
        const evidence: Evidence[] = [
          ...acc.evidence,
          {
            kind: "other",
            weight: -0.7,
            label: "Found by name search only — not verified through any tournament game; could be a namesake",
            source: "resolver",
          },
        ];
        return {
          ...acc,
          evidence,
          confidence: Math.min(scoreFromEvidence(evidence), NAME_FALLBACK_MAX_CONFIDENCE),
        };
      };

      const fallbackResults = await runProviders(NAME_FALLBACK_PROVIDERS);
      for (const r of fallbackResults) {
        for (const acc of r.accounts) addToPool(demote(acc));
        // Their fragments may carry further suggestions worth one verification.
        for (const frag of r.identities) {
          for (const s of frag.suggestedAccounts || []) {
            const key = poolKey(s.platform, s.username);
            if (!inPool.has(key) && !suggestions.some((x) => poolKey(x.platform, x.username) === key)) {
              suggestions.push({ ...s, attachName: frag.name });
            }
          }
        }
      }

      if (suggestions.length) {
        emit(`Verifying ${suggestions.length} suggested handle(s) against the live platforms…`, "running");
        // One worker pool instead of lock-step batches — a slow lookup no
        // longer stalls the other verifications in its batch.
        const verified = new Array<Awaited<ReturnType<typeof verifyCandidate>>>(suggestions.length);
        await runPool(
          suggestions,
          10,
          async (s, i) => {
            verified[i] = await verifyCandidate(s.platform, s.username, { attachName: s.attachName });
          },
          () => !!signal?.aborted
        );
        suggestions.forEach((s, i) => {
          const acc = verified[i];
          if (acc) addToPool(demote(acc), s.attachName);
        });
      }
      nameSearchDone();
    } else if (googleVerified > 0 || schoolVerified > 0) {
      for (const p of NAME_FALLBACK_PROVIDERS) {
        providerStatus.push({
          name: p.name,
          label: p.label,
          available: true,
          notes: [
            schoolVerified > 0
              ? "Skipped — the school social graph already produced a verified match."
              : "Skipped — the Google index already produced verified leads.",
          ],
        });
      }
    }
  } else {
    for (const p of NAME_FALLBACK_PROVIDERS) {
      providerStatus.push({
        name: p.name,
        label: p.label,
        available: true,
        notes: [
          traversalFound
            ? "Skipped — username already verified through the player's own tournament games."
            : "Skipped — the user-supplied handle already identifies the account.",
        ],
      });
    }
  }

  emit("Matching player identities & building confidence graph…", "running");

  // --- 4. Cluster anchors + accounts -----------------------------------------
  const clusters: Cluster[] = [];

  // Seed clusters from anchor fragments (real-world identities).
  for (const frag of fragments) {
    if (!ANCHOR_SOURCES.has(frag.source)) continue;
    const existing = clusters.find((c) => c.anchor && fragmentsMatch(c, frag));
    if (existing) {
      existing.evidence.push(...frag.evidence);
      existing.sources.add(frag.source);
      existing.uscfId ||= frag.uscfId;
      existing.fideId ||= frag.fideId;
      existing.state ||= frag.state;
      existing.country ||= frag.country;
      existing.federation ||= frag.federation;
      existing.title ||= frag.title;
      if (frag.estimatedRating && !existing.estimatedRating) {
        existing.estimatedRating = frag.estimatedRating;
        existing.estimatedRatingSource = frag.source.toUpperCase();
      }
      if (frag.reasoning && !existing.reasoning) existing.reasoning = frag.reasoning;
    } else {
      clusters.push({
        name: frag.name,
        federation: frag.federation,
        country: frag.country,
        state: frag.state,
        uscfId: frag.uscfId,
        fideId: frag.fideId,
        title: frag.title,
        estimatedRating: frag.estimatedRating,
        estimatedRatingSource: frag.estimatedRating ? frag.source.toUpperCase() : undefined,
        ratings: frag.ratings,
        evidence: [...frag.evidence],
        reasoning: frag.reasoning,
        sources: new Set([frag.source]),
        accounts: [],
        anchor: true,
      });
    }
  }

  // Attach each pooled account to its best cluster, or spin up a new one.
  for (const { account, attachName } of pool) {
    const candidateName = account.displayName || account.username;
    let best: Cluster | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      const nameScore = Math.max(
        nameSimilarity(c.name, candidateName),
        attachName ? nameSimilarity(c.name, attachName) : 0
      );
      let score = nameScore;
      // Corroborating attributes nudge attachment.
      if (account.country && c.country && account.country.slice(-2).toLowerCase() === c.country.slice(-2).toLowerCase()) score += 0.1;
      if (account.rating && c.estimatedRating && Math.abs(account.rating - c.estimatedRating) <= 250) score += 0.1;
      if (account.fideId && c.fideId && idDigits(account.fideId) === idDigits(c.fideId)) score += 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best && bestScore >= 0.62) {
      best.accounts.push(account);
      best.sources.add(account.platform);
    } else {
      clusters.push({
        name: candidateName,
        country: account.country,
        title: account.title,
        estimatedRating: account.rating,
        estimatedRatingSource: account.rating ? account.platform : undefined,
        ratings: account.ratings,
        evidence: [],
        sources: new Set([account.platform]),
        accounts: [account],
        anchor: false,
      });
    }
  }

  // --- 5. Score + assemble final identities ----------------------------------
  const identities: ResolvedIdentity[] = clusters
    .map((c, idx) => buildIdentity(c, query, idx))
    .filter((id) => id.accounts.length > 0 || id.confidence >= 0.25);

  identities.sort((a, b) => b.confidence - a.confidence);
  const top = identities.slice(0, 4);

  emit("Almost done — finalising matches…", "running");
  if (top.length) emit(`Found ${top.length} possible match${top.length > 1 ? "es" : ""}.`, "done");
  else emit("No confident match found.", "info");

  const elapsedMs = Math.round(performance.now() - start);
  const phaseSummary = Object.entries(timings)
    .filter(([, ms]) => ms >= 100)
    .map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`)
    .join(" · ");
  if (phaseSummary) emit(`Search took ${(elapsedMs / 1000).toFixed(1)}s — ${phaseSummary}.`, "info");

  return {
    query,
    identities: top,
    providerStatus,
    elapsedMs,
    timings,
    // Only flag partial-progress when we truly never confirmed the target: if a
    // later fallback DID produce a verified-identity account, drop the warning.
    partialOpponents:
      partialOpponents > 0 && !top.some((id) => id.accounts.some((a) => a.verified && !a.evidence?.some((e) => /namesake/i.test(e.label))))
        ? partialOpponents
        : undefined,
  };
}

function buildIdentity(c: Cluster, query: PlayerQuery, idx: number): ResolvedIdentity {
  // Dedupe accounts (keep the highest-confidence instance of each handle).
  const byKey = new Map<string, DiscoveredAccount>();
  for (const a of c.accounts) {
    const key = `${a.platform}:${a.username.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev || a.confidence > prev.confidence) byKey.set(key, a);
  }
  const accounts = Array.from(byKey.values()).sort((a, b) => b.confidence - a.confidence);

  // Identity-level scoring evidence: the person-facts plus a bounded boost for
  // each strong verified account we attributed to them.
  const scoringEvidence: Evidence[] = collapseForScoring(c.evidence);
  for (const acc of accounts.slice(0, 2)) {
    const w = Math.max(-0.3, Math.min(1.6, acc.confidence * 1.8 - 0.5));
    scoringEvidence.push({
      kind: "cross-reference",
      weight: w,
      label: `Verified ${platformLabel(acc.platform)} account @${acc.username}`,
      source: "resolver",
    });
  }
  // If a name-match wasn't supplied by any anchor (online-only cluster), add one.
  if (!scoringEvidence.some((e) => e.kind === "name-match")) {
    const sim = nameSimilarity(query.name, c.name);
    scoringEvidence.push({
      kind: "name-match",
      weight: nameMatchWeight(sim),
      label: `Name "${c.name}" ${sim >= 0.8 ? "matches" : "resembles"} "${query.name}"`,
      source: "resolver",
    });
  }

  const confidence = scoreFromEvidence(scoringEvidence, c.anchor ? -0.9 : -1.2);

  // Estimated rating: prefer a federation rating, else the strongest account.
  let estimatedRating = c.estimatedRating;
  let estimatedRatingSource = c.estimatedRatingSource;
  if (!estimatedRating && accounts[0]?.rating) {
    estimatedRating = accounts[0].rating;
    estimatedRatingSource = platformLabel(accounts[0].platform);
  }

  const ratings: Record<string, number> = { ...(c.ratings || {}) };
  for (const acc of accounts) {
    for (const [fmt, r] of Object.entries(acc.ratings || {})) {
      ratings[`${platformLabel(acc.platform)} ${fmt}`] = r;
    }
  }

  // Display evidence: unique, human-readable, strongest first.
  const displayEvidence = dedupeDisplay([...c.evidence, ...scoringEvidence.filter((e) => e.source === "resolver")]);

  const reasoning =
    c.reasoning ||
    synthesizeReasoning(c, accounts, query, confidence);

  const sources = Array.from(new Set([...c.sources, ...accounts.map((a) => a.platform)]));

  return {
    id: `identity-${idx}-${normalizeName(c.name).replace(/\s/g, "-") || "unknown"}`,
    name: c.name,
    federation: c.federation,
    country: c.country,
    state: c.state,
    uscfId: c.uscfId,
    fideId: c.fideId,
    estimatedRating,
    estimatedRatingSource,
    ratings: Object.keys(ratings).length ? ratings : undefined,
    title: c.title || accounts.find((a) => a.title)?.title,
    accounts,
    confidence,
    evidence: displayEvidence,
    reasoning,
    sources,
  };
}

function dedupeDisplay(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of [...evidence].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))) {
    const key = e.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.slice(0, 8);
}

function synthesizeReasoning(
  c: Cluster,
  accounts: DiscoveredAccount[],
  query: PlayerQuery,
  confidence: number
): string {
  const bits: string[] = [];
  const strong = c.evidence
    .filter((e) => e.weight > 0.5)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2)
    .map((e) => e.label.toLowerCase());
  if (strong.length) bits.push(strong.join(" and "));
  if (accounts.length) {
    bits.push(
      `${accounts.length} verified online ${accounts.length > 1 ? "accounts" : "account"} (${accounts
        .map((a) => `${platformLabel(a.platform)} @${a.username}`)
        .slice(0, 2)
        .join(", ")})`
    );
  }
  const lead =
    confidence >= 0.75 ? "Strong match" : confidence >= 0.45 ? "Possible match" : "Speculative match";
  if (!bits.length) return `${lead} for "${query.name}".`;
  return `${lead}: ${bits.join("; ")}.`;
}

function platformLabel(p: Platform): string {
  switch (p) {
    case "lichess":
      return "Lichess";
    case "chesscom":
      return "Chess.com";
    case "chesskid":
      return "ChessKid";
    case "icc":
      return "ICC";
    default:
      return "Other";
  }
}
