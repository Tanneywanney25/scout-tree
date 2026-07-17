import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { postAuthPath } from "@/lib/authRouting";

/**
 * Landing route for the Google OAuth redirect. The Supabase client
 * (detectSessionInUrl + PKCE) exchanges the code automatically; we just wait for
 * the session, then route the user into the app.
 */
const AuthCallback = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let done = false;

    const go = async (userId: string) => {
      if (done) return;
      done = true;
      const path = await postAuthPath(userId);
      navigate(path, { replace: true });
    };

    // Surface a provider error returned in the URL (?error=...).
    const params = new URLSearchParams(window.location.search);
    if (params.get("error")) {
      setError(params.get("error_description") || params.get("error"));
    }

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session?.user) go(session.user.id);
    });

    // In case the session is already established by the time we mount.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) go(session.user.id);
    });

    // Safety net: if nothing resolves, send them back to sign in.
    const timer = setTimeout(() => {
      if (!done) navigate("/auth", { replace: true });
    }, 8000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, [navigate]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-3">
      {error ? (
        <>
          <p className="text-destructive font-medium">Sign-in failed</p>
          <p className="text-sm text-muted-foreground">{error}</p>
          <button className="text-primary text-sm hover:underline" onClick={() => navigate("/auth", { replace: true })}>
            Back to sign in
          </button>
        </>
      ) : (
        <>
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Signing you in…</p>
        </>
      )}
    </div>
  );
};

export default AuthCallback;
