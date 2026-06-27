import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/useAuth";
import { fetchProfile, type Profile } from "@/lib/profile";

/**
 * Loads the signed-in user's profile (personalization data). Returns null when
 * signed out or while the profile row hasn't been created yet.
 */
export function useProfile() {
  const { user, loading: authLoading } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!user) {
      setProfile(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const p = await fetchProfile(user.id);
    setProfile(p);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    reload();
  }, [authLoading, reload]);

  return { profile, loading: loading || authLoading, reload, userId: user?.id ?? null };
}
