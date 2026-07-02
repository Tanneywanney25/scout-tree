// ============================================================================
// Google-index username discovery + event/flyer web discovery.
//
// Finding a person's Lichess/Chess.com username from their real name must NOT
// go through the platforms' own name search (autocomplete / handle guessing):
// that finds the wrong homonym far too easily. Both platforms let public
// profile pages be indexed by Google, and blogs/club pages/tournament flyers
// often mention a real name next to a handle — so the trusted route is the
// GOOGLE INDEX, queried with an escalating ladder of site-restricted searches:
//
//   1. site:lichess.org "John Smith"        (exact, site-restricted)
//   2. site:chess.com "John Smith"
//   3. unquoted + broad ("John Smith" lichess / chess.com)
//   4. + identifying context (state, USCF, club/school, event name)
//   5. profile-URL and cross-mention searches ("John Smith" "chess.com/member")
//   6. partial names / username-reuse ("knownhandle" lichess)
//
// Two interchangeable backends:
//   • Google Programmable Search JSON API (GOOGLE_CSE_KEY + GOOGLE_CSE_ID) —
//     the literal Google index, queried directly, in parallel with pacing.
//   • AI with live web search (Gemini google_search grounding / Anthropic
//     web_search via _shared/ai.ts) — the model runs the same ladder and
//     reports what the index shows. Used when no CSE key is configured.
//
// Candidates returned here are LEADS, not identifications: the traversal
// engine must verify each against the platform APIs (account exists, games in
// the tournament's date window, rating/country sanity, FIDE-ID gate) before
// trusting it. Runtime-agnostic: works in Deno (edge) and Node (CLI harness).
// ============================================================================

import { callAIWithSearch, readEnv } from "../_shared/ai.ts";

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
  /** Short human-readable why ("Google: site:lichess.org \"John Smith\""). */
  note?: string;
}

export interface UsernameSearchResult {
  candidates: UsernameCandidate[];
  backend: "google-cse" | "ai-search" | "none";
  queriesTried: number;
  note?: string;
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
 * The escalating ladder of Google queries for one person, in the order they
 * should be tried (most precise first). Mirrors the practical search order:
 * exact site-restricted → broad → +context → profile-URL forms → partial names
 * → username reuse.
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

/** Path segments that regex-match a profile URL but are never usernames. */
const NOT_USERNAMES = new Set([
  "chess", "chesscom", "lichess", "member", "members", "player", "players",
  "login", "signup", "register", "settings", "search", "stats", "live",
]);

function pushCandidate(out: UsernameCandidate[], seen: Set<string>, c: UsernameCandidate) {
  const uname = c.username.trim().replace(/^@+/, "");
  if (uname.length < 2 || uname.length > 29) return;
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

// ---------------------------------------------------------------------------
// Backend 1: Google Programmable Search JSON API (the literal index)
// ---------------------------------------------------------------------------

interface CseItem {
  link?: string;
  title?: string;
  snippet?: string;
}

// When Google answers 429/403 (quota), stop hitting CSE for a while and let
// the AI-search backend carry the load instead.
let cseCooldownUntil = 0;

async function cseQuery(query: string, key: string, cx: string): Promise<CseItem[] | "quota"> {
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}` +
    `&cx=${encodeURIComponent(cx)}&num=10&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (res.status === 429 || res.status === 403) return "quota";
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.items) ? (data.items as CseItem[]) : [];
  } catch {
    return [];
  }
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
  let quotaHit = false;

  // Parallel workers over the ladder, gently paced so Google doesn't block us.
  const CONCURRENCY = 3;
  const PACE_MS = 250;
  let idx = 0;
  let lastStart = 0;
  const enough = () => out.length >= 14;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queries.length) }, async () => {
      while (idx < queries.length && !enough() && !quotaHit) {
        const q = queries[idx++];
        const wait = Math.max(0, lastStart + PACE_MS - Date.now());
        lastStart = Math.max(Date.now(), lastStart + PACE_MS);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        tried++;
        const items = await cseQuery(q, key, cx);
        if (items === "quota") {
          quotaHit = true;
          cseCooldownUntil = Date.now() + 10 * 60_000;
          log?.(`Google CSE quota hit — cooling down and switching to AI web search.`);
          return;
        }
        for (const item of items) {
          const blob = `${item.link || ""}\n${item.title || ""}\n${item.snippet || ""}`;
          for (const c of extractCandidatesFromText(blob, `Google: ${q}`)) {
            pushCandidate(out, seen, { ...c, sourceUrl: item.link || c.sourceUrl });
          }
        }
      }
    })
  );
  return { candidates: out, queriesTried: tried, quotaHit };
}

