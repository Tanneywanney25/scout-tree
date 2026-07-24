import { getCachedChesscomCookie } from "../supabase/functions/_shared/chessCookie.js";

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

    // Test Supabase connection
    let cached = null;
    try {
      cached = await getCachedChesscomCookie();
    } catch (dbError) {
      return res.status(500).json({
        ok: false,
        error: "Supabase connection failed",
        details: dbError.message || String(dbError)
      });
    }

    return res.status(200).json({
      ok: true,
      message: "Supabase connection works",
      hasCachedCookie: !!cached?.cookie,
      cachedSource: cached?.source || null
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || String(error),
      stack: error.stack
    });
  }
}