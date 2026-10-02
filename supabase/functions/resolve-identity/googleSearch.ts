// ============================================================================
// Web discovery: username leads + event/flyer location.
//
// ARCHITECTURE (rewritten): retrieval and reasoning are now separate jobs.
//
//   cache  ->  SearXNG (unmetered)  ->  Gemini (tool-free)  ->  [gated grounding]
//
// Previously this file asked a model to search the web for us (Gemini
// google_search grounding / Anthropic web_search). That stopped working: the
// grounding quota was exhausted, and on the free tier Gemini 3.x does not offer
// grounding at all, so every discovery call that needed the open web failed.
// Retrieval now goes through a self-hosted SearXNG instance — no API key, no
// per-query cost — and the model only ever reasons over what SearXNG returned,
// with no search tool attached. See _shared/search/pipeline.ts.
//
// The GOOGLE PROGRAMMABLE SEARCH path is retained but DISABLED BY DEFAULT
// behind SEARCH_ENABLE_CSE=1. Google announced in January 2026 that the Custom
// Search JSON API will be discontinued on 2027-01-01, and it has been closed to
// new customers since 2025 — so it is a dead end even where a key still works.
//
// Finding a person's Lichess/Chess.com username from their real name must NOT
// go through the platforms' own name search (autocomplete / handle guessing):
// that finds the wrong homonym far too easily. Both platforms let public
// profile pages be indexed, and blogs/club pages/tournament flyers often
// mention a real name next to a handle — so the trusted route is a search
// index, queried with an escalating ladder of site-restricted searches.
//
// Candidates returned here are LEADS, not identifications: the traversal
// engine must verify each against the platform APIs (account exists, games in
// the tournament's date window, rating/country sanity, FIDE-ID gate) before
// trusting it. Runtime-agnostic: works in Deno (edge) and Node (CLI harness).
// ============================================================================

import { readEnv } from "../_shared/ai.ts";
import {
  retrieve,
  reasonOverHits,
  expandQueries,
  emergencyGroundedSearch,
  parseJsonLoose,
} from "../_shared/search/pipeline.ts";
import { searxngConfigured, type SearchHit } from "../_shared/search/searxng.ts";

export type WebPlatform = "chesscom" | "lichess";

export interface UsernameSearchRequest {
  /** The player's real name ("First Last"). */
  name: string;
  /** 2-letter US state code, when known. */
  state?: string;
  city?: string;
  clubOrSchool?: string;
  uscfRating?: number;
  fideId?: string;
  /** USCF event context — sharpens queries and helps the model disambiguate. */
  eventName?: string;
  eventDate?: string;
  /** Restrict to these platforms (default: both). */
  platforms?: WebPlatform[];
  /** Handles this person is already known to use elsewhere (username reuse). */
  knownUsernames?: string[];
}

export interface UsernameCandidate {
  platform: WebPlatform;
  username: string;
  /** The indexed page that ties the name to the handle, when known. */
  sourceUrl?: string;
  /** Short human-readable why. */
  note?: string;
}

export interface UsernameSearchResult {
  candidates: UsernameCandidate[];
  /**
   * Which backend answered. "searxng" is the normal path; "cache" is a repeat;
   * "grounded-emergency" means the ledger-gated last resort actually ran.
   */
  backend: "searxng" | "cache" | "google-cse" | "grounded-emergency" | "none";
  queriesTried: number;
  note?: string;
  /**
   * True when discovery returned nothing because a quota/budget was spent
   * rather than because the index had no match. Callers must treat this
   * differently from a clean empty result.
   */
  quotaExhausted?: boolean;
  /** True when SearXNG is simply not configured — an operator problem. */
  retrievalUnavailable?: boolean;
}

// ---------------------------------------------------------------------------
// Query ladder
// ---------------------------------------------------------------------------

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "Washington DC",
};

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").replace(/[",]/g, "").trim();
}

/**
 * The escalating ladder of queries for one person, most precise first. This is
 * hand-tuned domain knowledge and it is BETTER than asking a model to invent
 * queries for this particular job — so username discovery feeds the ladder to
 * SearXNG as seed queries and skips the model-expansion step entirely, which
 * also removes one Gemini call per request.
 */
