// ============================================================================
// Retrieval cache + model-quota ledger (Postgres, service-role REST).
//
// Tables live in migrations/20261001000000_search_cache_and_quota_ledger.sql.
// Same access pattern as identityStore.ts / chessCookie.ts: plain fetch against
// the Supabase REST API with the service-role key, because both tables are
// RLS-locked with no policies. Everything FAILS SOFT — a missing database or a
// failed request reads as a cache miss / unknown quota, never an error, so the
// pipeline still works on a database-less local run.
//
// Two jobs:
//
//   search_cache — never pay for the same retrieval twice. 30 day TTL for
//     ordinary web queries; PERMANENT for identity resolutions, because a USCF
//     member mapped to a Chess.com handle does not change.
//
//   quota_ledger — the hard stop that keeps the emergency grounding path from
//     quietly draining the quota again. Counted per UTC day, incremented
//     ATOMICALLY via the increment_quota() RPC (concurrent edge invocations
//     would otherwise race and undercount, which is exactly how a "capped"
//     budget overruns).
// ============================================================================

import { readEnv } from "../ai.ts";
import type { SearchHit } from "./searxng.ts";

export type CacheKind = "web" | "identity";
export type QuotaProvider = "gemini_grounding" | "gemini_generate";

const WEB_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function supabaseRest(): { url: string; key: string } | null {
  const url = readEnv("SUPABASE_URL") || readEnv("VITE_SUPABASE_URL");
  const key =
    readEnv("SUPABASE_SERVICE_ROLE_KEY") ||
    readEnv("SUPABASE_SERVICE_KEY") ||
    readEnv("SUPABASE_SECRET_KEY");
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

function headers(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", ...extra };
}

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

/** Lowercase, collapse whitespace — so the same intent keys identically. */
export function normalizeQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/** sha256 of the normalized query. */
export async function cacheKey(query: string): Promise<string> {
  const norm = normalizeQuery(query);
  const bytes = new TextEncoder().encode(norm);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Cache hit-rate instrumentation
//
// The point of the cache is measurable, so measure it rather than assert it.
// Counters are per-isolate; they reset on a cold start, which is fine for the
// "across a ten-query test" reporting they exist for.
// ---------------------------------------------------------------------------

let cacheHits = 0;
let cacheMisses = 0;

export function cacheStats(): { hits: number; misses: number; total: number; hitRate: number } {
  const total = cacheHits + cacheMisses;
  return { hits: cacheHits, misses: cacheMisses, total, hitRate: total ? cacheHits / total : 0 };
}

export function resetCacheStats(): void {
  cacheHits = 0;
  cacheMisses = 0;
}

// ---------------------------------------------------------------------------
// search_cache
// ---------------------------------------------------------------------------

/** Read cached hits. Null on miss/expiry/error. Counts toward the hit rate. */
export async function searchCacheGet(query: string, log?: (m: string) => void): Promise<SearchHit[] | null> {
  const rest = supabaseRest();
  if (!rest) {
    cacheMisses++;
    return null;
  }
  try {
    const key = await cacheKey(query);
    const nowIso = new Date().toISOString();
    // expires_at IS NULL means permanent (identity); otherwise it must be in
    // the future. PostgREST `or=` gives us exactly that in one request.
    const res = await fetch(
      `${rest.url}/rest/v1/search_cache?key=eq.${encodeURIComponent(key)}` +
        `&or=(expires_at.is.null,expires_at.gt.${encodeURIComponent(nowIso)})` +
        `&select=hits,kind&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) {
      cacheMisses++;
      return null;
    }
    const rows = (await res.json()) as Array<{ hits?: SearchHit[]; kind?: string }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row?.hits || !Array.isArray(row.hits)) {
      cacheMisses++;
      return null;
    }
    cacheHits++;
    log?.(`search cache HIT (${row.kind || "web"}) for "${normalizeQuery(query).slice(0, 60)}"`);
    // Fire-and-forget usage counter; never blocks the read.
    void bumpHitCount(key);
    return row.hits;
  } catch {
    cacheMisses++;
    return null;
  }
}

async function bumpHitCount(key: string): Promise<void> {
  const rest = supabaseRest();
  if (!rest) return;
  try {
    // Read-modify-write is acceptable here: hit_count is observability only,
    // so a lost update under concurrency costs nothing (unlike the quota
    // ledger, which is why THAT one uses an atomic RPC).
    const res = await fetch(
      `${rest.url}/rest/v1/search_cache?key=eq.${encodeURIComponent(key)}&select=hit_count&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return;
    const rows = (await res.json()) as Array<{ hit_count?: number }>;
    const current = rows?.[0]?.hit_count ?? 0;
    await fetch(`${rest.url}/rest/v1/search_cache?key=eq.${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({ hit_count: current + 1 }),
    });
  } catch {
    /* observability only — ignore */
  }
}

/**
 * Upsert hits. `kind` decides the TTL: 'identity' is permanent, 'web' expires
 * in 30 days. Fire-and-forget semantics; the boolean is for logs only.
 */
export async function searchCachePut(
  query: string,
  hits: SearchHit[],
  kind: CacheKind = "web"
): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest) return false;
  // Caching an empty result would pin a failure (an engine outage, a dead
  // tunnel) for 30 days and make it look like the web has no answer.
  if (!hits.length) return false;
  try {
    const key = await cacheKey(query);
    const expiresAt = kind === "identity" ? null : new Date(Date.now() + WEB_TTL_MS).toISOString();
    const res = await fetch(`${rest.url}/rest/v1/search_cache?on_conflict=key`, {
      method: "POST",
      headers: headers(rest.key, {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        key,
        query: normalizeQuery(query).slice(0, 2000),
        hits,
        kind,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// quota_ledger
// ---------------------------------------------------------------------------

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function envInt(name: string, dflt: number): number {
  const raw = readEnv(name);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * Daily caps. Deliberately CONSERVATIVE by default: grounding is the resource
 * that was exhausted, and the whole point of this pipeline is not to need it.
 * Override with GEMINI_GROUNDING_DAILY_CAP / GEMINI_GENERATE_DAILY_CAP.
 */
export function quotaCap(provider: QuotaProvider): number {
  return provider === "gemini_grounding"
    ? envInt("GEMINI_GROUNDING_DAILY_CAP", 5)
    : envInt("GEMINI_GENERATE_DAILY_CAP", 500);
}

/** Calls used today. Returns null when the ledger is unreachable. */
export async function quotaUsed(provider: QuotaProvider): Promise<number | null> {
  const rest = supabaseRest();
  if (!rest) return null;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/quota_ledger?provider=eq.${encodeURIComponent(provider)}` +
        `&day=eq.${utcDay()}&select=used&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ used?: number }>;
    return rows?.[0]?.used ?? 0;
  } catch {
    return null;
  }
}

/** Atomic +1 via the increment_quota RPC. Returns the new total, or null. */
export async function incrementQuota(provider: QuotaProvider, amount = 1): Promise<number | null> {
  const rest = supabaseRest();
  if (!rest) return null;
  try {
    const res = await fetch(`${rest.url}/rest/v1/rpc/increment_quota`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json" }),
      body: JSON.stringify({ p_provider: provider, p_amount: amount }),
    });
    if (!res.ok) return null;
    const val = await res.json();
    return typeof val === "number" ? val : null;
  } catch {
    return null;
  }
}

/**
 * Whether the emergency grounding path may run.
 *
 * FAIL CLOSED when the ledger is unreachable: an uncountable budget is exactly
 * the condition that produced the original exhaustion, so "we cannot tell" must
 * mean "no", not "go ahead".
 */
export async function groundingAllowed(log?: (m: string) => void): Promise<boolean> {
  const cap = quotaCap("gemini_grounding");
  if (cap === 0) {
    log?.("grounding disabled by cap=0");
    return false;
  }
  const used = await quotaUsed("gemini_grounding");
  if (used === null) {
    log?.("grounding BLOCKED: quota ledger unreachable (failing closed)");
    return false;
  }
  if (used >= cap) {
    log?.(`grounding BLOCKED: ${used}/${cap} used today`);
    return false;
  }
  return true;
}
