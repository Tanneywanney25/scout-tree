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

    // Simple response
    return res.status(200).json({
      ok: true,
      message: "API is working",
      env: {
        hasUsername: !!process.env.CHESS_COM_USERNAME,
        hasPassword: !!process.env.CHESS_COM_PASSWORD,
        hasSupabaseUrl: !!process.env.SUPABASE_URL,
        hasServiceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        hasCookie: !!process.env.CHESSCOM_COOKIE
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || String(error)
    });
  }
}