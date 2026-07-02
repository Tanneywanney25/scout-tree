// Provider-agnostic AI helper for the edge functions.
//
// Supports Google Gemini (preferred when `GEMINI_API_KEY` is set) and the
// Anthropic Messages API (used when only `ANTHROPIC_API_KEY` is set). Callers
// use a single `callAI(system, prompt, maxTokens)` entry point and don't care
// which provider answered. Every function that uses this is OPTIONAL — the app
// degrades gracefully if no key is configured (callers catch the error and fall
// back to non-AI text).
//
// Configure ONE of:
//   • GEMINI_API_KEY  (+ optional GEMINI_MODEL, default gemini-2.5-flash)
//   • ANTHROPIC_API_KEY (+ optional AI_MODEL, default claude-haiku-4-5-20251001)

export interface AIResult {
  ok: boolean;
  text: string;
  status: number; // HTTP-ish status for the caller to map (429, 402, 500...)
  error?: string;
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

export async function callAI(system: string, prompt: string, maxTokens = 250): Promise<AIResult> {
  const geminiKey = readEnv("GEMINI_API_KEY") || readEnv("GOOGLE_API_KEY");
  if (geminiKey) return callGemini(geminiKey, system, prompt, maxTokens);

  const anthropicKey = readEnv("ANTHROPIC_API_KEY");
  if (anthropicKey) return callAnthropic(anthropicKey, system, prompt, maxTokens);

  return { ok: false, text: "", status: 503, error: "No AI key configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY)" };
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
  const geminiKey = readEnv("GEMINI_API_KEY") || readEnv("GOOGLE_API_KEY");
  if (geminiKey) {
    const res = await callGemini(geminiKey, system, prompt, maxTokens, true);
    if (res.ok || res.status >= 500) return res;
    return callGemini(geminiKey, system, prompt, maxTokens);
  }
  const anthropicKey = readEnv("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    const res = await callAnthropic(anthropicKey, system, prompt, maxTokens, true, opts.maxSearchUses);
    if (res.ok || res.status >= 500) return res;
    return callAnthropic(anthropicKey, system, prompt, maxTokens);
  }
  return { ok: false, text: "", status: 503, error: "No AI key configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY)" };
}

// ---------------------------------------------------------------------------
// Google Gemini (Generative Language API)
// ---------------------------------------------------------------------------

async function callGemini(apiKey: string, system: string, prompt: string, maxTokens: number, withSearch = false): Promise<AIResult> {
  const model = readEnv("GEMINI_MODEL") || GEMINI_DEFAULT_MODEL;

  let response: Response;
  try {
    response = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
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
    return { ok: false, text: "", status: 500, error: e instanceof Error ? e.message : "network error" };
  }

  if (!response.ok) {
    const status = response.status;
    const body = await response.text().catch(() => "");
    return { ok: false, text: "", status, error: `Gemini error ${status}: ${body.slice(0, 200)}` };
  }

  const data = await response.json().catch(() => null);
  const parts = data?.candidates?.[0]?.content?.parts;
  const text: string = Array.isArray(parts) ? parts.map((p: { text?: string }) => p?.text || "").join("") : "";
  return { ok: true, text, status: 200 };
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
    return { ok: false, text: "", status: 500, error: e instanceof Error ? e.message : "network error" };
  }

  if (!response.ok) {
    const status = response.status;
    const body = await response.text().catch(() => "");
    return { ok: false, text: "", status, error: `AI error ${status}: ${body.slice(0, 200)}` };
  }

  const data = await response.json().catch(() => null);
  const text: string = data?.content?.map((b: { text?: string }) => b?.text || "").join("") || "";
  return { ok: true, text: text || "", status: 200 };
}
