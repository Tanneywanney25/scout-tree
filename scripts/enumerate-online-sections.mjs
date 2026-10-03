#!/usr/bin/env node
// Enumerate USCF online-rated sections from the US Chess ratings API (MUIR) and
// queue them for the pre-resolution batch (public.preresolve_section).
//
// MUIR enumeration endpoints (probed 2026-10-03):
//   GET /affiliates/{affiliateId}/events?Offset=N&Size=M   newest first, {items[], hasNextPage}
//   GET /rated-events?Offset=N&Size=M[&Name=..][&StateCode=..]   all events newest first
//       (StartDate/EndDate/AffiliateId/IsOnline/Online/RatingSystem/Fuzzy are ignored)
//   GET /affiliates?Fuzzy=<name>   affiliate search;  GET /affiliates/{id}
// There is NO section list and no online filter: isOnline lives only on
//   GET /rated-events/{eventId}/sections/{n}
// so the online flag is taken, in order, from: muir_cache (kind=section), a
// per-affiliate rule (online-only affiliate / known online series name), or a
// budgeted section request (stored back into muir_cache).
//
// Rows are inserted with verdict 'queued', source 'enumerated' and
// Prefer: resolution=ignore-duplicates on (event_id,section_no): processed rows
// are never overwritten.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Args: --max-muir N (default 60)  --per-min N (default 14)  --size N (default 250)
//       --affiliates A1,A2 (default: all below)  --dry
//       --since YYYY-MM-DD   override every affiliate's date floor
//       --queue-unknown      queue sections whose online flag is unknown too
//                            (source 'enumerated-unverified'); the batch reads
//                            isOnline itself and records 'not-online'.

const SB = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB || !KEY) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2); }

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const MAX_MUIR = Number(arg("max-muir", 60));
const PER_MIN = Math.min(15, Number(arg("per-min", 14)));
const SIZE = Number(arg("size", 250));
const DRY = process.argv.includes("--dry");
const SINCE = arg("since", "");
const QUEUE_UNKNOWN = process.argv.includes("--queue-unknown");
const API = "https://ratings-api.uschess.org/api/v1";
const UA = "scout-report-pro/roster-index (online section enumeration)";

// Affiliates behind the crawled series. `since`: oldest date roster_tournament
// holds done rosters for. `online`: null = every event of the affiliate is
// online; a RegExp = event names known to be online series; anything else
// needs cache or a section request.
const AFFILIATES = [
  { id: "A6010674", label: "wnz", since: "2025-12-01", online: /\b(WNZ|WALTHAM)\s+RATED\b/i },
  { id: "A6044892", label: "uschess/grandprix (Chess.com LLC)", since: "2025-12-01", online: null },
  { id: "A7238879", label: "pca", since: "2025-12-01", online: /\bPCA\b.*\b(ONLINE|RATED|BLITZ|RAPID)\b|\bONLINE\b/i },
  { id: "A5028582", label: "uschess (US Chess Federation)", since: "2025-12-01", online: /ON\s+CHESS\.?COM|\bONLINE\b/i },
  { id: "A6045387", label: "dmv", since: "2020-01-01", online: /\bONLINE\b/i },
  // Series and Lichess teams added by the 2026-10-03 target discovery; their
  // tournaments are queued in roster_tournament and reach back to 2020.
  { id: "A6053298", label: "sfs (64Squares)", since: "2020-01-01", online: /\bSFS\b/i },
  { id: "A6034194", label: "evangel", since: "2020-01-01", online: /JACKALOPE|FAST\s+FIVE|FASTBALL|WILD\s+WEDNESDAY|SUNDAY\s+SEVEN/i },
  { id: "A6055630", label: "aocc (Westford)", since: "2020-01-01", online: /AOCC.*ONLINE|ONLINE.*AOCC/i },
  { id: "T6021030", label: "seneca", since: "2020-01-01", online: /\bONLINE\b/i },
  { id: "A7215356", label: "transcon (Innovative Chess Solutions)", since: "2020-01-01", online: /\bONLINE\b/i },
  { id: "A6055886", label: "start-right-chess (Lichess)", since: "2020-01-01", online: /ONLINE\s+RATED/i },
  { id: "A8439478", label: "chess4everyone (Lichess)", since: "2020-01-01", online: /\bONLINE\b/i },
  { id: "A9704313", label: "online-tr-tournaments (Lichess)", since: "2020-01-01", online: /\bONLINE\b/i },
  { id: "A6055871", label: "sam-schenk (Lichess)", since: "2020-01-01", online: /\bONLINE\b/i },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let muirUsed = 0, lastAt = 0;
async function muir(path) {
  if (muirUsed >= MAX_MUIR) return { budget: true };
  const wait = lastAt + Math.ceil(60000 / PER_MIN) - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  muirUsed++;
  const r = await fetch(API + path, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (r.status === 429) { console.log("MUIR 429, stopping"); muirUsed = MAX_MUIR; return { budget: true }; }
  if (!r.ok) return { status: r.status };
  return { json: await r.json() };
}
async function rest(method, path, body, prefer) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]} ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

