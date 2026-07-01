// ============================================================================
// US Chess (USCF) scraper — runs server-side inside the resolve-identity edge
// function (the MSA pages are server-rendered HTML and not CORS-accessible from
// the browser).
//
// Confirmed endpoints & structure (reconnaissance against live MSA):
//   • Name search: /datapage/player-search.php?name=<Last, First>&rating=R&mode=Find
//       → rows link to  msa/MbrDtlMain.php?<memberId>
//       (the rating=R param is REQUIRED — without it MSA throws a SQL error.)
//   • Member detail: /msa/MbrDtlMain.php?<id>
//       ratings rows: <td valign=top> <Label> Rating </td><td><b> VALUE </b>
//       labels: Regular / Quick / Blitz / Online-Regular / Online-Quick /
//               Online-Blitz / Correspondence; plus State, FIDE ID, Expiration.
//   • Tournament history: /msa/MbrDtlTnmtHst.php?<id>  → events link XtblMain.php?<eventId>
//   • Crosstable: /msa/XtblMain.php?<eventId>  → players link MbrDtlMain.php?<id>
//
// All parsing is defensive: any failure yields empty/undefined rather than
// throwing, so the caller degrades gracefully.
// ============================================================================

const MSA = "https://www.uschess.org/msa";
const DATAPAGE = "https://www.uschess.org/datapage";
const UA = "Mozilla/5.0 (compatible; ScoutTree/1.0)";

export interface UscfRatings {
  regular?: number;
  quick?: number;
  blitz?: number;
  onlineRegular?: number;
  onlineQuick?: number;
  onlineBlitz?: number;
  correspondence?: number;
}

export interface UscfMember {
  id: string;
  name: string; // "First Last"
  state?: string;
  fideId?: string;
  expiration?: string;
  ratings: UscfRatings;
  hasOnline: boolean;
}

export interface UscfSearchRow {
  id: string;
  name: string; // "First Last"
  rating?: number;
  state?: string;
}

export interface UscfEvent {
  eventId: string; // token after XtblMain.php?
  name: string;
  date?: string; // YYYY-MM-DD
  online: boolean;
  platformGuess?: string;
}

export interface UscfOpponent {
  uscfId: string;
  name: string; // "First Last"
  rating?: number;
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: ctrl.signal });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

/** "LAST, FIRST MIDDLE" (or "First Last") → "First Middle Last", title-cased. */
export function toFirstLast(raw: string): string {
  const clean = raw.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  if (clean.includes(",")) {
    const [last, rest] = clean.split(",");
    return title(`${rest} ${last}`.replace(/\s+/g, " "));
  }
  return title(clean);
}

/** Build the "Last, First" query string the MSA search expects. */
function toLastFirst(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.includes(",")) return clean;
  const parts = clean.split(" ");
  if (parts.length < 2) return clean;
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  return `${last}, ${first}`;
}

// ---------------------------------------------------------------------------
// Name search
// ---------------------------------------------------------------------------

