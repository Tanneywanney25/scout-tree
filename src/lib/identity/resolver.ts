// ============================================================================
// Identity Resolution Engine — the resolver
//
// Orchestrates every Provider, then turns their raw output into ranked,
// explainable identities:
//
//   1. run all enabled providers concurrently (each narrates into the live UI)
//   2. pool every discovered + AI-suggested online account, and *verify* the
//      unconfirmed suggestions against the real Lichess / Chess.com APIs
//   3. cluster real-world identity fragments (USCF / FIDE / AI) with the online
//      accounts that corroborate them — name, IDs, rating and country all vote
//   4. score each cluster's confidence in log-odds space and rank them
//
// The result is 0..N candidate identities ("we found 3 possible matches"), each
// with its discovered accounts and the evidence behind every number.
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
} from "./types";
import { PROVIDERS } from "./providers";
import {
  scoreFromEvidence,
  nameSimilarity,
  nameMatchWeight,
  ratingMatchWeight,
  normalizeName,
} from "./confidence";
import { verifyAccount } from "./verify";

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

  // --- 1. Run every enabled provider concurrently ----------------------------
  const enabled = PROVIDERS.filter((p) => p.enabled(query));
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

  const results: ProviderResult[] = [];
  const providerStatus: ResolutionResult["providerStatus"] = [];
  settled.forEach((s, i) => {
    const p = enabled[i];
    if (s.status === "fulfilled") {
      results.push(s.value);
      providerStatus.push({ name: p.name, label: p.label, available: !s.value.unavailable, notes: s.value.notes });
    } else {
      providerStatus.push({ name: p.name, label: p.label, available: false, notes: ["Provider error."] });
    }
  });

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // --- 2. Pool accounts + verify AI/edge-suggested usernames -----------------
  const pool: PooledAccount[] = [];
  const poolKey = (platform: Platform, username: string) => `${platform}:${username.toLowerCase()}`;
  const inPool = new Set<string>();

  for (const r of results) {
    for (const acc of r.accounts) {
      const key = poolKey(acc.platform, acc.username);
      if (!inPool.has(key)) {
        inPool.add(key);
        pool.push({ account: acc });
      }
    }
  }

  // Collect unique suggestions that we haven't already verified as accounts.
  const fragments: PartialIdentity[] = results.flatMap((r) => r.identities);
  const suggestions: { platform: Platform; username: string; attachName: string }[] = [];
  const suggestionSeen = new Set<string>();
  for (const frag of fragments) {
    for (const s of frag.suggestedAccounts || []) {
      const key = poolKey(s.platform, s.username);
      if (inPool.has(key) || suggestionSeen.has(key)) continue;
      suggestionSeen.add(key);
      suggestions.push({ ...s, attachName: frag.name });
    }
  }

  if (suggestions.length) {
    emit(`Verifying ${suggestions.length} suggested online account(s)…`, "running");
    // Verify with limited concurrency to respect platform rate limits.
    const CONCURRENCY = 4;
    for (let i = 0; i < suggestions.length; i += CONCURRENCY) {
      if (signal?.aborted) break;
      const batch = suggestions.slice(i, i + CONCURRENCY);
      const verified = await Promise.all(
        batch.map(async (s) => ({ s, profile: await verifyAccount(s.platform, s.username, signal) }))
      );
      for (const { s, profile } of verified) {
        if (!profile) continue;
        const evidence: Evidence[] = [];
        const candidateName = profile.displayName || profile.username;
        const simToFragment = nameSimilarity(s.attachName, candidateName);
        const simToQuery = nameSimilarity(query.name, candidateName);
        const sim = Math.max(simToFragment, simToQuery);
        evidence.push({
          kind: "name-match",
          weight: nameMatchWeight(sim),
          label: profile.displayName
            ? `Profile name "${profile.displayName}" matches`
            : `Suggested handle "${profile.username}" verified`,
          source: "verification",
        });
        if (query.approxRating && profile.rating) {
          evidence.push({
            kind: "rating-match",
            weight: ratingMatchWeight(query.approxRating, profile.rating),
            label: `Rating ${profile.rating} vs expected ~${query.approxRating}`,
            source: "verification",
          });
        }
        evidence.push({ kind: "account-verified", weight: 0.6, label: "AI-suggested account confirmed live", source: "verification" });

        const account: DiscoveredAccount = {
          platform: profile.platform,
          username: profile.username,
          displayName: profile.displayName,
          title: profile.title,
          rating: profile.rating,
          ratings: profile.ratings,
          country: profile.country,
          gamesFound: profile.gamesFound,
          lastActive: profile.lastActiveMs ? new Date(profile.lastActiveMs).toISOString() : undefined,
          profileUrl: profile.profileUrl,
          verified: true,
          confidence: scoreFromEvidence(evidence),
          evidence,
        };
        const key = poolKey(account.platform, account.username);
        if (!inPool.has(key)) {
          inPool.add(key);
          pool.push({ account, attachName: s.attachName });
        }
      }
    }
  }

  emit("Matching player identities & building confidence graph…", "running");

  // --- 3. Cluster anchors + accounts -----------------------------------------
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

  // --- 4. Score + assemble final identities ----------------------------------
  const identities: ResolvedIdentity[] = clusters
    .map((c, idx) => buildIdentity(c, query, idx))
    .filter((id) => id.accounts.length > 0 || id.confidence >= 0.25);

  identities.sort((a, b) => b.confidence - a.confidence);
  const top = identities.slice(0, 4);

  emit("Almost done — finalising matches…", "running");
  if (top.length) emit(`Found ${top.length} possible match${top.length > 1 ? "es" : ""}.`, "done");
  else emit("No confident match found.", "info");

  return {
    query,
    identities: top,
    providerStatus,
    elapsedMs: Math.round(performance.now() - start),
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
