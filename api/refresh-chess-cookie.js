import { refreshChesscomCookie } from "../supabase/functions/_shared/chessCookie.js";

export default async function handler(req, res) {
  try {
    // Check secret
    const secret = process.env.CRON_SECRET;
    const querySecret = req.query?.secret;
    const authHeader = req.headers["authorization"];
    const authProvided = authHeader ? authHeader.replace(/^Bearer\s+/, '') : null;
    const provided = authProvided || querySecret;

    if (secret && provided !== secret) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Check env vars
    const required = ['CHESS_COM_USERNAME', 'CHESS_COM_PASSWORD', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CHESSCOM_COOKIE'];
    const missing = required.filter(name => !process.env[name]);
    if (missing.length > 0) {
      return res.status(500).json({ ok: false, error: 'Missing env vars', missing });
    }

    // Run the refresh
    const logs = [];
    const log = (m) => {
      logs.push(m);
      console.log("[refresh]", m);
    };

    const result = await refreshChesscomCookie(log);

    return res.status(result.ok ? 200 : 502).json({
      ok: result.ok,
      source: result.source,
      cookieSummary: result.cookieSummary || null,
      stored: result.stored || false,
      logs
    });

  } catch (error) {
    console.error("Fatal error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || String(error),
      stack: error.stack
    });
  }
}