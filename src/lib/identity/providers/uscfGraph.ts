// ============================================================================
// Provider: USCF tournament-graph traversal  (the "secret feature")
//
// When a player can't be found directly, we replicate the manual detective
// workflow a serious tournament player does by hand:
//
//   player → online USCF event → opponents (from the crosstable) → an
//   opponent's online account → that account's games during the event month →
//   the OTHER player in their tournament games → verify → match back to our
//   target's name.
//
// The USCF half (event → opponents) is scraped server-side and arrives as the
// `tournamentGraph`. This provider does the online half in the browser
// (Chess.com/Lichess APIs are CORS-friendly), fanning work out across several
// concurrent "agents" and narrating each step into the live search UI.
// ============================================================================

import type { DiscoveredAccount, Provider, PartialIdentity, Evidence, Platform } from "../types";
import { getTournamentGraph, type GraphOpponent } from "./edgeClient";
import { verifyChesscom, verifyLichess, type VerifiedProfile } from "../verify";
import { nameSimilarity, nameMatchWeight, scoreFromEvidence } from "../confidence";

/** Compact username guesser (mirrors the Chess.com provider, kept local). */
function guessUsernames(name: string): string[] {
  const clean = name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const t = clean.split(" ").filter(Boolean);
  const first = t[0] || "";
  const last = t.length > 1 ? t[t.length - 1] : "";
  const g = new Set<string>();
  const add = (s: string) => {
    const u = s.replace(/[^a-z0-9_-]/g, "");
    if (u.length >= 3) g.add(u);
  };
  if (first && last) {
    add(`${first}${last}`);
    add(`${first}_${last}`);
    add(`${first[0]}${last}`);
    add(`${last}${first}`);
    add(`${first}${last}1`);
  }
  add(clean.replace(/\s/g, ""));
  if (first) add(first);
  if (last) add(last);
  return Array.from(g).slice(0, 8);
}

/** Bounded-concurrency map — our "multiple agents". */
async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length && !signal?.aborted) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

/** Resolve one opponent's Chess.com account by name (guess → verify → name-gate). */
async function resolveOpponentChesscom(opp: GraphOpponent, signal?: AbortSignal): Promise<VerifiedProfile | null> {
  for (const guess of guessUsernames(opp.name)) {
    if (signal?.aborted) return null;
    const p = await verifyChesscom(guess, signal);
    if (p && p.displayName && nameSimilarity(opp.name, p.displayName) >= 0.8) return p;
  }
  return null;
}

/** Fetch a Chess.com monthly archive and return the games. */
async function fetchArchive(username: string, ym: string, signal?: AbortSignal): Promise<any[]> {
  try {
    const [y, m] = ym.split("-");
    const res = await fetch(`https://api.chess.com/pub/player/${username}/games/${y}/${m}`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.games) ? data.games : [];
  } catch {
    return [];
  }
}