export function buildQueryLadder(req: UsernameSearchRequest): string[] {
  const name = cleanName(req.name);
  if (!name) return [];
  const tokens = name.split(" ").filter(Boolean);
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : "";
  const platforms = req.platforms?.length ? req.platforms : (["lichess", "chesscom"] as WebPlatform[]);
  const wantLichess = platforms.includes("lichess");
  const wantChesscom = platforms.includes("chesscom");
  const stateName = req.state ? STATE_NAMES[req.state.toUpperCase()] : undefined;
  const place = req.city || stateName || req.state;

  const q: string[] = [];
  const push = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t && !q.includes(t)) q.push(t);
  };

  // 1. Site-restricted exact-phrase — by far the highest hit rate.
  if (wantLichess) push(`site:lichess.org "${name}"`);
  if (wantChesscom) push(`site:chess.com "${name}"`);
  // 2. Broad (other sites mentioning name + platform) and unquoted.
  if (wantLichess) push(`"${name}" lichess`);
  if (wantChesscom) push(`"${name}" chess.com`);
  if (wantLichess) push(`site:lichess.org ${name}`);
  if (wantChesscom) push(`site:chess.com ${name}`);
  // 3. Identifying context: place, federation, club/school, event.
  if (place) {
    if (wantLichess) push(`site:lichess.org "${name}" ${place}`);
    if (wantChesscom) push(`site:chess.com "${name}" ${place}`);
  }
  if (wantLichess) push(`"${name}" USCF lichess`);
  if (wantChesscom) push(`site:chess.com "${name}" USCF`);
  if (req.clubOrSchool) {
    if (wantLichess) push(`site:lichess.org "${name}" ${req.clubOrSchool}`);
    if (wantChesscom) push(`site:chess.com "${name}" ${req.clubOrSchool}`);
  }
  if (req.eventName) push(`"${name}" "${req.eventName}"`);
  if (wantLichess) push(`site:lichess.org "${name}" tournament`);
  if (wantChesscom) push(`site:chess.com "${name}" arena`);
  // 4. Profile-URL cross-mentions (blogs/forums pairing name and handle).
  if (wantChesscom) push(`"${name}" "chess.com/member"`);
  if (wantLichess) push(`"${name}" "lichess.org/@"`);
  push(`"${name}" chess profile`);
  // 5. Partial names (profiles listing initials / first name only).
  if (last && last.length >= 4 && place) {
    if (wantLichess) push(`site:lichess.org ${last} ${place}`);
    if (wantChesscom) push(`site:chess.com ${last} ${place}`);
  }
  if (tokens.length === 2) {
    // Wildcard for a possible middle name/initial.
    if (wantLichess) push(`"${tokens[0]} * ${tokens[1]}" lichess`);
  }
  // 6. Username reuse from other platforms / sites.
  for (const known of (req.knownUsernames || []).slice(0, 3)) {
    if (wantLichess) push(`"${known}" lichess`);
    if (wantChesscom) push(`"${known}" chess.com`);
  }
  return q;
}

// ---------------------------------------------------------------------------
// Candidate extraction — profile URLs and @handle mentions in indexed text
// ---------------------------------------------------------------------------

const LICHESS_PROFILE_RE = /lichess\.org\/@\/([A-Za-z0-9_-]{2,29})/gi;
const CHESSCOM_PROFILE_RE = /chess\.com\/(?:member|members|player|players|stats\/live[a-z/]*)\/([A-Za-z0-9_-]{2,29})/gi;

/** Path segments that regex-match a profile URL but are never usernames — plus
 *  chess titles, which a model sometimes emits as a bare "username"
 *  (observed: {"username":"GM A-Liang"} and {"username":"GM"}). */
const NOT_USERNAMES = new Set([
  "chess", "chesscom", "lichess", "member", "members", "player", "players",
  "login", "signup", "register", "settings", "search", "stats", "live",
  "gm", "im", "fm", "cm", "nm", "wgm", "wim", "wfm", "wcm",
]);

