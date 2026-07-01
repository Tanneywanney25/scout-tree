// ============================================================================
// Identity Resolution Engine — confidence & similarity model
//
// Confidence is computed in log-odds space: we start from a prior and add the
// signed `weight` of every piece of Evidence, then squash back to a 0..1
// probability with the logistic function. This lets independent clues combine
// naturally (two moderate clues ≈ one strong clue) and keeps everything
// explainable — each Evidence carries the exact nudge it contributed.
// ============================================================================

import type { Evidence } from "./types";

/** Logistic squash: log-odds → probability in (0, 1). */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Combine evidence into a 0..1 confidence.
 *
 * @param evidence   the signed log-odds contributions
 * @param prior      starting log-odds (default -1.4 ≈ 20% before any evidence,
 *                   reflecting that an arbitrary candidate is probably *not* the
 *                   person until clues say otherwise)
 */
export function scoreFromEvidence(evidence: Evidence[], prior = -1.4): number {
  const logOdds = evidence.reduce((sum, e) => sum + e.weight, prior);
  // Clamp to keep extreme single-ID matches from reading as a literal 100%.
  const p = sigmoid(logOdds);
  return Math.max(0.02, Math.min(0.985, p));
}

/** Confidence buckets used for colour-coding throughout the UI. */
export type ConfidenceLevel = "high" | "medium" | "low";

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.45) return "medium";
  return "low";
}

export function confidencePercent(confidence: number): number {
  return Math.round(confidence * 100);
}

// ---------------------------------------------------------------------------
// String / name similarity helpers
// ---------------------------------------------------------------------------

/** Lowercase, strip accents and non-letters, collapse whitespace. */
export function normalizeName(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sørensen–Dice coefficient over character bigrams (0..1). */
export function diceCoefficient(a: string, b: string): number {
  const x = normalizeName(a).replace(/\s/g, "");
  const y = normalizeName(b).replace(/\s/g, "");
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;

  const bigrams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const bg = x.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const bg = y.slice(i, i + 2);
    const count = bigrams.get(bg) || 0;
    if (count > 0) {
      bigrams.set(bg, count - 1);
      intersection++;
    }
  }
  return (2 * intersection) / (x.length - 1 + (y.length - 1));
}

/**
 * Name match score that is robust to order ("John Smith" vs "Smith, John")
 * and to partial info. Returns 0..1 where 1 is an essentially exact match.
 */
export function nameSimilarity(query: string, candidate: string): number {
  const qTokens = normalizeName(query).split(" ").filter(Boolean);
  const cTokens = normalizeName(candidate).split(" ").filter(Boolean);
  if (!qTokens.length || !cTokens.length) return 0;

  // Token-set overlap: each query token finds its best candidate token.
  let matched = 0;
  for (const qt of qTokens) {
    let best = 0;
    for (const ct of cTokens) {
      if (qt === ct) {
        best = 1;
        break;
      }
      best = Math.max(best, diceCoefficient(qt, ct));
    }
    if (best >= 0.85) matched += 1;
    else matched += best * 0.6; // partial credit for fuzzy token hits
  }
  const tokenScore = matched / qTokens.length;

  // Blend with whole-string similarity to reward fully-aligned names.
  const whole = diceCoefficient(query, candidate);
  return Math.max(tokenScore, 0.5 * tokenScore + 0.5 * whole);
}

/**
 * Translate a name similarity (0..1) into signed evidence weight. A strong
 * match is a solid positive; a clear mismatch is a meaningful negative so a
 * randomly-similar username can't masquerade as the person.
 */
export function nameMatchWeight(similarity: number): number {
  if (similarity >= 0.92) return 2.4;
  if (similarity >= 0.8) return 1.6;
  if (similarity >= 0.65) return 0.7;
  if (similarity >= 0.45) return 0.0;
  if (similarity >= 0.3) return -0.8;
  return -1.8;
}

/**
 * Rating proximity → signed weight. Deliberately lenient on large gaps because
 * ratings are compared across systems: a player's USCF (OTB) rating typically
 * sits several hundred points ABOVE their Chess.com/Lichess ratings, so a big
 * spread is expected for the same person and must not read as a mismatch. Only
 * an implausibly huge gap counts (mildly) against a match.
 */
export function ratingMatchWeight(approx: number, candidate: number): number {
  const diff = Math.abs(approx - candidate);
  if (diff <= 100) return 1.2;
  if (diff <= 250) return 0.8;
  if (diff <= 450) return 0.4; // ~USCF↔online offset — still corroborating
  if (diff <= 700) return 0.05;
  if (diff <= 1000) return -0.2;
  return -0.6;
}

/**
 * Rating proximity for an account discovered through the tournament-graph
 * engine, compared against a US Chess rating. Online play (Chess.com / Lichess)
 * and the target's USCF number are different systems — a player's online rating
 * typically sits a few hundred points below their OTB USCF rating — so this is
 * deliberately forgiving: proximity corroborates, but distance never sinks a
 * match that is already anchored by a date-matched game against a known
 * opponent. Only a wild (>1200pt) gap counts mildly against it.
 */
export function onlineRatingMatchWeight(uscfRating: number, onlineRating: number): number {
  const diff = Math.abs(uscfRating - onlineRating);
  if (diff <= 200) return 1.0;
  if (diff <= 400) return 0.6;
  if (diff <= 600) return 0.35; // classic OTB↔online offset — still corroborating
  if (diff <= 900) return 0.1;
  if (diff <= 1200) return 0.0;
  return -0.3;
}

/**
 * Evidence weight for a username found by tracing a *known* USCF opponent's
 * online games during the exact tournament window. This is the engine's
 * strongest signal short of an exact federation-ID match: we are looking at the
 * other side of a game a confirmed opponent really played. A date-matched game
 * (played inside the event window) is worth more than a loose one, and each
 * additional corroborating opponent compounds the certainty.
 */
export function graphDiscoveryWeight(dateMatched: boolean, corroboratingOpponents = 1): number {
  const base = dateMatched ? 2.0 : 1.2;
  const bonus = Math.min(1.2, Math.max(0, corroboratingOpponents - 1) * 0.6);
  return base + bonus;
}

/** ISO-2 / loose country comparison. */
export function countryMatches(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  // Compare trailing ISO-2 codes (e.g. ".../country/US" vs "United States").
  const codeA = na.slice(-2);
  const codeB = nb.slice(-2);
  return codeA.length === 2 && codeA === codeB;
}

/** Recency of activity → small positive weight; very stale → mildly negative. */
export function recencyWeight(lastActiveMs?: number): number {
  if (!lastActiveMs) return 0;
  const days = (Date.now() - lastActiveMs) / 86_400_000;
  if (days <= 30) return 0.3;
  if (days <= 365) return 0.15;
  if (days <= 365 * 3) return 0;
  return -0.2;
}
