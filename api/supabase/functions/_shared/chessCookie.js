"use strict";
// ============================================================================
// Chess.com session-cookie store + refresher (shared, runtime-agnostic).
//
// The identity resolver needs an AUTHENTICATED Chess.com session cookie to read
// members' friends lists (the endpoint 401s anonymously). That cookie used to be
// a hand-set CHESSCOM_COOKIE env var that silently expired. This module makes it
// self-healing:
//
//   • WRITER  — a scheduled Vercel function (api/refresh-chess-cookie) calls
//     refreshChesscomCookie() to keep a live session alive and store the fresh
//     Cookie string in the `chess_cookies` Supabase table.
//   • READER  — the resolve-identity edge function (school.ts) calls
//     readChesscomSessionCookie(), which reads that table first and falls back to
//     the CHESSCOM_COOKIE env var (local dev / before the first refresh).
//
// Storage is the `chess_cookies` table, reached over the Supabase REST API with
// the SERVICE ROLE key (the table is RLS-locked with no policies, so only the
// service role can touch the secret). Plain fetch only — no SDK — so the same
// file runs in Deno (edge) and Node 18+ (Vercel) unchanged.
//
// IMPORTANT — Cloudflare Turnstile: chess.com's /login form is protected by
// Cloudflare Turnstile (a `turnstile_token` field). Fully-headless credential
// login therefore only succeeds when Turnstile is non-interactive for the caller
// (or an operator supplies a token via CHESSCOM_TURNSTILE_TOKEN). This module
// does NOT and MUST NOT solve or bypass that bot-check. The reliable path is
// KEEP-ALIVE: seed a real browser session once (CHESSCOM_COOKIE), then this
// refresher extends it on a schedule so it never expires.
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.readEnv = readEnv;
exports.parseCookiePairs = parseCookiePairs;
exports.parseSetCookies = parseSetCookies;
exports.getSetCookieList = getSetCookieList;
exports.mergeCookies = mergeCookies;
exports.formatCookieHeader = formatCookieHeader;
exports.sessionCookieSummary = sessionCookieSummary;
exports.getCachedChesscomCookie = getCachedChesscomCookie;
exports.putChesscomCookie = putChesscomCookie;
exports.readChesscomSessionCookie = readChesscomSessionCookie;
exports.resetCookieMemo = resetCookieMemo;
exports.refreshChesscomCookie = refreshChesscomCookie;
/** Env lookup that works in Deno (edge) and Node (Vercel / CLI). */
function readEnv(name) {
    const deno = globalThis.Deno;
    if (deno?.env?.get) {
        try {
            const v = deno.env.get(name);
            if (v)
                return v;
        }
        catch {
            /* permission denied — fall through */
        }
    }
    const proc = globalThis.process;
    return proc?.env?.[name];
}
// ---------------------------------------------------------------------------
// Cookie parsing / formatting (pure — unit-tested in scripts/test-chess-cookie)
// ---------------------------------------------------------------------------
// A cookie NAME must look like a token; VALUE we keep verbatim (already URL-safe
// as chess.com sends it). Analytics/consent cookies are harmless to forward, but
// we drop a few obviously-useless ones to keep the header lean.
const DROP_COOKIES = new Set(["OptanonConsent", "OptanonAlertBoxClosed", "usprivacy"]);
/** Parse a "Cookie:" header value ("a=1; b=2") into name→value. */
function parseCookiePairs(cookieHeader) {
    const out = new Map();
    if (!cookieHeader)
        return out;
    for (const part of cookieHeader.split(/;\s*/)) {
        const eq = part.indexOf("=");
        if (eq <= 0)
            continue;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name)
            out.set(name, value);
    }
    return out;
}
/** Parse a list of Set-Cookie header lines into name→value (the pair before the
 *  first ";" of each line; attributes like Path/Expires/HttpOnly are dropped). */