// ---------------------------------------------------------------------------
// Backend 2: AI with live web search (Gemini grounding / Anthropic web_search)
// ---------------------------------------------------------------------------

function buildAiSearchPrompt(req: UsernameSearchRequest, queries: string[]): string {
  const ctx: string[] = [`Real name: ${cleanName(req.name)}`];
  const add = (label: string, v?: string | number) => {
    if (v !== undefined && v !== null && `${v}`.trim?.() !== "") ctx.push(`${label}: ${v}`);
  };
  add("US state", req.state && (STATE_NAMES[req.state.toUpperCase()] || req.state));
  add("City", req.city);
  add("Club/School", req.clubOrSchool);
  add("USCF rating (approx)", req.uscfRating);
  add("FIDE ID", req.fideId);
  add("Played USCF online event", req.eventName);
  add("Event date", req.eventDate);
  if (req.knownUsernames?.length) add("Known usernames elsewhere", req.knownUsernames.join(", "));

  return `Find the Lichess and/or Chess.com USERNAME(S) of a specific chess player using Google-indexed pages. Their profile pages (lichess.org/@/<username>, chess.com/member/<username>) are often indexed, and club pages / tournament flyers / forum posts often mention the real name next to the handle.

PLAYER:
${ctx.join("\n")}

Run web searches following this exact ladder, starting from the top, until you find profile URLs or name↔username pairings (you do not need to run all of them — stop escalating once you have solid candidates, but DO try both platforms):
${queries.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Rules:
- Only report usernames that an indexed page actually ties to this person (their name on the profile, or a page mentioning both the name and the handle). Do NOT invent or guess handles from the name.
- Prefer exact profile URLs. Include the URL of the page that made the connection.
- Rating sanity: their online rating should be roughly compatible with the USCF rating above (online is often a few hundred points lower). Note mismatches but still report the candidate.
- If several distinct people share the name, report each candidate — verification happens downstream.

Return STRICT JSON only (no prose, no markdown fences):
{"candidates":[{"platform":"lichess"|"chesscom","username":"handle","url":"page that ties name to handle","why":"one short sentence"}],"note":"one short sentence on overall findings"}`;
}

interface AiCandidateRow {
  platform?: unknown;
  username?: unknown;
  url?: unknown;
  why?: unknown;
}

