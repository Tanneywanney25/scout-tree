// Provider-agnostic AI helper for the edge functions.
//
// Backends, tried in this order (all optional — the app degrades gracefully;
// callers catch the error and fall back to non-AI text):
//   1. AI PROXY — an OpenAI-compatible unified router (e.g. FreeLLMAPI) that
//      pools many free-tier providers behind one key, so one provider's
//      exhausted quota fails over to the next. Gemini google_search GROUNDING
//      passes through it: an OpenAI `function` tool named `google_search` is
//      translated by the proxy into Gemini's native grounding tool, so grounded
//      calls must pin a Google-platform model (AI_PROXY_SEARCH_MODEL). A
//      grounded reply is trusted ONLY when the proxy reports it was routed via
//      the google platform — any other platform received `google_search` as a
//      plain function tool and did NOT search, so we fall through instead of
//      returning ungrounded guesses (the namesake bug).
//   2. Google Gemini direct (GEMINI_API_KEY).
//   3. Anthropic Messages API (ANTHROPIC_API_KEY).
//
// Configure any of:
//   • AI_PROXY_BASE_URL + AI_PROXY_API_KEY
//     (+ optional AI_PROXY_MODEL, default "auto" — plain calls;
//      + optional AI_PROXY_SEARCH_MODEL, default "gemini-2.5-flash" — grounded
//        calls; MUST be a model the proxy routes to Google for grounding)
//   • GEMINI_API_KEY  (+ optional GEMINI_MODEL, default gemini-2.5-flash)
//   • ANTHROPIC_API_KEY (+ optional AI_MODEL, default claude-haiku-4-5-20251001)
//
// NOTE: a localhost AI_PROXY_BASE_URL only works where that proxy runs (the
// dev machine / CLI harness). Production (Supabase edge) must either point at
// a cloud-reachable proxy or leave AI_PROXY_* unset and use the direct keys.

export interface AIResult {
  ok: boolean;
  text: string;
  status: number; // HTTP-ish status for the caller to map (429, 402, 500...)
  error?: string;
  /** Which backend actually served the call — "proxy:<platform>/<model>",
   *  "gemini-direct", or "anthropic". Callers log this so quota triage can
   *  tell WHERE a discovery answer (or a 429) came from. */
  backend?: string;
}

