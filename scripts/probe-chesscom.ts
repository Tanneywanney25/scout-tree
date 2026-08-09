// ============================================================================
// Phase 0 diagnostic — is the Chess.com archive 5xx a size-correlated,
// deterministic STRUCTURAL failure (as their staff describe) or random flake?
// And do the cheaper endpoints (PGN serializer, time-control archive) or a
// slower request cadence route around it?
//
// This is a STANDALONE measurement tool. It imports nothing from the app; it
// only speaks to api.chess.com's public, key-less, read-only endpoints — the
// exact calls the resolver already makes, just instrumented. Run it once to
// gather real numbers before touching production logic:
//
//   node scripts/probe-chesscom.mjs                 # auto-source heavy accounts
//   node scripts/probe-chesscom.mjs --pairs f.json  # [["user","YYYY","MM"],…]
//   node scripts/probe-chesscom.mjs --n 24 --gap 350
//
// Candidate accounts are drawn from the live leaderboards (the heaviest public
// accounts there are), NOT a hard-coded roster of people — so the sample is
// reproducible and generalizes. Results are written to probe-results.json and
// summarized as a table on stdout.
// ============================================================================

const ARGS = (() => {
  const a = process.argv.slice(2);
  const get = (flag: string, def?: string) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : def;
  };
  return {
    n: Number(get("--n", "20")),
    gapMs: Number(get("--gap", "350")),
    concurrency: Number(get("--conc", "8")),
    pairsFile: get("--pairs"),
    outFile: get("--out", "probe-results.json"),
  };
})();

const UA_COMPLIANT = "ScoutTree/1.0 (chess-scout.vercel.app; contact: probe@example.com)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Attempt {
  variant: string;
  url: string;
  status: number | "ERR";
  statusClass: string; // 2xx | 4xx-404 | 4xx-other | 5xx-500 | 5xx-other | 429 | transport
  ms: number;
  bytes: number;
  games: number | null;
  err?: string;
}

interface PairResult {
  username: string;
  year: string;
  month: string;
  /** total games across all formats from /stats (win+loss+draw). */
  statsTotalGames: number | null;
  attempts: Attempt[];
}

function classify(status: number | "ERR"): string {
  if (status === "ERR") return "transport";
  if (status >= 200 && status < 300) return "2xx";
  if (status === 404) return "4xx-404";
  if (status === 410) return "410";
  if (status === 429) return "429";
  if (status >= 400 && status < 500) return "4xx-other";
  if (status === 500) return "5xx-500";
  if (status >= 500) return "5xx-other";
  return String(status);
}

/** One instrumented GET. Reads the whole body so byte size is real. */
async function probe(variant: string, url: string, useUA: boolean, timeoutMs = 15000): Promise<Attempt> {
  const t = Date.now();
  const headers: Record<string, string> = { Accept: url.endsWith("/pgn") ? "text/plain" : "application/json", "Accept-Encoding": "gzip" };
  if (useUA) headers["User-Agent"] = UA_COMPLIANT;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const buf = await res.arrayBuffer();
    clearTimeout(to);
    const bytes = buf.byteLength;
    let games: number | null = null;
    if (url.endsWith("/pgn")) {
      games = res.ok ? (new TextDecoder().decode(buf).match(/\[Event /g) || []).length : null;
    } else if (res.ok) {
      try {
        const j = JSON.parse(new TextDecoder().decode(buf));
        games = Array.isArray(j?.games) ? j.games.length : null;
      } catch {
        games = null;
      }
    }
    return { variant, url, status: res.status, statusClass: classify(res.status), ms: Date.now() - t, bytes, games };
  } catch (e: any) {
    return { variant, url, status: "ERR", statusClass: "transport", ms: Date.now() - t, bytes: 0, games: null, err: (e?.cause?.code || e?.name || e?.message || "err").toString().slice(0, 40) };
  }
}

