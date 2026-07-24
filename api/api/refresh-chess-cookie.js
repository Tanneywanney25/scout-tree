"use strict";
// ============================================================================
// Vercel serverless function: /api/refresh-chess-cookie
//
// Runs on a schedule (see vercel.json `crons`) to keep the identity resolver's
// authenticated Chess.com session cookie fresh WITHOUT manual intervention or a
// personal machine staying online. It:
//   1. keeps the current session alive (or logs in with the stored service
//      credentials as a best-effort fallback — see the Turnstile note in
//      ../supabase/functions/_shared/chessCookie.ts), and
//   2. writes the fresh Cookie string to the `chess_cookies` Supabase table,
//      which the resolve-identity edge function reads (school.ts).
//
// Env (set in the Vercel project):
//   • CHESS_COM_USERNAME / CHESS_COM_PASSWORD — the service account creds.
//   • CHESSCOM_COOKIE                          — one-time browser-session seed
//                                                (the reliable keep-alive path).
//   • SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — where the cookie is stored.
//   • CRON_SECRET (optional but recommended)   — Vercel sends it as
//     `Authorization: Bearer <CRON_SECRET>`; we reject calls that don't match,
//     so the endpoint can't be triggered by the public.
//
// It can also be invoked manually (GET/POST) for testing; with CRON_SECRET set,
// pass the same bearer header.
// ============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.default = handler;
const chessCookie_ts_1 = require("../supabase/functions/_shared/chessCookie.ts");
// Allow the login + keep-alive round-trips (with backoff) room to finish. Vercel
// caps this to the project's plan limit if lower.
exports.config = { maxDuration: 60 };
async function handler(req, res) {
    // Cron-secret gate: when CRON_SECRET is set, only accept the matching bearer
    // (Vercel Cron sends exactly this header). No secret configured → open (dev).
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
        // Surfaces in the Vercel function logs for on-schedule observability.
        console.log("[refresh-chess-cookie]", m);
    };
    const startedAt = new Date().toISOString();
    try {
        const result = await (0, chessCookie_ts_1.refreshChesscomCookie)(log);
        res.setHeader("Cache-Control", "no-store");
        res.status(result.ok ? 200 : 502).json({ startedAt, ...result, logs });
    }
    catch (e) {
        const error = e instanceof Error ? e.message : "unknown error";
        log(`FATAL: ${error}`);
        res.status(500).json({ ok: false, source: "none", error, logs });
    }
}