/** Environment lookup that works in Deno (edge functions) and Node (CLI harness). */
export function readEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(n: string): string | undefined } } }).Deno;
  if (deno?.env?.get) {
    try {
      const v = deno.env.get(name);
      if (v) return v;
    } catch {
      /* permission denied — fall through */
    }
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Gemini rate-limit discipline (shared by EVERY Gemini call in the process)
//
// The traversal fans out dozens of discovery calls at once; Gemini's free tier
// answers a burst with 429s. Left unpaced, ONE burst exhausts the per-minute
// quota and every seed silently falls back to name-guessing. Observed: 12
// concurrent grounded calls → 10 return 429 immediately, 2 succeed. So every
// Gemini request now funnels through here:
//   • a concurrency GATE (only GEMINI_MAX_CONCURRENCY requests in flight),
//   • light inter-call spacing (so N calls don't start on the same tick),
//   • bounded retry with exponential backoff + jitter on 429/5xx, honouring
//     Retry-After, capped by GEMINI_RETRY_BUDGET_MS so a DEAD quota fails fast
//     instead of hanging the traversal,
//   • a short process-wide COOLDOWN once the quota is proven exhausted, so the
//     other 39 calls in the burst fail fast (and the caller logs it ONCE)
//     rather than each re-hitting the wall.
//
// CAVEAT: a module-level limiter only paces calls WITHIN one process/isolate —
// exactly right for the Node CLI harness (single process) and effective for a
// warm Supabase edge isolate, but NOT a distributed limiter across cold
// isolates. The CSE backend (its own quota, see googleSearch.ts) is the durable
// production fix for scale; this keeps the Gemini path from self-immolating.
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function envInt(name: string, dflt: number): number {
  const raw = readEnv(name);
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const GEMINI_MAX_CONCURRENCY = envInt("GEMINI_MAX_CONCURRENCY", 3);
const GEMINI_SPACING_MS = envInt("GEMINI_SPACING_MS", 500);
const GEMINI_RETRY_BUDGET_MS = envInt("GEMINI_RETRY_BUDGET_MS", 25_000);
const GEMINI_ATTEMPT_TIMEOUT_MS = envInt("GEMINI_ATTEMPT_TIMEOUT_MS", 30_000);
const GEMINI_COOLDOWN_MS = envInt("GEMINI_COOLDOWN_MS", 60_000);

// Concurrency gate — net.ts's proven counting-semaphore pattern, inlined so this
// file stays dependency-free (it is imported by both Deno and Node).
let geminiActive = 0;
const geminiWaiters: (() => void)[] = [];
function geminiAcquire(): Promise<void> {
  return new Promise((resolve) => {
    if (geminiActive < GEMINI_MAX_CONCURRENCY) {
      geminiActive++;
      resolve();
    } else {
      geminiWaiters.push(() => {
        geminiActive++;
        resolve();
      });
    }
  });
}
function geminiRelease(): void {
  geminiActive--;
  const next = geminiWaiters.shift();
  if (next) next();
}

// Global pacer — spaces successive Gemini calls so a fan-out doesn't fire them
// all on the same tick.
let geminiNextSlot = 0;
async function geminiPace(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, geminiNextSlot - now);
  geminiNextSlot = Math.max(now, geminiNextSlot) + GEMINI_SPACING_MS;
  if (wait > 0) await sleep(wait);
}

// Process-wide cooldown: set the moment the quota is PROVEN exhausted (a 429
// that survived every retry). Read by callers (googleSearch) so the rest of a
// burst fast-fails to name-guess and the exhaustion is logged exactly once.
let geminiCooldownUntil = 0;
export function geminiQuotaCoolingDown(): boolean {
  return Date.now() < geminiCooldownUntil;
}

/** Exponential backoff with jitter, clamped to what's left of the retry budget. */
function backoffMs(attempt: number, deadline: number): number {
  const base = 1500 * Math.pow(2, attempt); // 1.5s, 3s, 6s, 12s…
  const jitter = base * 0.25 * Math.random();
  return Math.min(base + jitter, Math.max(250, deadline - Date.now()));
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * Fetch the Gemini API with the concurrency gate, spacing, per-attempt timeout
 * and bounded backoff-retry applied. Returns the final Response — ok, or the
 * last 429/5xx once the retry budget is spent. On a proven-exhausted quota it
 * trips the process-wide cooldown so the rest of the burst can fail fast.
 */
async function geminiFetch(url: string, init: RequestInit): Promise<Response> {
  await geminiAcquire();
  try {
    const deadline = Date.now() + GEMINI_RETRY_BUDGET_MS;
    let attempt = 0;
    for (;;) {
      await geminiPace();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GEMINI_ATTEMPT_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: controller.signal });
      } catch (e) {
        clearTimeout(timer);
        // Timeout / transient network error: retry within budget, else rethrow.
        if (Date.now() >= deadline || attempt >= 4) throw e;
        await sleep(backoffMs(attempt++, deadline));
        continue;
      }
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && Date.now() < deadline && attempt < 5) {
        const wait = Math.min(
          retryAfterMs(res) ?? backoffMs(attempt, deadline),
          Math.max(0, deadline - Date.now())
        );
        try {
          await res.body?.cancel(); // free the throwaway error body / socket
        } catch {
          /* ignore */
        }
        attempt++;
        await sleep(wait);
        continue;
      }
      if (res.status === 429) {
        // Retries spent and still throttled: the quota is exhausted for now.
        geminiCooldownUntil = Date.now() + GEMINI_COOLDOWN_MS;
      }
      return res;
    }
  } finally {
    geminiRelease();
  }
}

function proxyConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = readEnv("AI_PROXY_BASE_URL");
  const apiKey = readEnv("AI_PROXY_API_KEY");
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

export async function callAI(system: string, prompt: string, maxTokens = 250): Promise<AIResult> {
  const proxy = proxyConfig();
  if (proxy) {
    const res = await callProxy(proxy, system, prompt, maxTokens, false);
    // ok, or the whole pool is rate-limited (429 = honest quota answer): done.
    // Anything else (proxy unreachable, empty completion, 5xx) falls through to
    // the direct backends so a bad proxy config can't take AI down entirely.
    if (res.ok || res.status === 429) return res;
  }

  const geminiKey = readEnv("GEMINI_API_KEY") || readEnv("GOOGLE_API_KEY");
  if (geminiKey) return callGemini(geminiKey, system, prompt, maxTokens);

  const anthropicKey = readEnv("ANTHROPIC_API_KEY");
  if (anthropicKey) return callAnthropic(anthropicKey, system, prompt, maxTokens);

  if (proxy) return { ok: false, text: "", status: 502, error: "AI proxy failed and no direct key configured" };
  return { ok: false, text: "", status: 503, error: "No AI key configured (set AI_PROXY_BASE_URL+AI_PROXY_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY)" };
}