function pushCandidate(out: UsernameCandidate[], seen: Set<string>, c: UsernameCandidate) {
  const uname = c.username.trim().replace(/^@+/, "");
  if (uname.length < 2 || uname.length > 29) return;
  // Real Lichess/Chess.com handles are [A-Za-z0-9_-] only. A model
  // occasionally returns a display-name string ("GM A-Liang") as the username —
  // a space (or any other char) means it isn't a handle, so drop it before it
  // wastes a verification round-trip.
  if (!/^[A-Za-z0-9_-]+$/.test(uname)) return;
  if (NOT_USERNAMES.has(uname.toLowerCase())) return;
  const key = `${c.platform}:${uname.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ ...c, username: uname });
}

/** Pull every platform-profile handle referenced anywhere in a blob of text. */
export function extractCandidatesFromText(text: string, note?: string): UsernameCandidate[] {
  const out: UsernameCandidate[] = [];
  const seen = new Set<string>();
  for (const [re, platform] of [
    [LICHESS_PROFILE_RE, "lichess"],
    [CHESSCOM_PROFILE_RE, "chesscom"],
  ] as const) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) && out.length < 40) {
      pushCandidate(out, seen, { platform, username: m[1], note });
    }
  }
  return out;
}

/** Harvest handles straight out of the retrieved hits, with no model involved.
 *  A profile URL in a result IS the evidence, so this costs nothing and cannot
 *  hallucinate. The model pass then adds the cases where the handle is only in
 *  prose ("... playing as @foo ..."). */
function candidatesFromHits(hits: SearchHit[]): UsernameCandidate[] {
  const out: UsernameCandidate[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const blob = `${h.url}\n${h.title}\n${h.content}`;
    for (const c of extractCandidatesFromText(blob, `search: ${h.engine || "web"}`)) {
      pushCandidate(out, seen, { ...c, sourceUrl: h.url });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google Programmable Search — retained, DISABLED BY DEFAULT
//
// Google announced (January 2026) that the Custom Search JSON API will be
// discontinued on 2027-01-01, and it has been closed to new customers since
// 2025. Enable with SEARCH_ENABLE_CSE=1 only if an existing key must be used
// up; SearXNG is the supported path.
// ---------------------------------------------------------------------------

function cseEnabled(): boolean {
  return readEnv("SEARCH_ENABLE_CSE") === "1";
}

async function searchViaCse(
  queries: string[],
  key: string,
  cx: string,
  log?: (m: string) => void
): Promise<{ candidates: UsernameCandidate[]; queriesTried: number; quotaHit: boolean }> {
  const out: UsernameCandidate[] = [];
  const seen = new Set<string>();
  let tried = 0;
  for (const q of queries.slice(0, 10)) {
    tried++;
    try {
      const url =
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}` +
        `&cx=${encodeURIComponent(cx)}&num=10&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.status === 429 || res.status === 403) {
        log?.("Google CSE quota hit.");
        return { candidates: out, queriesTried: tried, quotaHit: true };
      }
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (Array.isArray(data.items) ? data.items : []) as Array<Record<string, string>>) {
        const blob = `${item.link || ""}\n${item.title || ""}\n${item.snippet || ""}`;
        for (const c of extractCandidatesFromText(blob, `Google CSE: ${q}`)) {
          pushCandidate(out, seen, { ...c, sourceUrl: item.link || c.sourceUrl });
        }
      }
      if (out.length >= 30) break;
    } catch {
      /* one failed query never fails the ladder */
    }
  }
  return { candidates: out, queriesTried: tried, quotaHit: false };
}

// ---------------------------------------------------------------------------
// Public entry — username discovery
// ---------------------------------------------------------------------------

interface AiCandidateRow {
  platform?: unknown;
  username?: unknown;
  url?: unknown;
  why?: unknown;
}

const USERNAME_SCHEMA = `{"candidates":[{"platform":"lichess"|"chesscom","username":"handle","url":"the result URL that ties name to handle","result_index":0,"why":"one short sentence"}],"note":"one short sentence"}`;

// Memoized per person+context for the life of the (warm) process: the
// traversal asks about the same member from several events and the resolver's
// own fallback repeats the traversal's query. Failure/quota results are NOT
// memoized, so a later call can retry.
const usernameSearchMemo = new Map<string, Promise<UsernameSearchResult>>();

export function findUsernamesOnWeb(
  req: UsernameSearchRequest,
  log?: (m: string) => void
): Promise<UsernameSearchResult> {
  const key = JSON.stringify([
    (req.name || "").toLowerCase(),
    req.state,
    req.uscfRating,
    req.fideId,
    req.eventName,
    [...(req.platforms || [])].sort(),
  ]);
  const hit = usernameSearchMemo.get(key);
  if (hit) return hit;
  const p = findUsernamesOnWebUncached(req, log);
  usernameSearchMemo.set(key, p);
  void p.then(
    (r) => {
      // Only a completed search (hits, or a clean whole-ladder miss) is a
      // stable answer worth remembering.
      if (!r.candidates.length && (r.quotaExhausted || r.retrievalUnavailable)) usernameSearchMemo.delete(key);
    },
    () => usernameSearchMemo.delete(key)
  );
  return p;
}

async function findUsernamesOnWebUncached(
  req: UsernameSearchRequest,
  log?: (m: string) => void
): Promise<UsernameSearchResult> {
  const queries = buildQueryLadder(req);
  if (!queries.length) return { candidates: [], backend: "none", queriesTried: 0 };

  const name = cleanName(req.name);
  const context = {
    "Real name": name,
    "US state": req.state && (STATE_NAMES[req.state.toUpperCase()] || req.state),
    City: req.city,
    "Club/School": req.clubOrSchool,
    "USCF rating (approx)": req.uscfRating,
    "FIDE ID": req.fideId,
    "Played USCF online event": req.eventName,
    "Event date": req.eventDate,
    "Known usernames elsewhere": req.knownUsernames?.length ? req.knownUsernames.join(", ") : undefined,
  };

  // --- cache + SearXNG retrieval (the ladder is the seed; no expansion call)
  const got = await retrieve({
    intent: `Find the Lichess and/or Chess.com username of the chess player ${name}`,
    context,
    seedQueries: queries.slice(0, 8),
    // An identity resolution is permanent: a USCF member mapped to a handle
    // does not change, so this is cached forever rather than for 30 days.
    cacheKind: "identity",
    maxResults: 25,
    log,
  });

  if (!got.hits.length) {
    // Optional CSE sweep, only if an operator deliberately enabled it.
    const cseKey = readEnv("GOOGLE_CSE_KEY") || readEnv("GOOGLE_SEARCH_KEY");
    const cseCx = readEnv("GOOGLE_CSE_ID") || readEnv("GOOGLE_SEARCH_CX");
    if (cseEnabled() && cseKey && cseCx) {
      const cse = await searchViaCse(queries, cseKey, cseCx, log);
      if (cse.candidates.length) {
        return {
          candidates: rankForPlatforms(cse.candidates, req.platforms),
          backend: "google-cse",
          queriesTried: cse.queriesTried,
        };
      }
    }
    if (!searxngConfigured()) {
      return {
        candidates: [],
        backend: "none",
        queriesTried: 0,
        retrievalUnavailable: true,
        note: "SearXNG is not configured (set SEARXNG_URL/SEARXNG_LOCAL_URL + SEARXNG_TOKEN)",
      };
    }
    // --- step 5: emergency grounding, ledger-gated. Returns null when the
    // budget is spent, which is an honest "could not search", not "no match".
    const emergency = await emergencyGroundedSearch(
      "You find chess players' online usernames strictly from what web pages say. You never guess handles from a name. You output strict JSON only.",
      `Find the Lichess and/or Chess.com username(s) of this player.\n\n${Object.entries(context)
        .filter(([, v]) => v !== undefined && v !== null && `${v}` !== "")
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")}\n\nReturn STRICT JSON only:\n${USERNAME_SCHEMA}`,
      1600,
      log
    );
    if (!emergency) {
      return {
        candidates: [],
        backend: "none",
        queriesTried: got.queries.length,
        quotaExhausted: true,
        note: "retrieval found nothing and the grounding budget is spent",
      };
    }
    const cands = collectFromModelText(emergency.text);
    return {
      candidates: rankForPlatforms(cands, req.platforms),
      backend: "grounded-emergency",
      queriesTried: got.queries.length,
    };
  }

  // --- free, non-hallucinable pass: handles visible in the results themselves
  const direct = candidatesFromHits(got.hits);

  // --- step 3: model extraction for handles that only appear in prose
  const reasoned = await reasonOverHits<{ candidates?: AiCandidateRow[]; note?: string }>(
    `Identify every distinct Lichess or Chess.com username that the search results below tie to this specific person. Collect ALL of them — main account, older accounts, and same-name candidates that might be namesakes; verification happens downstream, so a COMPLETE list (up to 12) matters more than a single answer. A username that merely LOOKS like the name (e.g. johnsmith) is worthless unless a result connects it to them; real players rarely use their real name as a handle.`,
    USERNAME_SCHEMA,
    got.hits,
    { maxTokens: 1600, context, log }
  );

  const merged: UsernameCandidate[] = [];
  const seen = new Set<string>();
  for (const c of direct) pushCandidate(merged, seen, c);
  if (reasoned.data?.candidates && Array.isArray(reasoned.data.candidates)) {
    for (const row of reasoned.data.candidates) {
      const p = typeof row.platform === "string" ? row.platform.toLowerCase().replace(/[^a-z]/g, "") : "";
      const platform: WebPlatform | null = p.includes("lichess") ? "lichess" : p.includes("chess") ? "chesscom" : null;
      const username = typeof row.username === "string" ? row.username.trim() : "";
      if (!platform || !username) continue;
      pushCandidate(merged, seen, {
        platform,
        username,
        sourceUrl: typeof row.url === "string" ? row.url : undefined,
        note: typeof row.why === "string" ? `search: ${row.why.slice(0, 160)}` : "search result (model-extracted)",
      });
    }
  }
  // Regex-scan the raw answer too — replies often cite URLs outside the JSON.
  if (reasoned.raw) for (const c of extractCandidatesFromText(reasoned.raw, "cited URL")) pushCandidate(merged, seen, c);

  return {
    candidates: rankForPlatforms(merged, req.platforms),
    backend: got.fromCache ? "cache" : "searxng",
    queriesTried: got.queries.length,
    note: typeof reasoned.data?.note === "string" ? reasoned.data.note.slice(0, 300) : undefined,
  };
}