async function searchViaAi(
  req: UsernameSearchRequest,
  queries: string[],
  log?: (m: string) => void
): Promise<{ candidates: UsernameCandidate[]; note?: string; ok: boolean }> {
  const ai = await callAIWithSearch(
    "You are a research assistant who finds chess players' online usernames strictly from what Google-indexed web pages say. You never guess handles from a name. You output strict JSON only.",
    buildAiSearchPrompt(req, queries),
    1600,
    { maxSearchUses: 8 }
  );
  if (!ai.ok) {
    log?.(`AI web search unavailable (${ai.status}): ${ai.error || "no detail"}`);
    return { candidates: [], ok: false };
  }

  const out: UsernameCandidate[] = [];
  const seen = new Set<string>();
  let note: string | undefined;

  try {
    const s = ai.text.replace(/```(?:json)?/gi, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(s.slice(start, end + 1));
      if (typeof parsed.note === "string") note = parsed.note.slice(0, 300);
      if (Array.isArray(parsed.candidates)) {
        for (const row of parsed.candidates as AiCandidateRow[]) {
          const p = typeof row.platform === "string" ? row.platform.toLowerCase().replace(/[^a-z]/g, "") : "";
          const platform: WebPlatform | null = p.includes("lichess") ? "lichess" : p.includes("chess") ? "chesscom" : null;
          const username = typeof row.username === "string" ? row.username.trim() : "";
          if (!platform || !username) continue;
          pushCandidate(out, seen, {
            platform,
            username,
            sourceUrl: typeof row.url === "string" ? row.url : undefined,
            note: typeof row.why === "string" ? `Google: ${row.why.slice(0, 160)}` : "Google index (AI web search)",
          });
        }
      }
    }
  } catch {
    /* fall through to regex extraction */
  }
  // Regex-scan the whole answer too — grounded replies often cite profile URLs
  // outside the JSON.
  for (const c of extractCandidatesFromText(ai.text, "Google index (cited URL)")) pushCandidate(out, seen, c);
  return { candidates: out, note, ok: true };
}

// ---------------------------------------------------------------------------
// Public entry — the ladder, CSE first, AI fallback
// ---------------------------------------------------------------------------

export async function findUsernamesOnWeb(
  req: UsernameSearchRequest,
  log?: (m: string) => void
): Promise<UsernameSearchResult> {
  const queries = buildQueryLadder(req);
  if (!queries.length) return { candidates: [], backend: "none", queriesTried: 0 };

  const cseKey = readEnv("GOOGLE_CSE_KEY") || readEnv("GOOGLE_SEARCH_KEY");
  const cseCx = readEnv("GOOGLE_CSE_ID") || readEnv("GOOGLE_SEARCH_CX");

  if (cseKey && cseCx && Date.now() > cseCooldownUntil) {
    const cse = await searchViaCse(queries, cseKey, cseCx, log);
    if (cse.candidates.length) {
      return { candidates: rankForPlatforms(cse.candidates, req.platforms), backend: "google-cse", queriesTried: cse.queriesTried };
    }
    // Zero hits (or quota): escalate to AI search, which reads pages rather
    // than just result snippets and can follow context.
  }

  const ai = await searchViaAi(req, queries, log);
  return {
    candidates: rankForPlatforms(ai.candidates, req.platforms),
    backend: ai.ok ? "ai-search" : "none",
    queriesTried: queries.length,
    note: ai.note,
  };
}

/** Requested-platform candidates first, preserving discovery order. */
function rankForPlatforms(cands: UsernameCandidate[], platforms?: WebPlatform[]): UsernameCandidate[] {
  if (!platforms?.length || platforms.length >= 2) return cands.slice(0, 24);
  const want = new Set(platforms);
  return [...cands.filter((c) => want.has(c.platform)), ...cands.filter((c) => !want.has(c.platform))].slice(0, 24);
}

// ---------------------------------------------------------------------------
// Event/flyer discovery (moved here so the Node CLI can use it too): which
// platform hosted a USCF online event, ideally with the exact tournament page.
// ---------------------------------------------------------------------------

export interface DiscoverEventRequest {
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

export async function discoverEventOnWeb(ev: DiscoverEventRequest): Promise<DiscoveredEventInfo | null> {
  const name = (ev.name || "").trim();
  if (!name) return null;

  const lines = [
    `Name: ${name}`,
    ev.sectionName ? `Section: ${ev.sectionName}` : "",
    ev.startDate ? `Dates: ${ev.startDate}${ev.endDate && ev.endDate !== ev.startDate ? ` to ${ev.endDate}` : ""}` : "",
    ev.ratingSystem ? `US Chess rating system: ${ev.ratingSystem} (online-rated)` : "",
    ev.timeControl ? `Time control: ${ev.timeControl}` : "",
  ].filter(Boolean);

  const prompt = `A US Chess (USCF) rated ONLINE tournament needs to be located on the web. Figure out which platform hosted the games — chess.com, lichess, chesskid or ICC — and if at all possible find the EXACT tournament page.

EVENT:
${lines.join("\n")}

Search for the event's flyer, TLA (Tournament Life Announcement), club announcement/website, or results page. USCF online events (mostly 2020-2021) almost always say "played on Chess.com" or "hosted on lichess.org", and often link the tournament directly (chess.com/tournament/..., lichess.org/swiss/... or lichess.org/tournament/...). Organiser/club names inside the event name are strong search terms.

Return STRICT JSON only (no prose, no markdown fences):
{"platform":"chesscom"|"lichess"|"chesskid"|"icc"|"unknown","urls":["any tournament/flyer URLs found"],"confidence":0.0-1.0,"note":"one short sentence on what you found"}`;

  const ai = await callAIWithSearch(
    "You are a research assistant locating where US Chess online-rated tournaments were hosted. You search the web, answer only from what you find, and output strict JSON.",
    prompt,
    1200
  );
  if (!ai.ok) return null;

  // Parse the JSON answer, but also regex-scan the WHOLE response for platform
  // URLs — grounded answers sometimes cite links outside the JSON.
  let platform: DiscoveredEventInfo["platform"];
  let confidence: number | undefined;
  let note: string | undefined;
  let urlText = ai.text;
  try {
    const s = ai.text.replace(/```(?:json)?/gi, "").trim();
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(s.slice(start, end + 1));
      if (typeof parsed.platform === "string") {
        const p = parsed.platform.toLowerCase().replace(/[^a-z]/g, "");
        if (["chesscom", "lichess", "chesskid", "icc"].includes(p)) platform = p as DiscoveredEventInfo["platform"];
      }
      if (typeof parsed.confidence === "number") confidence = Math.max(0, Math.min(1, parsed.confidence));
      if (typeof parsed.note === "string") note = parsed.note.slice(0, 300);
      if (Array.isArray(parsed.urls)) urlText += "\n" + parsed.urls.filter((u: unknown) => typeof u === "string").join("\n");
    }
  } catch {
    /* fall through to regex-only parsing */
  }

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
