// Provider-agnostic AI helper for the edge functions.
//
// THIS MODULE KNOWS NOTHING ABOUT SEARCH. It sends a prompt to whichever
// backend answers and returns the text. Provider TOOLS are supplied by the
// caller as an AiToolSpec and are absent by default, so no call made through
// here attaches a tool unless the caller deliberately passes one. That is a
// deliberate boundary: search tools are quota-metered, this project exhausted
// that quota once already, and a helper that enabled search "for convenience"
// is how it happened. The only caller that passes a tool spec is the
// quota-ledger-gated path in _shared/search/pipeline.ts. Everything else —
// query expansion, result extraction, move explanations, training hints — is
// tool-free and spends only the ordinary free-tier request allowance.
//
// Open-web retrieval now happens in _shared/search/searxng.ts (self-hosted,
// unmetered) rather than by asking a model to search.
//
// Backends, tried in this order (all optional — the app degrades gracefully;
// callers catch the error and fall back to non-AI text):
//   1. AI PROXY — an OpenAI-compatible unified router (e.g. FreeLLMAPI) that
//      pools many free-tier providers behind one key, so one provider's
//      exhausted quota fails over to the next.
//   2. Google Gemini direct (GEMINI_API_KEY).
//   3. Anthropic Messages API (ANTHROPIC_API_KEY).
//
// Configure any of:
//   • AI_PROXY_BASE_URL + AI_PROXY_API_KEY
//     (+ optional AI_PROXY_MODEL, default "auto" — tool-free calls;
//      + optional AI_PROXY_SEARCH_MODEL, default "gemini-3.6-flash" — used only
//        when a caller supplies a tool spec, which must route to a platform
//        that can actually execute it; see AiToolSpec.requireProxyPlatform)
//   • GEMINI_API_KEY  (+ optional GEMINI_MODEL, default gemini-3.6-flash)
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

/**
 * A provider-tool bundle, supplied BY THE CALLER.
 *
 * This module deliberately does not know what a search tool is. Grounding is
 * the scarce, quota-metered capability that this project exhausted once
 * already, so the tool definitions live in the one gated call site that is
 * allowed to use them (_shared/search/pipeline.ts) rather than here, where any
 * caller could reach them. Passing no tools — the default everywhere — means
 * no tool is attached to any provider, on any backend.
 */
export interface AiToolSpec {
  /** Native Gemini `tools` entries, e.g. a grounding tool. */
  gemini: unknown[];
  /** OpenAI-style `tools` entries for the proxy. */
  proxy: unknown[];
  /** Anthropic `tools` entries. */
  anthropic: unknown[];
  /**
   * When set, a proxy reply is trusted ONLY if the proxy reports it routed to
   * this platform. Any other platform received the tool as a plain function
   * tool and did NOT execute it, so the answer would be unfounded.
   */
  requireProxyPlatform?: string;
}

export interface CallOpts {
  /** Omit for an ordinary, tool-free call. */
  tools?: AiToolSpec;
  /** Anthropic server-tool use cap, when the tool spec supports it. */
  maxSearchUses?: number;
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
// Google's current Flash line (its named replacement for the 2.5 Flash family).
// The old default, gemini-2.5-flash, is now served only to projects that were
// already using it (Gemini API changelog, 2026-09-18) and answers other keys
// with a 4xx — which silently took down every AI feature here (username
// discovery, flyer search, AI reasoning) as "AI unavailable (400)".
// Override with GEMINI_MODEL.
const GEMINI_DEFAULT_MODEL = "gemini-3.6-flash";

/**
 * Thinking is pure cost for our strict-JSON extraction prompts, so turn it as
 * far down as each model generation allows: Gemini 2.5 takes a token budget
 * (0 = off), Gemini 3 takes a level ("minimal" is its floor). Anything else
 * gets no thinking config at all — and a 400 that blames the thinking config
 * retries once without it (see callGemini) rather than losing the whole call.
 */
function geminiThinkingConfig(model: string): Record<string, unknown> | undefined {
  if (/^gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-3/.test(model)) return { thinkingLevel: "minimal" };
  return undefined;
}

/**
 * Google's error envelope is {error:{code,message,status,details:[{reason}]}}.
 * Surface the machine reason (API_KEY_INVALID, …) next to the message so a
 * dead key reads as exactly that in the logs / health check, never as a
 * generic "400".
 */
function geminiErrorSummary(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error;
    if (err && typeof err === "object") {
      const reason = Array.isArray(err.details)
        ? err.details.map((d: { reason?: unknown }) => (typeof d?.reason === "string" ? d.reason : "")).find(Boolean)
        : undefined;
      const message = typeof err.message === "string" ? err.message : "";
      const s = `${reason ? `${reason}: ` : ""}${message || err.status || ""}`.trim();
      if (s) return s.slice(0, 200);
    }
  } catch {
    /* not JSON — fall through */
  }
  return body.slice(0, 200);
}

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