export async function searchUscfByName(name: string, state?: string): Promise<UscfSearchRow[]> {
  const params = new URLSearchParams({ name: toLastFirst(name), rating: "R", mode: "Find" });
  if (state && /^[A-Za-z]{2}$/.test(state.trim())) params.set("state", state.trim().toUpperCase());
  const html = await fetchText(`${DATAPAGE}/player-search.php?${params.toString()}`);
  if (!html || /Query Failed/i.test(html)) return [];

  const rows: UscfSearchRow[] = [];
  // Each result: MbrDtlMain.php?<id>...>NAME</a> then rating/state cells.
  const re = /MbrDtlMain\.php\?(\d{6,})[^>]*>([^<]+)<\/a>((?:(?!<\/tr>)[\s\S]){0,400})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && rows.length < 25) {
    const id = m[1];
    const name = toFirstLast(m[2]);
    const tail = m[3].replace(/&nbsp;/g, " ");
    const ratingMatch = tail.match(/\b(\d{3,4})\b/);
    const stateMatch = tail.match(/>\s*([A-Z]{2})\s*</);
    rows.push({
      id,
      name,
      rating: ratingMatch ? parseInt(ratingMatch[1], 10) : undefined,
      state: stateMatch ? stateMatch[1] : undefined,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Member detail (ratings, state, FIDE, expiration)
// ---------------------------------------------------------------------------

const RATING_LABELS: [keyof UscfRatings, RegExp][] = [
  ["onlineRegular", /Online-?Regular Rating/i],
  ["onlineQuick", /Online-?Quick Rating/i],
  ["onlineBlitz", /Online-?Blitz Rating/i],
  ["regular", /(?<!Online-)\bRegular Rating/i],
  ["quick", /(?<!Online-)\bQuick Rating/i],
  ["blitz", /(?<!Online-)\bBlitz Rating/i],
  ["correspondence", /Correspondence Rating/i],
];

function parseRatingAfterLabel(html: string, labelRe: RegExp): number | undefined {
  const idx = html.search(labelRe);
  if (idx < 0) return undefined;
  // The value sits in the next <td><b> ... </b>; look within a short window.
  const window = html.slice(idx, idx + 260);
  // Skip "(Unrated)"; grab the first standalone 3-4 digit number.
  if (/\(Unrated\)/i.test(window.slice(0, 120))) return undefined;
  const num = window.match(/<b>[\s\S]{0,60}?(\d{3,4})\b/) || window.match(/(\d{3,4})\b/);
  return num ? parseInt(num[1], 10) : undefined;
}

export async function fetchUscfMember(id: string): Promise<UscfMember | null> {
  const html = await fetchText(`${MSA}/MbrDtlMain.php?${id}`);
  if (!html) return null;

  const nameMatch = html.match(new RegExp(`<b>\\s*${id}:\\s*([^<]+)</b>`));
  const name = nameMatch ? toFirstLast(nameMatch[1]) : "";

  const ratings: UscfRatings = {};
  for (const [key, re] of RATING_LABELS) {
    const v = parseRatingAfterLabel(html, re);
    if (v !== undefined) ratings[key] = v;
  }

  // State — MSA shows it near the top; try a couple of patterns.
  let state: string | undefined;
  const st =
    html.match(/State\s*<\/td>\s*<td[^>]*>\s*<b>\s*([A-Z]{2})\b/i) ||
    html.match(/\b([A-Z]{2})\b\s*<\/b>\s*<\/td>\s*<\/tr>\s*<tr>\s*<td[^>]*>\s*Expiration/i);
  if (st) state = st[1].toUpperCase();

  const fideMatch =
    html.match(/FIDE[^0-9]{0,60}?(\d{6,})/i) || html.match(/ratings\.fide\.com\/(?:profile\/)?(\d{6,})/i);
  const fideId = fideMatch ? fideMatch[1] : undefined;

  const expMatch = html.match(/Expiration Dt\.\s*<\/td>\s*<td[^>]*>\s*<b>\s*(\d{4}-\d{2}-\d{2})/i);
  const expiration = expMatch ? expMatch[1] : undefined;

  const hasOnline =
    ratings.onlineRegular !== undefined ||
    ratings.onlineQuick !== undefined ||
    ratings.onlineBlitz !== undefined;

  return { id, name, state, fideId, expiration, ratings, hasOnline };
}

// ---------------------------------------------------------------------------
// Tournament history
// ---------------------------------------------------------------------------

const ONLINE_EVENT_RE =
  /\b(online|virtual|lichess|chess\.?com|chesskid|internet|pandemic|covid|isolated|quarantine|web)\b/i;

export async function fetchUscfTournaments(id: string): Promise<UscfEvent[]> {
  const html = await fetchText(`${MSA}/MbrDtlTnmtHst.php?${id}`);
  if (!html) return [];

  const events: UscfEvent[] = [];
  const re = /XtblMain\.php\?([0-9][0-9A-Za-z.\-]{6,})[^>]*>([^<]*)<\/a>((?:(?!<\/tr>)[\s\S]){0,400})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && events.length < 60) {
    const eventId = m[1];
    const name = m[2].replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const rowText = m[3];
    const dateMatch = (name + rowText).match(/(\d{4}-\d{2}-\d{2})/);
    const combined = `${name} ${rowText}`;
    const online = ONLINE_EVENT_RE.test(combined);
    let platformGuess: string | undefined;
    if (/lichess/i.test(combined)) platformGuess = "lichess";
    else if (/chess\.?com/i.test(combined)) platformGuess = "chesscom";
    else if (/chesskid/i.test(combined)) platformGuess = "chesskid";
    events.push({ eventId, name, date: dateMatch?.[1], online, platformGuess });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Crosstable → opponents (all players in the section, minus the root)
// ---------------------------------------------------------------------------

export async function fetchCrosstableOpponents(eventId: string, rootId: string): Promise<UscfOpponent[]> {
  const html = await fetchText(`${MSA}/XtblMain.php?${eventId}`);
  if (!html) return [];
  const opponents: UscfOpponent[] = [];
  const seen = new Set<string>();
  const re = /MbrDtlMain\.php\?(\d{6,})[^>]*>\s*([^<]+?)\s*<\/a>((?:(?!<\/tr>)[\s\S]){0,160})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && opponents.length < 40) {
    const uscfId = m[1];
    if (uscfId === rootId || seen.has(uscfId)) continue;
    seen.add(uscfId);
    const name = toFirstLast(m[2]);
    const ratingMatch = m[3].match(/\b(\d{3,4})\b/);
    opponents.push({ uscfId, name, rating: ratingMatch ? parseInt(ratingMatch[1], 10) : undefined });
  }
  return opponents;
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
