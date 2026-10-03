// Batch-only model rotation across free tiers (docs/roster-index.md, "Mass
// pre-resolution"): round-robin over whichever providers have a key in the
// environment, with a per-provider pause on 429. Not the production path —
// production's AI_PROXY_* secrets are untouched. Keys come from the
// environment only; nothing here reads or writes a key file.
//
//   OPENROUTER_API_KEY, CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, GROQ_API_KEY
//   node scripts/llm-rotate.mjs --measure 45 [--concurrency 6]   # seconds
//
// import { createRotation } from "./llm-rotate.mjs"; const { chat } = createRotation();
const env = process.env;

export function providers() {
  const out = [];
  if (env.GROQ_API_KEY)
    out.push({ name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: env.GROQ_API_KEY, model: env.GROQ_MODEL || "openai/gpt-oss-120b" });
  if (env.OPENROUTER_API_KEY)
    out.push({ name: "openrouter", url: "https://openrouter.ai/api/v1/chat/completions", key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || "nvidia/nemotron-3-super-120b-a12b:free" });
  if (env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_ACCOUNT_ID)
    out.push({
      name: "cloudflare",
      url: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
      key: env.CLOUDFLARE_API_TOKEN,
      model: env.CLOUDFLARE_MODEL || "@cf/openai/gpt-oss-120b",
    });
  return out;
}

export function createRotation(list = providers()) {
  const state = list.map((p) => ({ ...p, pausedUntil: 0, backoffMs: 5000, ok: 0, limited: 0, failed: 0, tokens: 0 }));
  let turn = 0;
  /** Next provider that is not paused, round-robin; waits when all are. */
  async function pick() {
    for (;;) {
      const now = Date.now();
      for (let i = 0; i < state.length; i++) {
        const p = state[(turn + i) % state.length];
        if (p.pausedUntil <= now) {
          turn = (turn + i + 1) % state.length;
          return p;
        }
      }
      await new Promise((r) => setTimeout(r, Math.max(50, Math.min(...state.map((p) => p.pausedUntil)) - now)));
    }
  }
  async function chat(messages, opts = {}) {
    if (!state.length) throw new Error("no provider key in the environment");
    for (let attempt = 0; attempt < state.length * 3; attempt++) {
      const p = await pick();
      const res = await fetch(p.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: p.model, messages, max_tokens: opts.maxTokens ?? 256, temperature: opts.temperature ?? 0 }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      }).catch(() => null);
      if (res?.status === 429) {
        p.limited++;
        const ra = Number(res.headers.get("retry-after")) * 1000;
        p.pausedUntil = Date.now() + (ra > 0 ? ra : p.backoffMs);
        p.backoffMs = Math.min(60_000, p.backoffMs * 2);
        continue;
      }
      if (!res?.ok) {
        p.failed++;
        p.pausedUntil = Date.now() + 2000;
        continue;
      }
      const j = await res.json().catch(() => null);
      const text = j?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text) {
        // A reasoning model that spent max_tokens thinking returns no content.
        p.failed++;
        p.pausedUntil = Date.now() + 1000;
        continue;
      }
      p.ok++;
      p.backoffMs = 5000;
      p.tokens += j.usage?.total_tokens || 0;
      return { text, provider: p.name, model: p.model, usage: j.usage };
    }
    throw new Error("every provider failed or is rate-limited");
  }
  return { chat, state };
}

const mi = process.argv.indexOf("--measure");
if (mi > 0) {
  const seconds = Number(process.argv[mi + 1]) || 45;
  const ci = process.argv.indexOf("--concurrency");
  const conc = ci > 0 ? Number(process.argv[ci + 1]) : 6;
  const { chat, state } = createRotation();
  const end = Date.now() + seconds * 1000;
  // A prompt the size of a small classification call (~250 tokens in, ~40 out).
  const prompt = "Classify each chess tournament name as USCF-rated online or not, one word each (yes/no):\n" + Array.from({ length: 12 }, (_, i) => `${i + 1}. Friday Night Rated Rapid #${i + 100}`).join("\n");
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (Date.now() < end) await chat([{ role: "user", content: prompt }], { maxTokens: 512 }).catch(() => new Promise((r) => setTimeout(r, 1000)));
    })
  );
  const per = (n) => Math.round((n / seconds) * 60);
  console.log(JSON.stringify({ seconds, concurrency: conc, providers: state.map((p) => ({ name: p.name, model: p.model, okPerMin: per(p.ok), tokensPerMin: per(p.tokens), limited: p.limited, failed: p.failed })), totalOkPerMin: per(state.reduce((s, p) => s + p.ok, 0)), totalTokensPerMin: per(state.reduce((s, p) => s + p.tokens, 0)) }));
}