// The orchestrator may still be creating the table: wait up to 4 minutes.
async function waitForTable() {
  for (let i = 0; i < 24; i++) {
    try { await rest("GET", "preresolve_section?select=event_id&limit=1"); return; } catch (e) {
      if (i === 23) throw e;
      await sleep(10000);
    }
  }
}

// Cached section metadata: key "eventId/sectionNo" -> isOnline.
async function loadCachedOnline() {
  const m = new Map();
  for (let off = 0; ; off += 1000) {
    const rows = await rest("GET", `muir_cache?kind=eq.section&select=key,online:payload->isOnline&order=key.asc&limit=1000&offset=${off}`);
    for (const r of rows) m.set(r.key, r.online === true);
    if (rows.length < 1000) break;
  }
  return m;
}

async function queue(rows) {
  if (!rows.length || DRY) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const ins = await rest("POST", "preresolve_section?on_conflict=event_id,section_no", rows.slice(i, i + 500), "resolution=ignore-duplicates,return=representation");
    n += ins?.length || 0;
  }
  return n;
}

const stats = {};
await waitForTable();
const cached = await loadCachedOnline();
console.log(`cached section flags: ${cached.size}`);
const only = arg("affiliates", "") ? new Set(arg("affiliates", "").split(",")) : null;
const pendingVerify = []; // sections whose online flag is unknown, newest first per affiliate

for (const a of AFFILIATES) {
  if (only && !only.has(a.id)) continue;
  const st = (stats[a.label] = { events: 0, sections: 0, online_cache: 0, online_rule: 0, offline_cache: 0, unknown: 0, queued_new: 0, pages: 0, complete: false });
  let pageSize = SIZE;
  for (let off = 0; ; off += pageSize) {
    const res = await muir(`/affiliates/${a.id}/events?Offset=${off}&Size=${SIZE}`);
    if (!res.json) { console.log(`${a.label}: listing stopped at offset ${off} (${res.budget ? "budget" : res.status})`); break; }
    st.pages++;
    const items = res.json.items || [];
    pageSize = Number(res.json.pageSize) || items.length || SIZE;
    const rows = [];
    const unverified = [];
    let older = false;
    for (const ev of items) {
      const day = ev.endDate || ev.startDate || "";
      if (day && day < (SINCE || a.since)) { older = true; continue; }
      st.events++;
      for (let n = 1; n <= (Number(ev.sectionCount) || 0); n++) {
        st.sections++;
        const k = `${ev.id}/${n}`;
        if (cached.has(k)) {
          if (cached.get(k)) { st.online_cache++; rows.push(k); } else st.offline_cache++;
        } else if (a.online === null || a.online.test(ev.name || "")) {
          st.online_rule++; rows.push(k);
        } else {
          st.unknown++;
          if (QUEUE_UNKNOWN) unverified.push(k);
          else pendingVerify.push({ k, st });
        }
      }
    }
    st.queued_new += await queue(rows.map((k) => {
      const [event_id, no] = k.split("/");
      return { event_id, section_no: Number(no), verdict: "queued", source: "enumerated" };
    }));
    st.queued_new += await queue(unverified.map((k) => {
      const [event_id, no] = k.split("/");
      return { event_id, section_no: Number(no), verdict: "queued", source: "enumerated-unverified" };
    }));
    console.log(`${a.label}: offset ${off} items ${items.length} (${items[0]?.startDate}..${items[items.length - 1]?.startDate}) queued so far ${st.queued_new}`);
    if (older || !res.json.hasNextPage || !items.length) { st.complete = true; break; }
  }
}

// Spend what is left of the MUIR budget on sections whose online flag is unknown.
let verified = 0, verifiedOnline = 0;
for (const p of pendingVerify) {
  const [event_id, no] = p.k.split("/");
  const res = await muir(`/rated-events/${event_id}/sections/${no}`);
  if (res.budget) break;
  if (!res.json) continue;
  verified++;
  if (!DRY) await rest("POST", "muir_cache?on_conflict=kind,key", [{ kind: "section", key: p.k, payload: res.json, fetched_at: new Date().toISOString() }], "resolution=ignore-duplicates,return=minimal").catch(() => null);
  if (res.json.isOnline === true) {
    verifiedOnline++;
    p.st.queued_new += await queue([{ event_id, section_no: Number(no), verdict: "queued", source: "enumerated" }]);
  }
}

console.log(JSON.stringify({ muirUsed, verified, verifiedOnline, unverifiedLeft: pendingVerify.length - verified, stats }, null, 1));