function collectFromModelText(text: string): UsernameCandidate[] {
  const out: UsernameCandidate[] = [];
  const seen = new Set<string>();
  const parsed = parseJsonLoose<{ candidates?: AiCandidateRow[] }>(text);
  for (const row of parsed?.candidates || []) {
    const p = typeof row.platform === "string" ? row.platform.toLowerCase().replace(/[^a-z]/g, "") : "";
    const platform: WebPlatform | null = p.includes("lichess") ? "lichess" : p.includes("chess") ? "chesscom" : null;
    const username = typeof row.username === "string" ? row.username.trim() : "";
    if (!platform || !username) continue;
    pushCandidate(out, seen, {
      platform,
      username,
      sourceUrl: typeof row.url === "string" ? row.url : undefined,
      note: "grounded emergency search",
    });
  }
  for (const c of extractCandidatesFromText(text, "grounded emergency (cited URL)")) pushCandidate(out, seen, c);
  return out;
}

/** Requested-platform candidates first, preserving discovery order. */
function rankForPlatforms(cands: UsernameCandidate[], platforms?: WebPlatform[]): UsernameCandidate[] {
  if (!platforms?.length || platforms.length >= 2) return cands.slice(0, 40);
  const want = new Set(platforms);
  return [...cands.filter((c) => want.has(c.platform)), ...cands.filter((c) => !want.has(c.platform))].slice(0, 40);
}

