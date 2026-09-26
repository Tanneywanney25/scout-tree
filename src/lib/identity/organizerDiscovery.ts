// ============================================================================
// Organizer → platform → tournament discovery (the "research every event
// first" stage of the tournament-first engine).
//
// Almost every USCF online-rated event is run by an ORGANIZER who hosts all of
// their events the same way — a Lichess team whose swiss/arena list is a public
// API, or a Chess.com club. So before any per-name work starts, this module
// answers, for EVERY event at once: "who ran it, where did it run, and which
// exact tournament object was it?" Lichess makes this deterministic:
//
//   USCF event name  →  organizer key ("DMVCHESS.COM" → dmv chess)
//                    →  lichess team search  (/api/team/search?text=…)
//                    →  the team's swiss + arena history (/api/team/{id}/swiss|arena)
//                    →  match by DATE + ROUNDS + CLOCK + PLAYER COUNT + NAME
//                    →  the swiss/arena id whose /results and /games list every
//                       participant handle — the whole section maps at once.
//
// Everything here is browser-runnable (Lichess is CORS-open) and fails soft:
// no team, no match, a network blip — the caller just proceeds with its other
// discovery routes. Nothing in here ever names a person; it only ties USCF
// events to tournament objects.
// ============================================================================

import type { GraphEvent } from "./graphTypes";
import { politeFetch } from "./net";
import { parseEventTc, gameMatchesTc } from "./uscfGraphEngine";

const DAY = 86_400_000;

/** One tournament object an organizer's Lichess team ran. */
export interface OrganizerTournament {
  platform: "lichess";
  kind: "lichess-swiss" | "lichess-arena";
  id: string;
  teamId: string;
  name: string;
  startsAtMs: number;
  nbPlayers: number;
  /** Swiss only. */
  nbRounds?: number;
  clock?: { limit: number; increment: number };
  variant?: string;
  status?: string;
  /** Arena only — total minutes. */
  minutes?: number;
}

export interface OrganizerMatch {
  eventId: string;
  tournament: OrganizerTournament;
  /** 0..1 — how well date/rounds/clock/players/name agree. */
  score: number;
  /** True when a runner-up scored within the ambiguity margin — both are
   *  returned as candidates and the roster alignment decides. */
  ambiguous: boolean;
  reasons: string[];
}

export interface OrganizerResearch {
  /** Every match found, best-first per event (an ambiguous event lists 2). */
  matches: Map<string, OrganizerMatch[]>;
  /** Organizer key each event was grouped under ("" when none could be read). */
  organizerOf: Map<string, string>;
  /** Lichess team ids consulted per organizer key. */
  teamsOf: Map<string, string[]>;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Organizer keys from USCF event names
// ---------------------------------------------------------------------------

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
];
const MONTH_ABBR: Record<string, string> = {
  jan: "january", feb: "february", mar: "march", apr: "april", jun: "june", jul: "july", aug: "august",
  sep: "september", sept: "september", oct: "october", nov: "november", dec: "december",
};
/** Words that describe the EVENT rather than the ORGANIZER — a leading phrase
 *  stops at the first of these. */
const EVENT_WORDS = new Set([
  ...MONTHS,
  ...Object.keys(MONTH_ABBR),
  "open", "swiss", "scholastic", "action", "rapid", "blitz", "quick", "bullet", "classical", "championship", "championships",
  "champ", "tournament", "tourney", "quad", "quads", "online", "monthly", "weekly", "daily", "sunday", "saturday", "friday",
  "thursday", "wednesday", "tuesday", "monday", "weekend", "series", "premier", "showdown", "smash", "matches", "match",
  "challenge", "competition", "invitational", "junior", "juniors", "k-12", "k-8", "k-5", "k-3", "k-1", "u1600", "u1200",
  "spring", "summer", "fall", "winter", "autumn", "labor", "memorial", "holiday", "thanksgiving", "christmas", "new",
  "year", "years", "late-summer", "mid-summer", "annual", "1st", "2nd", "3rd", "4th", "5th", "first", "second", "third",
  "fourth", "fifth", "grand", "prix", "league", "cup", "arena", "night", "morning", "afternoon", "evening", "session",
  "round", "robin", "g/25", "g/30", "g/45", "g/60", "g/90", "g/5", "g/10", "g/15", "g/3", "the", "of", "and", "&",
  "for", "at", "in", "on", "with", "vs", "by", "to", "a", "an", "us", "usa", "u.s.", "national", "state", "regional", "city",
  "county", "elementary", "middle", "high", "school", "team", "individual", "section", "sections", "class", "amateur", "under",
  "over", "adult", "youth", "kids", "girls", "boys", "women", "womens", "women's", "senior", "seniors", "beginner", "beginners",
  "novice", "intermediate", "advanced", "reserve", "booster", "warmup", "warm-up", "special", "rated", "unrated", "uscf",
  "fide", "or", "oq", "ob", "online-rated",
]);

