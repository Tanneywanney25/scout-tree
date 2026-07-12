// ============================================================================
// Identity Resolution Engine — the SEARCH-WIDE cache
//
// The engine's expensive fetches were already memoized, but only per traversal
// run: runGraphTraversal builds a fresh SharedCaches unless handed one, so the
// main search's traversal, every schoolmate trace the school resolver runs,
// and any follow-up search in the same session each re-fetched the same
// profiles, monthly game archives and Google lookups. Schoolmates play each
// other constantly — their traces overlap heavily — so that redundancy was a
// large share of the 60–180s resolution times.
//
// This module makes the memoization SESSION-WIDE:
//   • SearchCache — a small dependency-free Map-with-TTL used for plain values.
//   • getSharedTraversalCaches() — ONE SharedCaches instance (profile verifies,
//     window games, Chess.com months, Google candidates) reused by every
//     traversal in the session, recycled after CACHE_TTL_MS so data can't go
//     stale forever.
//   • A resolved-identity store (`identity:{uscfId}` → platform/handle/
//     confidence) written whenever a traversal confirms an account, and read by
//     the school resolver's fast path so a schoolmate resolved once — in this
//     search or the previous one — costs nothing the next time.
//
// Dependency-light on purpose (uscfGraphEngine only, for the SharedCaches
// shape): runs in the browser, the Node CLI harness and tests alike.
// ============================================================================

import { makeSharedCaches, type SharedCaches, type OnlinePlatform } from "./uscfGraphEngine";

/** How long cached data stays valid — balances freshness (ratings move, new
 *  games appear) against not refetching the same person mid-session. */
export const CACHE_TTL_MS = 60 * 60_000; // 1 hour

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/** A tiny Map-with-TTL. Values are plain data (not promises) — callers that
 *  memoize in-flight work keep using promise-maps; this is for results worth
 *  keeping across whole searches. */
export class SearchCache<V = unknown> {
  private entries = new Map<string, Entry<V>>();

  constructor(private ttlMs: number = CACHE_TTL_MS) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    this.entries.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.ttlMs) });
    // Opportunistic sweep so a long session can't accumulate dead entries.
    if (this.entries.size > 2048) this.sweep();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, e] of this.entries) if (now > e.expiresAt) this.entries.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Session-wide traversal caches (profile verifies / game windows / Chess.com
// months / Google candidates). One instance shared by the main traversal, its
// deep-phase sub-traversals AND every schoolmate trace — recycled after the
// TTL so a long-lived tab eventually refreshes ratings and new games.
// ---------------------------------------------------------------------------

let sharedCaches: SharedCaches | null = null;
let sharedCachesBornAt = 0;

export function getSharedTraversalCaches(): SharedCaches {
  if (!sharedCaches || Date.now() - sharedCachesBornAt > CACHE_TTL_MS) {
    sharedCaches = makeSharedCaches();
    sharedCachesBornAt = Date.now();
  }
  return sharedCaches;
}

/** TEST: drop every session-wide cache (fresh state between harness runs). */
export function resetSearchCaches(): void {
  sharedCaches = null;
  sharedCachesBornAt = 0;
  identityCache.clear();
}

// ---------------------------------------------------------------------------
// Resolved-identity store — `identity:{uscfId}` → the best verified handle a
// traversal produced for that member. The school resolver's fast path reads
// this before spending a 60s tournament trace on a schoolmate the engine has
// already resolved (this search, a sibling search, or the previous one).
// ---------------------------------------------------------------------------

export interface CachedIdentity {
  platform: OnlinePlatform;
  username: string;
  confidence: number;
}

const identityCache = new SearchCache<CachedIdentity>();

const identityKey = (uscfId: string) => `identity:${uscfId.replace(/\D/g, "")}`;

export function getCachedIdentity(uscfId: string): CachedIdentity | undefined {
  const id = uscfId.replace(/\D/g, "");
  if (!id) return undefined;
  return identityCache.get(identityKey(id));
}

/** Record a traversal-confirmed handle. Keeps the strongest claim per member —
 *  a later, weaker resolution must not overwrite a stronger one. */
export function cacheIdentity(uscfId: string, identity: CachedIdentity): void {
  const id = uscfId.replace(/\D/g, "");
  if (!id || !identity.username) return;
  const prev = identityCache.get(identityKey(id));
  if (prev && prev.confidence >= identity.confidence) return;
  identityCache.set(identityKey(id), identity);
}