// ---------------------------------------------------------------------------
// Public entry — event/flyer discovery: which platform hosted a USCF online
// event, ideally with the exact tournament page.
// ---------------------------------------------------------------------------

export interface DiscoverEventRequest {
  /** USCF event id — the persistent event_platform_cache key (see index.ts).
   *  The discovery logic itself ignores it; it only threads through for caching. */
  eventId?: string;
  name?: string;
  sectionName?: string;
  startDate?: string;
  endDate?: string;
  ratingSystem?: string;
  timeControl?: string;
}

export interface DiscoveredEventInfo {
  platform?: "chesscom" | "lichess" | "chesskid" | "icc";
  chesscomSlugs: string[];
  lichessSwissIds: string[];
  lichessArenaIds: string[];
  confidence?: number;
  note?: string;
}

const CHESSCOM_TOURNAMENT_RE = /(?:api\.)?chess\.com\/(?:pub\/tournament|(?:play\/)?tournament(?:\/live)?)\/([a-z0-9][a-z0-9-]{2,120})/gi;
const LICHESS_SWISS_RE = /lichess\.org\/(?:api\/)?swiss\/([a-zA-Z0-9]{8})/g;
const LICHESS_ARENA_RE = /lichess\.org\/(?:api\/)?tournament\/([a-zA-Z0-9]{8})/g;

function collectMatches(re: RegExp, text: string): string[] {
  const out = new Set<string>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.size < 5) out.add(m[1]);
  return Array.from(out);
}

// Memoized per event for the life of the (warm) process: the answer to "where
// was this 2020 tournament hosted" never changes. Failures are not memoized.
const discoverEventMemo = new Map<string, Promise<DiscoveredEventInfo | null>>();

