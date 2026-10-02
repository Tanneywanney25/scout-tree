// ============================================================================
// Identity-graph read modes and the per-caller rate limiter.
//
//   storedIdentity  — one member's stored identities, classified as verdict /
//                     lead, with lazy revalidation of rows that have not been
//                     checked for REVALIDATE_AFTER_MS. The single-member read
//                     the search does BEFORE any discovery (the short circuit).
//                     Same disclosure as memberPreview, which already returns
//                     one member's stored handles unauthenticated.
//   seedEdges       — stored identities for a BATCH of members (crosstable
//                     seeds for the traversal). Bulk, so it requires a
//                     signed-in caller, exactly like resolvedHandles.
//   sectionGraph    — crosstables for named sections (MUIR via muir_cache).
//   memberFootprints— portal footprints for pivot ranking (footprint.ts).
//   sectionNegatives— read / record sections walked out without a result.
//
// Age policy (3.1). Chess.com allows a username change every 90 days; a
// renamed or closed account stops answering under its old name. So:
//   • a row not checked in 30 days is revalidated when read (one profile
//     request; at most REVALIDATE_PER_CALL per call);
//   • 404/410, or a profile reporting a closed account, retires the row
//     (status 'gone') and every edge for that handle;
//   • a row that has gone unchecked for 90 days and cannot be revalidated
//     right now is served as a lead, never as a verdict.
// ============================================================================

import {
  getActiveEdges,
  getVerdictRows,
  retireVerdict,
  markRevalidated,
  retireEdgesForHandle,
  getSectionNegatives,
  putSectionNegative,
  type StoredEdge,
  type VerdictRow,
} from "../_shared/identityStore.ts";
import { fetchSectionGraph } from "./uscf.ts";
import { memberFootprints } from "./footprint.ts";

const UA = "ScoutTree/1.0 (+https://chess-scout.vercel.app)";
const DAY = 86_400_000;
const REVALIDATE_AFTER_MS = 30 * DAY;
const STALE_AFTER_MS = 90 * DAY;
const REVALIDATE_PER_CALL = 3;
/** Negative-cache lifetime. See sectionNegatives below for the defence. */
export const NEGATIVE_TTL_MS = 30 * DAY;

// ---------------------------------------------------------------------------
// Per-caller sliding-window limiter (per warm isolate). Generalises the one
// memberSearch has had since the anchor split; each mode gets its own bucket.
// ---------------------------------------------------------------------------

const limiterBuckets = new Map<string, number[]>();

export function rateLimited(mode: string, clientKey: string, maxInWindow: number, windowMs: number): boolean {
  const key = `${mode}|${clientKey}`;
  const now = Date.now();
  const bucket = (limiterBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (bucket.length >= maxInWindow) {
    limiterBuckets.set(key, bucket);
    return true;
  }
  bucket.push(now);
  limiterBuckets.set(key, bucket);
  if (limiterBuckets.size > 2000) {
    for (const [k, v] of limiterBuckets) if (!v.length || now - v[v.length - 1] > 10 * 60_000) limiterBuckets.delete(k);
  }
  return false;
}

export function clientKeyOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("cf-connecting-ip") || "anon";
}

// ---------------------------------------------------------------------------
// storedIdentity
// ---------------------------------------------------------------------------

type Liveness = "live" | "gone" | "unknown";

async function profileLiveness(platform: string, handle: string): Promise<Liveness> {
  const url =
    platform === "chesscom"
      ? `https://api.chess.com/pub/player/${encodeURIComponent(handle.toLowerCase())}`
      : platform === "lichess"
      ? `https://lichess.org/api/user/${encodeURIComponent(handle)}`
      : "";
  if (!url) return "unknown";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    clearTimeout(t);
    if (res.status === 404 || res.status === 410) return "gone";
    if (!res.ok) return "unknown";
    const body = (await res.json().catch(() => null)) as { status?: string; closed?: boolean; disabled?: boolean } | null;
    if (body?.closed || body?.disabled || (typeof body?.status === "string" && /^closed/.test(body.status))) return "gone";
    return "live";
  } catch {
    return "unknown";
  }
}

