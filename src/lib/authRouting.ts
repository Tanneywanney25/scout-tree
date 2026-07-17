import { fetchProfile } from "@/lib/profile";

/**
 * Where to send a user right after authenticating: into onboarding the first
 * time (so we can personalize), otherwise straight into the app. Falls back to
 * the app on any error so auth never dead-ends.
 */
export async function postAuthPath(userId: string): Promise<string> {
  try {
    const profile = await fetchProfile(userId);
    return profile?.onboarded ? "/scout" : "/onboarding";
  } catch {
    return "/scout";
  }
}
