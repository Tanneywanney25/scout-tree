// Mass pre-resolution (docs/roster-index.md): join USCF online sections against
// the roster index in bulk, ahead of any search, and write every verified
// identity exactly as the edge indexJoin does (section_link source 'index' +
// record_identity_edges). Bundled and run by scripts/pre-resolve.mjs.
//
// Candidates: every cached online section (muir_cache: section meta +
// crosstable; no MUIR request) and every 'queued' row of preresolve_section
// (enumerators put those there; MUIR-paced by uscf.ts, ~75 requests/min).
//
// Trust: the STRICT index bar — a candidate must explain >= 90% of the
// crosstable (rosterIndexCore.indexTrusted strict). Sections with fewer than
// 3 players who played are not joined blind at all.
//
// Resumable: one preresolve_section row per section, written as it goes. A
// resolved or already-linked section is never processed again; an unresolved
// one is retried only when a roster inside its window was crawled since.
import { joinSection, candidateWindow, playedCount, type StoredRoster } from "../supabase/functions/_shared/rosterIndexCore.ts";
import {
  fetchSectionMeta,
  fetchSectionPlayers,
  fetchEventName,
  platformGuess,
  nameForMatch,
  muirRequestsSent,
} from "../supabase/functions/resolve-identity/uscf.ts";
import { recordVerifiedAlignment } from "../supabase/functions/resolve-identity/harvest.ts";
import { putSectionLink } from "../supabase/functions/_shared/identityStore.ts";

