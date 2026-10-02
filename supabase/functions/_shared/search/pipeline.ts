// ============================================================================
// The cooperative search pipeline: Gemini and SearXNG doing DIFFERENT jobs.
//
// The old design asked one model to both retrieve and reason — that is what
// Grounding-with-Google-Search is — and it died when the grounding quota ran
// out (and on the free tier, Gemini 3.x does not offer grounding at all). The
// two jobs are separable, and separating them makes retrieval free:
//
//   SearXNG  does RETRIEVAL. Self-hosted, no key, no per-query cost.
//   Gemini   does REASONING, called with NO search tool, so it spends only the
//            ordinary free-tier request allowance and ZERO grounding quota.
//
// They cooperate rather than fall back on each other: Gemini writes the queries
// (step 1) and interprets the results (step 3); SearXNG fetches (step 2).
//
// Order matters and is the whole point:
//   0. cache          — never pay for the same retrieval twice (before ANY net)
//   1. expand         — Gemini, ungrounded: 1 intent -> 3-5 targeted queries
//   2. retrieve       — SearXNG, parallel, merged + de-duplicated, capped ~25
//   3. extract/rank   — Gemini, ungrounded: answer ONLY from supplied results,
//                       every claim cites a result index, "insufficient
//                       evidence" is a required available output
//   4. one page fetch — optional, max ONE, when the decisive snippet is cut off
//   5. grounding      — EMERGENCY ONLY, behind a hard quota-ledger gate
//
// Nothing in steps 0-4 can touch the grounding tool. Step 5 is the only path
// that can, and it asks the ledger first and fails CLOSED.
// ============================================================================

import { callAI, type AIResult, type AiToolSpec } from "../ai.ts";
import {
  searxngSearchMany,
  searxngConfigured,
  fetchPageText,
  type SearchHit,
  type SearxngStatus,
} from "./searxng.ts";
import {
  searchCacheGet,
  searchCachePut,
  groundingAllowed,
  incrementQuota,
  type CacheKind,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Defensive JSON parsing
//
// Models wrap JSON in prose and code fences no matter how firmly told not to.
// Every parse in this file goes through here, and a failure is never fatal —
// callers fall back to something useful instead of throwing.
// ---------------------------------------------------------------------------

export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  // Try the object and the array framings; take whichever starts first.
  const candidates: Array<[number, number]> = [];
  const ob = stripped.indexOf("{");
  const cb = stripped.lastIndexOf("}");
  if (ob !== -1 && cb > ob) candidates.push([ob, cb]);
  const oa = stripped.indexOf("[");
  const ca = stripped.lastIndexOf("]");
  if (oa !== -1 && ca > oa) candidates.push([oa, ca]);
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [start, end] of candidates) {
    try {
      return JSON.parse(stripped.slice(start, end + 1)) as T;
    } catch {
      /* try the next framing */
    }
  }
  return null;
}

