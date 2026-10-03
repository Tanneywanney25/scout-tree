// ============================================================================
// Roster-index crawler core (docs/roster-index.md, Phase 3), runtime-neutral:
// plain fetch and timers, so the Node CLI (scripts/roster-crawler.mjs) and the
// Supabase Edge slice (supabase/functions/roster-crawl) run the same code.
//
// createCrawler({ sbUrl, key, ua, rate, log, deadline, idleReturn }) returns
// { chesscomLane, lichessLane, stats, pacers }. Each lane is serial per
// platform and returns at `deadline`; nothing it has not finished is written,
// so a lane cut off mid-tournament leaves that tournament 'pending'.
// Scope, discovery, pacing and resumability: see scripts/roster-crawler.mjs.
// ============================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
// ---------------------------------------------------------------------------
// Series scope. Anything not matched here is never fetched.
// The second block (2026-10-03) is organizers found from uncovered USCF online
// sections; each was accepted on a Chess.com tournament whose name and start
// date matched a USCF section of the same series (within a day): 64Squares
// "SFS", Evangel Chess Club (Jackalope / Fast Five / Three-Two Fastball / Wild
// Wednesday / Sunday Seven), Westford CC "AOCC USCF rated", Morning Membership
// Event, Seneca scholastic, Transcontinental Scholastic, KT Chess. Live
// tournaments only: a slug with no numeric id (daily events) is out of scope.
// Second wave (same day, same name-and-date test): Waltham's other formats,
// "<tc>-1201|1400|1401-rated-<n>" (USCF "(Under 1400) RATED #n"; Chess.com
// names it "<1201 RATED"), First Thursday / First Friday and Goldfarb, all
// "<tc>-<name>-<n>-<id>"; Evangel's Tuesday Twelve; Super Saturday Online.
// ---------------------------------------------------------------------------
export function chesscomSeries(slug) {
  const s = String(slug || "").toLowerCase();
  if (/^-*us-chess-/.test(s)) return "uschess";
  if (/(^|-)(wnz|waltham)-rated(-|$)/.test(s)) return "wnz";
  if (/^-*pca-/.test(s)) return "pca";
  if (/(^|-)grand-prix-rated(-|$)/.test(s)) return "grandprix";
  if (!/-\d{6,}$/.test(s)) return null;
  if (/^\d+-(1[24]0[01]-rated|first-thursday|first-friday|goldfarb)-\d+-\d{6,}$/.test(s)) return "wnz";
  if (/^-*sfs-/.test(s)) return "sfs";
  if (/(^|-)(jackalope|fast-five|three-two-fastball|wild-wednesday|sunday-seven|tuesday-twelve)(-|$)/.test(s)) return "evangel";
  if (/^-*super-saturday-/.test(s)) return "supersat";
  // Third wave: Mechanics' Institute USCF online events, US Championship Online Qualifier.
  if (/^(mechanics-uscf-online-rated-(rapid|blitz)|2020-mechanics-(rapid|blitz)-online-championship)/.test(s)) return "mechanics";
  if (/^\d{4}-\d{4}-us-championship-online-qualifier-/.test(s)) return "uscoq";
  if (/(^|-)aocc-/.test(s) && /uscf-rated/.test(s)) return "aocc";
  if (/^-*morning-membership-event-/.test(s)) return "morning";
  if (/^-*seneca-/.test(s)) return "seneca";
  if (/(^|-)transcontinental-scholastic-/.test(s)) return "transcon";
  if (/^-*kt-chess-/.test(s)) return "ktchess";
  return null;
}
const idNum = (slug) => Number(String(slug).match(/(\d+)$/)?.[1] || 0);

