// ============================================================================
// TEST HARNESS: the Chess.com cookie store + refresher, offline (bundled + run
// by scripts/test-chess-cookie.mjs). Fakes the Supabase REST store and the
// chess.com login / keep-alive endpoints in-memory, then drives the REAL
// chessCookie.ts logic end to end.
//
//   node scripts/test-chess-cookie.mjs
//
// Covers:
//   • pure cookie parsing / merge / format helpers
//   • keep-alive refresh of an existing (seed) session, folding in rotated cookies
//   • credential login when there is no session to keep alive
//   • a login blocked by Turnstile → ok:false with a clear alert
//   • readChesscomSessionCookie source resolution (cache → env → none)
// ============================================================================

import * as CC from "../supabase/functions/_shared/chessCookie";

const SUPA = "https://fake.supabase.co";

// ---------------------------------------------------------------------------
// Assertion plumbing
// ---------------------------------------------------------------------------
let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

// ---------------------------------------------------------------------------
// Fake network — a mutable `net` config the scenarios set per test.
// ---------------------------------------------------------------------------
interface FakeNet {
  cacheRows: Array<{ cookie: string; source?: string; updated_at?: string }>;
  lastUpsert?: Record<string, unknown>;
  loginPageHtml?: string;
  loginPageCookies?: string[];
  loginCheck?: { status: number; location?: string; setCookies?: string[] };
  keepAlive?: { status: number; setCookies?: string[] };
}
const net: FakeNet = { cacheRows: [] };

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const withCookies = (status: number, setCookies: string[] = [], location?: string) => {
  const headers: Array<[string, string]> = setCookies.map((c) => ["set-cookie", c]);
  if (location) headers.push(["location", location]);
  return new Response(status === 204 ? null : "", { status, headers });
};

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  const method = (init?.method || "GET").toUpperCase();

  // --- Supabase REST store --------------------------------------------------
  if (url.startsWith(`${SUPA}/rest/v1/chess_cookies`)) {
    if (method === "GET") return json(net.cacheRows);
    if (method === "POST") {
      net.lastUpsert = JSON.parse(String(init?.body || "{}"));
      return withCookies(204);
    }
  }

  // --- chess.com login page (GET) ------------------------------------------
  if (url === "https://www.chess.com/login" && method === "GET") {
    const headers: Array<[string, string]> = (net.loginPageCookies || []).map((c) => ["set-cookie", c]);
    return new Response(net.loginPageHtml ?? "", { status: 200, headers });
  }
  // --- chess.com login_check (POST) ----------------------------------------
  if (url === "https://www.chess.com/login_check" && method === "POST") {
    const lc = net.loginCheck || { status: 200 };
    return withCookies(lc.status, lc.setCookies || [], lc.location);
  }
  // --- chess.com keep-alive probe (friends endpoint) ------------------------
  if (/\/callback\/friends\/[^/]+\/top-friends/.test(url)) {
    const ka = net.keepAlive || { status: 401 };
    return withCookies(ka.status, ka.setCookies || []);
  }

  console.error(`  [FAKE-NET] unexpected outbound request: ${method} ${url}`);
  return new Response("blocked by test harness", { status: 404 });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function resetState() {
  net.cacheRows = [];
  net.lastUpsert = undefined;
  net.loginPageHtml = undefined;
  net.loginPageCookies = undefined;
  net.loginCheck = undefined;
  net.keepAlive = undefined;
  CC.resetCookieMemo();
}

