// Token-gated forwarder that sits in front of SearXNG.
//
// WHY THIS EXISTS: a Cloudflare quick tunnel is reachable by anyone who learns
// the URL, and the URL changes on every restart. Tunnelling raw SearXNG would
// hand the open internet a free search API running on this machine. So the
// tunnel points here (8081), not at SearXNG (8080), and every request must
// carry X-ScoutTree-Token. Anything else gets 401 and never reaches SearXNG.
//
// Zero dependencies on purpose — Node's stdlib only, no account, no billing.
//
//   SEARXNG_TOKEN     required, the shared secret
//   SEARXNG_ORIGIN    upstream SearXNG (default http://127.0.0.1:8080)
//   PORT              listen port (default 8081)

import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const TOKEN = process.env.SEARXNG_TOKEN || "";
const ORIGIN = process.env.SEARXNG_ORIGIN || "http://127.0.0.1:8080";
const PORT = Number(process.env.PORT || 8081);

if (!TOKEN) {
  console.error("FATAL: SEARXNG_TOKEN is not set — refusing to start an open proxy.");
  process.exit(1);
}

/** Constant-time compare that can't leak length through early return. */
function tokenOk(given) {
  if (typeof given !== "string" || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Only the search API and the health root are forwarded. No /config, no
// /preferences, no /stats — nothing that could be used to reconfigure the
// instance through the tunnel.
const ALLOWED_PATHS = new Set(["/", "/search", "/healthz"]);

const server = createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "bad request" }));
  }

  if (!tokenOk(req.headers["x-scouttree-token"])) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "method not allowed" }));
  }
  if (!ALLOWED_PATHS.has(url.pathname)) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }

  const target = `${ORIGIN}${url.pathname}${url.search}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { accept: req.headers.accept || "application/json" },
      signal: ac.signal,
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    });
    res.end(body);
    console.log(`${req.method} ${url.pathname} -> ${upstream.status} ${Date.now() - started}ms`);
  } catch (e) {
    const aborted = e?.name === "AbortError";
    res.writeHead(aborted ? 504 : 502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: aborted ? "upstream timeout" : "upstream unreachable" }));
    console.error(`${req.method} ${url.pathname} -> ${aborted ? 504 : 502}: ${e?.message || e}`);
  } finally {
    clearTimeout(timer);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`searxng-proxy listening on :${PORT} -> ${ORIGIN}`);
});
