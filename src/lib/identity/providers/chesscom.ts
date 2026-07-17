// ============================================================================
// Provider: Chess.com  (real, client-side, key-less)
//
// Chess.com's public API has no name search — only "does username X exist".
// So we generate likely usernames from the name (+ any "username starts with…"
// hint), verify each against /pub/player, and gate acceptance on the profile's
// real `name` field. That keeps false positives down: a random existing handle
// only counts if its on-profile name actually resembles the person.
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
import { verifyChesscom, type VerifiedProfile } from "../verify";

/** Generate a bounded, ordered list of plausible Chess.com usernames. */
function generateUsernameGuesses(name: string, hint?: string): string[] {
  const clean = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = clean.split(" ").filter(Boolean);
  const first = tokens[0] || "";
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : "";
  const guesses = new Set<string>();

  const add = (s: string) => {
    const u = s.replace(/[^a-z0-9_-]/g, "");
    if (u.length >= 3) guesses.add(u);
  };

  if (first && last) {
    add(`${first}${last}`);
    add(`${first}_${last}`);
    add(`${first}-${last}`);
    add(`${first[0]}${last}`); // jsmith
    add(`${first}${last[0]}`);
    add(`${last}${first}`);
    add(`${first}${last}1`);
    add(`${first}${last}chess`);
  }
  add(clean.replace(/\s/g, ""));
  if (first) add(first);
  if (last) add(last);

  // A "username starts with…" hint is gold — verify hint-derived handles first.
  const ordered: string[] = [];
  if (hint) {
    const hintTokens = hint.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
    for (const h of hintTokens) {
      if (/^(the|with|chess|username|starts|their|com|think|maybe|something)$/.test(h)) continue;
      add(h);
      ordered.push(h.replace(/[^a-z0-9_-]/g, ""));
      if (first) add(`${h}${first}`);
    }
  }
  for (const g of guesses) if (!ordered.includes(g)) ordered.push(g);
  return ordered.slice(0, 14);
}

function scoreProfile(profile: VerifiedProfile, query: PlayerQuery): DiscoveredAccount | null {
  const evidence: Evidence[] = [];
  const source = "chesscom";

  const hasRealName = !!profile.displayName;
  const sim = nameSimilarity(query.name, profile.displayName || profile.username);

  // Without a real name on the profile, only accept a near-literal username hit.
  if (!hasRealName && sim < 0.78) return null;
  // With a real name present, a clear mismatch is disqualifying.
  if (hasRealName && sim < 0.4) return null;

  evidence.push({
    kind: "name-match",
    weight: nameMatchWeight(sim) + (hasRealName ? 0.3 : -0.3),
    label: hasRealName
      ? `Chess.com profile name "${profile.displayName}" ${sim >= 0.8 ? "matches" : "is similar to"} "${query.name}"`
      : `Username "${profile.username}" closely matches the name`,
    source,
  });

  if (query.approxRating && profile.rating) {
    evidence.push({
      kind: "rating-match",
      weight: ratingMatchWeight(query.approxRating, profile.rating),
      label: `Chess.com rating ${profile.rating} vs expected ~${query.approxRating}`,
      source,
    });
  }
  if (query.country && profile.country && countryMatches(query.country, profile.country)) {
    evidence.push({ kind: "country-match", weight: 0.8, label: `Country matches (${profile.country})`, source });
  }
  if (profile.title) {
    evidence.push({ kind: "title-match", weight: 0.3, label: `Holds the ${profile.title} title`, source });
  }
  if (query.fideId && profile.fideId && query.fideId.replace(/\D/g, "") === profile.fideId.replace(/\D/g, "")) {
    evidence.push({ kind: "fide-id-match", weight: 3.5, label: `FIDE ID ${profile.fideId} matches exactly`, source });
  }
  const rec = recencyWeight(profile.lastActiveMs);
  if (rec !== 0) {
    evidence.push({ kind: "activity-recency", weight: rec, label: rec > 0 ? "Recently active" : "Account looks dormant", source });
  }
  evidence.push({ kind: "account-verified", weight: 0.4, label: "Account confirmed live via Chess.com API", source });

  return {
    platform: "chesscom",
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

export const chesscomProvider: Provider = {
  name: "chesscom",
  label: "Chess.com",
  enabled: () => true,
  async run({ query, signal, log }) {
    log("Searching Chess.com members…");
    const guesses = generateUsernameGuesses(query.name, query.usernameHint);
    const accounts: DiscoveredAccount[] = [];
    let checked = 0;

    for (const guess of guesses) {
      if (signal?.aborted) break;
      const profile = await verifyChesscom(guess, signal);
      checked++;
      if (profile) {
        const account = scoreProfile(profile, query);
        if (account && account.confidence >= 0.3) accounts.push(account);
      }
      // Gentle pacing — Chess.com tolerates serial reads but we stay polite.
      if (checked % 4 === 0) await new Promise((r) => setTimeout(r, 120));
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
            fideId: top[0].evidence.some((e) => e.kind === "fide-id-match") ? query.fideId : undefined,
            suggestedAccounts: top.map((a) => ({ platform: "chesscom" as const, username: a.username })),
            evidence: top[0].evidence,
            reasoning: `Chess.com account "${top[0].username}" is the strongest on-platform match.`,
            source: "chesscom",
          },
        ]
      : [];

    return {
      provider: "chesscom",
      identities,
      accounts: top,
      notes: top.length
        ? [`Found ${top.length} candidate Chess.com account(s) from ${checked} checks.`]
        : [`Checked ${checked} likely handles; no confident Chess.com match.`],
    };
  },
};
