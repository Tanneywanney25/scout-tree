// ============================================================================
// Portal footprint — what the US Chess ratings API says about a member's
// ONLINE history, before any online account is known.
//
// The pivot ranker (src/lib/identity/sectionBfs.ts) needs, for every member on
// a crosstable: how many online-rated sections they played, on which platform,
// and how recently. All of it comes from the member's MUIR games feed (each row
// carries event, section and rating system), so ranking costs no Chess.com or
// Lichess request and no search query.
//
// MUIR carries no platform field. The platform of each section is read, in
// order of trust, from: a stored verdict for the event (event_platform_cache,
// written when a section aligns or the roster index joins it); a series proved
// by an alignment or present in the roster index; the event/section title; a
// series seen in a Chess.com member's public tournament list; a learned
// organizer prefix ("dmvchess.com …" → Lichess); else "unknown". Measured
// 2026-10-03 over 13,535 distinct footprint sections: 57% had no platform
// before these layers, 23% after (docs/roster-index.md, Phase 5). ICC events
// name ICC in the title (314 of 314 ICC-hosted sections in the cache).
//
// Cost: one MUIR request per 100 games, at most FOOTPRINT_PAGE_CAP pages,
// served from muir_cache when warm; the footprint itself is cached 3 days.
// ============================================================================

import {
  fetchMemberOnlineSections,
  ONLINE_HISTORY_SINCE,
  platformGuess,
  nameForMatch,
  seriesKey,
  type OnlineSecRef,
} from "./uscf.ts";
import { cacheGet, cachePut, getEventPlatforms, getSeriesPlatforms, type SeriesPlatformRow } from "../_shared/identityStore.ts";

export type FootprintPlatform = "chesscom" | "lichess" | "icc" | "chesskid" | "unknown";

export interface FootprintSection {
  eventId: string;
  section: number;
  name: string;
  sectionName?: string;
  date?: string;
  rs: string;
  platform: FootprintPlatform;
  /** Where the platform came from. */
  via: "stored" | "series" | "index" | "title" | "listing" | "prefix" | "none";
  games: number;
}

export interface MemberFootprint {
  uscfId: string;
  /** Online-rated sections seen (within the pages read). */
  total: number;
  chesscom: number;
  lichess: number;
  /** ICC + ChessKid: online-rated but not searchable or alignable. */
  other: number;
  unknown: number;
  lastDate?: string;
  pagesRead: number;
  /** True when the page cap stopped the walk (a very active member). */
  truncated: boolean;
  /** Chess.com / Lichess / unknown-host sections, newest first, capped — the
   *  traversal's expansion frontier when this member is resolved. */
  sections: FootprintSection[];
  /** Payload version (FOOTPRINT_VERSION). */
  v?: number;
}

const FOOTPRINT_TTL_MS = 3 * 24 * 60 * 60_000;
const FOOTPRINT_PAGE_CAP = 2;
const SECTIONS_RETURNED = 80;

/** Only a series proved by an aligned section outranks the title; index,
 *  listing and prefix evidence fill a blank the title leaves. */
const STRONG_SERIES = new Set(["alignment"]);
/** Footprint payload version: bump when classification changes, so cached
 *  footprints (3 days) are recomputed instead of serving stale platforms. */
export const FOOTPRINT_VERSION = 2;
/** The organizer token of a series key ("dmvchess.com action swiss" → "dmvchess.com"). */
export const organizerPrefix = (key: string) => `prefix:${key.split(" ")[0] || ""}`;

