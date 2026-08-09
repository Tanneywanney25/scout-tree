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
  | "games"
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
// event_platform_cache — persistent "which platform hosted this USCF event"
// answers (see migrations/20260801000000_event_platform_cache.sql). Pinning an
// event's platform costs a grounded AI web-search; the answer is immutable and
// shared by everyone who played the event, so caching it once turns a 2-4s
// discovery into an instant DB read reused across every future search. The
// whole discovery payload is stored so a hit reproduces the roster shortcut's
// tournament slugs / swiss ids, not just the platform label.
// ---------------------------------------------------------------------------

export interface EventPlatformRow {
  platform: string;
  /** The full DiscoveredEventInfo payload (platform + slugs/ids/confidence/note). */
  info?: unknown;
  source?: string;
}

/** A cached platform for the event, or null on miss / expiry / store error.
 *  The TTL is enforced server-side (expires_at > now), so an expired row reads
 *  as a miss and the caller re-runs discovery. Fails soft everywhere. */
export async function getEventPlatform(eventId: string): Promise<EventPlatformRow | null> {
  const rest = supabaseRest();
  const id = (eventId || "").trim();
  if (!rest || !id) return null;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/event_platform_cache?event_id=eq.${encodeURIComponent(id)}&expires_at=gt.${encodeURIComponent(
        new Date().toISOString()
      )}&select=platform,info,source&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as EventPlatformRow[];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row && typeof row.platform === "string" ? row : null;
  } catch {
    return null;
  }
}

/** Upsert an event's resolved platform + full discovery payload. Refreshes the
 *  1-year TTL on write. Fire-and-forget: the boolean is for logs only. */