/**
 * The single entry point for every model call in the project.
 *
 * Tool-free by default. `opts.tools` is the ONLY way to attach a provider tool,
 * and the only caller that passes one is the quota-gated emergency path in
 * _shared/search/pipeline.ts. Ordinary reasoning (query expansion, extraction,
 * move explanations, training hints) therefore spends no grounding quota at
 * all, which is the entire point of the SearXNG split.
 */
export async function callAI(
  system: string,
  prompt: string,
  maxTokens = 250,
  opts: CallOpts = {}
): Promise<AIResult> {
  const tools = opts.tools;
  const withTools = !!tools;
  const proxy = proxyConfig();
  let proxyErr: AIResult | null = null;

  if (proxy) {
    const res = await callProxy(proxy, system, prompt, maxTokens, tools);
    if (res.ok) return res;
    // Tool-free: a 429 is the pool's honest quota answer, so stop. Anything
    // else (unreachable, empty completion, 5xx) falls through to the direct
    // backends so a bad proxy config can't take AI down entirely.
    if (!withTools && res.status === 429) return res;
    proxyErr = res;
  }

  const geminiKey = readEnv("GEMINI_API_KEY") || readEnv("GOOGLE_API_KEY");
  const anthropicKey = readEnv("ANTHROPIC_API_KEY");

  // With tools, a proxy 429 means the Google quota behind it is spent — and the
  // direct Gemini key draws on that SAME quota, so retrying it would just burn
  // a second unit for nothing. Anthropic is a genuinely separate pool.
  const skipGemini = withTools && proxyErr?.status === 429;

  if (geminiKey && !skipGemini) {
    const res = await callGemini(geminiKey, system, prompt, maxTokens, tools);
    // ok, quota (429) or a Google outage (5xx): that IS the answer. A config
    // failure (dead key, unknown model → other 4xx) must not block a working
    // Anthropic key behind it — before this, one revoked Gemini key silenced
    // every AI feature even with a valid fallback configured.
    if (res.ok || res.status === 429 || res.status >= 500 || !anthropicKey) return res;
    if (withTools) {
      // Other 4xx with a tool attached usually means the model doesn't expose
      // it. The one meaningful retry is the same call with no tool.
      const plain = await callGemini(geminiKey, system, prompt, maxTokens, undefined);
      if (plain.ok || !anthropicKey) return plain;
    }
  }

  if (anthropicKey) {
    const res = await callAnthropic(anthropicKey, system, prompt, maxTokens, tools, opts.maxSearchUses);
    if (res.ok || res.status >= 500 || !withTools) return res;
    return callAnthropic(anthropicKey, system, prompt, maxTokens, undefined);
  }

  if (proxyErr) return proxyErr;
  if (proxy) return { ok: false, text: "", status: 502, error: "AI proxy failed and no direct key configured" };
  return { ok: false, text: "", status: 503, error: "No AI key configured (set AI_PROXY_BASE_URL+AI_PROXY_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY)" };
}

// NOTE: `callAIWithSearch` used to live here. It is gone on purpose. A
// convenience wrapper that silently enabled a quota-metered search tool is how
// grounding got spent from a dozen call sites without anyone counting. Callers
// that genuinely need the open web now go through _shared/search/pipeline.ts,
// which retrieves with SearXNG (unmetered) and reasons with a tool-free model,
// and only reaches for a provider search tool through one ledger-gated path.

// ---------------------------------------------------------------------------
// AI proxy (OpenAI-compatible unified router, e.g. FreeLLMAPI)
//
// Shares the Gemini gate/pacing/backoff/cooldown: the pool has aggregate
// limits too, and its google platform is the SAME quota as GEMINI_API_KEY, so
// pacing them together is exactly right. A final 429 here trips the shared
// cooldown, letting discovery fast-fail the rest of a burst honestly.
// ---------------------------------------------------------------------------