function classify(
  ref: OnlineSecRef,
  stored: Map<string, { platform: string }>,
  series: Map<string, SeriesPlatformRow>
): { platform: FootprintPlatform; via: FootprintSection["via"] } {
  const norm = (p?: string): FootprintPlatform | null =>
    p === "chesscom" || p === "lichess" || p === "icc" || p === "chesskid" ? p : null;
  // 1. A stored verdict for this very event (alignment, harvest or index join).
  const fromStore = norm(stored.get(ref.eventId)?.platform);
  if (fromStore) return { platform: fromStore, via: "stored" };
  // 2. The series, when an aligned section or a crawled tournament proved it.
  const key = seriesKey(ref.eventName);
  const s = series.get(key);
  if (s && STRONG_SERIES.has(s.source)) {
    const p = norm(s.platform);
    if (p) return { platform: p, via: "series" };
  }
  // 3. The title ("… on Chess.com", "… on ICC").
  const fromTitle = norm(platformGuess(nameForMatch(`${ref.eventName} ${ref.sectionName || ""}`)));
  if (fromTitle) return { platform: fromTitle, via: "title" };
  // 4. Weaker series evidence: a crawled tournament of that name (index), a
  //    Chess.com public listing of that name, then a learned organizer prefix.
  if (s) {
    const p = norm(s.platform);
    if (p) return { platform: p, via: s.source === "index" ? "index" : "listing" };
  }
  const pre = norm(series.get(organizerPrefix(key))?.platform);
  if (pre) return { platform: pre, via: "prefix" };
  return { platform: "unknown", via: "none" };
}

export async function memberFootprint(uscfId: string, overBudget: () => boolean): Promise<MemberFootprint | null> {
  const id = uscfId.replace(/\D/g, "");
  if (!id) return null;
  const cached = await cacheGet<MemberFootprint>("footprint", id, FOOTPRINT_TTL_MS);
  if (cached && cached.v === FOOTPRINT_VERSION) return cached;
  let pages = 0;
  let truncated = false;
  const refs = await fetchMemberOnlineSections(
    id,
    ONLINE_HISTORY_SINCE,
    () => {
      if (overBudget()) return true;
      if (pages >= FOOTPRINT_PAGE_CAP) {
        truncated = true;
        return true;
      }
      pages++;
      return false;
    },
    FOOTPRINT_PAGE_CAP + 1
  );
  if (overBudget() && !refs.length) return null; // never cache a walk the clock cut short
  const [stored, series] = await Promise.all([
    getEventPlatforms(refs.map((r) => r.eventId)),
    getSeriesPlatforms(refs.flatMap((r) => {
      const k = seriesKey(r.eventName);
      return [k, organizerPrefix(k)];
    })),
  ]);
  const fp: MemberFootprint = {
    uscfId: id,
    total: refs.length,
    chesscom: 0,
    lichess: 0,
    other: 0,
    unknown: 0,
    pagesRead: pages,
    truncated,
    sections: [],
    v: FOOTPRINT_VERSION,
  };
  const secs: FootprintSection[] = [];
  for (const r of refs) {
    const { platform, via } = classify(r, stored, series);
    if (platform === "chesscom") fp.chesscom++;
    else if (platform === "lichess") fp.lichess++;
    else if (platform === "unknown") fp.unknown++;
    else fp.other++;
    if (r.startDate && (!fp.lastDate || r.startDate > fp.lastDate)) fp.lastDate = r.startDate;
    if (platform === "icc" || platform === "chesskid") continue;
    secs.push({
      eventId: r.eventId,
      section: r.sectionNumber,
      name: r.eventName,
      sectionName: r.sectionName,
      date: r.startDate,
      rs: r.ratingSystem,
      platform,
      via,
      games: r.gameCount,
    });
  }
  secs.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  fp.sections = secs.slice(0, SECTIONS_RETURNED);
  // A clock-truncated walk is not cached (it would under-count for 3 days).
  if (!overBudget()) void cachePut("footprint", id, fp);
  return fp;
}

/** Footprints for a batch, sequentially (MUIR is the bottleneck, and the
 *  bucket in uscf.ts paces it). Members the deadline cut off come back in
 *  `pending` for the client to ask again. */
export async function memberFootprints(
  uscfIds: string[],
  deadlineMs: number
): Promise<{ footprints: MemberFootprint[]; pending: string[] }> {
  const overBudget = () => Date.now() > deadlineMs;
  const footprints: MemberFootprint[] = [];
  const pending: string[] = [];
  for (const raw of uscfIds) {
    const id = raw.replace(/\D/g, "");
    if (!id) continue;
    if (overBudget()) {
      pending.push(id);
      continue;
    }
    const fp = await memberFootprint(id, overBudget);
    if (fp) footprints.push(fp);
    else pending.push(id);
  }
  return { footprints, pending };
}
