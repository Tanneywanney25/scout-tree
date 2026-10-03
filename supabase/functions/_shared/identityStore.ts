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
  | "fide-search"
  | "footprint";

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

/**
 * Which of these members have opted out. Returns null when the answer could
 * not be determined.
 *
 * Deliberately separate from isOptedOut(): that one decides whether to OFFER
 * discovery and fails open, because an outage must not brick the product. This
 * one gates DISCLOSURE of an already-stored identity, where the safe answer to
 * "we cannot tell" is to withhold. Same table, opposite default, on purpose.
 */
async function optedOutAmong(
  rest: { url: string; key: string },
  cleanIds: string[]
): Promise<Set<string> | null> {
  try {
    const inList = cleanIds.map((s) => `"${s}"`).join(",");
    const res = await fetch(
      `${rest.url}/rest/v1/handle_optouts?uscf_id=in.(${inList})&select=uscf_id`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ uscf_id?: string }>;
    if (!Array.isArray(rows)) return null;
    return new Set(rows.map((r) => (r.uscf_id || "").replace(/\D/g, "")).filter(Boolean));
  } catch {
    return null;
  }
}

/**
 * Every non-superseded resolved handle for the given member IDs, excluding any
 * member who has opted out.
 *
 * An opt-out MUST retract what is already stored, not merely stop future
 * discovery — otherwise the opt-out is cosmetic. Before this filter existed a
 * stored resolution remained readable forever after the member asked to be
 * removed. Fails CLOSED: if handle_optouts cannot be read we return nothing
 * rather than risk disclosing a member who has opted out.
 */
export async function getResolvedHandles(uscfIds: string[]): Promise<ResolvedHandleRow[]> {
  const rest = supabaseRest();
  const clean = uscfIds.map((s) => s.replace(/\D/g, "")).filter(Boolean);
  if (!rest || !clean.length) return [];
  try {
    const optedOut = await optedOutAmong(rest, clean);
    if (optedOut === null) return []; // cannot verify consent -> disclose nothing
    const allowed = clean.filter((id) => !optedOut.has(id));
    if (!allowed.length) return [];
    const inList = allowed.map((s) => `"${s}"`).join(",");
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
    // Precedence: a browser-asserted engine row never replaces a row the
    // server proved itself (alignment harvest) or one a human asserted.
    if (prev && row.source === "engine" && ["alignment", "user-correction", "claim"].includes(prev.source)) return false;
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
        // A fresh write revives a row an earlier revalidation had retired.
        status: "active",
        status_reason: null,
        superseded_by: null,
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

// ---------------------------------------------------------------------------
// Identity graph (migrations/20261002000000_identity_graph.sql). Writes go
// through record_identity_edges(), which applies the conflict rules and the
// opt-out filter inside one transaction. Everything fails soft like the rest
// of this module.
// ---------------------------------------------------------------------------

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T | null> {
  const rest = supabaseRest();
  if (!rest) return null;
  try {
    const res = await fetch(`${rest.url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json" }),
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const inList = (ids: string[]) => ids.map((s) => `"${s.replace(/"/g, "")}"`).join(",");

export interface IdentityEdgeInput {
  uscf_id: string;
  platform: string;
  handle: string;
  tier: "strong" | "weak";
  rounds: number;
  corroborating: number;
  section: Record<string, unknown>;
}

export interface RecordEdgesResult {
  written: number;
  skippedOptOut: number;
  superseded: number;
  conflicts: number;
  verdictsMirrored: number;
}

export function recordIdentityEdges(rows: IdentityEdgeInput[]): Promise<RecordEdgesResult | null> {
  if (!rows.length) return Promise.resolve({ written: 0, skippedOptOut: 0, superseded: 0, conflicts: 0, verdictsMirrored: 0 });
  return rpc<RecordEdgesResult>("record_identity_edges", { p_rows: rows });
}

export async function putSectionLink(row: {
  eventId: string;
  sectionNo: number;
  platform: string;
  tournamentId: string;
  status: "verified" | "rejected";
  assigned?: number;
  nPlayers?: number;
  contradicted?: number;
  inconsistentEdges?: number;
  source?: string;
}): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/section_link?on_conflict=event_id,section_no,platform,tournament_id`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        event_id: row.eventId,
        section_no: row.sectionNo,
        platform: row.platform,
        tournament_id: row.tournamentId,
        status: row.status,
        assigned: row.assigned ?? null,
        n_players: row.nPlayers ?? null,
        contradicted: row.contradicted ?? null,
        inconsistent_edges: row.inconsistentEdges ?? null,
        source: row.source ?? null,
        checked_at: new Date().toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface SectionLinkRow {
  event_id: string;
  section_no: number;
  platform: string;
  tournament_id: string;
  status: string;
  assigned?: number;
}

/** Stored tournament verdicts (verified and rejected) for these sections. */
export async function getSectionLinks(keys: { eventId: string; sectionNo: number }[]): Promise<SectionLinkRow[]> {
  const rest = supabaseRest();
  const ids = [...new Set(keys.map((k) => k.eventId.replace(/\D/g, "")).filter(Boolean))];
  if (!rest || !ids.length) return [];
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/section_link?event_id=in.(${inList(ids)})&select=event_id,section_no,platform,tournament_id,status,assigned`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as SectionLinkRow[];
    const want = new Set(keys.map((k) => `${k.eventId}#${k.sectionNo}`));
    return Array.isArray(rows) ? rows.filter((r) => want.has(`${r.event_id}#${r.section_no}`)) : [];
  } catch {
    return [];
  }
}

/** Platforms already known for these events (event_platform_cache, unexpired). */
export async function getEventPlatforms(eventIds: string[]): Promise<Map<string, EventPlatformRow>> {
  const rest = supabaseRest();
  const ids = [...new Set(eventIds.map((s) => s.replace(/\D/g, "")).filter(Boolean))];
  const out = new Map<string, EventPlatformRow>();
  if (!rest || !ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = ids.slice(i, i + 150);
      const res = await fetch(
        `${rest.url}/rest/v1/event_platform_cache?event_id=in.(${inList(chunk)})&expires_at=gt.${encodeURIComponent(
          new Date().toISOString()
        )}&select=event_id,platform,info,source`,
        { headers: headers(rest.key) }
      );
      if (!res.ok) continue;
      for (const r of (await res.json()) as (EventPlatformRow & { event_id: string })[]) out.set(r.event_id, r);
    }
  } catch {
    /* fail soft */
  }
  return out;
}

