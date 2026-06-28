// Provider-agnostic AI helper for the edge functions.
//
// Uses the Anthropic Messages API by default (no Lovable dependency). Configure
// with the `ANTHROPIC_API_KEY` secret; optionally override the model with
// `AI_MODEL`. These functions are OPTIONAL — the app degrades gracefully if the
// key isn't set (callers catch the error and fall back to non-AI text).

export interface AIResult {
  ok: boolean;
  text: string;
  status: number; // HTTP-ish status for the caller to map (429, 402, 500...)
  error?: string;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export async function callAI(
  system: string,
  prompt: string,
  maxTokens = 250
): Promise<AIResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return { ok: false, text: "", status: 503, error: "ANTHROPIC_API_KEY is not configured" };
  }

  const model = Deno.env.get("AI_MODEL") || DEFAULT_MODEL;

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
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
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
  const text: string =
    data?.content?.map((b: { text?: string }) => b?.text || "").join("") || "";
  return { ok: true, text: text || "", status: 200 };
}
