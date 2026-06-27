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
import { Loader2, Sparkles } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";
import { GOAL_OPTIONS, saveProfile } from "@/lib/profile";

const Onboarding = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { profile, loading: profileLoading, reload } = useProfile();

  const [platform, setPlatform] = useState("lichess");
  const [lichess, setLichess] = useState("");
  const [chesscom, setChesscom] = useState("");
  const [rating, setRating] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // Redirect signed-out users to auth; pre-fill if a profile already exists.
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    if (!lichess.trim() && !chesscom.trim()) {
      toast.error("Add at least one of your Lichess or Chess.com usernames.");
      return;
    }
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
      onboarded: true,
    });
    setSaving(false);

    if (error) {
      toast.error(`Could not save your profile: ${error}`);
      return;
    }
    await reload();
    toast.success("You're all set! Reports are now tailored to you.");
    navigate("/scout");
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
          <div className="text-center mb-8">
            <div className="flex justify-center mb-3">
              <Sparkles className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-3xl font-bold mb-2">Let's tailor ScoutTree to you</h1>
            <p className="text-muted-foreground">
              We'll use this to give you win-focused suggestions tuned to your level.
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Your chess profile</CardTitle>
              <CardDescription>You can change any of this later in Settings.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="space-y-2">
                  <Label>Main platform</Label>
                  <RadioGroup value={platform} onValueChange={setPlatform}>
                    <div className="flex items-center gap-6">
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="lichess" id="ob-lichess" />
                        <Label htmlFor="ob-lichess" className="font-normal cursor-pointer">Lichess</Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <RadioGroupItem value="chesscom" id="ob-chesscom" />
                        <Label htmlFor="ob-chesscom" className="font-normal cursor-pointer">Chess.com</Label>
                      </div>
                    </div>
                  </RadioGroup>
                </div>

                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="ob-lichess-user">Lichess username</Label>
                    <Input id="ob-lichess-user" placeholder="optional" value={lichess} onChange={(e) => setLichess(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ob-chesscom-user">Chess.com username</Label>
                    <Input id="ob-chesscom-user" placeholder="optional" value={chesscom} onChange={(e) => setChesscom(e.target.value)} />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="ob-rating">Your rating</Label>
                  <Input
                    id="ob-rating"
                    type="number"
                    placeholder="e.g., 1500"
                    value={rating}
                    onChange={(e) => setRating(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    We tune suggestions and training difficulty to your level.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>What do you want most from ScoutTree?</Label>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {GOAL_OPTIONS.map((g) => (
                      <div key={g.id} className="flex items-center space-x-2">
                        <Checkbox id={`goal-${g.id}`} checked={goals.includes(g.id)} onCheckedChange={() => toggleGoal(g.id)} />
                        <Label htmlFor={`goal-${g.id}`} className="font-normal cursor-pointer">{g.label}</Label>
                      </div>
                    ))}
                  </div>
                </div>

                <Button type="submit" className="w-full" disabled={saving}>
                  {saving ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</> : "Start scouting"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Onboarding;
