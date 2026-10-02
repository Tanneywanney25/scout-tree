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
// written when a section aligns), a learned series (series_platform), the
// event/section title, else "unknown". In production's muir_cache on
// 2026-10-02, 46% of online sections named no platform in the title, 43% were
// ICC, 10% Chess.com, 0.1% Lichess — so a title-only rule would zero out most
// real online players.
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
import { cacheGet, cachePut, getEventPlatforms, getSeriesPlatforms } from "../_shared/identityStore.ts";

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
  via: "stored" | "series" | "title" | "none";
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
}

const FOOTPRINT_TTL_MS = 3 * 24 * 60 * 60_000;
const FOOTPRINT_PAGE_CAP = 5;
const SECTIONS_RETURNED = 80;

function classify(
  ref: OnlineSecRef,
  stored: Map<string, { platform: string }>,
  series: Map<string, string>
): { platform: FootprintPlatform; via: FootprintSection["via"] } {
  const norm = (p?: string): FootprintPlatform | null =>
    p === "chesscom" || p === "lichess" || p === "icc" || p === "chesskid" ? p : null;
  const fromStore = norm(stored.get(ref.eventId)?.platform);
  if (fromStore) return { platform: fromStore, via: "stored" };
  const fromSeries = norm(series.get(seriesKey(ref.eventName)));
  if (fromSeries) return { platform: fromSeries, via: "series" };
  const fromTitle = norm(platformGuess(nameForMatch(`${ref.eventName} ${ref.sectionName || ""}`)));
  if (fromTitle) return { platform: fromTitle, via: "title" };
  return { platform: "unknown", via: "none" };
}

export async function memberFootprint(uscfId: string, overBudget: () => boolean): Promise<MemberFootprint | null> {
  const id = uscfId.replace(/\D/g, "");
  if (!id) return null;
  const cached = await cacheGet<MemberFootprint>("footprint", id, FOOTPRINT_TTL_MS);
  if (cached) return cached;
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
    getSeriesPlatforms(refs.map((r) => seriesKey(r.eventName))),
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
