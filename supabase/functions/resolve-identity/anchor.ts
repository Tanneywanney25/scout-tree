// ============================================================================
// Anchor-phase modes — the FAST half of the anchor → discovery split.
//
// The UX redesign separates "who is this person?" (cheap, seconds) from "what
// do they play as online?" (expensive, minutes). These handlers power the
// cheap half:
//
//   memberSearch    — live picker results while the user types. No graph
//                     build, no AI, no crosstables: ONE MUIR search call,
//                     cached in Postgres and rate-limited per client.
//   memberPreview   — the AnchorCard payload: full member record, a cheap
//                     online-event estimate, opt-out status, and any already-
//                     resolved handles from the moat.
//   fideSearch      — name → FIDE ID via Lichess's FIDE database, closing the
//                     "go look up the FIDE ID elsewhere" ask.
//   resolvedHandles — cache read over the moat.
//   claimHandle     — cache write: engine confirmations and user corrections.
//   optOut          — privacy: record a do-not-resolve request.
//
// All of it degrades gracefully without the Postgres store (local dev): cache
// misses everywhere, live MUIR/Lichess calls still answer.
// ============================================================================

import {
  searchUscfByName,
  fetchUscfMember,
  fetchMemberEventsSince,
  looksOnline,
  type UscfMember,
  type UscfSearchRow,
} from "./uscf.ts";
import {
  cacheGet,
  cachePut,
  getResolvedHandles,
  putResolvedHandle,
  isOptedOut,
  putOptOut,
} from "../_shared/identityStore.ts";

// ---------------------------------------------------------------------------
// Cache TTLs. Member records change slowly (a rating updates after an event);
// searches are re-runnable; the FIDE registry is glacial.
// ---------------------------------------------------------------------------
const SEARCH_TTL_MS = 12 * 60 * 60_000;
const MEMBER_TTL_MS = 6 * 60 * 60_000;
const EVENTS_TTL_MS = 6 * 60 * 60_000;
const FIDE_TTL_MS = 7 * 24 * 60 * 60_000;

// ---------------------------------------------------------------------------
// Per-instance rate limiter for memberSearch: it fires on every debounced
// keystroke, so one hot client must not monopolise MUIR. Sliding window per
// caller (x-forwarded-for), generous enough for real typing.
// ---------------------------------------------------------------------------
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_IN_WINDOW = 25;
const rateBuckets = new Map<string, number[]>();

export function memberSearchRateLimited(clientKey: string): boolean {
  const now = Date.now();
  const bucket = (rateBuckets.get(clientKey) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.length >= RATE_MAX_IN_WINDOW) {
    rateBuckets.set(clientKey, bucket);
    return true;
  }
  bucket.push(now);
  rateBuckets.set(clientKey, bucket);
  if (rateBuckets.size > 500) {
    // Bound memory on a long-lived instance: drop stale buckets.
    for (const [k, v] of rateBuckets) if (!v.length || now - v[v.length - 1] > RATE_WINDOW_MS) rateBuckets.delete(k);
  }
  return false;
}

// ---------------------------------------------------------------------------
// memberSearch
// ---------------------------------------------------------------------------

/** What the picker renders per row — the search row plus nothing it can't use. */
export interface MemberSearchHit {
  uscfId: string;
  name: string;
  state?: string;
  rating?: number;
  ratings: Record<string, number | undefined>;
  hasOnline: boolean;
  fideId?: string;
  title?: string;
  expiration?: string;
}

function hitFrom(row: UscfSearchRow): MemberSearchHit {
  return {
    uscfId: row.id,
    name: row.name,
    state: row.state,
    rating: row.rating,
    ratings: {
      regular: row.ratings.regular,
      quick: row.ratings.quick,
      blitz: row.ratings.blitz,
      onlineRegular: row.ratings.onlineRegular,
      onlineQuick: row.ratings.onlineQuick,
      onlineBlitz: row.ratings.onlineBlitz,
    },
    hasOnline: row.hasOnline,
    fideId: row.fideId,
    title: row.title,
    expiration: row.expiration,
  };
}

/** Accept the MSA search grammar users already know: "Smith, John" flips to
 *  "John Smith"; a leading % wildcard is stripped (MUIR's Fuzzy handles it);
 *  a bare member ID short-circuits to a direct fetch. */
function normalizeSearchName(raw: string): { name?: string; uscfId?: string } {
  const s = raw.replace(/\s+/g, " ").trim();
  if (/^\d{6,}$/.test(s.replace(/\D/g, "")) && /^[\d\s-]+$/.test(s)) return { uscfId: s.replace(/\D/g, "") };
  const comma = s.indexOf(",");
  if (comma > 0) {
    const last = s.slice(0, comma).trim();
    const first = s.slice(comma + 1).trim();
    return { name: `${first} ${last}`.replace(/%+/g, "").trim() };
  }
  return { name: s.replace(/%+/g, "").trim() };
}