function parseSetCookies(setCookies) {
    const out = new Map();
    for (const line of setCookies) {
        const first = line.split(";", 1)[0] ?? "";
        const eq = first.indexOf("=");
        if (eq <= 0)
            continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        // A cleared cookie ("deleted"/empty value) should not overwrite a good one.
        if (name && value && value.toLowerCase() !== "deleted")
            out.set(name, value);
    }
    return out;
}
/** Read Set-Cookie lines off a Response across runtimes. Headers.getSetCookie()
 *  is the correct multi-value accessor (available in Node 18.14+ and Deno);
 *  header.get("set-cookie") joins with ", " and would corrupt Expires dates. */
function getSetCookieList(res) {
    const h = res.headers;
    if (typeof h.getSetCookie === "function")
        return h.getSetCookie();
    const single = res.headers.get("set-cookie");
    return single ? [single] : [];
}
/** Merge cookie updates onto a base map (updates win); dropped names removed. */
function mergeCookies(base, updates) {
    const out = new Map(base);
    for (const [k, v] of updates)
        out.set(k, v);
    for (const d of DROP_COOKIES)
        out.delete(d);
    return out;
}
/** Format name→value back into a "Cookie:" header string. */
function formatCookieHeader(map) {
    return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}
/** The cookie names that actually matter for an authenticated chess.com request,
 *  surfaced for logging ("did we capture a session?"). */
const SESSION_COOKIE_NAMES = ["PHPSESSID", "CHESSCOM_REMEMBERME", "ACCESS_TOKEN", "__cf_bm"];
function sessionCookieSummary(map) {
    const present = SESSION_COOKIE_NAMES.filter((n) => map.has(n));
    return `${map.size} cookie(s)${present.length ? ` incl. ${present.join(", ")}` : ""}`;
}
// ---------------------------------------------------------------------------
// Supabase REST store (service role — the table is RLS-locked)
// ---------------------------------------------------------------------------
const COOKIE_KEY = "chesscom";
function supabaseRest() {
    const url = readEnv("SUPABASE_URL") || readEnv("VITE_SUPABASE_URL");
    const key = readEnv("SUPABASE_SERVICE_ROLE_KEY") ||
        readEnv("SUPABASE_SERVICE_KEY") ||
        readEnv("SUPABASE_SECRET_KEY");
    if (!url || !key)
        return null;
    return { url: url.replace(/\/+$/, ""), key };
}
/** Read the cached cookie row from Supabase, or null (no store configured / no
 *  row / request failed — the caller then falls back to the env var). */
async function getCachedChesscomCookie() {
    const rest = supabaseRest();
    if (!rest)
        return null;
    try {
        const res = await fetch(`${rest.url}/rest/v1/chess_cookies?key=eq.${COOKIE_KEY}&select=cookie,source,updated_at&limit=1`, { headers: { apikey: rest.key, Authorization: `Bearer ${rest.key}`, Accept: "application/json" } });
        if (!res.ok)
            return null;
        const rows = (await res.json());
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row?.cookie)
            return null;
        return { cookie: row.cookie, source: row.source, updatedAt: row.updated_at };
    }
    catch {
        return null;
    }
}
/** Upsert the fresh cookie into Supabase. Returns false when no store is
 *  configured or the write failed (the caller logs it). */