/**
 * Like `callAI`, but with the provider's live web-search tool enabled (Gemini
 * google_search grounding / Anthropic web_search). Used to look up tournament
 * flyers, TLAs and announcements on the open web. Falls back to a plain call
 * if the search-enabled request is rejected (e.g. tool not available on the
 * configured model).
 */
export async function callAIWithSearch(
  system: string,
  prompt: string,
  maxTokens = 1024,
  opts: { maxSearchUses?: number } = {}
): Promise<AIResult> {
  const proxy = proxyConfig();
  let proxyErr: AIResult | null = null;
  if (proxy) {
    const res = await callProxy(proxy, system, prompt, maxTokens, true);
    if (res.ok) return res;
    proxyErr = res;
    // A proxy 429 means the Google grounding quota behind it is spent. The
    // direct Gemini key shares that same quota, so skip it — but Anthropic
    // web_search is a genuinely separate pool, so let it take over below.
  }

  const geminiKey = readEnv("GEMINI_API_KEY") || readEnv("GOOGLE_API_KEY");
  if (geminiKey && proxyErr?.status !== 429) {
    const res = await callGemini(geminiKey, system, prompt, maxTokens, true);
    // ok / server error / quota (429): return as-is. A 429 is the QUOTA, not a
    // "tool unavailable" signal — retrying the same key without google_search
    // would just burn a second quota unit for nothing (and hasten exhaustion).
    if (res.ok || res.status >= 500 || res.status === 429) return res;
    // Other 4xx (e.g. the configured model doesn't expose google_search): the
    // one meaningful fallback is a plain, un-grounded call.
    return callGemini(geminiKey, system, prompt, maxTokens);
  }
  const anthropicKey = readEnv("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    const res = await callAnthropic(anthropicKey, system, prompt, maxTokens, true, opts.maxSearchUses);
    if (res.ok || res.status >= 500) return res;
    return callAnthropic(anthropicKey, system, prompt, maxTokens);
  }
  if (proxyErr) return proxyErr;
  return { ok: false, text: "", status: 503, error: "No AI key configured (set AI_PROXY_BASE_URL+AI_PROXY_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY)" };
}

// ---------------------------------------------------------------------------
// AI proxy (OpenAI-compatible unified router, e.g. FreeLLMAPI)
//
// Shares the Gemini gate/pacing/backoff/cooldown: the pool has aggregate
// limits too, and its google platform is the SAME quota as GEMINI_API_KEY, so
// pacing them together is exactly right. A final 429 here trips the shared
// cooldown, letting discovery fast-fail the rest of a burst honestly.
// ---------------------------------------------------------------------------

const PROXY_DEFAULT_MODEL = "auto"; // plain calls: let the router pick / fail over
const PROXY_DEFAULT_SEARCH_MODEL = "gemini-2.5-flash"; // grounded calls: must route to Google

interface ProxyChatResponse {
  choices?: { message?: { content?: string; tool_calls?: unknown[] } }[];
  _routed_via?: { platform?: string; model?: string };
}