const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!SB || !KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const SOURCE = arg("source", "cache"); // cache | queued | both
const CONC = Number(arg("concurrency", SOURCE === "cache" ? "8" : "4"));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const MINUTES = Number(arg("minutes", "0")) || 0;
const DRY = process.argv.includes("--dry-run");
const [SHARD, SHARDS] = arg("shard", "0/1").split("/").map(Number);
const DEADLINE = MINUTES ? Date.now() + MINUTES * 60_000 : Infinity;
const MIN_PLAYED = 3;
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function getAll<T = any>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; ; off += 1000) {
    const res = await fetch(`${SB}/rest/v1/${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${off}`, { headers: H });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
async function putProgress(row: Record<string, unknown>): Promise<boolean> {
  if (DRY) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${SB}/rest/v1/preresolve_section?on_conflict=event_id,section_no`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ ...row, checked_at: new Date().toISOString() }),
    }).catch(() => null);
    if (res?.ok) return true;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return false;
}

type Roster = StoredRoster & { fetched_at?: string | null };
log("loading index and progress…");
const [rostersRaw, links, progress, metas, xtKeys, evRows] = await Promise.all([
  getAll<Roster>("roster_tournament?select=platform,tid,series,name,starts_at,n_rounds,n_players,handles,vectors,fetched_at&status=eq.done&order=platform.asc,tid.asc"),
  getAll<{ event_id: string; section_no: number; status: string; source: string | null }>("section_link?select=event_id,section_no,status,source&order=event_id.asc,section_no.asc,platform.asc,tournament_id.asc"),
  getAll<{ event_id: string; section_no: number; verdict: string; win_from: string | null; win_to: string | null; checked_at: string; source: string | null }>(
    "preresolve_section?select=event_id,section_no,verdict,win_from,win_to,checked_at,source&order=event_id.asc,section_no.asc"
  ),
  getAll<{ key: string; payload: any }>("muir_cache?select=key,payload&kind=eq.section&payload->>isOnline=eq.true&order=key.asc"),
  getAll<{ key: string }>("muir_cache?select=key&kind=eq.crosstable&order=key.asc"),
  getAll<{ key: string; name: string | null }>("muir_cache?select=key,name:payload->>name&kind=eq.event&order=key.asc"),
]);
const rosters = [...new Map(rostersRaw.filter((r) => r.starts_at && r.handles?.length).map((r) => [`${r.platform}:${r.tid}`, r])).values()];
const evNames = new Map(evRows.map((r) => [r.key, r.name || ""]));
const linked = new Set(links.filter((l) => l.status === "verified").map((l) => `${l.event_id}/${l.section_no}`));
// An index link with no 'resolved' progress row (written by the edge indexJoin,
// or by a run that was cut off before its progress write) is joined once more
// so it gets one: idempotent, the same link and edges are upserted.
const linkedElsewhere = new Set(links.filter((l) => l.status === "verified" && l.source !== "index").map((l) => `${l.event_id}/${l.section_no}`));
const progressBy = new Map(progress.map((p) => [`${p.event_id}/${p.section_no}`, p]));
const xtSet = new Set(xtKeys.map((r) => r.key));
const metaBy = new Map(metas.map((m) => [m.key, m.payload]));

// Cached payloads are read straight from muir_cache with no TTL: a rated
// crosstable never changes, and the batch must not spend MUIR requests on
// sections it already holds (uscf.ts refetches anything older than 30 days).
function cachedMeta(key: string) {
  const s = metaBy.get(key);
  if (!s) return null;
  return { name: typeof s.name === "string" ? s.name : undefined, isOnline: !!s.isOnline, ratingSystem: s.ratingSystem, timeControl: s.timeControl, roundCount: s.roundCount, isBlitz: !!s.isBlitz, startDate: s.startDate, endDate: s.endDate };
}
const colorOf = (raw: unknown) => {
  const c = String(raw || "").toLowerCase();
  return c === "white" || c === "black" ? c : "unknown";
};
async function cachedPlayers(key: string) {
  const res = await fetch(`${SB}/rest/v1/muir_cache?kind=eq.crosstable&key=eq.${encodeURIComponent(key)}&select=payload&limit=1`, { headers: H });
  if (!res.ok) throw new Error(`crosstable read ${res.status}`);
  const data = ((await res.json()) as { payload?: any }[])[0]?.payload;
  const items: any[] = Array.isArray(data?.items) ? data.items : [];
  // Same shape as fetchSectionPlayers (uscf.ts), minus names the join never reads.
  return items
    .filter((row) => row.memberId)
    .map((row) => ({
      uscfId: String(row.memberId),
      name: "",
      isTarget: false,
      games: (row.roundOutcomes || [])
        .filter((ro: any) => ro?.opponentMemberId)
        .map((ro: any) => ({ round: ro.roundNumber, color: colorOf(ro.color) as "white" | "black" | "unknown", outcome: ro.outcome || "", opponentUscfId: String(ro.opponentMemberId), opponentName: "" })),
    }));
}

const FINAL = new Set(["resolved", "untraceable", "no-crosstable", "not-online", "too-small", "no-date"]);
const grewSince = (p: { win_from: string | null; win_to: string | null; checked_at: string }) =>
  !!p.win_from && !!p.win_to && rosters.some((r) => r.starts_at! >= p.win_from! && r.starts_at! <= p.win_to! && (r.fetched_at || "") > p.checked_at);

interface Cand { eventId: string; n: number; cached: boolean; source: string }
const skipped: Record<string, number> = {};
const skip = (why: string) => void (skipped[why] = (skipped[why] || 0) + 1);
const cands: Cand[] = [];
const seen = new Set<string>();
function consider(key: string, cached: boolean, source: string) {
  if (seen.has(key)) return;
  seen.add(key);
  const [eventId, nStr] = key.split("/");
  const n = Number(nStr);
  if (!/^\d+$/.test(eventId) || !Number.isFinite(n)) return skip("bad-key");
  const p = progressBy.get(key);
  if (linkedElsewhere.has(key) || (linked.has(key) && p?.verdict === "resolved")) return skip(p?.verdict === "resolved" ? "already-resolved" : "already-linked");
  if (p && p.verdict !== "queued") {
    if (FINAL.has(p.verdict)) return skip(p.verdict === "resolved" ? "already-resolved" : `final:${p.verdict}`);
    if (!grewSince(p)) return skip("tried-no-new-roster");
  }
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  if (h % SHARDS !== SHARD) return;
  cands.push({ eventId, n, cached, source });
}
if (SOURCE === "cache" || SOURCE === "both") for (const m of metas) if (xtSet.has(m.key)) consider(m.key, true, "cache");
// Unresolved sections whose cached crosstable has since been pruned from
// muir_cache (sweep_muir_cache): still retried when the index has grown; the
// crosstable is fetched again.
if (SOURCE === "cache" || SOURCE === "both")
  for (const p of progress) if (!FINAL.has(p.verdict) && p.verdict !== "queued") consider(`${p.event_id}/${p.section_no}`, xtSet.has(`${p.event_id}/${p.section_no}`), p.source || "cache");
if (SOURCE === "queued" || SOURCE === "both") {
  // Newest events first: recent sections are the ones searches ask about.
  const queued = progress.filter((p) => p.verdict === "queued").sort((a, b) => (a.event_id < b.event_id ? 1 : -1));
  for (const p of queued) consider(`${p.event_id}/${p.section_no}`, xtSet.has(`${p.event_id}/${p.section_no}`), p.source || "queued");
}
log(
  JSON.stringify({
    rosters: rosters.length,
    cachedOnlineSections: metas.length,
    cachedCrosstables: xtKeys.length,
    queuedRows: progress.filter((p) => p.verdict === "queued").length,
    verifiedLinks: linked.size,
    candidates: cands.length,
    skippedBeforeStart: skipped,
    source: SOURCE,
    shard: `${SHARD}/${SHARDS}`,
    dryRun: DRY,
  })
);

const tally: Record<string, number> = {};
const totals = { processed: 0, resolved: 0, identities: 0, strong: 0, conflicts: 0, superseded: 0, optOut: 0, writeFailed: 0 };
const bySeries: Record<string, number> = {};

async function processOne(c: Cand): Promise<void> {
  const base = { event_id: c.eventId, section_no: c.n, source: c.source };
  const done = async (verdict: string, extra: Record<string, unknown> = {}) => {
    tally[verdict] = (tally[verdict] || 0) + 1;
    totals.processed++;
    await putProgress({ ...base, verdict, ...extra });
  };
  const key = `${c.eventId}/${c.n}`;
  const meta = c.cached && metaBy.has(key) ? cachedMeta(key) : await fetchSectionMeta(c.eventId, c.n);
  if (!meta) return done("no-crosstable");
  if (!meta.isOnline) return done("not-online");
  if (!meta.startDate && !meta.endDate) return done("no-date");
  // Before spending a standings request: is any roster near these dates at all?
  const loose = candidateWindow({ startDate: meta.startDate, endDate: meta.endDate, roundCount: meta.roundCount }, 2);
  const win = { win_from: loose.from, win_to: loose.to };
  const near = rosters.filter((r) => r.starts_at! >= loose.from && r.starts_at! <= loose.to && (r.n_rounds || 0) >= loose.minRounds && (r.n_rounds || 0) <= loose.maxRounds);
  if (!near.length) return done("no-candidate", { ...win, candidates: 0 });
  let evName = evNames.get(c.eventId) || "";
  if (!evName && !c.cached) evName = await fetchEventName(c.eventId);
  const guess = (platformGuess(nameForMatch(`${evName} ${meta.name || ""}`)) || "").toLowerCase();
  if (guess === "icc" || guess === "chesskid") return done("untraceable", win);
  let players = c.cached ? await cachedPlayers(key) : await fetchSectionPlayers(c.eventId, c.n, "");
  // A cached crosstable can be pruned between the listing and this read.
  if (!players.length && c.cached) players = await fetchSectionPlayers(c.eventId, c.n, "");
  if (!players.length) return done("no-crosstable", win);
  const sec = {
    eventId: c.eventId,
    name: evName,
    sectionName: meta.name,
    sectionNumber: c.n,
    startDate: meta.startDate,
    endDate: meta.endDate,
    ratingSystem: meta.ratingSystem || "",
    timeControl: meta.timeControl,
    roundCount: meta.roundCount,
    isBlitz: meta.isBlitz,
    platformGuess: guess || undefined,
    players,
  };
  const played = playedCount(sec);
  if (played < MIN_PLAYED) return done("too-small", { ...win, played });
  const w = candidateWindow({ startDate: meta.startDate, endDate: meta.endDate, roundCount: meta.roundCount }, played);
  const pool = near.filter((r) => (r.n_players || 0) >= w.minPlayers && (guess === "chesscom" || guess === "lichess" ? r.platform === guess : true));
  if (!pool.length) return done("no-candidate", { ...win, played, candidates: 0 });
  const j = joinSection(sec, pool, { strict: true });
  if (!j.best) {
    const top = j.tried[0];
    const belowFloor = !!top && top.assigned >= Math.max(2, Math.ceil(played * 0.5)) && top.assigned / played < 0.9;
    return done(j.ambiguous ? "ambiguous" : belowFloor ? "below-floor" : "none", { ...win, played, candidates: pool.length, assigned: top?.assigned ?? 0 });
  }
  if (j.best.assigned / played < 0.9) return done("below-floor", { ...win, played, candidates: pool.length, assigned: j.best.assigned });
  const kind = j.best.platform === "chesscom" ? "chesscom-tournament" : "lichess-swiss";
  let stored: Awaited<ReturnType<typeof recordVerifiedAlignment>>["stored"] = null;
  let strong = 0;
  if (!DRY) {
    // Identities first (retried: concurrent calls can deadlock on a shared
    // member row), then the link that marks the section as done.
    let rec = await recordVerifiedAlignment(sec, j.best.alignment, { eventId: c.eventId, sectionNumber: c.n, kind, tournamentId: j.best.tid });
    for (let attempt = 0; !rec.stored && attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 400 + Math.random() * 1200));
      rec = await recordVerifiedAlignment(sec, j.best.alignment, { eventId: c.eventId, sectionNumber: c.n, kind, tournamentId: j.best.tid });
    }
    stored = rec.stored;
    strong = rec.edges.filter((e) => e.tier === "strong").length;
    const linkOk =
      !!stored &&
      (await putSectionLink({
        eventId: c.eventId,
        sectionNo: c.n,
        platform: j.best.platform,
        tournamentId: j.best.tid,
        status: "verified",
        assigned: j.best.assigned,
        nPlayers: played,
        contradicted: j.best.contradicted,
        inconsistentEdges: j.best.inconsistentEdges,
        source: "index",
      }));
    if (!linkOk || !stored) {
      // Not recorded as resolved: the next run tries this section again.
      totals.writeFailed++;
      tally["write-failed"] = (tally["write-failed"] || 0) + 1;
      totals.processed++;
      return;
    }
  }
  totals.resolved++;
  totals.identities += stored?.written ?? j.best.assigned;
  totals.strong += strong;
  totals.conflicts += stored?.conflicts ?? 0;
  totals.superseded += stored?.superseded ?? 0;
  totals.optOut += stored?.skippedOptOut ?? 0;
  bySeries[j.best.series || "?"] = (bySeries[j.best.series || "?"] || 0) + 1;
  return done("resolved", {
    ...win,
    platform: j.best.platform,
    tournament_id: j.best.tid,
    played,
    assigned: j.best.assigned,
    candidates: pool.length,
    written: stored?.written ?? null,
    conflicts: (stored?.conflicts ?? 0) + (stored?.superseded ?? 0),
  });
}

const t0 = Date.now();
let next = 0;
const todo = cands.slice(0, LIMIT === Infinity ? cands.length : LIMIT);
const report = () =>
  log(JSON.stringify({ done: totals.processed, of: todo.length, ...totals, tally, bySeries, muirRequests: muirRequestsSent, perMin: Math.round(totals.processed / ((Date.now() - t0) / 60_000)) }));
const ticker = setInterval(report, 30_000);
await Promise.all(
  Array.from({ length: Math.max(1, CONC) }, async () => {
    while (next < todo.length && Date.now() < DEADLINE) {
      const c = todo[next++];
      try {
        await processOne(c);
      } catch (e) {
        tally["error"] = (tally["error"] || 0) + 1;
        log("error", `${c.eventId}/${c.n}`, (e as Error)?.message || e);
      }
    }
  })
);
clearInterval(ticker);
report();
log("final", JSON.stringify({ minutes: ((Date.now() - t0) / 60_000).toFixed(1), candidates: cands.length, skippedBeforeStart: skipped, ...totals, tally, bySeries }));