export function discoverEventOnWeb(ev: DiscoverEventRequest): Promise<DiscoveredEventInfo | null> {
  const key = JSON.stringify([ev.name, ev.sectionName, ev.startDate, ev.ratingSystem]);
  const hit = discoverEventMemo.get(key);
  if (hit) return hit;
  const p = discoverEventOnWebUncached(ev);
  discoverEventMemo.set(key, p);
  void p.then(
    (r) => {
      if (r === null) discoverEventMemo.delete(key); // retryable
    },
    () => discoverEventMemo.delete(key)
  );
  return p;
}

const EVENT_SCHEMA = `{"platform":"chesscom"|"lichess"|"chesskid"|"icc"|"unknown","urls":["tournament/flyer URLs found in the results"],"result_index":0,"confidence":0.0,"note":"one short sentence"}`;

async function discoverEventOnWebUncached(ev: DiscoverEventRequest): Promise<DiscoveredEventInfo | null> {
  const name = (ev.name || "").trim();
  if (!name) return null;

  const context = {
    Name: name,
    Section: ev.sectionName,
    Dates: ev.startDate
      ? `${ev.startDate}${ev.endDate && ev.endDate !== ev.startDate ? ` to ${ev.endDate}` : ""}`
      : undefined,
    "US Chess rating system": ev.ratingSystem ? `${ev.ratingSystem} (online-rated)` : undefined,
    "Time control": ev.timeControl,
  };

  // Here the model DOES write the queries: unlike username discovery there is
  // no hand-tuned ladder for "where was this event hosted", and organiser/club
  // names buried in an event title make good search terms that are hard to
  // template.
  const intent = `Find which platform hosted the US Chess (USCF) rated ONLINE tournament "${name}" — chess.com, lichess, chesskid or ICC — and the exact tournament page if possible. USCF online events (mostly 2020-2021) usually say "played on Chess.com" or "hosted on lichess.org" in a flyer, TLA or results page.`;

  const got = await retrieve({ intent, context, cacheKind: "web", maxResults: 20 });
  if (!got.hits.length) return null;

  const reasoned = await reasonOverHits<{
    platform?: unknown;
    urls?: unknown;
    confidence?: unknown;
    note?: unknown;
  }>(
    `Determine which platform hosted this tournament and extract any tournament or flyer URLs.`,
    EVENT_SCHEMA,
    got.hits,
    { maxTokens: 900, context }
  );

  // Regex-scan BOTH the model's answer and the raw hits — a tournament link is
  // self-evidencing, so it counts whether or not the model reported it.
  let urlText = reasoned.raw || "";
  for (const h of got.hits) urlText += `\n${h.url}\n${h.content}`;
  if (Array.isArray(reasoned.data?.urls)) {
    urlText += "\n" + (reasoned.data!.urls as unknown[]).filter((u) => typeof u === "string").join("\n");
  }

  let platform: DiscoveredEventInfo["platform"];
  const praw = typeof reasoned.data?.platform === "string" ? reasoned.data.platform.toLowerCase().replace(/[^a-z]/g, "") : "";
  if (["chesscom", "lichess", "chesskid", "icc"].includes(praw)) {
    platform = praw as DiscoveredEventInfo["platform"];
  }
  const confidence = typeof reasoned.data?.confidence === "number"
    ? Math.max(0, Math.min(1, reasoned.data.confidence))
    : undefined;
  const note = typeof reasoned.data?.note === "string" ? reasoned.data.note.slice(0, 300) : undefined;

  const chesscomSlugs = collectMatches(CHESSCOM_TOURNAMENT_RE, urlText);
  const lichessSwissIds = collectMatches(LICHESS_SWISS_RE, urlText);
  const lichessArenaIds = collectMatches(LICHESS_ARENA_RE, urlText);
  if (!platform) {
    if (chesscomSlugs.length && !lichessSwissIds.length && !lichessArenaIds.length) platform = "chesscom";
    else if (!chesscomSlugs.length && (lichessSwissIds.length || lichessArenaIds.length)) platform = "lichess";
  }

  if (!platform && !chesscomSlugs.length && !lichessSwissIds.length && !lichessArenaIds.length) return null;
  return { platform, chesscomSlugs, lichessSwissIds, lichessArenaIds, confidence, note };
}

/** Re-exported so callers that only need query expansion don't reach past this
 *  module into the pipeline internals. */
export { expandQueries };