export async function putEventPlatform(
  eventId: string,
  platform: string,
  info: unknown,
  source = "web_search"
): Promise<boolean> {
  const rest = supabaseRest();
  const id = (eventId || "").trim();
  if (!rest || !id || !platform) return false;
  try {
    const now = Date.now();
    const res = await fetch(`${rest.url}/rest/v1/event_platform_cache?on_conflict=event_id`, {
      method: "POST",
      headers: headers(rest.key, {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify({
        event_id: id,
        platform,
        info: info ?? null,
        source,
        fetched_at: new Date(now).toISOString(),
        expires_at: new Date(now + 365 * 86_400_000).toISOString(),
      }),
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

// ---------------------------------------------------------------------------
// chess_archive_cache / chess_failure_cache — persistent Chess.com archive +
// failure cache (see migrations/20260808000000_chess_archive_cache.sql). Service
// -role only; the browser reaches these only via the edge fetch proxy. Every
// call is fail-soft, so a store-less local run (Node CLI) is a pure no-op and
// every fetch falls straight through to Chess.com — behaviour unchanged.
//
// TTL is enforced on READ here (a NULL expires_at means "never expires", used
// for immutable closed months and 410-Gone). Writers set expires_at per the
// differentiated rules; readers treat an expired row as a miss.
// ---------------------------------------------------------------------------

const CLOSED_MONTH_AGE_MS = 35 * 86_400_000; // older than this = immutable
const CURRENT_MONTH_TTL_MS = 6 * 60 * 60_000;
const STRUCTURAL_TTL_MS = 7 * 86_400_000;
const TRANSIENT_TTL_MS = 15 * 60_000;
const WEIGHT_TTL_MS = 30 * 86_400_000;

/** True once the (year, month) is far enough in the past to be immutable. */
function monthIsClosed(year: number, month: number): boolean {
  const monthEnd = Date.UTC(year, month, 1); // first instant of the NEXT month
  return Date.now() - monthEnd > CLOSED_MONTH_AGE_MS;
}
const fresh = (expiresAt?: string | null) => !expiresAt || Date.parse(expiresAt) > Date.now();

export interface ArchiveCacheHit {
  payload: unknown;
  etag?: string;
  lastModified?: string;
}

/** A cached archive for (username, year, month, variant), or null on
 *  miss/expiry/store error. Returns the revalidation handles so the caller can
 *  send If-None-Match / If-Modified-Since for a current-month entry. */
export async function getArchiveCache(
  username: string,
  year: number,
  month: number,
  variant = "json"
): Promise<ArchiveCacheHit | null> {
  const rest = supabaseRest();
  const u = username.trim().toLowerCase();
  if (!rest || !u) return null;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/chess_archive_cache?username=eq.${encodeURIComponent(u)}&year=eq.${year}&month=eq.${month}` +
        `&endpoint_variant=eq.${encodeURIComponent(variant)}&select=payload,etag,last_modified,expires_at&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ payload?: unknown; etag?: string; last_modified?: string; expires_at?: string | null }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || row.payload === undefined || row.payload === null || !fresh(row.expires_at)) return null;
    return { payload: row.payload, etag: row.etag, lastModified: row.last_modified };
  } catch {
    return null;
  }
}

/** Upsert a successful archive. A closed (immutable) month is stored with NO
 *  expiry; the current month gets a 6h revalidation window. Fire-and-forget. */
export async function putArchiveCache(row: {
  username: string;
  year: number;
  month: number;
  variant?: string;
  payload: unknown;
  etag?: string;
  lastModified?: string;
  byteSize?: number;
}): Promise<boolean> {
  const rest = supabaseRest();
  const u = row.username.trim().toLowerCase();
  if (!rest || !u) return false;
  const closed = monthIsClosed(row.year, row.month);
  try {
    const res = await fetch(`${rest.url}/rest/v1/chess_archive_cache?on_conflict=username,year,month,endpoint_variant`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        username: u,
        year: row.year,
        month: row.month,
        endpoint_variant: row.variant ?? "json",
        payload: row.payload,
        etag: row.etag ?? null,
        last_modified: row.lastModified ?? null,
        byte_size: row.byteSize ?? null,
        fetched_at: new Date().toISOString(),
        expires_at: closed ? null : new Date(Date.now() + CURRENT_MONTH_TTL_MS).toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Extend a current-month entry's expiry after a 304 Not Modified. */
export async function touchArchiveCache(username: string, year: number, month: number, variant = "json"): Promise<boolean> {
  const rest = supabaseRest();
  const u = username.trim().toLowerCase();
  if (!rest || !u) return false;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/chess_archive_cache?username=eq.${encodeURIComponent(u)}&year=eq.${year}&month=eq.${month}&endpoint_variant=eq.${encodeURIComponent(variant)}`,
      {
        method: "PATCH",
        headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "return=minimal" }),
        body: JSON.stringify({ expires_at: new Date(Date.now() + CURRENT_MONTH_TTL_MS).toISOString() }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export type FailureClass = "structural" | "transient" | "gone";

/** A live failure record for (username, year, month, variant), or null when
 *  absent/expired — an expired failure reads as a miss, so the month is retried. */
export async function getFailureCache(username: string, year: number, month: number, variant = "json"): Promise<FailureClass | null> {
  const rest = supabaseRest();
  const u = username.trim().toLowerCase();
  if (!rest || !u) return null;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/chess_failure_cache?username=eq.${encodeURIComponent(u)}&year=eq.${year}&month=eq.${month}&endpoint_variant=eq.${encodeURIComponent(variant)}&select=status_class,expires_at&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ status_class?: string; expires_at?: string | null }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row?.status_class || !fresh(row.expires_at)) return null;
    return row.status_class as FailureClass;
  } catch {
    return null;
  }
}

/** Record a failure with the class-specific TTL (structural 7d, transient 15m,
 *  gone never). Fire-and-forget. */
export async function putFailureCache(row: {
  username: string;
  year: number;
  month: number;
  variant?: string;
  statusClass: FailureClass;
}): Promise<boolean> {
  const rest = supabaseRest();
  const u = row.username.trim().toLowerCase();
  if (!rest || !u) return false;
  const ttl = row.statusClass === "structural" ? STRUCTURAL_TTL_MS : row.statusClass === "transient" ? TRANSIENT_TTL_MS : null;
  try {
    const res = await fetch(`${rest.url}/rest/v1/chess_failure_cache?on_conflict=username,year,month,endpoint_variant`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        username: u,
        year: row.year,
        month: row.month,
        endpoint_variant: row.variant ?? "json",
        status_class: row.statusClass,
        failed_at: new Date().toISOString(),
        expires_at: ttl === null ? null : new Date(Date.now() + ttl).toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// chesscom_account_weight — cached archive-weight estimate for pairing-symmetry
// routing (see migrations/20260808010000_chesscom_account_weight.sql). Lets the
// engine prefer the LIGHTER side of a pairing when it has a choice of which
// known handle's archive to pull. Service-role only, fail-soft.
// ---------------------------------------------------------------------------

/** The cached weight for an account, or null on miss/expiry/store error. */
export async function getAccountWeight(username: string): Promise<number | null> {
  const rest = supabaseRest();
  const u = username.trim().toLowerCase();
  if (!rest || !u) return null;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/chesscom_account_weight?username=eq.${encodeURIComponent(u)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=weight&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ weight?: number }>;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return row && typeof row.weight === "number" ? row.weight : null;
  } catch {
    return null;
  }
}

/** Upsert an account's weight estimate (refreshes the 30-day TTL). */
export async function putAccountWeight(username: string, weight: number, source = "archives_len"): Promise<boolean> {
  const rest = supabaseRest();
  const u = username.trim().toLowerCase();
  if (!rest || !u) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/chesscom_account_weight?on_conflict=username`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        username: u,
        weight: Math.max(0, Math.round(weight)),
        source,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + WEIGHT_TTL_MS).toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