async function statsTotalGames(u: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.chess.com/pub/player/${u}/stats`, { headers: { "User-Agent": UA_COMPLIANT } });
    if (!res.ok) return null;
    const s: any = await res.json();
    let total = 0;
    let any = false;
    for (const k of ["chess_rapid", "chess_blitz", "chess_bullet", "chess_daily"]) {
      const rec = s?.[k]?.record;
      if (rec) {
        any = true;
        total += (rec.win || 0) + (rec.loss || 0) + (rec.draw || 0);
      }
    }
    return any ? total : null;
  } catch {
    return null;
  }
}

/** Heavy candidate accounts from the live leaderboards (not a hard-coded roster). */
async function sourceHeavyAccounts(want: number): Promise<string[]> {
  const out = new Set<string>();
  try {
    const res = await fetch("https://api.chess.com/pub/leaderboards", { headers: { "User-Agent": UA_COMPLIANT } });
    if (res.ok) {
      const lb: any = await res.json();
      for (const cat of ["live_bullet", "live_blitz", "live_rapid", "daily"]) {
        for (const row of (lb?.[cat] || []).slice(0, Math.ceil(want / 2))) {
          if (typeof row?.username === "string") out.add(row.username.toLowerCase());
        }
      }
    }
  } catch {
    /* fall through */
  }
  return Array.from(out).slice(0, want);
}

/** The most recent CLOSED month + current month for an account, as [y,m] pairs. */
async function recentMonths(u: string): Promise<{ y: string; m: string }[]> {
  try {
    const res = await fetch(`https://api.chess.com/pub/player/${u}/games/archives`, { headers: { "User-Agent": UA_COMPLIANT } });
    if (!res.ok) return [];
    const j: any = await res.json();
    const urls: string[] = Array.isArray(j?.archives) ? j.archives : [];
    return urls
      .slice(-2)
      .map((url) => {
        const mm = url.match(/\/(\d{4})\/(\d{2})$/);
        return mm ? { y: mm[1], m: mm[2] } : null;
      })
      .filter(Boolean) as { y: string; m: string }[];
  } catch {
    return [];
  }
}

async function buildPairs(): Promise<{ username: string; y: string; m: string }[]> {
  if (ARGS.pairsFile) {
    const fs = await import("node:fs");
    const raw = JSON.parse(fs.readFileSync(ARGS.pairsFile, "utf8")) as [string, string, string][];
    return raw.map(([username, y, m]) => ({ username: username.toLowerCase(), y, m }));
  }
  const accounts = await sourceHeavyAccounts(Math.ceil(ARGS.n / 1.5));
  console.log(`Sourced ${accounts.length} heavy accounts from the leaderboards.`);
  const pairs: { username: string; y: string; m: string }[] = [];
  for (const u of accounts) {
    if (pairs.length >= ARGS.n) break;
    const months = await recentMonths(u);
    for (const { y, m } of months) {
      if (pairs.length >= ARGS.n) break;
      pairs.push({ username: u, y, m });
    }
    await sleep(120);
  }
  return pairs;
}