// ---------------------------------------------------------------------------
// Platform inference (Phase 5): every tournament NAME the crawler sees teaches
// series_platform which platform a USCF series of that name runs on. Keys are
// built exactly like seriesKey() in supabase/functions/resolve-identity/uscf.ts
// (slugs: dashes read as spaces); generic keys ("rapid", "3 2 blitz") are
// skipped because every platform has them.
// ---------------------------------------------------------------------------
export function seriesKey(name) {
  return String(name || "")
    .replace(/[_-]/g, " ")
    .toLowerCase()
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g, " ")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, " ")
    .replace(/\b\d+(st|nd|rd|th)\b/g, " ")
    .replace(/[0-9]+/g, " ")
    .replace(/\b(round|rd|section|sec|week|wk|event|edition|no|part)\b/g, " ")
    .replace(/[^a-z.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
const GENERIC_KEYS = new Set(["", "rapid", "blitz", "bullet", "classical", "standard", "open", "rated", "online", "beginner", "swiss", "arena", "tournament", "championship", "live", "rapid quad", "blitz quad", "quad", "lightning", "super blitz", "hyper", "untitled", "rapid open", "blitz open", "scholastic", "chess", "club", "test", "practice", "casual", "seven", "wild"]);
export const distinctiveKey = (k) =>
  !GENERIC_KEYS.has(k) && k.replace(/\b(rapid|blitz|bullet|open|rated|online|u|i|ii|g|x)\b/g, "").trim().length >= 3;

// ---------------------------------------------------------------------------
// Result vectors
// ---------------------------------------------------------------------------
const DRAW = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);

/** games: [{round, w, b, o}] with o = white's result (w/l/d). */
function encodeVectors(handles, games, rounds) {
  const idx = new Map(handles.map((h, i) => [h, i]));
  const vec = handles.map(() => new Array(rounds).fill(""));
  for (const g of games) {
    const wi = idx.get(g.w);
    const bi = idx.get(g.b);
    if (wi === undefined || bi === undefined || !g.o || g.round < 1 || g.round > rounds) continue;
    const bo = g.o === "w" ? "l" : g.o === "l" ? "w" : "d";
    vec[wi][g.round - 1] = `${bi}w${g.o}`;
    vec[bi][g.round - 1] = `${wi}b${bo}`;
  }
  return vec.map((v) => v.join(",")).join(" ");
}


export function createCrawler(cfg) {
  const SB = String(cfg.sbUrl || "").replace(/\/$/, "");
  const KEY = cfg.key;
  const UA = cfg.ua;
  const TARGET_RATE = cfg.rate || 1;
  const deadline = cfg.deadline ?? Infinity;
  const log = cfg.log || ((...a) => console.log(new Date().toISOString().slice(11, 19), ...a));
  const LICHESS_TEAMS = cfg.lichessTeams || [{ team: "dmv-chess-tournaments", series: "dmv" }];
  const seriesSeen = new Set();
  async function learnSeries(pairs, source) {
    const rows = [];
    for (const [name, platform] of pairs) {
      const k = seriesKey(name);
      if (!distinctiveKey(k) || seriesSeen.has(`${k}|${platform}`)) continue;
      seriesSeen.add(`${k}|${platform}`);
      rows.push({ series_key: k, platform, source, n_events: 0 });
    }
    // Never overwrite: an alignment-learned row outranks anything learned here.
    for (let i = 0; i < rows.length; i += 500) {
      await rest("POST", "series_platform?on_conflict=series_key", rows.slice(i, i + 500), "resolution=ignore-duplicates,return=minimal").catch(() => null);
    }
  }

  // ---------------------------------------------------------------------------
  // Adaptive pacer: serial, rate halves on a block, steps back when clean.
  // ---------------------------------------------------------------------------
  class Pacer {
    constructor(name, { basePauseMs, maxPauseMs }) {
      this.name = name;
      this.rate = TARGET_RATE;
      this.min = 0.05;
      this.step = 0.1;
      this.recoverMs = 60_000;
      this.basePauseMs = basePauseMs;
      this.maxPauseMs = maxPauseMs;
      this.lastSend = 0;
      this.pausedUntil = 0;
      this.lastLimit = 0;
      this.lastStep = 0;
      this.streak = 0;
      this.limitEvents = 0;
      this.sent = 0;
    }
    /** Wait for this platform's next slot; false when the slot would land past
     *  the caller's deadline (an edge slice must end inside its wall clock). */
    async turn() {
      for (;;) {
        const t = now();
        if (this.rate < TARGET_RATE && t - this.lastLimit > this.recoverMs && t - this.lastStep > this.recoverMs) {
          this.rate = Math.min(TARGET_RATE, this.rate + this.step);
          this.lastStep = t;
          if (t - this.lastLimit > 5 * 60_000) this.streak = 0;
        }
        const wait = Math.max(this.pausedUntil - t, this.lastSend + 1000 / this.rate - t);
        if (t + Math.max(0, wait) >= deadline) return false;
        if (wait <= 0) break;
        await sleep(Math.min(wait, 30_000));
      }
      this.lastSend = now();
      this.sent++;
      return true;
    }
    limited() {
      const t = now();
      this.limitEvents++;
      this.streak = t - this.lastLimit < 10 * 60_000 ? this.streak + 1 : 1;
      this.lastLimit = t;
      this.rate = Math.max(this.min, this.rate / 2);
      const pause = Math.min(this.maxPauseMs, this.basePauseMs * 2 ** (this.streak - 1));
      this.pausedUntil = t + pause;
      log(`[${this.name}] rate limit #${this.limitEvents} — rate ${this.rate.toFixed(2)}/s, pause ${Math.round(pause / 1000)} s`);
    }
  }
  const pacers = {
    chesscom: new Pacer("chesscom", { basePauseMs: 10_000, maxPauseMs: 300_000 }),
    lichess: new Pacer("lichess", { basePauseMs: 60_000, maxPauseMs: 600_000 }),
  };

  /** One platform GET through its pacer. Returns {status, text} or {status:0}
   *  on a transport failure. A 429 / Cloudflare challenge is retried after the
   *  pause, at most 6 times. */
  async function platformGet(platform, url, { accept = "application/json", timeoutMs = 30_000 } = {}) {
    const p = pacers[platform];
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!(await p.turn())) return { status: -1, text: "" }; // past the deadline: not sent
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: ctrl.signal });
        const blocked = res.status === 429 || (res.status === 403 && /challenge/i.test(res.headers.get("cf-mitigated") || ""));
        if (blocked) {
          await res.body?.cancel().catch(() => {});
          p.limited();
          continue;
        }
        const text = res.ok ? await res.text() : "";
        return { status: res.status, text };
      } catch (e) {
        // Transport failure (sleep, network drop, timeout): short wait, retry.
        log(`[${platform}] transport failure (${String(e?.name || e).slice(0, 40)}) on ${url.slice(0, 90)}`);
        await sleep(5_000 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    return { status: 0, text: "" };
  }

  // ---------------------------------------------------------------------------
  // Postgres through PostgREST (service role). Retries survive a sleeping laptop.
  // ---------------------------------------------------------------------------
  async function rest(method, path, body, prefer) {
    for (let attempt = 0; ; attempt++) {
      try {
        const headers = { apikey: KEY, "Content-Type": "application/json" };
        // Legacy JWT keys also go in Authorization; new sb_secret_ keys go in apikey only.
        if (!KEY.startsWith("sb_")) headers.Authorization = `Bearer ${KEY}`;
        if (prefer) headers.Prefer = prefer;
        const res = await fetch(`${SB}/rest/v1/${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.ok) {
          const t = await res.text();
          return t ? JSON.parse(t) : null;
        }
        const t = await res.text();
        if (res.status < 500 && res.status !== 429) throw new Error(`PostgREST ${res.status}: ${t.slice(0, 200)}`);
        throw Object.assign(new Error(`PostgREST ${res.status}`), { retry: true });
      } catch (e) {
        if (!e.retry && !/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|network/i.test(String(e.message || e))) throw e;
        if (attempt >= 20) throw e;
        await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
      }
    }
  }
  const rpc = (fn, args = {}) => rest("POST", `rpc/${fn}`, args);

  async function upsertPending(rows) {
    for (let i = 0; i < rows.length; i += 500) {
      await rest("POST", "roster_tournament?on_conflict=platform,tid", rows.slice(i, i + 500), "resolution=ignore-duplicates,return=minimal");
    }
  }
  async function upsertSources(rows) {
    for (let i = 0; i < rows.length; i += 500) {
      await rest("POST", "crawl_source?on_conflict=platform,kind,key", rows.slice(i, i + 500), "resolution=ignore-duplicates,return=minimal");
    }
  }
  const enc = encodeURIComponent;

  // ---------------------------------------------------------------------------
  // Chess.com
  // ---------------------------------------------------------------------------
  async function chesscomRoster(slug) {
    let requests = 0;
    const get = async (url) => {
      requests++;
      return platformGet("chesscom", url);
    };
    const root = await get(`https://api.chess.com/pub/tournament/${enc(slug)}`);
    if (root.status === -1) return { deadline: true, requests };
    if (root.status === 404 || root.status === 410) return { gone: true, requests };
    if (root.status !== 200) return { error: `root ${root.status}`, requests };
    const j = JSON.parse(root.text);
    if (j.status && j.status !== "finished") return { notFinished: j.status, requests };
    const roundUrls = Array.isArray(j.rounds) ? j.rounds : [];
    const games = [];
    const roster = new Set();
    for (const [i, ru] of roundUrls.entries()) {
      const r = i + 1;
      let groupUrls = [`${ru}/1`];
      let g = await get(groupUrls[0]);
      if (g.status === -1) return { deadline: true, requests };
      if (g.status === 404) {
        const rr = await get(ru);
        if (rr.status === -1) return { deadline: true, requests };
        if (rr.status !== 200) return { error: `round ${r} ${rr.status}`, requests };
        const rj = JSON.parse(rr.text);
        for (const p of rj.players || []) roster.add(String(p.username || "").toLowerCase());
        groupUrls = rj.groups || [];
        g = groupUrls.length ? await get(groupUrls[0]) : { status: 200, text: '{"games":[]}' };
      }
      for (let gi = 0; gi < groupUrls.length; gi++) {
        if (gi > 0) g = await get(groupUrls[gi]);
        if (g.status === -1) return { deadline: true, requests };
        if (g.status !== 200) return { error: `group ${r}/${gi + 1} ${g.status}`, requests };
        const gj = JSON.parse(g.text);
        for (const p of gj.players || []) roster.add(String(p.username || "").toLowerCase());
        for (const gm of gj.games || []) {
          const w = String(gm.white?.username || "").toLowerCase();
          const b = String(gm.black?.username || "").toLowerCase();
          if (!w || !b) continue;
          roster.add(w);
          roster.add(b);
          const wr = String(gm.white?.result || "");
          const br = String(gm.black?.result || "");
          const o = wr === "win" ? "w" : br === "win" ? "l" : DRAW.has(wr) || DRAW.has(br) ? "d" : "";
          games.push({ round: r, w, b, o });
        }
      }
    }
    roster.delete("");
    const handles = [...roster].sort();
    const rounds = Math.max(roundUrls.length, Number(j.settings?.total_rounds) || 0);
    return {
      requests,
      row: {
        name: String(j.name || "").slice(0, 200),
        starts_at: j.start_time ? new Date(j.start_time * 1000).toISOString() : null,
        n_rounds: rounds,
        n_players: handles.length,
        time_control: j.settings?.time_control || null,
        handles,
        vectors: encodeVectors(handles, games, rounds),
      },
    };
  }

  async function pollChesscomSource(src) {
    const res = await platformGet("chesscom", `https://api.chess.com/pub/player/${enc(src.key)}/tournaments`);
    if (res.status === -1) return 0; // past the deadline: not polled, not marked
    let found = 0;
    if (res.status === 200) {
      const j = JSON.parse(res.text);
      const rows = [];
      const all = [...(j.finished || []), ...(j.in_progress || [])];
      await learnSeries(all.map((t) => [String(t.url || t["@id"] || "").split("/").pop(), "chesscom"]), "listing");
      for (const t of all) {
        const slug = String(t.url || t["@id"] || "").split("/").pop().toLowerCase();
        const series = chesscomSeries(slug);
        if (!series) continue;
        found++;
        rows.push({ platform: "chesscom", tid: slug, series, id_num: idNum(slug), n_players: Math.min(32767, Number(t.total_players) || 0) || null });
      }
      if (rows.length) await upsertPending(rows);
    }
    await rest(
      "PATCH",
      `crawl_source?platform=eq.chesscom&kind=eq.player&key=eq.${enc(src.key)}`,
      { last_polled_at: new Date().toISOString(), last_found: res.status === 200 ? found : -res.status },
      "return=minimal"
    );
    return found;
  }

  // ---------------------------------------------------------------------------
  // Lichess
  // ---------------------------------------------------------------------------
  async function lichessRoster(t) {
    let requests = 0;
    const get = async (url) => {
      requests++;
      return platformGet("lichess", url, { accept: "application/x-ndjson", timeoutMs: 120_000 });
    };
    // Metadata comes with the team listing; a tournament queued another way
    // (a validation target) costs one info request.
    const meta = {};
    if (!t.starts_at) {
      const info = await get(`https://lichess.org/api/swiss/${t.tid}`);
      if (info.status === -1) return { deadline: true, requests };
      if (info.status === 404) return { gone: true, requests };
      if (info.status === 200) {
        const ij = JSON.parse(info.text);
        Object.assign(meta, {
          name: String(ij.name || "").slice(0, 200),
          starts_at: ij.startsAt || null,
          time_control: ij.clock ? `${ij.clock.limit}+${ij.clock.increment}` : null,
        });
        t.n_rounds = t.n_rounds || ij.nbRounds;
      }
    }
    const res = await get(`https://lichess.org/api/swiss/${t.tid}/results`);
    if (res.status === -1) return { deadline: true, requests };
    if (res.status === 404) return { gone: true, requests };
    if (res.status !== 200) return { error: `results ${res.status}`, requests };
    const roster = new Set();
    for (const l of res.text.split("\n")) if (l.trim()) roster.add(String(JSON.parse(l).username || "").toLowerCase());
    const gm = await get(`https://lichess.org/api/swiss/${t.tid}/games?moves=false&tags=false&clocks=false&evals=false&opening=false`);
    if (gm.status === -1) return { deadline: true, requests };
    if (gm.status !== 200) return { error: `games ${gm.status}`, requests };
    const raw = [];
    for (const l of gm.text.split("\n")) {
      if (!l.trim()) continue;
      const g = JSON.parse(l);
      const w = String(g.players?.white?.user?.id || "").toLowerCase();
      const b = String(g.players?.black?.user?.id || "").toLowerCase();
      if (!w || !b) continue;
      roster.add(w);
      roster.add(b);
      const st = String(g.status || "");
      const done = !["noStart", "aborted", "unknownFinish", "created", "started"].includes(st);
      const o = !done ? "" : g.winner === "white" ? "w" : g.winner === "black" ? "l" : st === "draw" || st === "stalemate" ? "d" : "";
      raw.push({ start: Number(g.createdAt) || 0, w, b, o });
    }
    // Swiss rounds: games of one round start within seconds; rounds are minutes apart.
    raw.sort((a, b) => a.start - b.start);
    let round = 0;
    let last = -Infinity;
    const games = raw.map((g) => {
      if (g.start - last > 3 * 60_000) round++;
      last = Math.max(last, g.start);
      return { ...g, round };
    });
    roster.delete("");
    const handles = [...roster].sort();
    const rounds = Math.max(round, Number(t.n_rounds) || 0);
    return { requests, row: { ...meta, n_rounds: rounds, n_players: handles.length, handles, vectors: encodeVectors(handles, games, rounds) } };
  }

  // keepCasual: USCF-rated events are often Lichess-casual, so teams that come from crawl_source
  // keep unrated swisses too; the configured default (DMV) keeps the Lichess-rated filter.
  async function pollLichessTeam(team, series, max, keepCasual = false) {
    const res = await platformGet("lichess", `https://lichess.org/api/team/${team}/swiss?max=${max}`, {
      accept: "application/x-ndjson",
      timeoutMs: 600_000,
    });
    if (res.status !== 200) return -res.status;
    const rows = [];
    for (const l of res.text.split("\n")) {
      if (!l.trim()) continue;
      const t = JSON.parse(l);
      if (t.status !== "finished" || (!t.rated && !keepCasual)) continue;
      rows.push({
        platform: "lichess",
        tid: t.id,
        series,
        id_num: Date.parse(t.startsAt) || 0,
        name: String(t.name || "").slice(0, 200),
        starts_at: t.startsAt,
        n_rounds: t.nbRounds,
        n_players: t.nbPlayers,
        time_control: t.clock ? `${t.clock.limit}+${t.clock.increment}` : null,
      });
    }
    await upsertPending(rows);
    await rest("POST", "crawl_source?on_conflict=platform,kind,key", [{ platform: "lichess", kind: "team", key: team, priority: 1 }], "resolution=merge-duplicates,return=minimal");
    await rest("PATCH", `crawl_source?platform=eq.lichess&kind=eq.team&key=eq.${team}`, { last_polled_at: new Date().toISOString(), last_found: rows.length }, "return=minimal");
    return rows.length;
  }

  // ---------------------------------------------------------------------------
  // Lanes
  // ---------------------------------------------------------------------------
  const stats = {
    chesscom: { done: 0, failed: 0, skipped: 0, requests: 0, polls: 0, discovered: 0 },
    lichess: { done: 0, failed: 0, skipped: 0, requests: 0, polls: 0, discovered: 0 },
  };

  async function nextPending(platform, n = 25) {
    return rest(
      "GET",
      `roster_tournament?select=platform,tid,series,name,n_rounds,starts_at,attempts&platform=eq.${platform}&status=eq.pending&order=priority.desc,id_num.desc&limit=${n}`
    );
  }

  async function store(platform, t, r) {
    const st = stats[platform];
    st.requests += r.requests || 0;
    if (r.deadline) return; // cut off by the deadline: the row stays pending, untouched
    const base = `roster_tournament?platform=eq.${platform}&tid=eq.${enc(t.tid)}`;
    if (r.row) {
      await rest("PATCH", base, { ...r.row, status: "done", requests: r.requests, fetched_at: new Date().toISOString(), last_error: null }, "return=minimal");
      st.done++;
      const nm = r.row.name || t.name;
      if (nm) await learnSeries([[nm, platform]], "index");
    } else if (r.gone) {
      await rest("PATCH", base, { status: "skipped", last_error: "not found", requests: r.requests }, "return=minimal");
      st.skipped++;
    } else if (r.notFinished) {
      await rest("PATCH", base, { priority: -1, last_error: `status ${r.notFinished}`, attempts: (t.attempts || 0) + 1 }, "return=minimal");
    } else {
      const attempts = (t.attempts || 0) + 1;
      await rest("PATCH", base, { attempts, last_error: String(r.error || "error").slice(0, 200), status: attempts >= 3 ? "failed" : "pending" }, "return=minimal");
      if (attempts >= 3) st.failed++;
    }
  }

  async function chesscomLane() {
    if (now() >= deadline) return;
    const existing = await rest("GET", "crawl_source?select=key&platform=eq.chesscom&kind=eq.player&limit=1");
    if (!existing?.length) {
      // Seed sources from every stored Chess.com identity, hubs (most sections) first.
      const edges = await rest("GET", "identity_edge?select=handle,n_sections&platform=eq.chesscom&status=eq.active&limit=5000");
      await upsertSources(edges.map((e) => ({ platform: "chesscom", kind: "player", key: e.handle, priority: e.n_sections })));
      log(`[chesscom] seeded ${edges.length} discovery sources from stored identities`);
    }
    let sinceRefresh = 0;
    let sincePoll = 99;
    while (now() < deadline) {
      const queue = await nextPending("chesscom", 25);
      const backlog = queue?.length || 0;
      // Discovery: one source poll per 5 rosters, or whenever the queue is empty.
      if (backlog === 0 || sincePoll >= 5) {
        const src = await rest(
          "GET",
          `crawl_source?select=key&platform=eq.chesscom&kind=eq.player&or=(last_polled_at.is.null,last_polled_at.lt.${new Date(now() - 24 * 3600_000).toISOString()})&order=last_polled_at.asc.nullsfirst,priority.desc&limit=1`
        );
        if (src?.length) {
          const f = await pollChesscomSource(src[0]);
          stats.chesscom.polls++;
          stats.chesscom.discovered += f;
          sincePoll = 0;
          if (!backlog) continue;
        } else if (!backlog) {
          if (cfg.idleReturn) return;
          log("[chesscom] nothing pending and no source due — idle 10 min");
          await sleep(Math.min(600_000, Math.max(0, deadline - now())));
          continue;
        }
      }
      for (const t of queue) {
        if (now() >= deadline) break;
        const r = await chesscomRoster(t.tid).catch((e) => ({ error: String(e?.message || e), requests: 0 }));
        await store("chesscom", t, r);
        sincePoll++;
        if (++sinceRefresh >= 300) {
          sinceRefresh = 0;
          const n = await rpc("refresh_crawl_source_priority", { p_platform: "chesscom" }).catch(() => null);
          log(`[chesscom] source priorities refreshed (${n} sources)`);
        }
        if (sincePoll >= 5) break; // go back for a discovery poll
      }
    }
  }

  async function lichessLane() {
    if (now() >= deadline) return;
    // Teams: the configured default merged with every crawl_source team row. A team that is
    // only in crawl_source uses its team id as the series label.
    const stored = await rest("GET", "crawl_source?select=key&platform=eq.lichess&kind=eq.team&order=priority.desc,key&limit=1000").catch(() => []);
    const teams = [...LICHESS_TEAMS];
    for (const s of stored || []) if (!teams.some((t) => t.team === s.key)) teams.push({ team: s.key, series: s.key, keepCasual: true });
    for (const { team, series, keepCasual } of teams) {
      if (now() >= deadline) break;
      const src = await rest("GET", `crawl_source?select=last_polled_at&platform=eq.lichess&kind=eq.team&key=eq.${enc(team)}`);
      const last = src?.[0]?.last_polled_at ? Date.parse(src[0].last_polled_at) : 0;
      if (now() - last > 24 * 3600_000) {
        // Full history on the first poll, the newest 100 afterwards.
        const n = await pollLichessTeam(team, series, last || cfg.idleReturn ? 100 : 5000, !!keepCasual);
        stats.lichess.polls++;
        stats.lichess.discovered += Math.max(0, n);
        log(`[lichess] team ${team}: ${n} ${keepCasual ? "" : "rated "}finished swiss listed`);
      }
    }
    while (now() < deadline) {
      const queue = await nextPending("lichess", 25);
      if (!queue?.length) {
        log("[lichess] nothing pending — lane done");
        return;
      }
      for (const t of queue) {
        if (now() >= deadline) break;
        const r = await lichessRoster(t).catch((e) => ({ error: String(e?.message || e), requests: 0 }));
        await store("lichess", t, r);
      }
    }
  }

  return { chesscomLane, lichessLane, stats, pacers };
}
