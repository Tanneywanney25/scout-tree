// ============================================================================
// US Chess (USCF) data layer — MUIR JSON API
//
// In mid-2026 US Chess retired the old server-rendered MSA pages
// (www.uschess.org/msa/*, HTML scraping) and moved ratings to **MUIR**, a
// modern SPA backed by a clean JSON API at ratings-api.uschess.org. This module
// talks to that API. It still runs server-side inside the resolve-identity edge
// function because the MUIR API does not send CORS headers (a browser can't call
// it directly).
//
// Endpoints used (all public GET, no auth):
//   • Search:      /api/v1/members?Fuzzy=<First Last>&StateRep=XX&Size=N
//   • Member:      /api/v1/members/{memberId}
//   • History:     /api/v1/members/{memberId}/events?Offset=0&Size=N
//   • Event:       /api/v1/rated-events/{eventId}                 → sections[]
//   • Section:     /api/v1/rated-events/{eventId}/sections/{n}    → isOnline, TC…
//   • Crosstable:  /api/v1/rated-events/{eventId}/sections/{n}/standings
//        → per player: memberId, name, score, ratings[], and roundOutcomes[]
//          carrying { roundNumber, color, outcome, opponentMemberId, name }.
//
// Rating systems: R=Regular, Q=Quick, B=Blitz, OR/OQ/OB = the Online systems
// introduced in the 2020 online-play era. A member "hasOnline" when any OR/OQ/OB
// carries a real (non-null) rating — those are the players whose tournament
// graph is worth traversing for online usernames.
//
// Everything is defensive: any failure yields empty/undefined, never throws, so
// the caller degrades to "no USCF data" instead of breaking the search.
// ============================================================================

const API = "https://ratings-api.uschess.org/api/v1";
const UA = "Mozilla/5.0 (compatible; ScoutTree/1.0; +https://chess-scout.vercel.app)";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UscfRatings {
  regular?: number;
  quick?: number;
  blitz?: number;
  onlineRegular?: number;
  onlineQuick?: number;
  onlineBlitz?: number;
}

export interface UscfMember {
  id: string;
  name: string; // "First Last", title-cased for display
  state?: string;
  fideId?: string;
  fideCountry?: string;
  title?: string; // FIDE title letter mapped to GM/IM/… when present
  expiration?: string;
  ratings: UscfRatings;
  hasOnline: boolean;
  status?: string;
}

export interface UscfSearchRow extends UscfMember {
  /** Best single rating for ranking (regular, else online-regular, else quick). */
  rating?: number;
}

export interface UscfEventRef {
  eventId: string;
  name: string;
  startDate?: string; // YYYY-MM-DD
  endDate?: string;
  sectionCount?: number;
  playerCount?: number;
  state?: string;
}

export type GameColor = "white" | "black" | "unknown";

/** One game the target (or any roster player) played in a section. */
export interface UscfGame {
  round: number;
  color: GameColor;
  outcome: string; // Win / Loss / Draw / WinForfeit / …
  opponentUscfId: string;
  opponentName: string;
}

/** A player in an online section, with their round-by-round games. */
export interface UscfSectionPlayer {
  uscfId: string;
  name: string;
  rating?: number; // pre-event rating in this section's system
  /** USCF state of record (stateRep) — location signal for candidate profiles. */
  state?: string;
  isTarget?: boolean;
  games: UscfGame[];
}

/** An online-rated section the target played in — the traversable unit. */
export interface OnlineSection {
  eventId: string;
  name: string;
  sectionName?: string;
  sectionNumber: number;
  startDate?: string;
  endDate?: string;
  ratingSystem: string; // OR / OQ / OB
  timeControl?: string;
  roundCount?: number;
  isBlitz?: boolean;
  platformGuess?: string; // lichess / chesscom / chesskid / icc
  players: UscfSectionPlayer[];
}

// ---------------------------------------------------------------------------
// Low-level fetch with timeout + light retry (429 / 5xx / network)
// ---------------------------------------------------------------------------

