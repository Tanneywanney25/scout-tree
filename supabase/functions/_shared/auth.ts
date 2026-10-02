// ============================================================================
// Caller authentication for routes that disclose personal data.
//
// WHY THIS EXISTS: resolve-identity runs with verify_jwt = false
// (supabase/config.toml), because anonymous scouting is a product feature — the
// publishable key, or no credential at all, is enough to reach the function.
// That is fine for routes that only read public chess data. It is NOT fine for
// a route that hands back stored USCF-member -> online-handle mappings, which
// de-anonymise real people (a population that includes minors) and whose
// evidence text names third parties.
//
// Flipping verify_jwt for the whole function would break anonymous scouting, so
// the sensitive route authenticates its caller itself, here.
//
// The check is delegated to Supabase's own /auth/v1/user endpoint rather than
// verifying a JWT locally: no key material to mishandle, no signature code to
// get wrong, and a revoked or expired session stops working immediately. The
// publishable/anon key is not a user token, so it fails this check — which is
// the point.
// ============================================================================

import { readEnv } from "./chessCookie.ts";

export interface CallerIdentity {
  userId: string;
}

/**
 * Resolve the caller to a signed-in user, or null.
 *
 * `authorization` is the raw header from the incoming request. Anything that is
 * missing, malformed, or merely an API key resolves to null.
 */
export async function authenticateCaller(authorization: string | null): Promise<CallerIdentity | null> {
  const url = readEnv("SUPABASE_URL") || readEnv("VITE_SUPABASE_URL");
  const anonKey =
    readEnv("SUPABASE_ANON_KEY") ||
    readEnv("SUPABASE_PUBLISHABLE_KEYS") ||
    readEnv("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (!url || !authorization) return null;

  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  // A bare API key is not a session. Reject it without a round trip.
  if (anonKey && token === anonKey) return null;
  if (/^sb_(publishable|secret)_/.test(token)) return null;

  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(anonKey ? { apikey: anonKey } : {}),
        Accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body?.id === "string" && body.id ? { userId: body.id } : null;
  } catch {
    // Fail CLOSED: an auth outage must not turn a protected route into an open
    // one. The caller sees "unauthorized", not everybody else's identities.
    return null;
  }
}
