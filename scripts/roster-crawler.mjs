#!/usr/bin/env node
// ============================================================================
// Roster-index crawler (docs/roster-index.md, Phase 3).
//
// Crawls the complete rosters and per-round result vectors of the online
// tournaments that host the five USCF online-rated series which make up ~80%
// of all online-rated sections, and NOTHING else:
//
//   Chess.com  official US Chess events, WNZ / Waltham, PCA, Grand Prix Rated
//   Lichess    the DMV team's swiss events
//
// Discovery. Chess.com has no public club-tournament list (the club page needs
// a login), but one /pub/player/{h}/tournaments request returns a member's
// whole tournament history. Members are polled hubs-first; every crawled
// roster adds its members as further sources. Lichess: the team's swiss list.
//
// Rosters. Chess.com: the tournament, then /{id}/{round}/1 for each round
// (1 + R requests; the round summary is read only if a group URL 404s).
// Lichess: /api/swiss/{id}/results + /games (2 requests; round from start-time
// clusters). Stored: handles[] and one token per player per round.
//
// Pacing. One request at a time per platform; Chess.com documents serial
// access as unmetered. 1 request/s per platform, halved on any 429 / block and
// paused (Chess.com 10 s doubling, Lichess 60 s doubling — Lichess asks for a
// full minute), and stepped back up after each clean minute.
//
// Resumable by construction: all progress is in Postgres (roster_tournament
// status, crawl_source last_polled_at). A tournament is written in one PATCH
// only when its whole roster is in hand, so a crash, a sleep or a kill
// mid-tournament leaves it 'pending' and it is fetched again; a 'done'
// tournament is never fetched twice.
//
// Usage:
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/roster-crawler.mjs [--hours 4] [--platform chesscom|lichess|both]
//   Optional: CRAWLER_CONTACT (goes in the User-Agent), CRAWLER_RATE (req/s per platform, default 1)
// ============================================================================

import { createCrawler } from "./roster-crawl-core.mjs";

const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!SB || !KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const HOURS = Number(arg("hours", "0")) || 0; // 0 = run until killed
const PLATFORMS = arg("platform", "both");
const TARGET_RATE = Number(process.env.CRAWLER_RATE || "1");
const CONTACT = process.env.CRAWLER_CONTACT || "https://github.com/Tanneywanney25/scout-tree/issues";
const UA = `ScoutTree-RosterIndex/1.0 (+https://chess-scout.vercel.app; contact: ${CONTACT})`;
const DEADLINE = HOURS ? Date.now() + HOURS * 3600_000 : Infinity;
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const { chesscomLane, lichessLane, stats, pacers } = createCrawler({ sbUrl: SB, key: KEY, ua: UA, rate: TARGET_RATE, log, deadline: DEADLINE });

// One crawler at a time (migrations/20261003000300_crawl_lease.sql): an edge
// slice and this process never crawl together. Held for 10 minutes, renewed
// every 4.
const HOLDER = `cli-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
async function lease(fn, args) {
  const headers = { apikey: KEY, "Content-Type": "application/json" };
  if (!KEY.startsWith("sb_")) headers.Authorization = `Bearer ${KEY}`;
  const r = await fetch(`${SB}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) }).catch(() => null);
  return r && r.ok ? r.json().catch(() => null) : null;
}
if ((await lease("take_crawl_lease", { p_holder: HOLDER, p_ttl_seconds: 600 })) !== true) {
  log("another crawler holds the lease (an edge slice or another process) — exiting");
  process.exit(0);
}
const renew = setInterval(() => void lease("take_crawl_lease", { p_holder: HOLDER, p_ttl_seconds: 600 }), 240_000);

const t0 = now();
const ticker = setInterval(() => {
  const m = (now() - t0) / 60_000;
  for (const p of ["chesscom", "lichess"]) {
    const s = stats[p];
    const pc = pacers[p];
    log(
      `[${p}] ${m.toFixed(1)} min: ${s.done} rosters (${s.failed} failed, ${s.skipped} gone), ${pc.sent} requests sent (${(pc.sent / (m * 60)).toFixed(2)}/s), ` +
        `${s.polls} discovery polls (+${s.discovered} series tournaments listed), rate ${pc.rate.toFixed(2)}/s, ${pc.limitEvents} limit events`
    );
  }
}, 300_000);

const lanes = [];
if (PLATFORMS === "both" || PLATFORMS === "chesscom") lanes.push(chesscomLane().catch((e) => log("[chesscom] lane died:", e?.message || e)));
if (PLATFORMS === "both" || PLATFORMS === "lichess") lanes.push(lichessLane().catch((e) => log("[lichess] lane died:", e?.message || e)));
await Promise.all(lanes);
clearInterval(ticker);
clearInterval(renew);
await lease("release_crawl_lease", { p_holder: HOLDER });
log("final", JSON.stringify({ minutes: ((now() - t0) / 60_000).toFixed(1), stats, sent: { chesscom: pacers.chesscom.sent, lichess: pacers.lichess.sent }, limitEvents: { chesscom: pacers.chesscom.limitEvents, lichess: pacers.lichess.limitEvents } }));