async function putChesscomCookie(cookie, source) {
    const rest = supabaseRest();
    if (!rest)
        return false;
    try {
        const res = await fetch(`${rest.url}/rest/v1/chess_cookies?on_conflict=key`, {
            method: "POST",
            headers: {
                apikey: rest.key,
                Authorization: `Bearer ${rest.key}`,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates,return=minimal",
            },
            body: JSON.stringify({ key: COOKIE_KEY, cookie, source, updated_at: new Date().toISOString() }),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
const REFRESH_MEMO_MS = 60000;
// Memoize only the DB lookup (the round-trip we want to avoid once per crawl).
// The env var is re-read fresh every call — it's free, and tests toggle it.
let cacheMemo = null;
async function cachedCookieMemoized() {
    const now = Date.now();
    if (cacheMemo && now - cacheMemo.at < REFRESH_MEMO_MS)
        return cacheMemo.value;
    const value = await getCachedChesscomCookie();
    cacheMemo = { at: now, value };
    return value;
}
/** The authenticated Chess.com cookie for the resolver: the refreshed value from
 *  the cache when present, otherwise the CHESSCOM_COOKIE / CHESSCOM_SESSION env
 *  var (local dev / before the first refresh), otherwise none. */
async function readChesscomSessionCookie() {
    const cached = await cachedCookieMemoized();
    if (cached?.cookie) {
        const ageMs = cached.updatedAt ? Math.max(0, Date.now() - Date.parse(cached.updatedAt)) : undefined;
        return { cookie: cached.cookie, source: "cache", ageMs };
    }
    const env = readEnv("CHESSCOM_COOKIE") || readEnv("CHESSCOM_SESSION");
    return env ? { cookie: env, source: "env" } : { cookie: "", source: "none" };
}
/** TEST: clear the memoized DB lookup so a harness sees fresh state each run. */
function resetCookieMemo() {
    cacheMemo = null;
}
// ---------------------------------------------------------------------------
// Refresher — keep an existing session alive; fall back to a credential login.
// ---------------------------------------------------------------------------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Validate a cookie by hitting an endpoint that 401s without a live session —
 *  the service account's own friends list, i.e. the exact capability we need.
 *  Returns the merged (refreshed) cookies on success, or null. */
async function keepAlive(username, current, log) {
    const url = `https://www.chess.com/callback/friends/${encodeURIComponent(username)}/top-friends`;
    let res;
    try {
        res = await fetch(url, {
            headers: {
                "User-Agent": UA,
                Accept: "application/json",
                Cookie: formatCookieHeader(current),
                Referer: `https://www.chess.com/member/${username}/friends`,
            },
            redirect: "manual",
        });
    }
    catch (e) {
        log(`keep-alive: network error (${e instanceof Error ? e.message : "error"}).`);
        return null;
    }
    if (res.status === 401 || res.status === 403) {
        log(`keep-alive: session is no longer valid (HTTP ${res.status}).`);
        return null;
    }
    if (!res.ok) {
        log(`keep-alive: unexpected HTTP ${res.status} — treating the session as unconfirmed.`);
        return null;
    }
    // Still logged in — fold any rotated cookies (__cf_bm, a re-issued PHPSESSID)
    // back in so the stored value stays current.
    const refreshed = mergeCookies(current, parseSetCookies(getSetCookieList(res)));
    log(`keep-alive: session valid — ${sessionCookieSummary(refreshed)}.`);
    return refreshed;
}
/** Best-effort credential login. Honest about Turnstile: it sends the CSRF token
 *  and (only if the operator provided one) a turnstile_token, but never solves
 *  the bot-check. Returns the captured cookies on apparent success, else null. */
async function credentialLogin(username, password, log) {
    // 1. GET the login page: collect its cookies and the _token CSRF value.
    let page;
    try {
        page = await fetch("https://www.chess.com/login", {
            headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
            redirect: "manual",
        });
    }
    catch (e) {
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
        log("login: no CSRF _token on the login page — chess.com markup changed; aborting login.");
        return null;
    }
    const turnstile = readEnv("CHESSCOM_TURNSTILE_TOKEN") || "";
    if (!turnstile) {
        log("login: no CHESSCOM_TURNSTILE_TOKEN supplied. chess.com gates /login with Cloudflare Turnstile, " +
            "so a headless credential POST will usually be rejected. (This function does not bypass bot-checks.)");
    }
    // 2. POST the credentials to /login_check. redirect:manual so we can read the
    //    Set-Cookie on the 302.
    const body = new URLSearchParams({
        _username: username,
        _password: password,
        _token: csrf,
        _remember_me: "on",
        turnstile_token: turnstile,
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
                Origin: "https://www.chess.com",
            },
            body: body.toString(),
            redirect: "manual",
        });
    }
    catch (e) {
        log(`login: POST /login_check failed (${e instanceof Error ? e.message : "error"}).`);
        return null;
    }
    const merged = mergeCookies(cookies, parseSetCookies(getSetCookieList(res)));
    const location = res.headers.get("location") || "";
    // A successful Symfony form login 302s AWAY from /login; a failure bounces back
    // to /login (often with ?_errors). We don't trust that alone — the caller
    // re-validates with keepAlive — but a bounce is a clear early failure signal.
    if (res.status >= 300 && res.status < 400 && location && !/\/login(\b|_check|\?)/i.test(location)) {
        log(`login: /login_check redirected to ${location} — credentials accepted, validating session…`);
        return merged;
    }
    if (res.status === 200 || /\/login/i.test(location)) {
        log(`login: /login_check did not establish a session (HTTP ${res.status}${location ? `, →${location}` : ""}). ` +
            "Likely Turnstile or bad credentials.");
        return null;
    }
    log(`login: unexpected /login_check response HTTP ${res.status} — validating anyway…`);
    return merged;
}
/**
 * Refresh the stored Chess.com session cookie. Strategy:
 *   1. Take the current cookie (cache → CHESSCOM_COOKIE seed) and KEEP IT ALIVE
 *      (validate + fold in rotated cookies). This is the reliable path.
 *   2. Only if there is no working session, attempt a credential login (needs
 *      CHESS_COM_USERNAME/PASSWORD; gated by Turnstile — see the file header).
 * On success the fresh cookie is written to the `chess_cookies` table.
 *
 * Transient network failures are retried with exponential backoff; auth
 * failures (401/expired session, rejected credentials) are NOT retried.
 */
async function refreshChesscomCookie(log = () => { }) {
    const username = readEnv("CHESS_COM_USERNAME") || readEnv("CHESSCOM_USERNAME");
    const password = readEnv("CHESS_COM_PASSWORD") || readEnv("CHESSCOM_PASSWORD");
    const maxAttempts = 3;
    // Seed: prefer a previously-refreshed cache value, else a browser cookie the
    // operator set once via CHESSCOM_COOKIE (the one-time bootstrap).
    const cached = await getCachedChesscomCookie();
    const seedStr = cached?.cookie || readEnv("CHESSCOM_COOKIE") || readEnv("CHESSCOM_SESSION") || "";
    const seed = parseCookiePairs(seedStr);
    // --- 1. Keep-alive on the existing session --------------------------------
    if (username && seed.size) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const refreshed = await keepAlive(username, seed, log);
            if (refreshed) {
                const cookie = formatCookieHeader(refreshed);
                const stored = await putChesscomCookie(cookie, "keepalive");
                log(stored ? "Stored refreshed cookie (keep-alive)." : "WARNING: keep-alive succeeded but the store write failed.");
                return { ok: true, source: "keepalive", cookieSummary: sessionCookieSummary(refreshed), stored };
            }
            // keepAlive only returns null for network/uncertain OR a definite 401. We
            // can't tell them apart here cheaply, so back off once then fall through to
            // login rather than spinning on a genuinely-dead session.
            if (attempt < maxAttempts)
                await sleep(500 * 2 ** (attempt - 1));
        }
        log("Keep-alive could not confirm the existing session — trying a credential login.");
    }
    else if (!seed.size) {
        log("No existing cookie to keep alive (cache empty and no CHESSCOM_COOKIE seed).");
    }
    // --- 2. Credential login (best-effort; Turnstile-gated) -------------------
    if (!username || !password) {
        const msg = "No CHESS_COM_USERNAME / CHESS_COM_PASSWORD configured — cannot log in.";
        log(msg);
        return { ok: false, source: "none", error: msg };
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const loggedIn = await credentialLogin(username, password, log);
        if (loggedIn) {
            // Validate the freshly-minted session (and fold in any further rotation).
            const confirmed = (await keepAlive(username, loggedIn, log)) || loggedIn;
            const cookie = formatCookieHeader(confirmed);
            const stored = await putChesscomCookie(cookie, "login");
            log(stored ? "Stored refreshed cookie (login)." : "WARNING: login succeeded but the store write failed.");
            return { ok: true, source: "login", cookieSummary: sessionCookieSummary(confirmed), stored };
        }
        if (attempt < maxAttempts)
            await sleep(1000 * 2 ** (attempt - 1));
    }
    const msg = "Could not refresh the Chess.com session. Keep-alive found no valid session and credential login was rejected " +
        "(most likely Cloudflare Turnstile on /login). Re-seed CHESSCOM_COOKIE from a real browser session, or supply " +
        "CHESSCOM_TURNSTILE_TOKEN.";
    log(`ALERT: ${msg}`);
    return { ok: false, source: "none", error: msg };
}