// ---------------------------------------------------------------------------
// 1. Pure cookie helpers
// ---------------------------------------------------------------------------
function pureTests() {
  console.log("\n=== Pure cookie helpers ===\n");

  const p = CC.parseCookiePairs("PHPSESSID=abc; __cf_bm=xyz");
  check("P1 parseCookiePairs PHPSESSID", p.get("PHPSESSID") === "abc");
  check("P2 parseCookiePairs __cf_bm", p.get("__cf_bm") === "xyz");

  const s = CC.parseSetCookies([
    "PHPSESSID=newsess; path=/; HttpOnly; Secure",
    "__cf_bm=cf123; path=/; expires=Wed, 21 Oct 2026 07:28:00 GMT",
    "dead=deleted; expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "empty=; path=/",
  ]);
  check("P3 parseSetCookies strips attributes", s.get("PHPSESSID") === "newsess");
  check("P4 parseSetCookies keeps value with comma-bearing expires", s.get("__cf_bm") === "cf123");
  check("P5 parseSetCookies ignores 'deleted'", !s.has("dead"));
  check("P6 parseSetCookies ignores empty value", !s.has("empty"));

  const merged = CC.mergeCookies(
    CC.parseCookiePairs("PHPSESSID=old; keep=1; OptanonConsent=junk"),
    CC.parseSetCookies(["PHPSESSID=fresh; path=/"])
  );
  check("P7 mergeCookies update wins", merged.get("PHPSESSID") === "fresh");
  check("P8 mergeCookies keeps base entries", merged.get("keep") === "1");
  check("P9 mergeCookies drops analytics", !merged.has("OptanonConsent"));
  check("P10 formatCookieHeader roundtrip", CC.formatCookieHeader(new Map([["a", "1"], ["b", "2"]])) === "a=1; b=2");

  const res = new Response("", { status: 200, headers: [["set-cookie", "x=1"], ["set-cookie", "y=2"]] });
  check("P11 getSetCookieList reads multiple", CC.getSetCookieList(res).join("|") === "x=1|y=2");
}

// ---------------------------------------------------------------------------
// 2. Keep-alive refresh (existing seed session stays alive, cookies rotate)
// ---------------------------------------------------------------------------
async function keepAliveTest() {
  console.log("\n=== Keep-alive refresh ===\n");
  resetState();
  setEnv({
    SUPABASE_URL: SUPA,
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    CHESS_COM_USERNAME: "claudetestusername",
    CHESS_COM_PASSWORD: "pw",
    CHESSCOM_COOKIE: "PHPSESSID=seedsess; keep=1",
  });
  net.cacheRows = []; // no cached value yet → uses the env seed
  net.keepAlive = { status: 200, setCookies: ["__cf_bm=rotated; path=/; HttpOnly"] };

  const logs: string[] = [];
  const result = await CC.refreshChesscomCookie((m) => logs.push(m));
  check("K1 ok", result.ok, JSON.stringify(result));
  check("K2 source is keepalive", result.source === "keepalive", result.source);
  check("K3 stored to Supabase", result.stored === true);
  const stored = String(net.lastUpsert?.cookie || "");
  check("K4 kept the seed session cookie", stored.includes("PHPSESSID=seedsess"), stored);
  check("K5 folded in the rotated __cf_bm", stored.includes("__cf_bm=rotated"), stored);
  check("K6 upsert marked source=keepalive", net.lastUpsert?.source === "keepalive");
}

// ---------------------------------------------------------------------------
// 3. Credential login when there is no session to keep alive
// ---------------------------------------------------------------------------
async function loginTest() {
  console.log("\n=== Credential login (no existing session) ===\n");
  resetState();
  setEnv({
    SUPABASE_URL: SUPA,
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    CHESS_COM_USERNAME: "claudetestusername",
    CHESS_COM_PASSWORD: "pw",
    CHESSCOM_COOKIE: undefined, // no seed → keep-alive skipped, login attempted
    CHESSCOM_SESSION: undefined,
    CHESSCOM_TURNSTILE_TOKEN: "tstoken", // operator-supplied; we never solve it
  });
  net.cacheRows = [];
  net.loginPageHtml = '<input name="_token" form-error-clear="" value="TOK123" />';
  net.loginPageCookies = ["PHPSESSID=loginsess; path=/; HttpOnly", "__cf_bm=cfget; path=/"];
  net.loginCheck = { status: 302, location: "https://www.chess.com/home", setCookies: ["CHESSCOM_REMEMBERME=rmb; path=/; HttpOnly"] };
  net.keepAlive = { status: 200, setCookies: ["__cf_bm=cfafter; path=/"] };

  const logs: string[] = [];
  const result = await CC.refreshChesscomCookie((m) => logs.push(m));
  check("L1 ok", result.ok, JSON.stringify(result));
  check("L2 source is login", result.source === "login", result.source);
  const stored = String(net.lastUpsert?.cookie || "");
  check("L3 stored the login PHPSESSID", stored.includes("PHPSESSID=loginsess"), stored);
  check("L4 stored the remember-me cookie", stored.includes("CHESSCOM_REMEMBERME=rmb"), stored);
  check("L5 folded in the post-login rotated __cf_bm", stored.includes("__cf_bm=cfafter"), stored);
}