function variantUrls(u: string, y: string, m: string): { variant: string; url: string; useUA: boolean }[] {
  return [
    { variant: "A_json_ua", url: `https://api.chess.com/pub/player/${u}/games/${y}/${m}`, useUA: true },
    { variant: "B_json_noua", url: `https://api.chess.com/pub/player/${u}/games/${y}/${m}`, useUA: false },
    { variant: "C_pgn", url: `https://api.chess.com/pub/player/${u}/games/${y}/${m}/pgn`, useUA: true },
    // Variant D — the task's hypothesised time-control archive. Tested with a
    // representative blitz TC (180+1). If Chess.com has no such endpoint this
    // records the real status (documenting that the Phase 3 rung can't exist).
    { variant: "D_live_tc", url: `https://api.chess.com/pub/player/${u}/games/live/180/1`, useUA: true },
  ];
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

async function main() {
  console.log(`\n=== Phase 0 probe — origin: Node datacenter (representative of the Supabase Edge Function) ===`);
  console.log(`gap=${ARGS.gapMs}ms  target pairs=${ARGS.n}\n`);

  const pairs = await buildPairs();
  if (!pairs.length) {
    console.error("No username/month pairs to probe (leaderboards unreachable and no --pairs file).");
    process.exit(1);
  }
  console.log(`Probing ${pairs.length} username/month pairs across variants A–D (+ /stats)…\n`);

  const results: PairResult[] = [];
  // --- Variants A–D + stats, run STRICTLY SERIALLY with a polite gap ---------
  for (const { username, y, m } of pairs) {
    const statsTotalGames = await statsTotalGames_cached(username);
    const attempts: Attempt[] = [];
    for (const { variant, url, useUA } of variantUrls(username, y, m)) {
      attempts.push(await probe(variant, url, useUA));
      await sleep(ARGS.gapMs);
    }
    const a = attempts[0];
    console.log(
      `  ${username}/${y}/${m}`.padEnd(34) +
        `stats=${statsTotalGames ?? "?"}`.padEnd(14) +
        attempts.map((x) => `${x.variant.split("_")[0]}:${x.status}/${(x.bytes / 1024 / 1024).toFixed(1)}MB`).join("  ")
    );
    results.push({ username, year: y, month: m, statsTotalGames, attempts });
  }

  // --- Variant E: serial vs concurrency-N, same pairs, variant-A only --------
  console.log(`\n=== Variant E: serial vs concurrency ${ARGS.concurrency} (variant A) ===`);
  const eUrls = pairs.map((p) => ({ u: p.username, url: `https://api.chess.com/pub/player/${p.username}/games/${p.year}/${p.month}` }));

  const tSerial = Date.now();
  const serialAtt: Attempt[] = [];
  for (const { url } of eUrls) {
    serialAtt.push(await probe("E_serial", url, true));
    await sleep(ARGS.gapMs);
  }
  const serialMs = Date.now() - tSerial;

  const tConc = Date.now();
  const concAtt: Attempt[] = [];
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(ARGS.concurrency, eUrls.length) }, async () => {
      while (idx < eUrls.length) {
        const j = idx++;
        concAtt.push(await probe("E_conc", eUrls[j].url, true));
      }
    })
  );
  const concMs = Date.now() - tConc;

  const count5xx = (att: Attempt[]) => att.filter((x) => x.statusClass.startsWith("5xx")).length;
  const count429 = (att: Attempt[]) => att.filter((x) => x.statusClass === "429").length;

  console.log(`  serial:   ${(serialMs / 1000).toFixed(1)}s  5xx=${count5xx(serialAtt)}  429=${count429(serialAtt)}`);
  console.log(`  conc(${ARGS.concurrency}): ${(concMs / 1000).toFixed(1)}s  5xx=${count5xx(concAtt)}  429=${count429(concAtt)}`);

  // --- Analysis --------------------------------------------------------------
  const allA = results.map((r) => r.attempts.find((x) => x.variant === "A_json_ua")!).filter(Boolean);
  const withStats = results.filter((r) => r.statsTotalGames != null);
  const failFlag = (r: PairResult) => {
    const a = r.attempts.find((x) => x.variant === "A_json_ua");
    return a && a.statusClass.startsWith("5xx") ? 1 : 0;
  };
  const rSizeFail = pearson(withStats.map((r) => r.statsTotalGames as number), withStats.map(failFlag));

  // Bucketed 5xx rate by stats weight.
  const buckets: Record<string, { total: number; fail: number }> = {
    "0-1k": { total: 0, fail: 0 },
    "1k-5k": { total: 0, fail: 0 },
    "5k-20k": { total: 0, fail: 0 },
    "20k+": { total: 0, fail: 0 },
  };
  for (const r of withStats) {
    const g = r.statsTotalGames as number;
    const b = g < 1000 ? "0-1k" : g < 5000 ? "1k-5k" : g < 20000 ? "5k-20k" : "20k+";
    buckets[b].total++;
    buckets[b].fail += failFlag(r);
  }

  const cVsA = results.map((r) => {
    const A = r.attempts.find((x) => x.variant === "A_json_ua");
    const C = r.attempts.find((x) => x.variant === "C_pgn");
    return { aFail: A?.statusClass.startsWith("5xx"), cOk: C?.statusClass === "2xx" };
  });
  const cRescues = cVsA.filter((x) => x.aFail && x.cOk).length;
  const aFails = cVsA.filter((x) => x.aFail).length;
  const dStatuses = results.map((r) => r.attempts.find((x) => x.variant === "D_live_tc")?.status);
  const dExists = dStatuses.some((s) => s === 200);

  const maxBytes = Math.max(0, ...allA.map((x) => x.bytes));
  const summary = {
    origin: "node-datacenter (Supabase-Edge-representative)",
    pairsProbed: results.length,
    a5xx: allA.filter((x) => x.statusClass.startsWith("5xx")).length,
    a404: allA.filter((x) => x.statusClass === "4xx-404").length,
    a2xx: allA.filter((x) => x.statusClass === "2xx").length,
    maxArchiveMB: +(maxBytes / 1024 / 1024).toFixed(2),
    pearson_size_vs_5xx: rSizeFail,
    buckets,
    pgnRescuesOfA5xx: `${cRescues}/${aFails}`,
    variantD_liveTC_statuses: Array.from(new Set(dStatuses)),
    variantD_endpointExists: dExists,
    variantE: { serialMs, concMs, serial5xx: count5xx(serialAtt), conc5xx: count5xx(concAtt), serial429: count429(serialAtt), conc429: count429(concAtt) },
  };

  console.log(`\n=== SUMMARY ===`);
  console.log(JSON.stringify(summary, null, 2));

  const fs = await import("node:fs");
  fs.writeFileSync(ARGS.outFile, JSON.stringify({ summary, results, variantE: { serialAtt, concAtt } }, null, 2));
  console.log(`\nWrote ${ARGS.outFile}`);
}

// Memoize /stats so variant E doesn't refetch it.
const statsMemo = new Map<string, Promise<number | null>>();
function statsTotalGames_cached(u: string): Promise<number | null> {
  const hit = statsMemo.get(u);
  if (hit) return hit;
  const p = statsTotalGames(u);
  statsMemo.set(u, p);
  return p;
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
