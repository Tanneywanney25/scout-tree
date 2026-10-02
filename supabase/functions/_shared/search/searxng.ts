// ============================================================================
// SearXNG retrieval client — the unmetered half of the search pipeline.
//
// This replaces "ask the model to search for us". SearXNG is self-hosted, has
// no API key and no per-query cost, so retrieval is effectively unlimited; the
// model never touches the open web, it only reasons over what comes back here.
//
// REACHABILITY: deployed edge functions run in Supabase's cloud and cannot see
// localhost, so they go through a Cloudflare quick tunnel. But a LOCAL
// `supabase functions serve` runs on the same machine as the container, so it
// should skip the tunnel entirely — hence SEARXNG_LOCAL_URL is preferred when
// set. Both point at the token shim (tools/searxng-proxy), never at SearXNG
// directly: a quick-tunnel hostname is reachable by anyone who learns it.
//
//   SEARXNG_LOCAL_URL  preferred when present (e.g. http://127.0.0.1:8081)
//   SEARXNG_URL        public tunnel URL for deployed functions
//   SEARXNG_TOKEN      shared secret -> X-ScoutTree-Token
//
// PARTIAL FAILURE IS NORMAL, NOT AN ERROR: Google and Bing block datacenter IPs
// under load, so some engines answer "too many requests" on any given query.
// SearXNG aggregates whatever succeeded, so a query with 3 of 5 engines
// reporting is a good result. Nothing here throws on partial data; a totally
// failed query returns an empty list and the caller decides.
// ============================================================================

import { readEnv } from "../ai.ts";

export interface SearchHit {
  title: string;
  url: string;
  /** The result snippet. Often the only text we ever read for a page. */
  content: string;
  /** Which engine produced it — useful when triaging a bad result set. */
  engine?: string;
}

export interface SearxngStatus {
  configured: boolean;
  /** Which endpoint was used. */
  via: "local" | "tunnel" | "none";
  unresponsiveEngines: string[];
}

function endpoint(): { url: string; token: string; via: "local" | "tunnel" } | null {
  const token = readEnv("SEARXNG_TOKEN") || "";
  const local = readEnv("SEARXNG_LOCAL_URL");
  const remote = readEnv("SEARXNG_URL");
  const base = local || remote;
  if (!base || !token) return null;
  return { url: base.replace(/\/+$/, ""), token, via: local ? "local" : "tunnel" };
}

export function searxngConfigured(): boolean {
  return endpoint() !== null;
}

/**
 * Normalize a URL for de-duplication: the same page reached via http/https,
 * with or without a trailing slash, or carrying tracking params, must collapse
 * to ONE hit — otherwise near-duplicates eat the result budget we hand the
 * model.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref|mc_|_ga)/i.test(p)) u.searchParams.delete(p);
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/\/$/, "");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One SearXNG query. Returns an empty list on any failure — never throws. */
async function queryOnce(
  ep: { url: string; token: string },
  q: string,
  timeoutMs: number,
  unresponsive: Set<string>,
  log?: (m: string) => void
): Promise<SearchHit[]> {
  const target = `${ep.url}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      headers: { "X-ScoutTree-Token": ep.token, Accept: "application/json" },
      signal: ac.signal,
    });
    if (!res.ok) {
      log?.(`SearXNG ${res.status} for "${q}"`);
      return [];
    }
    const data = await res.json().catch(() => null);
    // Record which engines failed so the caller can report honestly rather
    // than mistaking an engine outage for "the web has no answer".
    if (Array.isArray(data?.unresponsive_engines)) {
      for (const e of data.unresponsive_engines) {
        const name = Array.isArray(e) ? e[0] : e;
        if (typeof name === "string") unresponsive.add(name);
      }
    }
    const rows = Array.isArray(data?.results) ? data.results : [];
    const out: SearchHit[] = [];
    for (const r of rows) {
      const url = typeof r?.url === "string" ? r.url : "";
      if (!url) continue;
      out.push({
        title: typeof r.title === "string" ? r.title.slice(0, 300) : "",
        url,
        content: typeof r.content === "string" ? r.content.slice(0, 1000) : "",
        engine: typeof r.engine === "string" ? r.engine : undefined,
      });
    }
    return out;
  } catch (e) {
    log?.(`SearXNG failed for "${q}": ${e instanceof Error ? e.message : e}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface MultiSearchResult {
  hits: SearchHit[];
  status: SearxngStatus;
  queriesRun: number;
}

/**
 * Run several queries concurrently and merge them.
 *
 * `maxResults` exists because the merged set becomes the model's context in the
 * next step; ~25 snippets keeps that inside a small token budget. Results are
 * interleaved round-robin across queries BEFORE truncation, so one broad query
 * cannot crowd out the narrow ones that are usually more diagnostic.
 */
export async function searxngSearchMany(
  queries: string[],
  opts: { maxResults?: number; concurrency?: number; timeoutMs?: number; log?: (m: string) => void } = {}
): Promise<MultiSearchResult> {
  const ep = endpoint();
  const unresponsive = new Set<string>();
  if (!ep) {
    return { hits: [], status: { configured: false, via: "none", unresponsiveEngines: [] }, queriesRun: 0 };
  }
  const uniqueQueries = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  if (!uniqueQueries.length) {
    return { hits: [], status: { configured: true, via: ep.via, unresponsiveEngines: [] }, queriesRun: 0 };
  }

  const maxResults = opts.maxResults ?? 25;
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const timeoutMs = opts.timeoutMs ?? 20_000;

  const perQuery: SearchHit[][] = new Array(uniqueQueries.length).fill(null).map(() => []);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueQueries.length) }, async () => {
      while (idx < uniqueQueries.length) {
        const my = idx++;
        perQuery[my] = await queryOnce(ep, uniqueQueries[my], timeoutMs, unresponsive, opts.log);
        await sleep(50); // gentle on the local instance
      }
    })
  );

  // Round-robin interleave, de-duplicating by normalized URL.
  const seen = new Set<string>();
  const merged: SearchHit[] = [];
  const depth = Math.max(0, ...perQuery.map((p) => p.length));
  for (let d = 0; d < depth && merged.length < maxResults; d++) {
    for (let q = 0; q < perQuery.length && merged.length < maxResults; q++) {
      const hit = perQuery[q][d];
      if (!hit) continue;
      const key = normalizeUrl(hit.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hit);
    }
  }

  return {
    hits: merged,
    status: { configured: true, via: ep.via, unresponsiveEngines: [...unresponsive] },
    queriesRun: uniqueQueries.length,
  };
}

/**
 * Fetch one page's readable text. Used only for step 4 (a truncated USCF MSA
 * page or crosstable), capped at one call per request — it is the single most
 * expensive step and the least often needed.
 */
export async function fetchPageText(url: string, maxChars = 12_000, timeoutMs = 15_000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "ScoutTree/1.0 (+identity resolution)",
      },
      signal: ac.signal,
    });
    if (!res.ok) return "";
    const html = await res.text();
    // Crude but dependency-free: drop scripts/styles, strip tags, collapse ws.
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
