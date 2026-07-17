import { supabase } from "@/integrations/supabase/client";

export interface SavedScoutSummary {
  playingStyle?: string;
  topOpenings?: { line: string; games: number; winRate: number }[];
  exploitableWeaknesses?: string[];
  recommendations?: string[];
}

export interface SavedScout {
  id: string;
  user_id: string;
  opponent_username: string;
  platform: string;
  player_color: string | null;
  total_games: number;
  summary: SavedScoutSummary | null;
  created_at: string;
}

export async function saveScout(scout: {
  opponent_username: string;
  platform: string;
  player_color?: string | null;
  total_games: number;
  summary: SavedScoutSummary;
}): Promise<{ error: string | null }> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in to save scouts." };

  const { error } = await supabase.from("saved_scouts").insert({
    user_id: user.id,
    opponent_username: scout.opponent_username,
    platform: scout.platform,
    player_color: scout.player_color ?? null,
    total_games: scout.total_games,
    summary: scout.summary as unknown as Record<string, unknown>,
  });
  return { error: error?.message ?? null };
}

export async function fetchSavedScouts(): Promise<SavedScout[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from("saved_scouts")
    .select("*")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("[SAVED-SCOUTS] fetch error:", error.message);
    return [];
  }
  return (data || []) as unknown as SavedScout[];
}

export async function deleteSavedScout(id: string): Promise<boolean> {
  const { error } = await supabase.from("saved_scouts").delete().eq("id", id);
  if (error) {
    console.error("[SAVED-SCOUTS] delete error:", error.message);
    return false;
  }
  return true;
}