// MUIR rate-limits bursts; space requests out so a graph build (which can make
// dozens of section/standings calls) stays under its limiter.
let muirNextSlot = 0;
async function muirThrottle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, muirNextSlot - now);
  muirNextSlot = Math.max(now, muirNextSlot) + 160;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function fetchJson(path: string, timeoutMs = 12000, retries = 3): Promise<any | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await muirThrottle();
      const res = await fetch(`${API}${path}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) {
          // 429s can persist for a while — back off meaningfully.
          await new Promise((r) => setTimeout(r, (res.status === 429 ? 1500 : 500) * (attempt + 1)));
          continue;
        }
        return null;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      clearTimeout(t);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Title-case a possibly ALL-CAPS MUIR name for display. */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\s+/g, " ")
    .trim();
}

function fullName(first?: string, last?: string): string {
  return titleCase(`${first || ""} ${last || ""}`.trim());
}

const FIDE_TITLE_MAP: Record<string, string> = {
  G: "GM",
  I: "IM",
  F: "FM",
  C: "CM",
  W: "WGM",
  WG: "WGM",
  WI: "WIM",
  WF: "WFM",
  WC: "WCM",
};

/** Map MUIR's ratings[] array into our structured UscfRatings. */
function mapRatings(ratings: any[]): UscfRatings {
  const out: UscfRatings = {};
  const key: Record<string, keyof UscfRatings> = {
    R: "regular",
    Q: "quick",
    B: "blitz",
    OR: "onlineRegular",
    OQ: "onlineQuick",
    OB: "onlineBlitz",
  };
  for (const r of ratings || []) {
    const k = key[r?.ratingSystem];
    if (k && typeof r.rating === "number") out[k] = r.rating;
  }
  return out;
}

function memberFrom(raw: any): UscfMember | null {
  if (!raw || !raw.id) return null;
  const ratings = mapRatings(raw.ratings || []);
  const hasOnline =
    ratings.onlineRegular !== undefined ||
    ratings.onlineQuick !== undefined ||
    ratings.onlineBlitz !== undefined;
  const title = raw.fideTitle ? FIDE_TITLE_MAP[String(raw.fideTitle).toUpperCase()] : undefined;
  return {
    id: String(raw.id),
    name: fullName(raw.firstName, raw.lastName),
    state: raw.stateRep || raw.jurisdiction || undefined,
    fideId: raw.fideId ? String(raw.fideId) : undefined,
    fideCountry: raw.fideCountry || undefined,
    title,
    expiration: raw.expirationDate || undefined,
    ratings,
    hasOnline,
    status: raw.status || undefined,
  };
}

function bestRating(r: UscfRatings): number | undefined {
  return r.regular ?? r.onlineRegular ?? r.quick ?? r.blitz ?? r.onlineBlitz;
}

/** Guess the online platform from an event/section name. */
const ONLINE_NAME_RE =
  /\b(online|virtual|lichess|chess\.?com|chesskid|icc|internet|pandemic|covid|quarantine|web)\b/i;

/** MUIR event names are often underscore-styled ("PNWCC_G60_ONLINE___NOV_12"),
 *  and `\b` treats `_` as a word character — so \bONLINE\b silently missed
 *  them, dropping whole online events from the graph (observed: every
 *  post-2022 PNWCC G60 online event a player had). Normalise before testing. */
const nameForMatch = (s: string) => s.replace(/_/g, " ");
const looksOnline = (name: string) => ONLINE_NAME_RE.test(nameForMatch(name));

function platformGuess(text: string): string | undefined {
  if (/lichess/i.test(text)) return "lichess";
  if (/chess\.?com/i.test(text)) return "chesscom";
  if (/chesskid/i.test(text)) return "chesskid";
  if (/\bicc\b/i.test(text)) return "icc";
  return undefined;
}

// ---------------------------------------------------------------------------
// Public: search, member, history
// ---------------------------------------------------------------------------

/** Name search. `Fuzzy` matches natural "First Last" order. */
export async function searchUscfByName(name: string, state?: string): Promise<UscfSearchRow[]> {
  const params = new URLSearchParams({ Fuzzy: name.replace(/\s+/g, " ").trim(), Size: "25" });
  if (state && /^[A-Za-z]{2}$/.test(state.trim())) params.set("StateRep", state.trim().toUpperCase());
  const data = await fetchJson(`/members?${params.toString()}`);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const rows: UscfSearchRow[] = [];
  for (const it of items) {
    const m = memberFrom(it);
    if (m) rows.push({ ...m, rating: bestRating(m.ratings) });
  }
  return rows;
}

export async function fetchUscfMember(id: string): Promise<UscfMember | null> {
  const clean = id.replace(/\D/g, "");
  if (!clean) return null;
  const data = await fetchJson(`/members/${clean}`);
  return memberFrom(data);
}

function eventRefFrom(e: any): UscfEventRef {
  return {
    eventId: String(e.id),
    name: e.name || "",
    startDate: e.startDate,
    endDate: e.endDate,
    sectionCount: e.sectionCount,
    playerCount: e.playerCount,
    state: e.stateCode,
  };
}

export async function fetchMemberEvents(id: string, size = 80): Promise<UscfEventRef[]> {
  const clean = id.replace(/\D/g, "");
  if (!clean) return [];
  const data = await fetchJson(`/members/${clean}/events?Offset=0&Size=${size}`);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  return items.map(eventRefFrom);
}

/**
 * Page a member's event history (newest-first) collecting every event on/after
 * `sinceDate`. Active players can have hundreds of events, and the online-rated
 * era (2020–2021) may sit many pages deep, so we page until a page drops below
 * the cutoff (or a safety page cap is hit) rather than reading only page one.
 */
export async function fetchMemberEventsSince(
  id: string,
  sinceDate: string,
  pageCap = 10,
  pageSize = 100
): Promise<UscfEventRef[]> {
  const clean = id.replace(/\D/g, "");
  if (!clean) return [];
  const out: UscfEventRef[] = [];
  for (let page = 0; page < pageCap; page++) {
    const data = await fetchJson(`/members/${clean}/events?Offset=${page * pageSize}&Size=${pageSize}`);
    const items: any[] = Array.isArray(data?.items) ? data.items : [];
    if (!items.length) break;
    let pageMax = "0";
    for (const e of items) {
      const ref = eventRefFrom(e);
      if ((ref.startDate || "0") >= sinceDate) out.push(ref);
      if ((ref.startDate || "0") > pageMax) pageMax = ref.startDate || "0";
    }
    // Newest-first: once an entire page predates the cutoff, we're done.
    if (pageMax < sinceDate) break;
    if (!data?.hasNextPage) break;
  }
  return out;
}

interface SectionRef {
  number: number;
  name?: string;
}

async function fetchEventSections(eventId: string): Promise<{ sections: SectionRef[]; startDate?: string; endDate?: string; name?: string }> {
  const data = await fetchJson(`/rated-events/${eventId}`);
  const sections: SectionRef[] = Array.isArray(data?.sections)
    ? data.sections.map((s: any) => ({ number: s.number, name: s.name }))
    : [];
  return { sections, startDate: data?.startDate, endDate: data?.endDate, name: data?.name };
}

interface SectionMeta {
  isOnline: boolean;
  ratingSystem?: string;
  timeControl?: string;
  roundCount?: number;
  isBlitz?: boolean;
  startDate?: string;
  endDate?: string;
}

async function fetchSectionMeta(eventId: string, number: number): Promise<SectionMeta | null> {
  const s = await fetchJson(`/rated-events/${eventId}/sections/${number}`);
  if (!s) return null;
  return {
    isOnline: !!s.isOnline,
    ratingSystem: s.ratingSystem,
    timeControl: s.timeControl,
    roundCount: s.roundCount,
    isBlitz: !!s.isBlitz,
    startDate: s.startDate,
    endDate: s.endDate,
  };
}

function colorFrom(raw: any): GameColor {
  const c = String(raw || "").toLowerCase();
  if (c === "white") return "white";
  if (c === "black") return "black";
  return "unknown";
}

/** Standings → roster of players with round-by-round games. */
async function fetchSectionPlayers(eventId: string, number: number, rootId: string): Promise<UscfSectionPlayer[]> {
  const data = await fetchJson(`/rated-events/${eventId}/sections/${number}/standings?Offset=0&Size=250`);
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  const players: UscfSectionPlayer[] = [];
  for (const row of items) {
    const uscfId = String(row.memberId || "");
    if (!uscfId) continue;
    const games: UscfGame[] = [];
    for (const ro of row.roundOutcomes || []) {
      if (!ro?.opponentMemberId) continue; // byes/forfeits vs nobody
      games.push({
        round: ro.roundNumber,
        color: colorFrom(ro.color),
        outcome: ro.outcome || "",
        opponentUscfId: String(ro.opponentMemberId),
        opponentName: fullName(ro.opponentFirstName, ro.opponentLastName),
      });
    }
    // pre-event rating for this section's system, if present
    const rating = Array.isArray(row.ratings) && row.ratings[0]?.preRating ? row.ratings[0].preRating : undefined;
    players.push({
      uscfId,
      name: fullName(row.firstName, row.lastName),
      rating,
      state: typeof row.stateRep === "string" && row.stateRep.trim() ? row.stateRep.trim().toUpperCase() : undefined,
      isTarget: uscfId === rootId,
      games,
    });
  }
  return players;
}

// ---------------------------------------------------------------------------
// Online tournament graph for a member
// ---------------------------------------------------------------------------

export interface BuildGraphOptions {
  /** Max online sections to include (each is one crosstable). */
  maxSections?: number;
  /** Max candidate events to inspect. */
  maxEvents?: number;
}

/**
 * Build the list of online-rated sections the member played in, each with the
 * full roster and every player's round-by-round games. This is the mesh the
 * client BFS traverses to discover online usernames.
 */
export async function buildOnlineGraphForMember(
  member: UscfMember,
  opts: BuildGraphOptions = {}
): Promise<OnlineSection[]> {
  if (!member.hasOnline) return []; // no online ratings ⇒ nothing to traverse
  // Generous defaults: the traversal must be able to work EVERY online
  // tournament the player has. The only real ceiling is the edge function's
  // own wall-clock limit — these keep a full build comfortably inside it.
  const maxSections = opts.maxSections ?? 16;
  const maxEvents = opts.maxEvents ?? 100;

  // Online-rated systems launched in 2020 — page back to that era (it can sit
  // many pages deep for active players) and ignore anything older.
  const era = await fetchMemberEventsSince(member.id, "2020-03-01");
  // Candidate order matters for active players with hundreds of events:
  //   1. events whose NAME signals online play (any date),
  //   2. events from the 2020-03..2022-06 window when nearly every rated event
  //      was online (they sit at the END of the newest-first era list, so a
  //      naive "newest N" scan misses them entirely),
  //   3. whatever else is newest.
  const named = new Set(era.filter((e) => looksOnline(e.name)));
  const pandemicEra = new Set(
    era.filter((e) => !named.has(e) && (e.startDate || "") >= "2020-03-01" && (e.startDate || "") <= "2022-06-30")
  );
  const rest = era.filter((e) => !named.has(e) && !pandemicEra.has(e));
  const candidates = [...named, ...pandemicEra, ...rest].slice(0, maxEvents);

  // Phase 1: find which sections are actually online. Modest concurrency plus
  // early stopping — named events are near-certain hits, and once the unnamed
  // scan keeps missing there is no point burning MUIR's rate limit further.
  interface Found {
    ev: UscfEventRef;
    section: SectionRef;
    meta: SectionMeta;
  }
  let foundCount = 0;
  let unnamedMisses = 0;
  const perEvent = await mapLimit(candidates, 2, async (ev): Promise<Found[]> => {
    if (foundCount >= maxSections || (unnamedMisses >= 20 && !named.has(ev))) return [];
    const { sections, startDate, endDate, name } = await fetchEventSections(ev.eventId);
    const evRef: UscfEventRef = { ...ev, name: ev.name || name || "", startDate: ev.startDate || startDate, endDate: ev.endDate || endDate };
    const metas = await mapLimit(sections, 2, async (sec) => {
      if (foundCount >= maxSections) return null;
      const meta = await fetchSectionMeta(ev.eventId, sec.number);
      return meta && meta.isOnline ? { ev: evRef, section: sec, meta } : null;
    });
    const found = metas.filter((x): x is Found => !!x);
    foundCount += found.length;
    if (!found.length && !named.has(ev)) unnamedMisses++;
    return found;
  });
  const foundSections = perEvent.flat().slice(0, maxSections);

  // Phase 2: pull the crosstable for each online section.
  const online = await mapLimit(foundSections, 2, async ({ ev, section, meta }): Promise<OnlineSection | null> => {
    const players = await fetchSectionPlayers(ev.eventId, section.number, member.id);
    if (!players.some((p) => p.isTarget)) return null; // target not actually here
    const evName = ev.name || "";
    return {
      eventId: ev.eventId,
      name: evName,
      sectionName: section.name,
      sectionNumber: section.number,
      startDate: meta.startDate || ev.startDate,
      endDate: meta.endDate || ev.endDate,
      ratingSystem: meta.ratingSystem || "OR",
      timeControl: meta.timeControl,
      roundCount: meta.roundCount,
      isBlitz: meta.isBlitz,
      platformGuess: platformGuess(nameForMatch(`${evName} ${section.name || ""}`)),
      players,
    };
  });
  return online.filter((x): x is OnlineSection => !!x);
}

// ---------------------------------------------------------------------------
// Bounded-concurrency helper
// ---------------------------------------------------------------------------

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
