// ============================================================================
// Provider: Lichess  (real, client-side, key-less)
//
// Lichess exposes a public username autocomplete and a rich user API, both
// CORS-friendly. We turn the query name + hints into a handful of search terms,
// autocomplete each, then verify the most promising hits to pull real names,
// countries, ratings and last-seen — all of which become scored evidence.
// ============================================================================

import type { DiscoveredAccount, Provider, PartialIdentity, Evidence, PlayerQuery } from "../types";
import {
  nameSimilarity,
  nameMatchWeight,
  ratingMatchWeight,
  countryMatches,
  recencyWeight,
  scoreFromEvidence,
} from "../confidence";
import { verifyLichess, type VerifiedProfile } from "../verify";

interface AutocompleteUser {
  id: string;
  name: string;
  title?: string;
}

/** Build a small, de-duplicated set of autocomplete terms from the query. */
function buildTerms(name: string, usernameHint?: string): string[] {
  const terms = new Set<string>();
  const clean = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = clean.split(" ").filter(Boolean);

  if (clean.replace(/\s/g, "").length >= 3) terms.add(clean.replace(/\s/g, "")); // "johnsmith"
  if (tokens.length >= 2) {
    terms.add(`${tokens[0]}${tokens[tokens.length - 1]}`); // first+last
    terms.add(`${tokens[0]}_${tokens[tokens.length - 1]}`);
  }
  for (const t of tokens) if (t.length >= 3) terms.add(t); // each long token

  if (usernameHint) {
    const hintTokens = usernameHint.toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
    for (const h of hintTokens) if (!/^(the|with|chess|username|starts|their|com)$/.test(h)) terms.add(h);
  }
  return Array.from(terms).slice(0, 6);
}

async function autocomplete(term: string, signal?: AbortSignal): Promise<AutocompleteUser[]> {
  try {
    const res = await fetch(
      `https://lichess.org/api/player/autocomplete?term=${encodeURIComponent(term)}&object=true`,
      { headers: { Accept: "application/json" }, signal }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.result) ? data.result : [];
  } catch {
    return [];
  }
}

/** Build evidence + confidence for one verified Lichess profile. */
function scoreProfile(profile: VerifiedProfile, query: PlayerQuery): DiscoveredAccount {
  const evidence: Evidence[] = [];
  const source = "lichess";

  // Name match — prefer the account's real name, fall back to the username.
  const candidateName = profile.displayName || profile.username;
  const sim = nameSimilarity(query.name, candidateName);
  evidence.push({
    kind: "name-match",
    weight: nameMatchWeight(sim),
    label: profile.displayName
      ? `Lichess profile name "${profile.displayName}" ${sim >= 0.8 ? "matches" : "is similar to"} "${query.name}"`
      : `Username "${profile.username}" ${sim >= 0.8 ? "matches" : "resembles"} the name`,
    source,
  });

  if (query.approxRating && profile.rating) {
    evidence.push({
      kind: "rating-match",
      weight: ratingMatchWeight(query.approxRating, profile.rating),
      label: `Lichess rating ${profile.rating} vs expected ~${query.approxRating}`,
      source,
    });
  }
  if (query.country && profile.country && countryMatches(query.country, profile.country)) {
    evidence.push({ kind: "country-match", weight: 0.8, label: `Country matches (${profile.country})`, source });
  }
  if (profile.title) {
    evidence.push({ kind: "title-match", weight: 0.3, label: `Holds the ${profile.title} title`, source });
  }
  // Cross-reference: Lichess profiles can carry FIDE/USCF IDs the user gave us.
  if (query.fideId && profile.fideId && query.fideId.replace(/\D/g, "") === profile.fideId.replace(/\D/g, "")) {
    evidence.push({ kind: "fide-id-match", weight: 3.5, label: `FIDE ID ${profile.fideId} matches exactly`, source });
  }
  const rec = recencyWeight(profile.lastActiveMs);
  if (rec !== 0) {
    evidence.push({ kind: "activity-recency", weight: rec, label: rec > 0 ? "Recently active" : "Account looks dormant", source });
  }
  evidence.push({ kind: "account-verified", weight: 0.4, label: "Account confirmed live via Lichess API", source });

  return {
    platform: "lichess",
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
}

export const lichessProvider: Provider = {
  name: "lichess",
  label: "Lichess",
  enabled: () => true,
  async run({ query, signal, log }) {
    log("Searching Lichess players…");
    const terms = buildTerms(query.name, query.usernameHint);
    const seen = new Set<string>();
    const candidates: AutocompleteUser[] = [];

    for (const term of terms) {
      if (signal?.aborted) break;
      const hits = await autocomplete(term, signal);
      for (const h of hits) {
        if (!seen.has(h.id.toLowerCase())) {
          seen.add(h.id.toLowerCase());
          candidates.push(h);
        }
      }
      if (candidates.length >= 14) break;
    }

    log(`Lichess: ${candidates.length} possible usernames, verifying the closest…`);

    // Verify the most promising candidates (cheap, but rate-limited — cap it).
    const ranked = candidates
      .map((c) => ({ c, sim: nameSimilarity(query.name, c.name) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 8);

    const accounts: DiscoveredAccount[] = [];
    for (const { c } of ranked) {
      if (signal?.aborted) break;
      const profile = await verifyLichess(c.id, signal);
      if (profile) {
        const account = scoreProfile(profile, query);
        // Keep only plausibly-related accounts to avoid flooding the UI.
        if (account.confidence >= 0.3) accounts.push(account);
      }
    }

    accounts.sort((a, b) => b.confidence - a.confidence);
    const top = accounts.slice(0, 5);

    const identities: PartialIdentity[] = top.length
      ? [
          {
            name: top[0].displayName || query.name,
            country: top[0].country,
            estimatedRating: top[0].rating,
            ratings: top[0].ratings,
            title: top[0].title,
            suggestedAccounts: top.map((a) => ({ platform: "lichess" as const, username: a.username })),
            evidence: top[0].evidence,
            reasoning: `Lichess account "${top[0].username}" is the strongest on-platform match.`,
            source: "lichess",
          },
        ]
      : [];

    return {
      provider: "lichess",
      identities,
      accounts: top,
      notes: top.length ? [`Found ${top.length} candidate Lichess account(s).`] : ["No confident Lichess match."],
    };
  },
};