export interface StoredIdentityOut {
  platform: string;
  username: string;
  /** verdict = show as the answer; lead = show as "likely", needs one more section. */
  kind: "verdict" | "lead";
  tier?: string;
  confidence: number;
  /** True only for rows the server proved itself (alignment harvest). */
  serverVerified: boolean;
  source: string;
  sections?: number;
  checkedAt?: string;
}

const edgeIsVerdict = (e: StoredEdge) => e.tier === "strong" || e.n_sections >= 2;

export async function handleStoredIdentity(req: { uscfId?: unknown }): Promise<Record<string, unknown>> {
  const id = typeof req.uscfId === "string" ? req.uscfId.replace(/\D/g, "") : "";
  if (!id) return { available: false, identities: [] };
  const [verdicts, edges] = await Promise.all([getVerdictRows(id), getActiveEdges([id])]);

  // Lazy revalidation of rows that have not been checked for 30 days.
  const now = Date.now();
  const lastCheck = (v: VerdictRow) => Date.parse(v.revalidated_at || v.verified_at || "") || 0;
  const due = verdicts.filter((v) => now - lastCheck(v) > REVALIDATE_AFTER_MS).slice(0, REVALIDATE_PER_CALL);
  const retired = new Set<number>();
  let revalidated = 0;
  for (const v of due) {
    const live = await profileLiveness(v.platform, v.username);
    if (live === "gone") {
      await retireVerdict(v.id, "gone", `${v.platform} account @${v.username} no longer answers (renamed or closed)`);
      await retireEdgesForHandle(v.platform, v.username, "account no longer answers under this name");
      retired.add(v.id);
    } else if (live === "live") {
      await markRevalidated(v.id);
      v.revalidated_at = new Date().toISOString();
      revalidated++;
    }
  }

  const out: StoredIdentityOut[] = [];
  const seen = new Set<string>();
  for (const v of verdicts) {
    if (retired.has(v.id)) continue;
    const stale = now - lastCheck(v) > STALE_AFTER_MS;
    const serverVerified = v.source === "alignment";
    out.push({
      platform: v.platform,
      username: v.username,
      kind: serverVerified && !stale ? "verdict" : "lead",
      tier: v.tier,
      confidence: v.confidence,
      serverVerified,
      source: v.source,
      checkedAt: v.revalidated_at || v.verified_at,
    });
    seen.add(`${v.platform}:${v.username.toLowerCase()}`);
  }
  // Edges not mirrored as a verdict (a second strong account, or a single weak
  // assignment) are returned as what they are.
  for (const e of edges) {
    const k = `${e.platform}:${e.handle}`;
    if (seen.has(k)) continue;
    const stale = now - (Date.parse(e.last_verified) || 0) > STALE_AFTER_MS;
    out.push({
      platform: e.platform,
      username: e.handle,
      kind: edgeIsVerdict(e) && !stale ? "verdict" : "lead",
      tier: e.tier,
      confidence: e.tier === "strong" ? 0.99 : e.n_sections >= 2 ? 0.97 : 0.93,
      serverVerified: true,
      source: "alignment",
      sections: e.n_sections,
      checkedAt: e.last_verified,
    });
  }
  return { available: true, identities: out, revalidated, retired: retired.size };
}

// ---------------------------------------------------------------------------
// seedEdges (auth required by the caller in index.ts)
// ---------------------------------------------------------------------------

export async function handleSeedEdges(req: { uscfIds?: unknown }): Promise<Record<string, unknown>> {
  const ids = Array.isArray(req.uscfIds) ? (req.uscfIds.filter((x) => typeof x === "string") as string[]).slice(0, 400) : [];
  if (!ids.length) return { available: true, seeds: [] };
  const edges = await getActiveEdges(ids);
  return {
    available: true,
    seeds: edges
      .filter(edgeIsVerdict)
      .map((e) => ({ uscfId: e.uscf_id, platform: e.platform, username: e.handle, tier: e.tier, sections: e.n_sections })),
  };
}