/** Rank rows for the picker: name-token hits, state, online history, rated. */
function rankHits(rows: UscfSearchRow[], name: string, state?: string): UscfSearchRow[] {
  const qTokens = name.toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean);
  const score = (r: UscfSearchRow): number => {
    let s = 0;
    const rn = r.name.toLowerCase();
    for (const t of qTokens) if (rn.includes(t)) s += 2;
    if (state && r.state && state.toUpperCase() === r.state.toUpperCase()) s += 2;
    if (r.hasOnline) s += 1.5;
    if (r.rating) s += 0.3;
    if (r.status && /expired|inactive/i.test(r.status)) s -= 0.5;
    return s;
  };
  return [...rows].sort((a, b) => score(b) - score(a));
}

export async function handleMemberSearch(req: {
  name?: unknown;
  state?: unknown;
  limit?: unknown;
}): Promise<Record<string, unknown>> {
  const raw = typeof req.name === "string" ? req.name.trim() : "";
  const state =
    typeof req.state === "string" && /^[A-Za-z]{2}$/.test(req.state.trim())
      ? req.state.trim().toUpperCase()
      : undefined;
  const limit = Math.min(12, Math.max(1, typeof req.limit === "number" ? Math.round(req.limit) : 8));
  if (raw.length < 2) return { available: true, hits: [] };

  const t0 = Date.now();
  const { name, uscfId } = normalizeSearchName(raw);

  // A bare ID: one direct member fetch, no search.
  if (uscfId) {
    const member = (await cacheGet<UscfMember>("member", uscfId, MEMBER_TTL_MS)) ?? (await fetchUscfMember(uscfId));
    if (member) void cachePut("member", uscfId, member);
    const hits = member
      ? [hitFrom({ ...member, rating: member.ratings.regular ?? member.ratings.onlineRegular ?? member.ratings.quick })]
      : [];
    return { available: true, hits, ms: Date.now() - t0 };
  }
  if (!name || name.length < 2) return { available: true, hits: [] };

  const cacheKey = `${name.toLowerCase()}|${state || "*"}`;
  let rows = await cacheGet<UscfSearchRow[]>("member-search", cacheKey, SEARCH_TTL_MS);
  const fromCache = !!rows;
  if (!rows) {
    rows = await searchUscfByName(name, state);
    if (rows.length) void cachePut("member-search", cacheKey, rows);
  }
  const hits = rankHits(rows, name, state).slice(0, limit).map(hitFrom);
  console.log(
    "[resolve-identity] memberSearch:",
    JSON.stringify({ q: name, state, hits: hits.length, cached: fromCache, ms: Date.now() - t0 })
  );
  return { available: true, hits, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// memberPreview
// ---------------------------------------------------------------------------

export interface MemberPreviewPayload {
  available: boolean;
  member?: MemberSearchHit & { status?: string };
  /** Events since the online era began whose NAME flags them online — a cheap
   *  lower bound on traversable history (the graph build finds more). */
  onlineEventsNamed?: number;
  /** Events in the 2020-03..2022-06 window when nearly everything was online. */
  pandemicEraEvents?: number;
  /** Total events on file since 2020-03 (activity signal). */
  eventsSince2020?: number;
  latestEventDate?: string;
  optedOut?: boolean;
  resolvedHandles?: { platform: string; username: string; confidence: number; source: string; verifiedAt?: string }[];
}

export async function handleMemberPreview(req: { uscfId?: unknown }): Promise<MemberPreviewPayload> {
  const id = typeof req.uscfId === "string" ? req.uscfId.replace(/\D/g, "") : "";
  if (!id) return { available: false };
  const t0 = Date.now();

  let member = await cacheGet<UscfMember>("member", id, MEMBER_TTL_MS);
  if (!member) {
    member = await fetchUscfMember(id);
    if (member) void cachePut("member", id, member);
  }
  if (!member) return { available: false };

  // Opt-out, moat handles and the event estimate are independent — overlap them.
  const [optedOut, handles, events] = await Promise.all([
    isOptedOut(id),
    getResolvedHandles([id]),
    (async () => {
      const cached = await cacheGet<{ n: string; d?: string }[]>("events", id, EVENTS_TTL_MS);
      if (cached) return cached;
      const fresh = (await fetchMemberEventsSince(id, "2020-03-01")).map((e) => ({ n: e.name, d: e.startDate }));
      void cachePut("events", id, fresh);
      return fresh;
    })(),
  ]);

  const named = events.filter((e) => looksOnline(e.n)).length;
  const era = events.filter((e) => !looksOnline(e.n) && (e.d || "") >= "2020-03-01" && (e.d || "") <= "2022-06-30").length;
  const latest = events.reduce<string | undefined>((max, e) => (e.d && (!max || e.d > max) ? e.d : max), undefined);

  console.log(
    "[resolve-identity] memberPreview:",
    JSON.stringify({ id, hasOnline: member.hasOnline, named, era, optedOut, handles: handles.length, ms: Date.now() - t0 })
  );
  return {
    available: true,
    member: {
      ...hitFrom({ ...member, rating: member.ratings.regular ?? member.ratings.onlineRegular ?? member.ratings.quick }),
      status: member.status,
    },
    onlineEventsNamed: named,
    pandemicEraEvents: era,
    eventsSince2020: events.length,
    latestEventDate: latest,
    optedOut,
    resolvedHandles: handles.map((h) => ({
      platform: h.platform,
      username: h.username,
      confidence: h.confidence,
      source: h.source,
      verifiedAt: h.verified_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// fideSearch — name → FIDE ID via Lichess's FIDE database. Lichess mirrors the
// FIDE registry and exposes a name search; one call closes the last "go look
// it up on another site" ask in the flow.
// ---------------------------------------------------------------------------

export interface FidePlayerHit {
  fideId: string;
  name: string;
  federation?: string;
  title?: string;
  year?: number;
  standard?: number;
  rapid?: number;
  blitz?: number;
}

export async function handleFideSearch(req: { name?: unknown }): Promise<Record<string, unknown>> {
  const name = typeof req.name === "string" ? req.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < 3) return { available: true, hits: [] };

  const cacheKey = name.toLowerCase();
  const cached = await cacheGet<FidePlayerHit[]>("fide-search", cacheKey, FIDE_TTL_MS);
  if (cached) return { available: true, hits: cached, cached: true };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(`https://lichess.org/api/fide/player?q=${encodeURIComponent(name)}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { available: false, hits: [], note: `Lichess FIDE search answered ${res.status}.` };
    const rows = (await res.json()) as Array<Record<string, unknown>>;
    const hits: FidePlayerHit[] = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && (typeof r.id === "number" || typeof r.id === "string") && typeof r.name === "string")
      .slice(0, 10)
      .map((r) => ({
        fideId: String(r.id),
        name: String(r.name),
        federation: typeof r.federation === "string" ? r.federation : undefined,
        title: typeof r.title === "string" ? r.title : undefined,
        year: typeof r.year === "number" ? r.year : undefined,
        standard: typeof r.standard === "number" ? r.standard : undefined,
        rapid: typeof r.rapid === "number" ? r.rapid : undefined,
        blitz: typeof r.blitz === "number" ? r.blitz : undefined,
      }));
    if (hits.length) void cachePut("fide-search", cacheKey, hits);
    console.log("[resolve-identity] fideSearch:", JSON.stringify({ q: name, hits: hits.length }));
    return { available: true, hits };
  } catch {
    return { available: false, hits: [], note: "Lichess FIDE search unreachable." };
  }
}

// ---------------------------------------------------------------------------
// resolvedHandles / claimHandle / optOut — the moat and the privacy loop
// ---------------------------------------------------------------------------

export async function handleResolvedHandles(req: { uscfIds?: unknown }): Promise<Record<string, unknown>> {
  const ids = Array.isArray(req.uscfIds)
    ? (req.uscfIds.filter((x) => typeof x === "string") as string[]).slice(0, 50)
    : [];
  if (!ids.length) return { available: true, handles: [] };
  const rows = await getResolvedHandles(ids);
  return {
    available: true,
    handles: rows.map((h) => ({
      uscfId: h.uscf_id,
      platform: h.platform,
      username: h.username,
      confidence: h.confidence,
      evidence: h.evidence,
      source: h.source,
      verifiedAt: h.verified_at,
    })),
  };
}

const CLAIM_SOURCES = new Set(["engine", "user-correction", "claim"]);
const CLAIM_PLATFORMS = new Set(["lichess", "chesscom", "chesskid", "icc", "other"]);

export async function handleClaimHandle(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const uscfId = typeof req.uscfId === "string" ? req.uscfId.replace(/\D/g, "") : "";
  const platform = typeof req.platform === "string" && CLAIM_PLATFORMS.has(req.platform) ? req.platform : "";
  const username = typeof req.username === "string" ? req.username.trim().replace(/^@/, "") : "";
  const source = typeof req.source === "string" && CLAIM_SOURCES.has(req.source) ? req.source : "engine";
  const confidence =
    typeof req.confidence === "number" && isFinite(req.confidence)
      ? Math.max(0, Math.min(1, req.confidence))
      : 0;
  if (!uscfId || !platform || !username || !/^[A-Za-z0-9_.-]{2,30}$/.test(username)) {
    return { available: true, stored: false };
  }
  const stored = await putResolvedHandle({
    uscfId,
    platform,
    username,
    confidence,
    evidence: req.evidence,
    source,
  });
  console.log("[resolve-identity] claimHandle:", JSON.stringify({ uscfId, platform, username, source, stored }));
  return { available: true, stored };
}

export async function handleOptOut(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  const stored = await putOptOut({
    uscfId: typeof req.uscfId === "string" ? req.uscfId : undefined,
    platform: typeof req.platform === "string" ? req.platform : undefined,
    username: typeof req.username === "string" ? req.username : undefined,
    note: typeof req.note === "string" ? req.note : undefined,
  });
  return { available: true, stored };
}