function contextLines(context?: Record<string, unknown>): string {
  if (!context) return "";
  const out: string[] = [];
  for (const [k, v] of Object.entries(context)) {
    if (v === undefined || v === null || `${v}`.trim() === "") continue;
    out.push(`${k}: ${v}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Step 1 — query expansion (Gemini, ungrounded, free)
// ---------------------------------------------------------------------------

const EXPAND_SYSTEM =
  "You turn one research intent into a small set of high-yield web search queries. " +
  "You know search operators (site:, quoted phrases) and you prefer precise, " +
  "site-restricted queries over broad ones. You output strict JSON only.";

/**
 * One intent becomes 3-5 targeted queries. Falls back to the raw intent as a
 * single-element array whenever the model is unavailable or unparseable — the
 * pipeline must never lose retrieval just because expansion failed.
 */
export async function expandQueries(
  intent: string,
  context?: Record<string, unknown>,
  log?: (m: string) => void
): Promise<{ queries: string[]; geminiCalls: number }> {
  const ctx = contextLines(context);
  const prompt = `Produce 3 to 5 web search queries that would find the answer to this intent.

INTENT:
${intent}
${ctx ? `\nKNOWN CONTEXT:\n${ctx}` : ""}

Guidance:
- Favour site-restricted queries for the authoritative sources, e.g.
  site:uschess.org/msa, site:new.uschess.org, site:chess.com, site:lichess.org.
- Include at least one query aimed at state-affiliate crosstables or tournament
  flyers/announcements, which often name a player next to their handle.
- Vary the framing; near-identical queries waste the retrieval budget.
- Quote exact names.

Return STRICT JSON only, no prose and no code fences:
{"queries":["query one","query two","query three"]}`;

  const ai = await callAI(EXPAND_SYSTEM, prompt, 400);
  if (ai.ok) void incrementQuota("gemini_generate");
  if (!ai.ok) {
    log?.(`query expansion unavailable (${ai.status}) — using the raw intent`);
    return { queries: [intent], geminiCalls: 0 };
  }
  const parsed = parseJsonLoose<{ queries?: unknown }>(ai.text);
  const raw = Array.isArray(parsed?.queries) ? parsed!.queries : [];
  const queries = raw
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!queries.length) {
    log?.("query expansion returned nothing usable — using the raw intent");
    return { queries: [intent], geminiCalls: 1 };
  }
  log?.(`expanded into ${queries.length} queries via ${ai.backend || "?"}`);
  return { queries, geminiCalls: 1 };
}

// ---------------------------------------------------------------------------
// Steps 0 + 2 — cache, then parallel retrieval
// ---------------------------------------------------------------------------

export interface RetrieveRequest {
  intent: string;
  context?: Record<string, unknown>;
  /** Skip expansion and use these verbatim (still cached and merged). */
  seedQueries?: string[];
  /** 'identity' caches permanently; 'web' gets the 30 day TTL. */
  cacheKind?: CacheKind;
  maxResults?: number;
  log?: (m: string) => void;
}

export interface RetrieveResult {
  hits: SearchHit[];
  queries: string[];
  fromCache: boolean;
  status: SearxngStatus;
  geminiCalls: number;
}

/**
 * The cache key is the INTENT (plus context), not the expanded queries, so a
 * repeat of the same request skips expansion as well as retrieval — a true
 * zero-network, zero-model repeat.
 */
function cacheSeed(req: RetrieveRequest): string {
  return `${req.intent}||${contextLines(req.context)}||${(req.seedQueries || []).join("|")}`;
}

export async function retrieve(req: RetrieveRequest): Promise<RetrieveResult> {
  const log = req.log;
  const seed = cacheSeed(req);

  // Step 0: cache before ANY network call.
  const cached = await searchCacheGet(seed, log);
  if (cached && cached.length) {
    return {
      hits: cached,
      queries: req.seedQueries || [req.intent],
      fromCache: true,
      status: { configured: searxngConfigured(), via: "none", unresponsiveEngines: [] },
      geminiCalls: 0,
    };
  }

  if (!searxngConfigured()) {
    log?.("SearXNG not configured (SEARXNG_URL/SEARXNG_LOCAL_URL + SEARXNG_TOKEN)");
    return {
      hits: [],
      queries: [],
      fromCache: false,
      status: { configured: false, via: "none", unresponsiveEngines: [] },
      geminiCalls: 0,
    };
  }

  // Step 1: expansion (skipped when the caller supplied its own ladder).
  let queries: string[];
  let geminiCalls = 0;
  if (req.seedQueries?.length) {
    queries = req.seedQueries.slice(0, 8);
  } else {
    const ex = await expandQueries(req.intent, req.context, log);
    queries = ex.queries;
    geminiCalls += ex.geminiCalls;
  }

  // Step 2: parallel retrieval.
  const merged = await searxngSearchMany(queries, { maxResults: req.maxResults ?? 25, log });
  if (merged.status.unresponsiveEngines.length) {
    log?.(`engines unresponsive (query still succeeded): ${merged.status.unresponsiveEngines.join(", ")}`);
  }
  log?.(`retrieved ${merged.hits.length} hits from ${merged.queriesRun} queries via ${merged.status.via}`);

  if (merged.hits.length) void searchCachePut(seed, merged.hits, req.cacheKind ?? "web");

  return { hits: merged.hits, queries, fromCache: false, status: merged.status, geminiCalls };
}

// ---------------------------------------------------------------------------
// Step 3 — extraction and ranking (Gemini, ungrounded, free)
// ---------------------------------------------------------------------------

function renderHits(hits: SearchHit[]): string {
  return hits
    .map((h, i) => `[${i}] ${h.title}\n    url: ${h.url}\n    ${h.content || "(no snippet)"}`)
    .join("\n");
}

const EXTRACT_SYSTEM =
  "You extract facts from a supplied list of search results and nothing else. " +
  "You never use prior knowledge, you never guess, and you never invent an " +
  "identifier that does not literally appear in the supplied results. Every " +
  "claim cites the index of the result it came from. When the results do not " +
  "support a conclusion you say so explicitly. You output strict JSON only.";

export interface ReasonResult<T> {
  ok: boolean;
  data: T | null;
  /** True when the model explicitly reported insufficient evidence. */
  insufficient: boolean;
  raw: string;
  geminiCalls: number;
  status: number;
}

/**
 * Ask the model for strict JSON derived ONLY from `hits`.
 *
 * `schemaHint` is the caller's JSON shape; this function adds the evidence
 * discipline (cite indices, allow an explicit insufficient-evidence answer) so
 * every caller inherits the same guardrail against invented usernames.
 */
export async function reasonOverHits<T>(
  task: string,
  schemaHint: string,
  hits: SearchHit[],
  opts: { maxTokens?: number; context?: Record<string, unknown>; log?: (m: string) => void } = {}
): Promise<ReasonResult<T>> {
  if (!hits.length) {
    return { ok: false, data: null, insufficient: true, raw: "", geminiCalls: 0, status: 204 };
  }
  const ctx = contextLines(opts.context);
  const prompt = `${task}
${ctx ? `\nKNOWN CONTEXT:\n${ctx}` : ""}

SEARCH RESULTS (the ONLY permitted source of facts):
${renderHits(hits)}

Rules:
- Use ONLY the results above. Do not use anything you know from training.
- Every item you report must cite the index of the result that supports it.
- A value that merely LOOKS plausible is not evidence. If no result ties the
  value to the subject, do not report it.
- If the results do not support a conclusion, return
  {"insufficient_evidence": true, "note": "<what is missing>"} and nothing else.

Return STRICT JSON only, no prose and no code fences:
${schemaHint}`;

  const ai = await callAI(EXTRACT_SYSTEM, prompt, opts.maxTokens ?? 1200);
  if (ai.ok) void incrementQuota("gemini_generate");
  if (!ai.ok) {
    opts.log?.(`extraction unavailable (${ai.status}, backend ${ai.backend || "?"})`);
    return { ok: false, data: null, insufficient: false, raw: "", geminiCalls: 0, status: ai.status };
  }
  const parsed = parseJsonLoose<Record<string, unknown>>(ai.text);
  if (parsed && parsed.insufficient_evidence === true) {
    opts.log?.(`model reported insufficient evidence: ${String(parsed.note || "").slice(0, 160)}`);
    return { ok: true, data: null, insufficient: true, raw: ai.text, geminiCalls: 1, status: 200 };
  }
  return {
    ok: parsed !== null,
    data: (parsed as T) ?? null,
    insufficient: false,
    raw: ai.text,
    geminiCalls: 1,
    status: 200,
  };
}

// ---------------------------------------------------------------------------
// Step 4 — one optional page fetch
// ---------------------------------------------------------------------------

/** Pages worth spending the single page-fetch budget on. */
function isAuthoritativePage(url: string): boolean {
  return /uschess\.org\/(msa|players)|msa\.uschess\.org|XtblMain|crosstable|TnmtHst/i.test(url);
}

/**
 * If the decisive result is a USCF MSA page or a crosstable whose snippet is
 * clearly truncated, read that ONE page in full and re-run step 3 over it.
 * Returns null when no fetch was warranted, so the caller keeps its step-3
 * answer.
 */
export async function deepenWithPageFetch<T>(
  task: string,
  schemaHint: string,
  hits: SearchHit[],
  opts: { maxTokens?: number; context?: Record<string, unknown>; log?: (m: string) => void } = {}
): Promise<ReasonResult<T> | null> {
  const target = hits.find((h) => isAuthoritativePage(h.url));
  if (!target) return null;
  // A short snippet is the signal that the page holds more than we were shown.
  if ((target.content || "").length > 500) return null;

  opts.log?.(`fetching one full page for depth: ${target.url}`);
  const text = await fetchPageText(target.url);
  if (!text || text.length < 200) {
    opts.log?.("page fetch returned too little text — keeping the snippet-based answer");
    return null;
  }
  const asHit: SearchHit = {
    title: target.title || target.url,
    url: target.url,
    content: text,
    engine: "page-fetch",
  };
  return reasonOverHits<T>(task, schemaHint, [asHit], opts);
}

// ---------------------------------------------------------------------------
// Step 5 — emergency grounding, hard-gated
//
// THE ONLY place in the codebase that may attach the google_search tool. It
// asks the quota ledger first and fails CLOSED when the ledger is unreachable,
// because an uncountable budget is exactly how the original exhaustion
// happened. Every call that does go out is counted before it is made.
// ---------------------------------------------------------------------------

/**
 * The provider search tools. These literals live HERE and nowhere else: ai.ts
 * deliberately knows nothing about search tools, so the only way any model call
 * in this project can reach one is through the quota-gated function below.
 */
const SEARCH_TOOLS: AiToolSpec = {
  // Gemini's native grounding tool.
  gemini: [{ google_search: {} }],
  // The proxy translates an OpenAI function tool of this name into Gemini's
  // native grounding tool — but only on its google platform, hence the
  // requireProxyPlatform gate: anywhere else it is an inert function tool.
  proxy: [
    {
      type: "function",
      function: {
        name: "google_search",
        description: "Google Search grounding",
        parameters: { type: "object", properties: {} },
      },
    },
  ],
  // Anthropic's server-side web search. max_uses: null is filled in by ai.ts
  // from opts.maxSearchUses.
  anthropic: [{ type: "web_search_20250305", name: "web_search", max_uses: null }],
  requireProxyPlatform: "google",
};

export async function emergencyGroundedSearch(
  system: string,
  prompt: string,
  maxTokens = 1200,
  log?: (m: string) => void
): Promise<AIResult | null> {
  if (!(await groundingAllowed(log))) return null;
  // Count BEFORE the call: a crash mid-call must not yield a free retry.
  const used = await incrementQuota("gemini_grounding");
  log?.(`EMERGENCY grounded search (grounding calls today: ${used ?? "?"})`);
  const res = await callAI(system, prompt, maxTokens, { tools: SEARCH_TOOLS, maxSearchUses: 5 });
  if (!res.ok) log?.(`emergency grounded search failed (${res.status}): ${res.error || "no detail"}`);
  return res;
}
