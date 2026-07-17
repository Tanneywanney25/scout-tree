import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
//
// Configure via env (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY). The
// fallbacks below point at the project's Supabase instance so the app still
// works if env vars aren't set — the publishable (anon) key is safe to ship to
// the browser by design.
const SUPABASE_URL =
  import.meta.env.VITE_SUPABASE_URL || 'https://xqyszdjczchlgyisvtvo.supabase.co';
const SUPABASE_PUBLISHABLE_KEY =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_BH3AoBttItAuh4mpSvgFTw_oKmPpKBU';

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,        // keep the session across refreshes/restarts
    autoRefreshToken: true,      // silently refresh access tokens
    detectSessionInUrl: true,    // complete the OAuth redirect automatically
    flowType: 'pkce',            // secure OAuth/code flow (Supabase best practice)
  }
});