const normWord = (w: string) => w.toLowerCase().replace(/[^a-z0-9.#+/-]/g, "");

/** Domain-shaped tokens in an event name ("DMVCHESS.COM", "chessclub.org"). */
function domainKeys(name: string): string[] {
  const out: string[] = [];
  const re = /\b([a-z0-9][a-z0-9-]{1,})\.(com|org|net|us|club|chess|io|co)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name))) {
    const host = m[1].toLowerCase();
    // "chess.com"/"lichess.org" themselves are PLATFORMS, not organizers.
    if (host === "chess" || host === "lichess" || host === "www") continue;
    out.push(host.replace(/^www\./, ""));
  }
  return out;
}

/** The organizer phrase leading an event name — the words before the first
 *  event-descriptive word, e.g. "CHESS KINGS AND QUEENS SEPTEMBER OPEN" →
 *  "chess kings and queens". Too-short/generic phrases yield "". */
function leadingPhrase(name: string): string {
  const words = name.split(/\s+/).map(normWord).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (/^\d/.test(w) || w.startsWith("#") || EVENT_WORDS.has(w)) {
      // "chess" is generic on its own, but organizer names commonly contain
      // it ("Chess Kings and Queens") — keep going through connector words
      // only while we already have a real word.
      if (out.length && (w === "and" || w === "&" || w === "of" || w === "the")) {
        out.push(w);
        continue;
      }
      break;
    }
    out.push(w);
  }
  while (out.length && ["and", "&", "of", "the"].includes(out[out.length - 1])) out.pop();
  const phrase = out.join(" ").trim();
  if (!phrase) return "";
  if (phrase === "chess" || phrase.length < 4) return "";
  return phrase;
}

/** Split an organizer domain key into search terms Lichess's team search can
 *  hit: "dmvchess" → ["dmv chess", "dmvchess", "dmv"]. */
function searchTermsForKey(key: string): string[] {
  const terms = new Set<string>();
  const k = key.toLowerCase().replace(/[^a-z0-9 -]/g, " ").trim();
  if (!k) return [];
  terms.add(k);
  const noSuffix = /^(.*?)(chess|club|academy|scholastic|kids|cc|chessclub|tournaments?)$/.exec(k.replace(/\s+/g, ""));
  if (noSuffix && noSuffix[1].length >= 2) {
    terms.add(`${noSuffix[1]} ${noSuffix[2]}`);
    terms.add(noSuffix[1]);
  }
  if (k.includes(" ")) terms.add(k.replace(/\s+/g, ""));
  return Array.from(terms).filter((t) => t.length >= 3);
}

/** Group events by organizer. Returns eventId → key ("" = unknown organizer)
 *  and key → search terms. */
export function organizerKeysFor(events: GraphEvent[]): { organizerOf: Map<string, string>; termsOf: Map<string, string[]> } {
  const organizerOf = new Map<string, string>();
  const termsOf = new Map<string, string[]>();
  // 1. Common leading word-prefix across ≥2 events is an organizer signature
  //    even when no domain/phrase heuristic fires.
  const wordLists = events.map((e) => e.name.split(/\s+/).map(normWord).filter(Boolean));
  const prefixCount = new Map<string, number>();
  for (const words of wordLists) {
    const seen = new Set<string>();
    for (let n = 1; n <= Math.min(3, words.length); n++) {
      const p = words.slice(0, n).join(" ");
      if (seen.has(p)) continue;
      seen.add(p);
      prefixCount.set(p, (prefixCount.get(p) || 0) + 1);
    }
  }
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const name = ev.name || "";
    let key = "";
    const doms = domainKeys(name);
    if (doms.length) key = doms[0];
    if (!key) {
      const phrase = leadingPhrase(name);
      if (phrase) key = phrase;
    }
    if (!key) {
      // Longest shared prefix (≥2 events) that isn't itself an event word.
      const words = wordLists[i];
      for (let n = Math.min(3, words.length); n >= 1; n--) {
        const p = words.slice(0, n).join(" ");
        if ((prefixCount.get(p) || 0) >= 2 && !EVENT_WORDS.has(p) && p.length >= 4) {
          key = p;
          break;
        }
      }
    }
    organizerOf.set(ev.eventId, key);
    if (key && !termsOf.has(key)) {
      const terms = new Set<string>();
      for (const t of searchTermsForKey(key)) terms.add(t);
      // A domain key also gets its phrase form from the event name, if any.
      const phrase = leadingPhrase(name.replace(/\b[a-z0-9-]+\.(com|org|net|us|club|io|co)\b/gi, " "));
      if (phrase && phrase !== key) terms.add(phrase);
      termsOf.set(key, Array.from(terms));
    }
  }
  return { organizerOf, termsOf };
}

