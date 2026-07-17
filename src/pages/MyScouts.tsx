import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Trash2, User, Target } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { fetchSavedScouts, deleteSavedScout, type SavedScout } from "@/lib/savedScouts";

const MyScouts = () => {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [scouts, setScouts] = useState<SavedScout[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [authLoading, user, navigate]);

  useEffect(() => {
    if (!user) return;
    fetchSavedScouts().then((s) => {
      setScouts(s);
      setLoading(false);
    });
  }, [user]);

  const handleDelete = async (id: string) => {
    const ok = await deleteSavedScout(id);
    if (ok) {
      setScouts((prev) => prev.filter((s) => s.id !== id));
      toast.success("Scout removed.");
    } else {
      toast.error("Could not remove scout.");
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="flex-1 py-12">
        <div className="container mx-auto px-4 max-w-3xl">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold">My Scouts</h1>
            <Button onClick={() => navigate("/scout")}>New Scout</Button>
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : scouts.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <Target className="w-10 h-10 mx-auto mb-3" />
                <p>No saved scouts yet.</p>
                <p className="text-sm mt-1">Run a scout report and hit “Save scout” to keep it here.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {scouts.map((s) => (
                <Card key={s.id}>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg flex items-center gap-2">
                        <User className="w-4 h-4" />
                        {s.opponent_username}
                        <Badge variant="outline" className="ml-1 capitalize">{s.platform}</Badge>
                        {s.player_color && <Badge variant="secondary" className="capitalize">{s.player_color}</Badge>}
                      </CardTitle>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(s.id)} title="Delete">
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      {s.total_games} games • saved {new Date(s.created_at).toLocaleDateString()}
                      {s.summary?.playingStyle && <> • style: <span className="capitalize">{s.summary.playingStyle}</span></>}
                    </p>
                    {s.summary?.recommendations && s.summary.recommendations.length > 0 && (
                      <ul className="text-sm space-y-1">
                        {s.summary.recommendations.slice(0, 3).map((r, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <span className="text-primary mt-0.5">›</span>
                            <span>{r}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default MyScouts;
