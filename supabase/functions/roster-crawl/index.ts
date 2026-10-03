// ============================================================================
// roster-crawl — one slice of the roster-index crawler, for a pg_cron schedule
// (docs/roster-index.md, Phase 7.2). Same code as the laptop crawler
// (scripts/roster-crawl-core.mjs); this file only adds the slice boundaries.
//
//   • Caller must present the service-role key (pg_net from pg_cron does).
//   • Takes the crawl lease for the slice, so a laptop crawler and the edge
//     never crawl at once; returns at once if someone else holds it.
//   • Runs the Chess.com and Lichess lanes side by side, serial per platform,
//     until SLICE_MS; a tournament not finished by then stays 'pending'.
//   • Never streams a team's whole history (newest 100 only): the edge's wall
//     clock is 150 s and the first DMV listing took 136 s.
// ============================================================================

import { createCrawler } from "../../../scripts/roster-crawl-core.mjs";

const SLICE_MS = 110_000;
const UA = "ScoutTree-RosterIndex/1.0 (+https://chess-scout.vercel.app; contact: https://github.com/Tanneywanney25/scout-tree/issues)";

Deno.serve(async (req) => {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!key || auth !== key) return new Response(JSON.stringify({ ok: false, error: "service role only" }), { status: 401 });

  const holder = `edge-${crypto.randomUUID().slice(0, 8)}`;
  const rpc = (fn: string, args: Record<string, unknown>) =>
    fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    }).then((r) => (r.ok ? r.json() : null));
  const got = await rpc("take_crawl_lease", { p_holder: holder, p_ttl_seconds: Math.ceil(SLICE_MS / 1000) + 30 });
  if (got !== true) return new Response(JSON.stringify({ ok: true, skipped: "lease held elsewhere" }), { status: 200 });

  const t0 = Date.now();
  const lines: string[] = [];
  const crawler = createCrawler({
    sbUrl: url,
    key,
    ua: UA,
    rate: 1,
    deadline: t0 + SLICE_MS,
    idleReturn: true,
    log: (...a: unknown[]) => lines.push(a.map(String).join(" ").slice(0, 200)),
  });
  try {
    await Promise.all([crawler.chesscomLane(), crawler.lichessLane()]);
  } finally {
    await rpc("release_crawl_lease", { p_holder: holder }).catch(() => null);
  }
  const out = {
    ok: true,
    ms: Date.now() - t0,
    stats: crawler.stats,
    sent: { chesscom: crawler.pacers.chesscom.sent, lichess: crawler.pacers.lichess.sent },
    limitEvents: { chesscom: crawler.pacers.chesscom.limitEvents, lichess: crawler.pacers.lichess.limitEvents },
    log: lines.slice(-10),
  };
  console.log("[roster-crawl]", JSON.stringify({ ms: out.ms, stats: out.stats, sent: out.sent }));
  return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
});