async function callProxy(
  proxy: { baseUrl: string; apiKey: string },
  system: string,
  prompt: string,
  maxTokens: number,
  withSearch: boolean
): Promise<AIResult> {
  const model = withSearch
    ? readEnv("AI_PROXY_SEARCH_MODEL") || PROXY_DEFAULT_SEARCH_MODEL
    : readEnv("AI_PROXY_MODEL") || PROXY_DEFAULT_MODEL;

  let response: Response;
  try {
    response = await geminiFetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${proxy.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        // Room for hidden "thinking" (Gemini burns budget on it before any
        // visible text): a tiny max_tokens yields an EMPTY completion, which
        // the proxy counts as a model failure and answers with a cooldown.
        max_tokens: Math.max(maxTokens, 1024),
        temperature: 0.4,
        // The proxy translates an OpenAI function tool named `google_search`
        // into Gemini's native grounding tool on its google platform. Other
        // platforms would receive it as a REAL function tool — detected and
        // rejected below, because answering without searching is guessing.
        ...(withSearch
          ? { tools: [{ type: "function", function: { name: "google_search", description: "Google Search grounding", parameters: { type: "object", properties: {} } } }] }
          : {}),
      }),
    });
  } catch (e) {
    return { ok: false, text: "", status: 500, error: e instanceof Error ? e.message : "network error", backend: "proxy" };
  }

  if (!response.ok) {
    const status = response.status;
    const body = await response.text().catch(() => "");
    return { ok: false, text: "", status, error: `AI proxy error ${status}: ${body.slice(0, 200)}`, backend: "proxy" };
  }

  const data = (await response.json().catch(() => null)) as ProxyChatResponse | null;
  const routedPlatform = data?._routed_via?.platform || "";
  const routedModel = data?._routed_via?.model || model;
  const backend = `proxy:${routedPlatform || "unknown"}/${routedModel}`;

  const msg = data?.choices?.[0]?.message;
  const text = typeof msg?.content === "string" ? msg.content : "";

  if (withSearch) {
    // Grounding only exists on the google platform. A reply routed anywhere
    // else either tried to CALL google_search as a function (tool_calls) or
    // answered from parametric memory — both are ungrounded, both rejected.
    if (routedPlatform !== "google") {
      return { ok: false, text: "", status: 502, error: `proxy routed grounded call to '${routedPlatform || "unknown"}' (not google — reply would be ungrounded)`, backend };
    }
    if (!text && Array.isArray(msg?.tool_calls) && msg.tool_calls.length) {
      return { ok: false, text: "", status: 502, error: "provider returned a google_search tool_call instead of a grounded answer", backend };
    }
  }
  if (!text) return { ok: false, text: "", status: 502, error: "AI proxy returned an empty completion", backend };
  return { ok: true, text, status: 200, backend };
}

// ---------------------------------------------------------------------------
// Google Gemini (Generative Language API)
// ---------------------------------------------------------------------------

async function callGemini(apiKey: string, system: string, prompt: string, maxTokens: number, withSearch = false): Promise<AIResult> {
  const model = readEnv("GEMINI_MODEL") || GEMINI_DEFAULT_MODEL;

  let response: Response;
  try {
    response = await geminiFetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(withSearch ? { tools: [{ google_search: {} }] } : {}),
        generationConfig: {
          // Give the answer room; Flash spends some budget on hidden "thinking",
          // which we disable so tokens go to the actual response.
          maxOutputTokens: Math.max(maxTokens, 1024),
          temperature: 0.4,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
  } catch (e) {
    return { ok: false, text: "", status: 500, error: e instanceof Error ? e.message : "network error", backend: "gemini-direct" };
  }

  if (!response.ok) {
    const status = response.status;
    const body = await response.text().catch(() => "");
    return { ok: false, text: "", status, error: `Gemini error ${status}: ${body.slice(0, 200)}`, backend: "gemini-direct" };
  }

  const data = await response.json().catch(() => null);
  const parts = data?.candidates?.[0]?.content?.parts;
  const text: string = Array.isArray(parts) ? parts.map((p: { text?: string }) => p?.text || "").join("") : "";
  return { ok: true, text, status: 200, backend: "gemini-direct" };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

async function callAnthropic(
  apiKey: string,
  system: string,
  prompt: string,
  maxTokens: number,
  withSearch = false,
  maxSearchUses = 3
): Promise<AIResult> {
  const model = readEnv("AI_MODEL") || ANTHROPIC_DEFAULT_MODEL;

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: withSearch ? Math.max(maxTokens, 2048) : maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
        ...(withSearch ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: maxSearchUses }] } : {}),
      }),
    });
  } catch (e) {
    return { ok: false, text: "", status: 500, error: e instanceof Error ? e.message : "network error", backend: "anthropic" };
  }

  if (!response.ok) {
    const status = response.status;
    const body = await response.text().catch(() => "");
    return { ok: false, text: "", status, error: `AI error ${status}: ${body.slice(0, 200)}`, backend: "anthropic" };
  }

  const data = await response.json().catch(() => null);
  const text: string = data?.content?.map((b: { text?: string }) => b?.text || "").join("") || "";
  return { ok: true, text: text || "", status: 200, backend: "anthropic" };
}
