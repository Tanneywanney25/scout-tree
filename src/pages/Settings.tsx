import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";
import { GOAL_OPTIONS, saveProfile } from "@/lib/profile";

const Settings = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { profile, loading: profileLoading, reload } = useProfile();

  const [platform, setPlatform] = useState("lichess");
  const [lichess, setLichess] = useState("");
  const [chesscom, setChesscom] = useState("");
  const [rating, setRating] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (profile) {
      setPlatform(profile.preferred_platform || "lichess");
      setLichess(profile.lichess_username || "");
      setChesscom(profile.chesscom_username || "");
      setRating(profile.rating ? String(profile.rating) : "");
      setGoals(profile.goals || []);
    }
  }, [profile]);

  const toggleGoal = (id: string) =>
    setGoals((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]));

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const ratingNum = rating ? parseInt(rating, 10) : null;
    if (rating && (isNaN(ratingNum!) || ratingNum! < 100 || ratingNum! > 3500)) {
      toast.error("Enter a rating between 100 and 3500 (or leave it blank).");
      return;
    }
    setSaving(true);
    const { error } = await saveProfile(user.id, {
      preferred_platform: platform,
      lichess_username: lichess.trim() || null,
      chesscom_username: chesscom.trim() || null,
      rating: ratingNum,
      goals,
    });
    setSaving(false);
    if (error) {
      toast.error(`Could not save: ${error}`);
      return;
    }
    await reload();
    toast.success("Settings saved.");
  };

  if (authLoading || profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="flex-1 py-12">
        <div className="container mx-auto px-4 max-w-2xl">
          <h1 className="text-3xl font-bold mb-6">Settings</h1>
          <Card>
            <CardHeader>
              <CardTitle>Your chess profile</CardTitle>
              <CardDescription>Used to tailor recommendations and training difficulty.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSave} className="space-y-6">
                <div className="space-y-2">
                  <Label>Main platform</Label>
                  <RadioGroup value={platform} onValueChange={setPlatform}>
                    <div className="flex items-center gap-6">
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="lichess" id="set-lichess" />
                        <Label htmlFor="set-lichess" className="font-normal cursor-pointer">Lichess</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="chesscom" id="set-chesscom" />
                        <Label htmlFor="set-chesscom" className="font-normal cursor-pointer">Chess.com</Label>
                      </div>
                    </div>
                  </RadioGroup>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="set-lichess-user">Lichess username</Label>
                    <Input id="set-lichess-user" value={lichess} onChange={(e) => setLichess(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="set-chesscom-user">Chess.com username</Label>
                    <Input id="set-chesscom-user" value={chesscom} onChange={(e) => setChesscom(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="set-rating">Your rating</Label>
                  <Input id="set-rating" type="number" value={rating} onChange={(e) => setRating(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>Your goals</Label>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {GOAL_OPTIONS.map((g) => (
                      <div key={g.id} className="flex items-center space-x-2">
                        <Checkbox id={`set-goal-${g.id}`} checked={goals.includes(g.id)} onCheckedChange={() => toggleGoal(g.id)} />
                        <Label htmlFor={`set-goal-${g.id}`} className="font-normal cursor-pointer">{g.label}</Label>
                      </div>
                    ))}
                  </div>
                </div>
                <Button type="submit" disabled={saving}>
                  {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</> : "Save changes"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Settings;
