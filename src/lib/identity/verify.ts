// ============================================================================
// Identity Resolution Engine — live account verification
//
// Given a (platform, username) guess, hit the platform's *public* API to:
//   1. confirm the account actually exists, and
//   2. enrich it with real attributes (real name, country, ratings, last-seen,
//      rough game count) that the resolver scores as evidence.
//
// Both Lichess and the Chess.com public APIs are CORS-friendly and key-less,
// so this runs directly in the browser. Everything fails soft: a network error
// or 404 just yields `null` and the caller treats the guess as unconfirmed.
// ============================================================================

import type { Platform } from "./types";
import { politeFetch } from "./net";

export interface VerifiedProfile {
  platform: Platform;
  username: string;
  displayName?: string;
  title?: string;
  /** Best single rating estimate across formats. */
  rating?: number;
  /** Per-format ratings, e.g. { blitz: 1850, rapid: 1900 }. */
  ratings?: Record<string, number>;
  country?: string; // ISO-2 where possible
  /** Free-text location from the profile ("Seattle, WA"), when given. */
  location?: string;
  /** FIDE ID the account owner linked on their profile (Lichess only). */
  fideId?: string;
  uscfRating?: number;
  fideRating?: number;
  lastActiveMs?: number;
  /** When the account was created — an account younger than the tournament
   *  cannot be the player who appeared in it. */
  joinedMs?: number;
  gamesFound?: number;
  profileUrl: string;
}

/** FIDE IDs are 5+ digit registry numbers; anything shorter is a rating. */
function plausibleFideId(v: unknown): string | undefined {
  const digits = String(v ?? "").replace(/\D/g, "");
  return digits.length >= 5 && Number(digits) >= 10000 ? digits : undefined;
}

const LICHESS_FORMAT_PRIORITY = ["rapid", "blitz", "classical", "bullet"];

// All verification calls go through the shared network discipline in net.ts:
// the global Chess.com concurrency gate / Lichess pacer, per-attempt timeouts,
// and 429-backoff-and-retry (a 429 is "slow down", NEVER "doesn't exist" —
// treating it as a missing account silently loses the player mid-traversal).

/** Verify and enrich a Lichess account. Returns null if it doesn't exist. */
export async function verifyLichess(
  username: string,
  signal?: AbortSignal
): Promise<VerifiedProfile | null> {
  const clean = username.trim().replace(/^@/, "");
  if (!clean) return null;
  try {
    const res = await politeFetch(
      `https://lichess.org/api/user/${encodeURIComponent(clean)}`,
      { headers: { Accept: "application/json" }, signal },
      "lichess"
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.disabled || data.closed) return null;

    const perfs = data.perfs || {};
    const ratings: Record<string, number> = {};
    for (const fmt of LICHESS_FORMAT_PRIORITY) {
      const p = perfs[fmt];
      if (p && typeof p.rating === "number" && (p.games || 0) > 0) {
        ratings[fmt] = p.rating;
      }
    }
    let rating: number | undefined;
    for (const fmt of LICHESS_FORMAT_PRIORITY) {
      if (ratings[fmt] !== undefined) {
        rating = ratings[fmt];
        break;
      }
    }

    const profile = data.profile || {};
    const realName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();

    return {
      platform: "lichess",
      username: data.username || clean,
      displayName: realName || undefined,
      title: data.title || undefined,
      rating,
      ratings: Object.keys(ratings).length ? ratings : undefined,
      country: profile.country || undefined,
      location: typeof profile.location === "string" && profile.location.trim() ? profile.location.trim() : undefined,
      fideId: plausibleFideId(profile.fideId),
      fideRating: typeof profile.fideRating === "number" ? profile.fideRating : undefined,
      uscfRating: typeof profile.uscfRating === "number" ? profile.uscfRating : undefined,
      lastActiveMs: typeof data.seenAt === "number" ? data.seenAt : undefined,
      joinedMs: typeof data.createdAt === "number" ? data.createdAt : undefined,
      gamesFound: data.count?.all,
      profileUrl: data.url || `https://lichess.org/@/${data.username || clean}`,
    };
  } catch {
    return null;
  }
}

/** Verify and enrich a Chess.com account. Returns null if it doesn't exist. */
export async function verifyChesscom(
  username: string,
  signal?: AbortSignal
): Promise<VerifiedProfile | null> {
  const clean = username.trim().replace(/^@/, "").toLowerCase();
  if (!clean) return null;
  try {
    // The profile and /stats calls are independent — fire both at once (the
    // stats fetch for a nonexistent user is a cheap fast 404).
    const [res, statsRes] = await Promise.all([
      politeFetch(
        `https://api.chess.com/pub/player/${encodeURIComponent(clean)}`,
        { headers: { Accept: "application/json" }, signal },
        "chesscom"
      ),
      politeFetch(
        `https://api.chess.com/pub/player/${encodeURIComponent(clean)}/stats`,
        { headers: { Accept: "application/json" }, signal },
        "chesscom"
      ).catch(() => null),
    ]);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.status === "closed:abuse") return null;

    // ISO-2 country code lives at the end of the country URL.
    let country: string | undefined;
    if (typeof data.country === "string") {
      const code = data.country.split("/").pop();
      if (code && code.length === 2) country = code.toUpperCase();
    }

    const ratings: Record<string, number> = {};
    let rating: number | undefined;
    let gamesFound: number | undefined;
    try {
      if (statsRes?.ok) {
        const stats = await statsRes.json();
        let totalGames = 0;
        for (const [key, fmt] of [
          ["chess_rapid", "rapid"],
          ["chess_blitz", "blitz"],
          ["chess_bullet", "bullet"],
          ["chess_daily", "daily"],
        ] as const) {
          const block = stats[key];
          if (block?.last?.rating) ratings[fmt] = block.last.rating;
          const rec = block?.record;
          if (rec) totalGames += (rec.win || 0) + (rec.loss || 0) + (rec.draw || 0);
        }
        for (const fmt of ["rapid", "blitz", "bullet", "daily"]) {
          if (ratings[fmt] !== undefined) {
            rating = ratings[fmt];
            break;
          }
        }
        if (totalGames > 0) gamesFound = totalGames;
      }
    } catch {
      /* stats are best-effort */
    }

    return {
      platform: "chesscom",
      username: data.username || clean,
      displayName: data.name || undefined,
      title: data.title || undefined,
      rating,
      ratings: Object.keys(ratings).length ? ratings : undefined,
      country,
      location: typeof data.location === "string" && data.location.trim() ? data.location.trim() : undefined,
      // Chess.com's `fide` field is the player's FIDE *rating*, not their ID.
      fideRating: typeof data.fide === "number" ? data.fide : undefined,
      lastActiveMs: typeof data.last_online === "number" ? data.last_online * 1000 : undefined,
      joinedMs: typeof data.joined === "number" ? data.joined * 1000 : undefined,
      gamesFound,
      profileUrl: data.url || `https://www.chess.com/member/${data.username || clean}`,
    };
  } catch {
    return null;
  }
}

/** Dispatch verification by platform. Unknown platforms return null. */
export async function verifyAccount(
  platform: Platform,
  username: string,
  signal?: AbortSignal
): Promise<VerifiedProfile | null> {
  if (platform === "lichess") return verifyLichess(username, signal);
  if (platform === "chesscom") return verifyChesscom(username, signal);
  return null;
}
