var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// api/refresh-chess-cookie.ts
var refresh_chess_cookie_exports = {};
__export(refresh_chess_cookie_exports, {
  config: () => config,
  default: () => handler
});
module.exports = __toCommonJS(refresh_chess_cookie_exports);

// supabase/functions/_shared/chessCookie.ts
function readEnv(name) {
  const deno = globalThis.Deno;
  if (deno?.env?.get) {
    try {
      const v = deno.env.get(name);
      if (v) return v;
    } catch {
    }
  }
  const proc = globalThis.process;
  return proc?.env?.[name];
}
var DROP_COOKIES = /* @__PURE__ */ new Set(["OptanonConsent", "OptanonAlertBoxClosed", "usprivacy"]);
function parseCookiePairs(cookieHeader) {
  const out = /* @__PURE__ */ new Map();
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out.set(name, value);
  }
  return out;
}
function parseSetCookies(setCookies) {
  const out = /* @__PURE__ */ new Map();
  for (const line of setCookies) {
    const first = line.split(";", 1)[0] ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name && value && value.toLowerCase() !== "deleted") out.set(name, value);
  }
  return out;
}
function getSetCookieList(res) {
  const h = res.headers;
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}
function mergeCookies(base, updates) {
  const out = new Map(base);
  for (const [k, v] of updates) out.set(k, v);
  for (const d of DROP_COOKIES) out.delete(d);
  return out;
}
function formatCookieHeader(map) {
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}
var SESSION_COOKIE_NAMES = ["PHPSESSID", "CHESSCOM_REMEMBERME", "ACCESS_TOKEN", "__cf_bm"];
function sessionCookieSummary(map) {
  const present = SESSION_COOKIE_NAMES.filter((n) => map.has(n));
  return `${map.size} cookie(s)${present.length ? ` incl. ${present.join(", ")}` : ""}`;
}
var COOKIE_KEY = "chesscom";
function supabaseRest() {
  const url = readEnv("SUPABASE_URL") || readEnv("VITE_SUPABASE_URL");
  const key = readEnv("SUPABASE_SERVICE_ROLE_KEY") || readEnv("SUPABASE_SERVICE_KEY") || readEnv("SUPABASE_SECRET_KEY");
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ""), key };
}
async function getCachedChesscomCookie() {
  const rest = supabaseRest();
  if (!rest) return null;
  try {
    const res = await fetch(
      `${rest.url}/rest/v1/chess_cookies?key=eq.${COOKIE_KEY}&select=cookie,source,updated_at&limit=1`,
      { headers: { apikey: rest.key, Authorization: `Bearer ${rest.key}`, Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    const row = Array.isArray(rows) ? rows[0] : void 0;
    if (!row?.cookie) return null;
    return { cookie: row.cookie, source: row.source, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}
async function putChesscomCookie(cookie, source) {
  const rest = supabaseRest();
  if (!rest) return false;
  try {
    const res = await fetch(`${rest.url}/rest/v1/chess_cookies?on_conflict=key`, {
      method: "POST",
      headers: {
        apikey: rest.key,
        Authorization: `Bearer ${rest.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({ key: COOKIE_KEY, cookie, source, updated_at: (/* @__PURE__ */ new Date()).toISOString() })
    });
    return res.ok;
  } catch {
    return false;
  }
}
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function keepAlive(username, current, log) {
  const url = `https://www.chess.com/callback/friends/${encodeURIComponent(username)}/top-friends`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        Cookie: formatCookieHeader(current),
        Referer: `https://www.chess.com/member/${username}/friends`
      },
      redirect: "manual"
    });
  } catch (e) {
    log(`keep-alive: network error (${e instanceof Error ? e.message : "error"}).`);
    return null;
  }
  if (res.status === 401 || res.status === 403) {
    log(`keep-alive: session is no longer valid (HTTP ${res.status}).`);
    return null;
  }
  if (!res.ok) {
    log(`keep-alive: unexpected HTTP ${res.status} \u2014 treating the session as unconfirmed.`);
    return null;
  }
  const refreshed = mergeCookies(current, parseSetCookies(getSetCookieList(res)));
  log(`keep-alive: session valid \u2014 ${sessionCookieSummary(refreshed)}.`);
  return refreshed;
}
async function credentialLogin(username, password, log) {
  let page;
  try {
    page = await fetch("https://www.chess.com/login", {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      redirect: "manual"
    });
  } catch (e) {
    log(`login: could not load the login page (${e instanceof Error ? e.message : "error"}).`);
    return null;
  }
  if (!page.ok) {
    log(`login: login page returned HTTP ${page.status}.`);
    return null;
  }
  const cookies = parseSetCookies(getSetCookieList(page));
  const html = await page.text();
  const csrf = /name="_token"[^>]*\bvalue="([^"]+)"/i.exec(html)?.[1];
  if (!csrf) {
    log("login: no CSRF _token on the login page \u2014 chess.com markup changed; aborting login.");
    return null;
  }
  const turnstile = readEnv("CHESSCOM_TURNSTILE_TOKEN") || "";
  if (!turnstile) {
    log(
      "login: no CHESSCOM_TURNSTILE_TOKEN supplied. chess.com gates /login with Cloudflare Turnstile, so a headless credential POST will usually be rejected. (This function does not bypass bot-checks.)"
    );
  }
  const body = new URLSearchParams({
    _username: username,
    _password: password,
    _token: csrf,
    _remember_me: "on",
    turnstile_token: turnstile
  });
  let res;
  try {
    res = await fetch("https://www.chess.com/login_check", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: formatCookieHeader(cookies),
        Referer: "https://www.chess.com/login",
        Origin: "https://www.chess.com"
      },
      body: body.toString(),
      redirect: "manual"
    });
  } catch (e) {
    log(`login: POST /login_check failed (${e instanceof Error ? e.message : "error"}).`);
    return null;
  }
  const merged = mergeCookies(cookies, parseSetCookies(getSetCookieList(res)));
  const location = res.headers.get("location") || "";
  if (res.status >= 300 && res.status < 400 && location && !/\/login(\b|_check|\?)/i.test(location)) {
    log(`login: /login_check redirected to ${location} \u2014 credentials accepted, validating session\u2026`);
    return merged;
  }
  if (res.status === 200 || /\/login/i.test(location)) {
    log(
      `login: /login_check did not establish a session (HTTP ${res.status}${location ? `, \u2192${location}` : ""}). Likely Turnstile or bad credentials.`
    );
    return null;
  }
  log(`login: unexpected /login_check response HTTP ${res.status} \u2014 validating anyway\u2026`);
  return merged;
}
async function refreshChesscomCookie(log = () => {
}) {
  const username = readEnv("CHESS_COM_USERNAME") || readEnv("CHESSCOM_USERNAME");
  const password = readEnv("CHESS_COM_PASSWORD") || readEnv("CHESSCOM_PASSWORD");
  const maxAttempts = 3;
  const cached = await getCachedChesscomCookie();
  const seedStr = cached?.cookie || readEnv("CHESSCOM_COOKIE") || readEnv("CHESSCOM_SESSION") || "";
  const seed = parseCookiePairs(seedStr);
  if (username && seed.size) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const refreshed = await keepAlive(username, seed, log);
      if (refreshed) {
        const cookie = formatCookieHeader(refreshed);
        const stored = await putChesscomCookie(cookie, "keepalive");
        log(stored ? "Stored refreshed cookie (keep-alive)." : "WARNING: keep-alive succeeded but the store write failed.");
        return { ok: true, source: "keepalive", cookieSummary: sessionCookieSummary(refreshed), stored };
      }
      if (attempt < maxAttempts) await sleep(500 * 2 ** (attempt - 1));
    }
    log("Keep-alive could not confirm the existing session \u2014 trying a credential login.");
  } else if (!seed.size) {
    log("No existing cookie to keep alive (cache empty and no CHESSCOM_COOKIE seed).");
  }
  if (!username || !password) {
    const msg2 = "No CHESS_COM_USERNAME / CHESS_COM_PASSWORD configured \u2014 cannot log in.";
    log(msg2);
    return { ok: false, source: "none", error: msg2 };
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const loggedIn = await credentialLogin(username, password, log);
    if (loggedIn) {
      const confirmed = await keepAlive(username, loggedIn, log) || loggedIn;
      const cookie = formatCookieHeader(confirmed);
      const stored = await putChesscomCookie(cookie, "login");
      log(stored ? "Stored refreshed cookie (login)." : "WARNING: login succeeded but the store write failed.");
      return { ok: true, source: "login", cookieSummary: sessionCookieSummary(confirmed), stored };
    }
    if (attempt < maxAttempts) await sleep(1e3 * 2 ** (attempt - 1));
  }
  const msg = "Could not refresh the Chess.com session. Keep-alive found no valid session and credential login was rejected (most likely Cloudflare Turnstile on /login). Re-seed CHESSCOM_COOKIE from a real browser session, or supply CHESSCOM_TURNSTILE_TOKEN.";
  log(`ALERT: ${msg}`);
  return { ok: false, source: "none", error: msg };
}

// api/refresh-chess-cookie.ts
var config = { maxDuration: 60 };
async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers["authorization"];
    const provided = Array.isArray(auth) ? auth[0] : auth;
    if (provided !== `Bearer ${secret}`) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
  }
  const logs = [];
  const log = (m) => {
    logs.push(m);
    console.log("[refresh-chess-cookie]", m);
  };
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  try {
    const result = await refreshChesscomCookie(log);
    res.setHeader("Cache-Control", "no-store");
    res.status(result.ok ? 200 : 502).json({ startedAt, ...result, logs });
  } catch (e) {
    const error = e instanceof Error ? e.message : "unknown error";
    log(`FATAL: ${error}`);
    res.status(500).json({ ok: false, source: "none", error, logs });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  config
});