// ---------------------------------------------------------------------------
// 4. Login blocked (Turnstile) → clear failure, no store write
// ---------------------------------------------------------------------------
async function loginBlockedTest() {
  console.log("\n=== Login blocked by Turnstile ===\n");
  resetState();
  setEnv({
    SUPABASE_URL: SUPA,
    SUPABASE_SERVICE_ROLE_KEY: "svc",
    CHESS_COM_USERNAME: "claudetestusername",
    CHESS_COM_PASSWORD: "pw",
    CHESSCOM_COOKIE: undefined,
    CHESSCOM_SESSION: undefined,
    CHESSCOM_TURNSTILE_TOKEN: undefined,
  });
  net.cacheRows = [];
  net.loginPageHtml = '<input name="_token" value="TOK123" />';
  net.loginPageCookies = ["PHPSESSID=loginsess; path=/"];
  // Symfony bounce back to /login on a rejected/challenged login.
  net.loginCheck = { status: 302, location: "https://www.chess.com/login?_errors=1" };

  const logs: string[] = [];
  const result = await CC.refreshChesscomCookie((m) => logs.push(m));
  check("B1 not ok", result.ok === false, JSON.stringify(result));
  check("B2 source none", result.source === "none");
  check("B3 nothing stored", net.lastUpsert === undefined);
  check("B4 alert mentions Turnstile / re-seed", logs.some((l) => /Turnstile/i.test(l)) && logs.some((l) => /re-seed/i.test(l)));
}

// ---------------------------------------------------------------------------
// 5. readChesscomSessionCookie: cache → env → none
// ---------------------------------------------------------------------------
async function readerTest() {
  console.log("\n=== readChesscomSessionCookie source resolution ===\n");

  // cache hit
  resetState();
  setEnv({ SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: "svc", CHESSCOM_COOKIE: "PHPSESSID=envone" });
  net.cacheRows = [{ cookie: "PHPSESSID=cachedone", source: "keepalive", updated_at: new Date(Date.now() - 5 * 60_000).toISOString() }];
  const r1 = await CC.readChesscomSessionCookie();
  check("R1 cache wins over env", r1.source === "cache" && r1.cookie === "PHPSESSID=cachedone", `${r1.source}/${r1.cookie}`);
  check("R2 reports a fresh-ish age", (r1.ageMs ?? 0) >= 4 * 60_000 && (r1.ageMs ?? 0) <= 6 * 60_000, `${r1.ageMs}`);

  // env fallback (cache empty)
  resetState();
  setEnv({ SUPABASE_URL: SUPA, SUPABASE_SERVICE_ROLE_KEY: "svc", CHESSCOM_COOKIE: "PHPSESSID=envone" });
  net.cacheRows = [];
  const r2 = await CC.readChesscomSessionCookie();
  check("R3 env fallback when cache empty", r2.source === "env" && r2.cookie === "PHPSESSID=envone", `${r2.source}/${r2.cookie}`);

  // none (no cache, no env)
  resetState();
  setEnv({ SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined, CHESSCOM_COOKIE: undefined, CHESSCOM_SESSION: undefined });
  const r3 = await CC.readChesscomSessionCookie();
  check("R4 none when nothing configured", r3.source === "none" && r3.cookie === "", `${r3.source}/${r3.cookie}`);
}

async function main() {
  pureTests();
  await keepAliveTest();
  await loginTest();
  await loginBlockedTest();
  await readerTest();
  console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
