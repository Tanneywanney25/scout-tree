// ============================================================================
// Identity persistence — service-role REST access to the three UX-redesign
// tables (see supabase/migrations/20260725000000_identity_cache_and_privacy.sql):
//
//   muir_cache       — cached MUIR payloads. Old crosstables are immutable, so
//                      serving repeats from Postgres cuts latency AND the load
//                      ScoutTree puts on an API US Chess has said is
//                      unsupported and will be rate-limited.
//   resolved_handles — the moat: confirmed USCF-member → online-handle rows.
//   handle_optouts   — players who asked not to be resolvable.
//
// Same access pattern as chessCookie.ts: plain fetch against the Supabase REST
// API with the service-role key (all three tables are RLS-locked with no
// policies). Everything fails soft — a missing store or a failed request reads
// as a cache miss / empty result, never an error, so the identity pipeline
// keeps working on a database-less local run.
// ============================================================================

import { readEnv } from "./chessCookie.ts";

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
// muir_cache
// ---------------------------------------------------------------------------

export type MuirCacheKind =
  | "member"
  | "member-search"
  | "events"
  | "event"
  | "section"
  | "crosstable"
  | "fide-search";

/** Read a cached payload no older than `maxAgeMs`. Null on miss/expiry/error. */
export async function cacheGet<T>(kind: MuirCacheKind, key: string, maxAgeMs: number): Promise<T | null> {
  const rest = supabaseRest();
  if (!rest) return null;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/muir_cache?kind=eq.${encodeURIComponent(kind)}&key=eq.${encodeURIComponent(key)}&select=payload,fetched_at&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ payload?: T; fetched_at?: string }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row?.payload || !row.fetched_at) return null;
    if (Date.now() - Date.parse(row.fetched_at) > maxAgeMs) return null;
    return row.payload;
  } catch {
    return null;
  }
}

/** Upsert a payload. Fire-and-forget semantics: the boolean is for logs only. */
export async function cachePut(kind: MuirCacheKind, key: string, payload: unknown): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/muir_cache?on_conflict=kind,key`, {
      method: "POST",
      headers: headers(rest.key, {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({ kind, key, payload, fetched_at: new Date().toISOString() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// resolved_handles
// ---------------------------------------------------------------------------

export interface ResolvedHandleRow {
  uscf_id: string;
  platform: string;
  username: string;
  confidence: number;
  evidence?: unknown;
  source: string;
  verified_at?: string;
}

/** Every non-superseded resolved handle for the given member IDs. */
export async function getResolvedHandles(uscfIds: string[]): Promise<ResolvedHandleRow[]> {
  const rest = supabaseRest();
  const clean = uscfIds.map((s) => s.replace(/\D/g, "")).filter(Boolean);
  if (!rest || !clean.length) return [];
  try {
    const inList = clean.map((s) => `"${s}"`).join(",");
    const res = await fetch(
      `${rest.url}/rest/v1/resolved_handles?uscf_id=in.(${inList})&superseded_by=is.null&select=uscf_id,platform,username,confidence,evidence,source,verified_at`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as ResolvedHandleRow[];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/**
 * Record a confirmed resolution. Upsert on (uscf_id, platform); an existing row
 * is only overwritten when the new confidence is at least as strong, or the
 * write is an explicit user correction (the human overrides the engine).
 */
export async function putResolvedHandle(row: {
  uscfId: string;
  platform: string;
  username: string;
  confidence: number;
  evidence?: unknown;
  source: string;
}): Promise<boolean> {
  const rest = supabaseRest();
  const uscfId = row.uscfId.replace(/\D/g, "");
  if (!rest || !uscfId || !row.username.trim()) return false;
  try {
    const existing = await getResolvedHandles([uscfId]);
    const prev = existing.find((r) => r.platform === row.platform);
    const isCorrection = row.source === "user-correction" || row.source === "claim";
    if (prev && !isCorrection && prev.confidence > row.confidence) return false; // keep the stronger row
    const res = await fetch(`${rest.url}/rest/v1/resolved_handles?on_conflict=uscf_id,platform`, {
      method: "POST",
      headers: headers(rest.key, {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        uscf_id: uscfId,
        platform: row.platform,
        username: row.username.trim(),
        confidence: row.confidence,
        evidence: row.evidence ?? null,
        source: row.source,
        verified_at: new Date().toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// handle_optouts
// ---------------------------------------------------------------------------

/** True when the member (or one of their known handles) has opted out.
 *  Fails OPEN on store errors — an outage must not brick the whole product —
 *  but the check runs again on every preview, so real opt-outs stick. */
export async function isOptedOut(uscfId: string): Promise<boolean> {
  const rest = supabaseRest();
  const clean = uscfId.replace(/\D/g, "");
  if (!rest || !clean) return false;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/handle_optouts?uscf_id=eq.${clean}&select=id&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as unknown[];
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

/** Record an opt-out request (unverified until a human review). */
export async function putOptOut(row: {
  uscfId?: string;
  platform?: string;
  username?: string;
  note?: string;
}): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest) return false;
  const uscfId = row.uscfId?.replace(/\D/g, "") || null;
  const username = row.username?.trim() || null;
  if (!uscfId && !username) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/handle_optouts`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({
        uscf_id: uscfId,
        platform: row.platform || null,
        username,
        note: row.note?.slice(0, 2000) || null,
        requested_at: new Date().toISOString(),
        verified: false,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