export async function getSeriesPlatforms(keys: string[]): Promise<Map<string, string>> {
  const rest = supabaseRest();
  const uniq = [...new Set(keys.filter(Boolean))];
  const out = new Map<string, string>();
  if (!rest || !uniq.length) return out;
  try {
    const res = await fetch(`${rest.url}/rest/v1/series_platform?series_key=in.(${inList(uniq)})&select=series_key,platform`, {
      headers: headers(rest.key),
    });
    if (!res.ok) return out;
    for (const r of (await res.json()) as { series_key: string; platform: string }[]) out.set(r.series_key, r.platform);
  } catch {
    /* fail soft */
  }
  return out;
}

// ---------------------------------------------------------------------------
// roster_tournament (the roster index; migrations/20261003000000_roster_index.sql)
// ---------------------------------------------------------------------------

export interface RosterCandidateRow {
  platform: "chesscom" | "lichess";
  tid: string;
  series: string;
  name: string | null;
  starts_at: string | null;
  n_rounds: number | null;
  n_players: number | null;
  handles: string[];
  vectors: string;
}

/** Crawled tournaments compatible with a section's date, round count and
 *  size. Null when the store is unreachable (distinct from "none matched"). */
export async function getRosterCandidates(w: {
  from: string;
  to: string;
  minRounds: number;
  maxRounds: number;
  minPlayers: number;
  platform?: "chesscom" | "lichess";
}): Promise<RosterCandidateRow[] | null> {
  const rest = supabaseRest();
  if (!rest) return null;
  try {
    const q =
      `status=eq.done&starts_at=gte.${encodeURIComponent(w.from)}&starts_at=lte.${encodeURIComponent(w.to)}` +
      `&n_rounds=gte.${w.minRounds}&n_rounds=lte.${w.maxRounds}&n_players=gte.${w.minPlayers}` +
      (w.platform ? `&platform=eq.${w.platform}` : "") +
      `&select=platform,tid,series,name,starts_at,n_rounds,n_players,handles,vectors&order=starts_at.asc&limit=80`;
    const res = await fetch(`${rest.url}/rest/v1/roster_tournament?${q}`, { headers: headers(rest.key) });
    if (!res.ok) return null;
    return (await res.json()) as RosterCandidateRow[];
  } catch {
    return null;
  }
}

/** Index coverage for a date: does the index hold ANY crawled tournament that
 *  day? Lets a miss be told apart from "the crawler never reached this date". */