export const uscfGraphProvider: Provider = {
  name: "uscf-graph",
  label: "Tournament graph",
  enabled: () => true,
  async run({ query, signal, log }) {
    const graph = await getTournamentGraph(query, signal).catch(() => null);
    if (!graph || graph.onlineEvents.length === 0) {
      return { provider: "uscf-graph", identities: [], accounts: [], unavailable: true, notes: ["No online tournament graph to traverse."] };
    }

    const totalOpp = graph.onlineEvents.reduce((n, e) => n + e.opponents.length, 0);
    log(`Traversing ${graph.onlineEvents.length} online event(s) and ${totalOpp} opponents…`);

    const accounts: DiscoveredAccount[] = [];
    const notes: string[] = [];
    const targetName = query.name;

    // Work through up to 2 events; within each, resolve opponents concurrently.
    for (const event of graph.onlineEvents.slice(0, 2)) {
      if (signal?.aborted) break;
      const ym = event.date ? event.date.slice(0, 7) : null;
      const opponents = event.opponents.slice(0, 8);
      log(`Event "${event.name || event.eventId}": resolving ${opponents.length} opponents' online accounts…`);

      const resolved = await pool(opponents, 4, (o: GraphOpponent) => resolveOpponentChesscom(o, signal), signal);
      const found = resolved.filter((p): p is VerifiedProfile => !!p);
      if (found.length) notes.push(`Linked ${found.length} opponent(s) to Chess.com in "${event.name || event.eventId}".`);

      if (!ym) continue; // need the event month to scan archives

      // For each linked opponent, scan their games that month; the OTHER player
      // in their tournament games is a candidate for our target.
      for (const oppProfile of found.slice(0, 4)) {
        if (signal?.aborted) break;
        log(`Scanning @${oppProfile.username}'s ${ym} games for the target…`);
        const games = await fetchArchive(oppProfile.username, ym, signal);
        const candidates = new Set<string>();
        for (const g of games) {
          if (!g.tournament && !g.rated) continue; // focus on rated/tournament games
          const w = g.white?.username?.toLowerCase();
          const b = g.black?.username?.toLowerCase();
          const other = w === oppProfile.username.toLowerCase() ? b : w;
          if (other && other !== oppProfile.username.toLowerCase()) candidates.add(other);
        }

        // Verify a bounded set of candidate handles; keep those whose real name
        // matches our target — that's the scouted player, found via the graph.
        const list = Array.from(candidates).slice(0, 18);
        const verified = await pool(list, 5, (u: string) => verifyChesscom(u, signal), signal);
        for (const p of verified) {
          if (!p) continue;
          const sim = p.displayName ? nameSimilarity(targetName, p.displayName) : 0;
          if (sim < 0.8) continue;
          const evidence: Evidence[] = [
            { kind: "name-match", weight: nameMatchWeight(sim), label: `Chess.com name "${p.displayName}" matches "${targetName}"`, source: "uscf-graph" },
            { kind: "shared-opponent", weight: 1.8, label: `Played USCF opponent @${oppProfile.username} in "${event.name || event.eventId}"`, source: "uscf-graph" },
            { kind: "tournament-overlap", weight: 1.0, label: `Appears in the ${ym} games of a known tournament opponent`, source: "uscf-graph" },
            { kind: "account-verified", weight: 0.5, label: "Account confirmed live via Chess.com API", source: "uscf-graph" },
          ];
          if (!accounts.some((a) => a.platform === "chesscom" && a.username.toLowerCase() === p.username.toLowerCase())) {
            accounts.push({
              platform: "chesscom",
              username: p.username,
              displayName: p.displayName,
              title: p.title,
              rating: p.rating,
              ratings: p.ratings,
              country: p.country,
              gamesFound: p.gamesFound,
              lastActive: p.lastActiveMs ? new Date(p.lastActiveMs).toISOString() : undefined,
              profileUrl: p.profileUrl,
              verified: true,
              confidence: scoreFromEvidence(evidence, -0.6),
              evidence,
            });
            log(`Found @${p.username} — a match for ${targetName} via tournament traversal.`);
          }
        }
        if (accounts.length) break; // stop once we've discovered the target
      }
      if (accounts.length) break;
    }

    accounts.sort((a, b) => b.confidence - a.confidence);
    const identities: PartialIdentity[] = accounts.length
      ? [
          {
            name: accounts[0].displayName || query.name,
            estimatedRating: accounts[0].rating,
            suggestedAccounts: accounts.map((a) => ({ platform: "chesscom" as Platform, username: a.username })),
            evidence: accounts[0].evidence,
            reasoning: `Discovered via tournament-graph traversal (played a known USCF opponent online).`,
            source: "chessresults",
          },
        ]
      : [];

    return {
      provider: "uscf-graph",
      identities,
      accounts,
      notes: notes.length ? notes : ["Traversed the tournament graph; no online username inferred."],
    };
  },
};