// ---------------------------------------------------------------------------
// Lichess team lookup
// ---------------------------------------------------------------------------

export interface LichessTeam {
  id: string;
  name: string;
  description?: string;
  nbMembers: number;
}

const teamSearchMemo = new Map<string, Promise<LichessTeam[]>>();

async function searchTeams(term: string, signal?: AbortSignal): Promise<LichessTeam[]> {
  const key = term.toLowerCase();
  const hit = teamSearchMemo.get(key);
  if (hit) return hit;
  const p = (async (): Promise<LichessTeam[]> => {
    try {
      const res = await politeFetch(
        `https://lichess.org/api/team/search?text=${encodeURIComponent(term)}`,
        { headers: { Accept: "application/json" }, signal },
        "lichess",
        15_000
      );
      if (!res.ok) return [];
      const data = await res.json();
      const rows: unknown[] = Array.isArray(data?.currentPageResults) ? data.currentPageResults : [];
      return rows
        .map((r): LichessTeam | null => {
          const t = r as { id?: string; name?: string; description?: string; nbMembers?: number };
          if (!t?.id || !t?.name) return null;
          return { id: String(t.id), name: String(t.name), description: typeof t.description === "string" ? t.description : undefined, nbMembers: Number(t.nbMembers) || 0 };
        })
        .filter((t): t is LichessTeam => !!t);
    } catch {
      return [];
    }
  })();
  teamSearchMemo.set(key, p);
  void p.then((r) => {
    if (!r.length && teamSearchMemo.get(key) === p) teamSearchMemo.delete(key); // a failed search may be retried later
  });
  return p;
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Teams that plausibly ARE this organizer: the key's letters appear in the
 *  team name/id, or the organizer's domain appears in the description. Sorted
 *  biggest-first (the main tournaments team of a club is usually its largest). */
export async function findOrganizerTeams(key: string, terms: string[], signal?: AbortSignal): Promise<LichessTeam[]> {
  const keyLetters = letters(key);
  const compact = keyLetters.replace(/(chess|club|academy|scholastic|kids|tournaments?)$/g, "");
  const found = new Map<string, LichessTeam>();
  for (const term of terms) {
    if (signal?.aborted) break;
    const teams = await searchTeams(term, signal);
    for (const t of teams) {
      const nameL = letters(t.name);
      const idL = letters(t.id);
      const desc = (t.description || "").toLowerCase();
      const domainHit = key.includes(".") ? desc.includes(key.toLowerCase()) : desc.includes(`${keyLetters}.com`) || desc.includes(`${keyLetters}.org`);
      const nameHit =
        (keyLetters.length >= 4 && (nameL.includes(keyLetters) || idL.includes(keyLetters))) ||
        (compact.length >= 3 && compact !== keyLetters && (nameL.startsWith(compact) || idL.startsWith(compact)) && /chess|tourn|club|academy|scholastic/.test(nameL + idL)) ||
        letters(term) === nameL ||
        letters(term) === idL;
      if (domainHit || nameHit) found.set(t.id, t);
    }
  }
  return Array.from(found.values()).sort((a, b) => b.nbMembers - a.nbMembers).slice(0, 3);
}

// ---------------------------------------------------------------------------
// Team tournament history (streamed, newest-first, stop at the oldest date needed)
// ---------------------------------------------------------------------------

interface TeamHistory {
  rows: OrganizerTournament[];
  /** Oldest startsAt the stream reached (rows older than this are unknown). */
  reachedMs: number;
  /** The stream ended naturally — the list is complete. */
  complete: boolean;
  fetchedAt: number;
}

const teamHistoryMemo = new Map<string, TeamHistory>();
const STORAGE_PREFIX = "scouttree:lichess-team:";
const STORAGE_TTL_MS = 12 * 60 * 60_000; // team history is append-only; refresh the head twice a day
const STORAGE_MAX_ROWS = 6000;

function readStored(teamId: string, kind: "swiss" | "arena"): TeamHistory | null {
  try {
    const raw = globalThis.localStorage?.getItem(`${STORAGE_PREFIX}${kind}:${teamId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TeamHistory;
    if (!Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(teamId: string, kind: "swiss" | "arena", h: TeamHistory): void {
  try {
    const trimmed: TeamHistory = { ...h, rows: h.rows.slice(0, STORAGE_MAX_ROWS) };
    globalThis.localStorage?.setItem(`${STORAGE_PREFIX}${kind}:${teamId}`, JSON.stringify(trimmed));
  } catch {
    /* quota / private mode — the in-memory memo still works */
  }
}

function parseSwissRow(teamId: string, raw: unknown): OrganizerTournament | null {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r.id !== "string") return null;
  const startsAt = typeof r.startsAt === "string" ? Date.parse(r.startsAt) : typeof r.startsAt === "number" ? r.startsAt : NaN;
  if (!isFinite(startsAt)) return null;
  const clock = r.clock as { limit?: number; increment?: number } | undefined;
  return {
    platform: "lichess",
    kind: "lichess-swiss",
    id: r.id,
    teamId,
    name: typeof r.name === "string" ? r.name : "",
    startsAtMs: startsAt,
    nbPlayers: Number(r.nbPlayers) || 0,
    nbRounds: typeof r.nbRounds === "number" ? r.nbRounds : undefined,
    clock: clock && typeof clock.limit === "number" ? { limit: clock.limit, increment: Number(clock.increment) || 0 } : undefined,
    variant: typeof r.variant === "string" ? r.variant : undefined,
    status: typeof r.status === "string" ? r.status : undefined,
  };
}

function parseArenaRow(teamId: string, raw: unknown): OrganizerTournament | null {
  const r = raw as Record<string, unknown>;
  if (!r || typeof r.id !== "string") return null;
  const startsAt = typeof r.startsAt === "number" ? r.startsAt : typeof r.startsAt === "string" ? Date.parse(r.startsAt) : NaN;
  if (!isFinite(startsAt)) return null;
  const clock = r.clock as { limit?: number; increment?: number } | undefined;
  const variant = r.variant as { key?: string } | string | undefined;
  return {
    platform: "lichess",
    kind: "lichess-arena",
    id: r.id,
    teamId,
    name: typeof r.fullName === "string" ? r.fullName : typeof r.name === "string" ? r.name : "",
    startsAtMs: startsAt,
    nbPlayers: Number(r.nbPlayers) || 0,
    clock: clock && typeof clock.limit === "number" ? { limit: clock.limit, increment: Number(clock.increment) || 0 } : undefined,
    variant: typeof variant === "string" ? variant : variant?.key,
    status: typeof r.status === "number" ? String(r.status) : typeof r.status === "string" ? r.status : undefined,
    minutes: typeof r.minutes === "number" ? r.minutes : undefined,
  };
}

/**
 * Stream a team's swiss (or arena) list newest-first and stop as soon as the
 * rows are older than `oldestNeededMs` — a big club's multi-thousand-tournament
 * history is only read back as far as the target's oldest event. Results are
 * memoized in-process and in localStorage (append-only data: a later run only
 * needs the newest rows until it meets a known id).
 */
export async function loadTeamHistory(
  teamId: string,
  kind: "swiss" | "arena",
  oldestNeededMs: number,
  signal?: AbortSignal,
  onProgress?: (rows: number, reachedMs: number) => void,
  /** Incremental consumer: every few seconds, ALL rows known so far (stream +
   *  prior cache) and the oldest start time the stream has reached — every
   *  tournament newer than `reachedMs` is now known. */
  onRows?: (rows: OrganizerTournament[], reachedMs: number) => void
): Promise<OrganizerTournament[]> {
  const memoKey = `${kind}:${teamId}`;
  const need = oldestNeededMs - 7 * DAY;
  const prior = teamHistoryMemo.get(memoKey) ?? readStored(teamId, kind);
  const fresh = !!prior && Date.now() - prior.fetchedAt < STORAGE_TTL_MS;
  if (prior && fresh && (prior.complete || prior.reachedMs <= need)) {
    teamHistoryMemo.set(memoKey, prior);
    const rows = prior.rows.filter((r) => r.startsAtMs >= need);
    onRows?.(rows, prior.complete ? 0 : prior.reachedMs);
    return rows;
  }
  const known = new Map<string, OrganizerTournament>();
  if (prior) for (const r of prior.rows) known.set(r.id, r);
  // Stop early at a known id ONLY if the prior history already reaches far
  // enough back — otherwise we must stream on past it to extend the history.
  const canStopAtKnown = !!prior && (prior.complete || prior.reachedMs <= need);

  const rows: OrganizerTournament[] = [];
  let reachedMs = Date.now();
  let complete = false;
  try {
    const path = kind === "swiss" ? `swiss` : `arena`;
    const res = await politeFetch(
      `https://lichess.org/api/team/${encodeURIComponent(teamId)}/${path}?max=5000`,
      { headers: { Accept: "application/x-ndjson" }, signal },
      "lichess",
      30_000
    );
    if (!res.ok || !res.body) throw new Error(`team ${path} ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let stop = false;
    let lastProgress = 0;
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let row: OrganizerTournament | null = null;
        try {
          const parsed = JSON.parse(line);
          row = kind === "swiss" ? parseSwissRow(teamId, parsed) : parseArenaRow(teamId, parsed);
        } catch {
          continue;
        }
        if (!row) continue;
        rows.push(row);
        reachedMs = Math.min(reachedMs, row.startsAtMs);
        if (row.startsAtMs < need) {
          stop = true;
          break;
        }
        if (canStopAtKnown && known.has(row.id)) {
          stop = true;
          complete = prior!.complete;
          reachedMs = Math.min(reachedMs, prior!.reachedMs);
          break;
        }
        if (Date.now() - lastProgress > 3000) {
          lastProgress = Date.now();
          onProgress?.(rows.length + (canStopAtKnown ? known.size : 0), reachedMs);
          if (onRows) {
            const soFar = new Map(known);
            for (const r of rows) soFar.set(r.id, r);
            onRows(Array.from(soFar.values()), reachedMs);
          }
        }
      }
      if (signal?.aborted) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* stream already closed */
    }
  } catch {
    if (!rows.length && prior) return prior.rows.filter((r) => r.startsAtMs >= need);
  }
  for (const r of rows) known.set(r.id, r);
  const merged = Array.from(known.values()).sort((a, b) => b.startsAtMs - a.startsAtMs);
  const history: TeamHistory = {
    rows: merged,
    reachedMs: Math.min(reachedMs, prior && (canStopAtKnown || prior.reachedMs < reachedMs) ? prior.reachedMs : reachedMs),
    complete: complete || (!!prior?.complete && canStopAtKnown),
    fetchedAt: Date.now(),
  };
  teamHistoryMemo.set(memoKey, history);
  writeStored(teamId, kind, history);
  return merged.filter((r) => r.startsAtMs >= need);
}

// ---------------------------------------------------------------------------
// Matching a USCF section to one of the organizer's tournaments
// ---------------------------------------------------------------------------

/** Section-defining tokens: grade bands, rating caps, "open". */
function sectionTokens(s: string): Set<string> {
  const out = new Set<string>();
  const t = s.toLowerCase();
  for (const m of t.matchAll(/\bk\s*-?\s*(\d{1,2})\b/g)) out.add(`k-${m[1]}`);
  for (const m of t.matchAll(/\bu\s*-?\s*(\d{3,4})\b/g)) out.add(`u${m[1]}`);
  for (const m of t.matchAll(/\bunder\s*(\d{3,4})\b/g)) out.add(`u${m[1]}`);
  for (const m of t.matchAll(/\b(\d{3,4})\s*\+/g)) out.add(`${m[1]}+`);
  if (/\bopen\b/.test(t)) out.add("open");
  if (/\bchampionship\b/.test(t)) out.add("championship");
  if (/\breserve\b/.test(t)) out.add("reserve");
  if (/\bpremier\b/.test(t) && !/\bscholastic\b/.test(t)) out.add("premier");
  if (/\bmerged\b/.test(t)) out.add("merged");
  return out;
}

/** Descriptive tokens of a tournament/event name with months expanded,
 *  organizer and section tokens stripped. */
function descTokens(s: string, organizerKey: string): Set<string> {
  const out = new Set<string>();
  const cleaned = s
    .toLowerCase()
    .replace(/\b[a-z0-9-]+\.(com|org|net|us|club|io|co)\b/g, " ")
    .replace(/[#:,/()]/g, " ")
    .replace(/\bsept\b\.?/g, "september");
  const orgWords = new Set(organizerKey.toLowerCase().split(/[\s.]+/).filter(Boolean));
  for (let w of cleaned.split(/\s+/)) {
    w = w.replace(/^[^a-z0-9]+|[^a-z0-9+-]+$/g, "");
    if (!w) continue;
    const abbr = MONTH_ABBR[w.replace(/\.$/, "")];
    if (abbr) w = abbr;
    if (orgWords.has(w)) continue;
    if (/^k-?\d+$/.test(w) || /^u\d{3,4}$/.test(w) || w === "open" || w === "merged") continue;
    if (["the", "of", "and", "&", "a", "an", "for", "at", "in", "on", "with", "to", "by"].includes(w)) continue;
    // "#3" / "3" ordinal markers count as tokens ("swiss 3" vs "swiss 4").
    out.add(w);
  }
  return out;
}

/** Days between the tournament start and the event's [start, end] range, with
 *  US time zones in mind (a 6pm Pacific start is the next UTC day). 0 = inside. */
function dayDistance(t: OrganizerTournament, ev: GraphEvent): number | null {
  const start = ev.startDate ? Date.parse(`${ev.startDate}T00:00:00Z`) : NaN;
  const end = ev.endDate ? Date.parse(`${ev.endDate}T00:00:00Z`) : start;
  if (!isFinite(start)) return null;
  const s = start;
  const e = (isFinite(end) ? end : start) + DAY - 1;
  let best = Infinity;
  for (const tzShiftH of [0, -4, -5, -6, -7, -8, -10]) {
    const local = t.startsAtMs + tzShiftH * 3_600_000;
    const d = local < s ? Math.ceil((s - local) / DAY) : local > e ? Math.ceil((local - e) / DAY) : 0;
    best = Math.min(best, d);
  }
  return best;
}

export function scoreTournamentForEvent(ev: GraphEvent, t: OrganizerTournament, organizerKey: string): { score: number; reasons: string[] } | null {
  const reasons: string[] = [];
  if (t.variant && t.variant !== "standard") return null;
  const dd = dayDistance(t, ev);
  if (dd === null || dd > 1) return null;
  let score = dd === 0 ? 0.2 : 0.05;
  reasons.push(dd === 0 ? "same day" : "adjacent day");

  // Rounds (swiss only).
  if (t.nbRounds !== undefined && ev.roundCount) {
    if (t.nbRounds === ev.roundCount) {
      score += 0.15;
      reasons.push(`${t.nbRounds} rounds`);
    } else if (Math.abs(t.nbRounds - ev.roundCount) === 1) {
      score -= 0.1;
    } else return null;
  }

  // Clock.
  const tc = parseEventTc(ev.timeControl);
  if (tc && t.clock) {
    if (gameMatchesTc({ baseSecs: t.clock.limit, incSecs: t.clock.increment }, tc)) {
      score += 0.15;
      reasons.push(`${t.clock.limit / 60}+${t.clock.increment} clock`);
    } else {
      // A 5-second gap on the increment or a base off by a couple of minutes
      // happens (organizer set G/25+5 on USCF, 25+3 online) — penalize, don't
      // reject; but a different time CLASS is a different event.
      const baseOff = Math.abs(t.clock.limit - tc.baseSecs);
      if (baseOff > Math.max(300, tc.baseSecs * 0.5)) return null;
      score -= 0.15;
    }
  }

  // Player count vs crosstable size. Lichess counts every joiner (incl. one
  // who never played); USCF only rates players with a result — allow slack.
  const n = ev.players.length;
  if (t.nbPlayers && n) {
    const diff = Math.abs(t.nbPlayers - n);
    if (diff === 0) {
      score += 0.25;
      reasons.push(`${n} players`);
    } else if (diff <= 1) {
      score += 0.18;
      reasons.push(`${t.nbPlayers} vs ${n} players`);
    } else if (diff <= 3) {
      score += 0.1;
      reasons.push(`${t.nbPlayers} vs ${n} players`);
    } else if (t.nbPlayers > 2.5 * n && t.nbPlayers >= 40) {
      return null; // a public pool, not this section
    } else if (t.nbPlayers < 0.5 * n) {
      score -= 0.3;
    } else {
      score -= 0.1;
    }
  }

  // Name: section tokens (K-5 vs K-12 is decisive on a same-day pair), then
  // descriptive overlap ("premier scholastic", "action swiss 3").
  const evSec = sectionTokens(`${ev.sectionName || ""} ${ev.name}`);
  const tSec = sectionTokens(t.name);
  const evSecOnly = sectionTokens(ev.sectionName || "");
  if (tSec.size && (evSecOnly.size || evSec.size)) {
    const mine = evSecOnly.size ? evSecOnly : evSec;
    const shared = [...mine].filter((x) => tSec.has(x));
    if (shared.length) {
      score += 0.2;
      reasons.push(`section "${shared[0]}"`);
    } else if (tSec.has("merged")) {
      score += 0.05; // a merged online section can host any crosstable section
    } else {
      // Both name a section and they differ — same-day sibling section.
      const hard = [...mine].some((x) => /^k-|^u\d|^open$/.test(x)) && [...tSec].some((x) => /^k-|^u\d|^open$/.test(x));
      if (hard) return null;
      score -= 0.2;
    }
  }
  const a = descTokens(`${ev.name} ${ev.sectionName || ""}`, organizerKey);
  const b = descTokens(t.name, organizerKey);
  if (a.size && b.size) {
    const inter = [...a].filter((x) => b.has(x)).length;
    const jacc = inter / new Set([...a, ...b]).size;
    score += 0.25 * jacc;
    if (inter) reasons.push(`name overlap ${inter}/${new Set([...a, ...b]).size}`);
  }
  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/** Best tournament(s) for one event out of an organizer's history. */
export function matchEventToTournaments(ev: GraphEvent, history: OrganizerTournament[], organizerKey: string): OrganizerMatch[] {
  const scored: { t: OrganizerTournament; score: number; reasons: string[] }[] = [];
  for (const t of history) {
    const s = scoreTournamentForEvent(ev, t, organizerKey);
    if (s) scored.push({ t, ...s });
  }
  if (!scored.length) return [];
  scored.sort((x, y) => y.score - x.score);
  const best = scored[0];
  if (best.score < 0.5) return [];
  const second = scored[1];
  const ambiguous = !!second && best.score - second.score < 0.12 && second.score >= 0.45;
  const out: OrganizerMatch[] = [{ eventId: ev.eventId, tournament: best.t, score: best.score, ambiguous, reasons: best.reasons }];
  if (ambiguous) out.push({ eventId: ev.eventId, tournament: second.t, score: second.score, ambiguous: true, reasons: second.reasons });
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface OrganizerResearchOptions {
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Stop researching (return what we have) past this wall-clock time. */
  deadlineMs?: number;
  /** Fired the moment an event's hosting tournament is pinned — while the
   *  team history is still streaming — so the caller can start aligning that
   *  section immediately instead of waiting for the whole history. Each event
   *  fires at most once. */
  onMatch?: (ev: GraphEvent, matches: OrganizerMatch[]) => void;
}

/**
 * Research every event's organizer on Lichess and match each USCF section to
 * the exact swiss/arena that hosted it. Events whose organizer has no Lichess
 * team (or whose tournaments don't match) simply get no entry — the caller
 * falls through to its other discovery routes for those.
 */
export async function researchOrganizers(events: GraphEvent[], opts: OrganizerResearchOptions = {}): Promise<OrganizerResearch> {
  const { signal, log } = opts;
  const notes: string[] = [];
  const matches = new Map<string, OrganizerMatch[]>();
  const teamsOf = new Map<string, string[]>();
  const { organizerOf, termsOf } = organizerKeysFor(events);
  const outOfTime = () => !!signal?.aborted || (opts.deadlineMs !== undefined && Date.now() > opts.deadlineMs);

  // Group events per organizer key (skip ICC/ChessKid-hinted and unkeyed events).
  const groups = new Map<string, GraphEvent[]>();
  for (const ev of events) {
    const key = organizerOf.get(ev.eventId) || "";
    if (!key) continue;
    const g = (ev.platformGuess || "").toLowerCase();
    if (g === "icc" || g === "chesskid") continue;
    const list = groups.get(key) || [];
    list.push(ev);
    groups.set(key, list);
  }
  if (!groups.size) {
    notes.push("No organizer could be read from the event names.");
    return { matches, organizerOf, teamsOf, notes };
  }

  for (const [key, evs] of groups) {
    if (outOfTime()) break;
    const terms = termsOf.get(key) || [key];
    const teams = await findOrganizerTeams(key, terms, signal);
    teamsOf.set(key, teams.map((t) => t.id));
    if (!teams.length) {
      log?.(`Organizer "${key}" (${evs.length} event${evs.length === 1 ? "" : "s"}): no Lichess team found under that name — will rely on the flyer/web search for its platform.`);
      continue;
    }
    const oldest = Math.min(...evs.map((e) => (e.startDate ? Date.parse(`${e.startDate}T00:00:00Z`) : Date.now())));
    log?.(
      `Organizer "${key}" (${evs.length} event${evs.length === 1 ? "" : "s"}) runs a Lichess team — ${teams
        .map((t) => `"${t.name}" (${t.nbMembers.toLocaleString()} members)`)
        .join(", ")}. Reading its tournament history back to ${new Date(oldest).toISOString().slice(0, 10)}…`
    );
    const history: OrganizerTournament[] = [];
    // Incremental matching: as the (newest-first) stream passes an event's
    // date, every tournament that could host it is already known — match it
    // now and hand it to the caller, so the newest events get aligned while
    // the older history is still downloading.
    const fired = new Set<string>();
    const tryIncremental = (rows: OrganizerTournament[], reachedMs: number) => {
      if (!opts.onMatch) return;
      for (const ev of evs) {
        if (fired.has(ev.eventId) || !ev.startDate) continue;
        const evStart = Date.parse(`${ev.startDate}T00:00:00Z`);
        if (!isFinite(evStart) || evStart - 2 * DAY < reachedMs) continue; // stream hasn't covered this date yet
        const m = matchEventToTournaments(ev, rows, key);
        if (!m.length) continue;
        fired.add(ev.eventId);
        matches.set(ev.eventId, m);
        try {
          opts.onMatch(ev, m);
        } catch {
          /* a consumer bug must not stop the research */
        }
      }
    };
    for (const team of teams) {
      if (outOfTime()) break;
      const [sw, ar] = await Promise.all([
        loadTeamHistory(
          team.id,
          "swiss",
          oldest,
          signal,
          (n, reached) => log?.(`…${n.toLocaleString()} "${team.name}" tournaments read so far (back to ${new Date(reached).toISOString().slice(0, 10)}).`),
          tryIncremental
        ),
        loadTeamHistory(team.id, "arena", oldest, signal),
      ]);
      history.push(...sw, ...ar);
    }
    if (!history.length) {
      log?.(`The "${key}" team history came back empty — falling back to the flyer/web search for its events.`);
      continue;
    }
    let matchedCount = 0;
    for (const ev of evs) {
      if (fired.has(ev.eventId)) {
        matchedCount++;
        continue;
      }
      const m = matchEventToTournaments(ev, history, key);
      if (m.length) {
        matches.set(ev.eventId, m);
        matchedCount++;
        try {
          opts.onMatch?.(ev, m);
        } catch {
          /* ignore consumer errors */
        }
      }
    }
    log?.(
      `Matched ${matchedCount}/${evs.length} of "${key}"'s events to a specific Lichess ${history.some((h) => h.kind === "lichess-swiss") ? "swiss/arena" : "arena"} by date, rounds, clock, player count and name` +
        (matchedCount ? ` — e.g. "${evs.find((e) => matches.has(e.eventId))!.name}" → lichess.org/${matches.get(evs.find((e) => matches.has(e.eventId))!.eventId)![0].tournament.kind === "lichess-swiss" ? "swiss" : "tournament"}/${matches.get(evs.find((e) => matches.has(e.eventId))!.eventId)![0].tournament.id}.` : ".")
    );
    notes.push(`${key}: ${matchedCount}/${evs.length} events matched on Lichess (${history.length} tournaments scanned).`);
  }
  return { matches, organizerOf, teamsOf, notes };
}

/** Platform-guess hygiene: the edge's regex tags anything containing
 *  "chess.com" — including organizer DOMAINS like "DMVCHESS.COM" — as a
 *  Chess.com event. Only a standalone "chess.com" (not glued to other letters)
 *  is a platform hint; everything else is unknown until researched. */
export function sanitizePlatformGuess(ev: GraphEvent): void {
  const g = (ev.platformGuess || "").toLowerCase();
  if (g !== "chesscom") return;
  const text = `${ev.name || ""} ${ev.sectionName || ""}`.replace(/_/g, " ");
  if (!/(^|[^a-z0-9])chess\.?com(?![a-z0-9])/i.test(text)) ev.platformGuess = undefined;
}