const PROXY_DEFAULT_MODEL = "auto"; // plain calls: let the router pick / fail over
const PROXY_DEFAULT_SEARCH_MODEL = GEMINI_DEFAULT_MODEL; // grounded calls: must route to Google

interface ProxyChatResponse {
  choices?: { message?: { content?: string; tool_calls?: unknown[] } }[];
  _routed_via?: { platform?: string; model?: string };
}

async function callProxy(
  proxy: { baseUrl: string; apiKey: string },
  system: string,
  prompt: string,
  maxTokens: number,
  tools?: AiToolSpec
): Promise<AIResult> {
  const withTools = !!tools?.proxy?.length;
  const model = withTools
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
        // Tools come from the caller; this module does not define any. The
        // proxy may translate a function tool into a provider-native one on
        // the matching platform, which is why the caller can demand a specific
        // routed platform below — a tool handed to the wrong platform is
        // received as an ordinary function tool and never executes.
        ...(withTools ? { tools: tools!.proxy } : {}),
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

  if (withTools) {
    // The caller may require a specific routed platform. A reply routed
    // elsewhere either tried to CALL the tool as a plain function (tool_calls)
    // or answered from parametric memory — both unfounded, both rejected.
    const need = tools!.requireProxyPlatform;
    if (need && routedPlatform !== need) {
      return { ok: false, text: "", status: 502, error: `proxy routed tool call to '${routedPlatform || "unknown"}' (not ${need} — reply would be unfounded)`, backend };
    }
    if (!text && Array.isArray(msg?.tool_calls) && msg.tool_calls.length) {
      return { ok: false, text: "", status: 502, error: "provider returned a tool_call instead of an executed-tool answer", backend };
    }
  }
  if (!text) return { ok: false, text: "", status: 502, error: "AI proxy returned an empty completion", backend };
  return { ok: true, text, status: 200, backend };
}

// ---------------------------------------------------------------------------
// Google Gemini (Generative Language API)
// ---------------------------------------------------------------------------

async function callGemini(
  apiKey: string,
  system: string,
  prompt: string,
  maxTokens: number,
  tools?: AiToolSpec
): Promise<AIResult> {
  const model = readEnv("GEMINI_MODEL") || GEMINI_DEFAULT_MODEL;
  const thinking = geminiThinkingConfig(model);
  const res = await geminiRequest(apiKey, model, system, prompt, maxTokens, tools, thinking);
  // A 400 that blames the thinking config (a model that can't turn thinking
  // off, or a renamed field on a newer generation) is not worth losing the
  // call over: retry once with no thinking config at all.
  if (!res.ok && res.status === 400 && thinking && /thinking/i.test(res.error || "")) {
    return geminiRequest(apiKey, model, system, prompt, maxTokens, tools, undefined);
  }
  return res;
}

async function geminiRequest(
  apiKey: string,
  model: string,
  system: string,
  prompt: string,
  maxTokens: number,
  tools: AiToolSpec | undefined,
  thinkingConfig: Record<string, unknown> | undefined
): Promise<AIResult> {
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
        ...(tools?.gemini?.length ? { tools: tools.gemini } : {}),
        generationConfig: {
          // Give the answer room; Flash spends some budget on hidden "thinking",
          // which we turn down so tokens go to the actual response.
          maxOutputTokens: Math.max(maxTokens, 1024),
          temperature: 0.4,
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      }),
    });
  } catch (e) {
    return { ok: false, text: "", status: 500, error: e instanceof Error ? e.message : "network error", backend: "gemini-direct" };
  }

  if (!response.ok) {
    const status = response.status;
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      text: "",
      status,
      error: `Gemini error ${status} (${model}): ${geminiErrorSummary(body)}`,
      backend: "gemini-direct",
    };
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
  tools?: AiToolSpec,
  maxSearchUses = 3
): Promise<AIResult> {
  const withTools = !!tools?.anthropic?.length;
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
        max_tokens: withTools ? Math.max(maxTokens, 2048) : maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
        // Caller-supplied; a server-tool entry may carry a max_uses the caller
        // left for us to fill in from opts.maxSearchUses.
        ...(withTools
          ? {
              tools: tools!.anthropic.map((t) =>
                t && typeof t === "object" && (t as Record<string, unknown>).max_uses === null
                  ? { ...(t as Record<string, unknown>), max_uses: maxSearchUses }
                  : t
              ),
            }
          : {}),
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
