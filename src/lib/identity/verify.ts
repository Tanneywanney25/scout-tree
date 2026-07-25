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
  /** USCF member ID the account owner published on their profile (Lichess
   *  bio/links only — Chess.com's public API exposes no bio). An exact match
   *  against a crosstable player is near-conclusive; a different valid ID is
   *  near-fatal. */
  uscfId?: string;
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

/** A USCF member ID the profile owner published in free text (bio, links).
 *  Only trust a number that sits in an unmistakably-USCF context: a uschess.org
 *  member URL, or within a few words of "USCF" / "US Chess" — a bare 8-digit
 *  number is far too often a FIDE ID or noise. */
export function uscfIdFromText(text: string): string | undefined {
  if (!text) return undefined;
  const url = /uschess\.org\/(?:msa\/MbrDtlMain\.php\?|player\/|members?\/)(\d{8})/i.exec(text);
  if (url) return url[1];
  const near = /\b(?:uscf|us\s*chess)\b[^0-9]{0,24}(\d{8})\b/i.exec(text);
  return near ? near[1] : undefined;
}

const LICHESS_FORMAT_PRIORITY = ["rapid", "blitz", "classical", "bullet"];

/** Keep only flags that actually claim a country ("US", "CA", "GB-ENG"). */
function realCountry(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s && !s.startsWith("_") ? s : undefined;
}

// All verification calls go through the shared network discipline in net.ts:
// the global Chess.com concurrency gate / Lichess pacer, per-attempt timeouts,
// and 429-backoff-and-retry (a 429 is "slow down", NEVER "doesn't exist" —
// treating it as a missing account silently loses the player mid-traversal).
//
// Return contract (both verifiers): a profile when the account loads, `null`
// ONLY for a definitive verdict (no such user / closed account), and
// `undefined` when the FETCH failed — 5xx, timeout, corrupt body, or the
// shard-flake 404 that carries a 5xx error in its body. The distinction is
// the same hole-vs-verdict rule the archive fetchers live by: a hole says
// NOTHING about the account, so callers may retry it or fall back to
// structural evidence, but must never file it as "account doesn't exist".

/**
 * Bulk existence prefilter for SPECULATIVE Lichess handle scans (guessed
 * handles). One POST to /api/users (up to 300 ids per call) answers "which of
 * these accounts exist at all?" in a single pacer slot, where probing each
 * guess individually costs one paced GET apiece — for a 24-guess scan that is
 * a 24x cut in Lichess traffic.
 *
 * Returns the lowercase usernames that exist, or null when the bulk call
 * failed or came back unusable — callers MUST treat null as "prefilter
 * unavailable" and fall back to individual verification, never as a verdict.
 * Handles absent from a SUCCESSFUL response are skipped only as speculative
 * guesses; nothing records "no such account" from a bulk miss, so an
 * evidence-bearing path that later names the same handle still gets its own
 * full verification.
 */
export async function lichessExistingSubset(usernames: string[], signal?: AbortSignal): Promise<Set<string> | null> {
  const ids = Array.from(new Set(usernames.map((u) => u.trim().replace(/^@/, "").toLowerCase()).filter(Boolean))).slice(0, 300);
  if (!ids.length) return new Set();
  try {
    const res = await politeFetch(
      "https://lichess.org/api/users",
      { method: "POST", headers: { "Content-Type": "text/plain", Accept: "application/json" }, body: ids.join(","), signal },
      "lichess",
      15_000
    );
    if (!res.ok) return null; // endpoint unhappy — fall back to singular probes
    const arr = await res.json();
    if (!Array.isArray(arr)) return null;
    const found = new Set<string>();
    for (const u of arr) {
      const uname = typeof u?.username === "string" ? u.username : typeof u?.id === "string" ? u.id : "";
      if (uname && !u?.disabled && !u?.closed) found.add(uname.toLowerCase());
    }
    return found;
  } catch {
    return null; // network failure / circuit open — prefilter unavailable
  }
}

/** Verify and enrich a Lichess account. Null = no such account; undefined =
 *  the fetch failed (a data hole, not a verdict). */