export async function rosterIndexCovers(from: string, to: string): Promise<boolean | null> {
  const rest = supabaseRest();
  if (!rest) return null;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/roster_tournament?status=eq.done&starts_at=gte.${encodeURIComponent(from)}&starts_at=lte.${encodeURIComponent(to)}&select=tid&limit=1`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return null;
    return ((await res.json()) as unknown[]).length > 0;
  } catch {
    return null;
  }
}

export async function putSeriesPlatform(seriesKey: string, platform: string): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest || !seriesKey) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/series_platform?on_conflict=series_key`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({ series_key: seriesKey, platform, updated_at: new Date().toISOString() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface StoredEdge {
  uscf_id: string;
  platform: string;
  handle: string;
  tier: "strong" | "weak";
  n_sections: number;
  rounds_verified: number;
  corroborating: number;
  status: string;
  last_verified: string;
}

/** Active identity edges for these members, opt-outs removed. Fails CLOSED
 *  on an unreadable opt-out table, like getResolvedHandles. */
export async function getActiveEdges(uscfIds: string[]): Promise<StoredEdge[]> {
  const rest = supabaseRest();
  const clean = [...new Set(uscfIds.map((s) => s.replace(/\D/g, "")).filter(Boolean))];
  if (!rest || !clean.length) return [];
  try {
    const optedOut = await optedOutAmong(rest, clean);
    if (optedOut === null) return [];
    const allowed = clean.filter((id) => !optedOut.has(id));
    if (!allowed.length) return [];
    const out: StoredEdge[] = [];
    for (let i = 0; i < allowed.length; i += 100) {
      const chunk = allowed.slice(i, i + 100);
      const res = await fetch(
        `${rest.url}/rest/v1/identity_edge?uscf_id=in.(${inList(chunk)})&status=eq.active&select=uscf_id,platform,handle,tier,n_sections,rounds_verified,corroborating,status,last_verified`,
        { headers: headers(rest.key) }
      );
      if (!res.ok) continue;
      out.push(...((await res.json()) as StoredEdge[]));
    }
    return out;
  } catch {
    return [];
  }
}

export interface VerdictRow extends ResolvedHandleRow {
  id: number;
  status?: string;
  tier?: string;
  revalidated_at?: string;
}

/** Active resolved_handles rows for one member, with ids (for revalidation). */
export async function getVerdictRows(uscfId: string): Promise<VerdictRow[]> {
  const rest = supabaseRest();
  const id = uscfId.replace(/\D/g, "");
  if (!rest || !id) return [];
  try {
    const optedOut = await optedOutAmong(rest, [id]);
    if (optedOut === null || optedOut.has(id)) return [];
    const res = await fetch(
      `${rest.url}/rest/v1/resolved_handles?uscf_id=eq.${id}&superseded_by=is.null&select=id,uscf_id,platform,username,confidence,source,verified_at,status,tier,revalidated_at`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as VerdictRow[];
    return Array.isArray(rows) ? rows.filter((r) => (r.status || "active") === "active") : [];
  } catch {
    return [];
  }
}

/** Retire a verdict row (gone / superseded / conflict). superseded_by = its
 *  own id, so readers that only check superseded_by hide it as well. */
export async function retireVerdict(id: number, status: "gone" | "superseded" | "conflict", reason: string): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/resolved_handles?id=eq.${id}`, {
      method: "PATCH",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({ status, status_reason: reason.slice(0, 300), superseded_by: id }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function markRevalidated(id: number): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/resolved_handles?id=eq.${id}`, {
      method: "PATCH",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({ revalidated_at: new Date().toISOString() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Mark every active edge for a (platform, handle) gone — the account no
 *  longer answers under that name. */
export async function retireEdgesForHandle(platform: string, handle: string, reason: string): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest) return false;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/identity_edge?platform=eq.${encodeURIComponent(platform)}&handle=eq.${encodeURIComponent(
        handle.toLowerCase()
      )}&status=eq.active`,
      {
        method: "PATCH",
        headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "return=minimal" }),
        body: JSON.stringify({ status: "gone", status_reason: reason.slice(0, 300) }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export interface SectionNegativeRow {
  event_id: string;
  section_no: number;
  reason?: string;
  walked_at?: string;
  expires_at?: string;
}

export async function getSectionNegatives(keys: { eventId: string; sectionNo: number }[]): Promise<SectionNegativeRow[]> {
  const rest = supabaseRest();
  const ids = [...new Set(keys.map((k) => k.eventId.replace(/\D/g, "")).filter(Boolean))];
  if (!rest || !ids.length) return [];
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/section_negative?event_id=in.(${inList(ids)})&expires_at=gt.${encodeURIComponent(
        new Date().toISOString()
      )}&select=event_id,section_no,reason,walked_at,expires_at`,
      { headers: headers(rest.key) }
    );
    if (!res.ok) return [];
    const want = new Set(keys.map((k) => `${k.eventId}#${k.sectionNo}`));
    const rows = (await res.json()) as SectionNegativeRow[];
    return Array.isArray(rows) ? rows.filter((r) => want.has(`${r.event_id}#${r.section_no}`)) : [];
  } catch {
    return [];
  }
}

export async function putSectionNegative(row: {
  eventId: string;
  sectionNo: number;
  members: string[];
  reason: string;
  requests?: number;
  ttlMs: number;
}): Promise<boolean> {
  const rest = supabaseRest();
  if (!rest) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/section_negative?on_conflict=event_id,section_no`, {
      method: "POST",
      headers: headers(rest.key, { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify({
        event_id: row.eventId,
        section_no: row.sectionNo,
        members: row.members.slice(0, 600),
        reason: row.reason.slice(0, 200),
        requests: row.requests ?? null,
        walked_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + row.ttlMs).toISOString(),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Remove expired search_cache rows and identity rows past `identityDays`. */
export function sweepSearchCache(identityDays = 90): Promise<number | null> {
  return rpc<number>("sweep_search_cache", { p_identity_days: identityDays });
}

/** Atomically add `n` to today's counter for `provider` (quota_ledger) and
 *  return the new total, or null when the ledger is unreachable. */
export function takeQuota(provider: string, n: number): Promise<number | null> {
  return rpc<number>("increment_quota", { p_provider: provider, p_amount: n });
}
