import { supabase } from "@/integrations/supabase/client";

export interface Profile {
  id: string;
  email: string | null;
  lichess_username: string | null;
  chesscom_username: string | null;
  rating: number | null;
  preferred_platform: string | null;
  goals: string[];
  onboarded: boolean;
}

// Survey options shown during onboarding.
export const GOAL_OPTIONS: { id: string; label: string }[] = [
  { id: "win_more", label: "Win more games" },
  { id: "prep_opponents", label: "Prepare for specific opponents" },
  { id: "fix_weaknesses", label: "Find & fix my weaknesses" },
  { id: "openings", label: "Build a stronger opening repertoire" },
  { id: "endgames", label: "Improve my endgames" },
  { id: "tactics", label: "Sharpen tactics & calculation" },
];

export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.error("[PROFILE] fetch error:", error.message);
    return null;
  }
  return (data as Profile) ?? null;
}

export async function saveProfile(
  userId: string,
  updates: Partial<Omit<Profile, "id" | "email">>
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId);
  return { error: error?.message ?? null };
}

// The opponent username the user most likely wants to scout against, based on
// their preferred platform.
export function ownUsernameFor(profile: Profile | null, platform: string): string | null {
  if (!profile) return null;
  return platform === "chesscom" ? profile.chesscom_username : profile.lichess_username;
}