export async function verifyLichess(
  username: string,
  signal?: AbortSignal
): Promise<VerifiedProfile | null | undefined> {
  const clean = username.trim().replace(/^@/, "");
  if (!clean) return null;
  try {
    const res = await politeFetch(
      `https://lichess.org/api/user/${encodeURIComponent(clean)}`,
      { headers: { Accept: "application/json" }, signal },
      "lichess"
    );
    // Only a clean 404 says "no such user" — any other failure status is the
    // server, not the account.
    if (!res.ok) return res.status === 404 ? null : undefined;
    const data = await res.json();
    if (!data) return undefined;
    if (data.disabled || data.closed) return null;

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
    // Lichess renamed its profile fields (firstName/lastName → realName,
    // country → flag); read the current names first and keep the old ones as
    // fallback so archived fixtures still parse.
    const realName = (
      (typeof profile.realName === "string" && profile.realName) ||
      [profile.firstName, profile.lastName].filter(Boolean).join(" ")
    ).trim();
    const freeText = [profile.bio, profile.links].filter((s: unknown) => typeof s === "string").join("\n");

    return {
      platform: "lichess",
      username: data.username || clean,
      displayName: realName || undefined,
      title: data.title || undefined,
      rating,
      ratings: Object.keys(ratings).length ? ratings : undefined,
      // Lichess "flags" include fantasy ones (_earth, _pirate…) that claim no
      // country at all — only a real code may feed the country evidence.
      country: realCountry(profile.flag) || realCountry(profile.country),
      location: typeof profile.location === "string" && profile.location.trim() ? profile.location.trim() : undefined,
      fideId: plausibleFideId(profile.fideId),
      uscfId: uscfIdFromText(freeText),
      fideRating: typeof profile.fideRating === "number" ? profile.fideRating : undefined,
      uscfRating: typeof profile.uscfRating === "number" ? profile.uscfRating : undefined,
      lastActiveMs: typeof data.seenAt === "number" ? data.seenAt : undefined,
      joinedMs: typeof data.createdAt === "number" ? data.createdAt : undefined,
      gamesFound: data.count?.all,
      profileUrl: data.url || `https://lichess.org/@/${data.username || clean}`,
    };
  } catch {
    return undefined; // network failure / corrupt body — a hole, not a verdict
  }
}

/** Verify and enrich a Chess.com account. Null = no such account; undefined =
 *  the fetch failed (a data hole, not a verdict). Chess.com's profile shards
 *  fail the same way its archive shards do — intermittent 404s whose BODY is
 *  a 5xx "internal error" for accounts that exist — so a 404 is only a
 *  verdict when its body doesn't carry that signature, and transient
 *  failures get the same bounded in-place retry the month fetcher uses. */
export async function verifyChesscom(
  username: string,
  signal?: AbortSignal
): Promise<VerifiedProfile | null | undefined> {
  const clean = username.trim().replace(/^@/, "").toLowerCase();
  if (!clean) return null;
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await politeFetch(
        `https://api.chess.com/pub/player/${encodeURIComponent(clean)}`,
        { headers: { Accept: "application/json" }, signal },
        "chesscom"
      );
    } catch {
      return undefined; // politeFetch already retried network errors
    }
    if (res.ok) break;
    // A real 404 (no such user) is a verdict; a 404 whose body carries a 5xx
    // error code is the shard flake in disguise; everything else is transient.
    let transient = res.status !== 404;
    if (!transient) {
      try {
        const body = await res.text();
        transient = /"code"\s*:\s*5\d\d|internal error/i.test(body);
      } catch {
        transient = true;
      }
    }
    if (!transient) return null;
    if (attempt < 2 && !signal?.aborted) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    return undefined;
  }
  try {
    const data = await res.json();
    if (!data) return undefined;
    if (data.status === "closed:abuse") return null;
    // Stats are fetched only for accounts that EXIST: speculative scans
    // (guessed handles, roster sweeps) are overwhelmingly misses, and the old
    // fire-both-upfront pattern doubled Chess.com volume through the shared
    // gate for every one of them. One extra RTT on the rare hit is far
    // cheaper than a wasted gate slot on every miss.
    const statsRes = await politeFetch(
      `https://api.chess.com/pub/player/${encodeURIComponent(clean)}/stats`,
      { headers: { Accept: "application/json" }, signal },
      "chesscom"
    ).catch(() => null);

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
    return undefined; // corrupt body on a 200 — a hole, not a verdict
  }
}

/** Dispatch verification by platform. Unknown platforms return null; an
 *  undefined result means the fetch failed (hole), not that the account is
 *  missing. */
// ---------------------------------------------------------------------------
// Verify observer — the WorkCounters' ear. Every candidate-handle verification
// pings this slot so the UI can report honest completed work ("Checked 41
// candidate handles") without touching any engine logic. One slot, attached /
// detached by the resolver around each search, same pattern as net.ts.
// ---------------------------------------------------------------------------

let verifyObserver: ((platform: Platform, username: string) => void) | null = null;

/** Attach (or with `null` detach) the process-wide verification observer. */
export function setVerifyObserver(fn: ((platform: Platform, username: string) => void) | null): void {
  verifyObserver = fn;
}

export async function verifyAccount(
  platform: Platform,
  username: string,
  signal?: AbortSignal
): Promise<VerifiedProfile | null | undefined> {
  try {
    verifyObserver?.(platform, username);
  } catch {
    /* an observer bug must never break a verification */
  }
  if (platform === "lichess") return verifyLichess(username, signal);
  if (platform === "chesscom") return verifyChesscom(username, signal);
  return null;
}