// ---------------------------------------------------------------------------
// sectionGraph / memberFootprints
// ---------------------------------------------------------------------------

export async function handleSectionGraph(req: { sections?: unknown; rootId?: unknown }): Promise<Record<string, unknown>> {
  const list = Array.isArray(req.sections) ? req.sections.slice(0, 12) : [];
  const root = typeof req.rootId === "string" ? req.rootId.replace(/\D/g, "") : "";
  const out = [];
  for (const s of list) {
    const o = s as { eventId?: unknown; sectionNumber?: unknown };
    const eventId = typeof o.eventId === "string" ? o.eventId.replace(/\D/g, "") : "";
    const n = typeof o.sectionNumber === "number" ? Math.floor(o.sectionNumber) : NaN;
    if (!eventId || !Number.isFinite(n)) continue;
    const g = await fetchSectionGraph(eventId, n, root);
    if (g) out.push(g);
  }
  return { available: true, sections: out };
}

export async function handleMemberFootprints(req: { uscfIds?: unknown }, budgetMs: number): Promise<Record<string, unknown>> {
  const ids = Array.isArray(req.uscfIds) ? (req.uscfIds.filter((x) => typeof x === "string") as string[]).slice(0, 40) : [];
  const { footprints, pending } = await memberFootprints(ids, Date.now() + budgetMs);
  return { available: true, footprints, pending };
}

// ---------------------------------------------------------------------------
// sectionNegatives
//
// TTL 30 days (NEGATIVE_TTL_MS). Defence: the crosstable of a rated section
// never changes, so what makes a dead section live again is new evidence —
// a member resolved elsewhere — and record_identity_edges() clears every
// negative listing a newly stored member the moment that happens. The TTL
// only bounds the cases that leave no trace in the store: a platform outage
// during the walk, a seed found by a path that was not harvested, a member
// renaming. 30 days matches the investigation's recommendation for "section
// has no tournament-tagged games for any known participant" (§6.5).
//
// The caller may only name the section; the member list is read from the
// crosstable server-side, so a client cannot attach a negative to members
// that are not in it. Negatives DEPRIORITISE a section (it goes to the back of
// its level), they never hide it, so a malicious write can delay a search but
// not make a section unsearchable.
// ---------------------------------------------------------------------------

export async function handleSectionNegatives(req: { get?: unknown; put?: unknown }): Promise<Record<string, unknown>> {
  if (Array.isArray(req.get)) {
    const keys = req.get
      .slice(0, 200)
      .map((k) => k as { eventId?: unknown; sectionNumber?: unknown })
      .filter((k) => typeof k.eventId === "string" && typeof k.sectionNumber === "number")
      .map((k) => ({ eventId: String(k.eventId).replace(/\D/g, ""), sectionNo: Math.floor(Number(k.sectionNumber)) }));
    const rows = await getSectionNegatives(keys);
    return {
      available: true,
      negatives: rows.map((r) => ({ eventId: r.event_id, sectionNumber: r.section_no, reason: r.reason, walkedAt: r.walked_at, expiresAt: r.expires_at })),
    };
  }
  const p = (req.put || {}) as { eventId?: unknown; sectionNumber?: unknown; reason?: unknown; requests?: unknown };
  const eventId = typeof p.eventId === "string" ? p.eventId.replace(/\D/g, "") : "";
  const n = typeof p.sectionNumber === "number" ? Math.floor(p.sectionNumber) : NaN;
  if (!eventId || !Number.isFinite(n)) return { available: true, stored: false };
  const sec = await fetchSectionGraph(eventId, n);
  if (!sec) return { available: true, stored: false };
  const stored = await putSectionNegative({
    eventId,
    sectionNo: n,
    members: sec.players.map((pl) => pl.uscfId),
    reason: typeof p.reason === "string" ? p.reason : "walked without a resolution",
    requests: typeof p.requests === "number" ? Math.floor(p.requests) : undefined,
    ttlMs: NEGATIVE_TTL_MS,
  });
  return { available: true, stored };
}
