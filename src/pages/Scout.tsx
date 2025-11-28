import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Search, Upload, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchLichessGames, fetchChessComGames } from "@/lib/chessApi";
import { analyzeGames, serializeOpeningTree, createEmptyAnalysis, analyzeGamesIncremental, type AnalysisResult } from "@/lib/chessAnalysis";

const Scout = () => {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [platform, setPlatform] = useState("lichess");
  const [color, setColor] = useState("both");
  const [timeControl, setTimeControl] = useState("blitz");
  const [dateFilter, setDateFilter] = useState<"all" | "year" | "6months">("all");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [currentAnalysis, setCurrentAnalysis] = useState<AnalysisResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!username.trim()) {
      toast.error("Please enter a username");
      return;
    }

    setLoading(true);
    setProgress(null);
    setWarning(null);
    setCurrentAnalysis(null);

    try {
      const cacheKey = `scout_${username}_${platform}_${timeControl}_${color}_${dateFilter}`;
      const cached = localStorage.getItem(cacheKey);
      
      if (cached) {
        const cachedData = JSON.parse(cached);
        const cacheAge = Date.now() - cachedData.timestamp;
        
        if (cacheAge < 24 * 60 * 60 * 1000) {
          toast.success("Loading cached report...");
          navigate(`/report/${username}`, { state: cachedData.analysis });
          setLoading(false);
          return;
        }
      }

      toast.loading("Fetching and analyzing games...");

      // Initialize empty analysis
      let analysis = createEmptyAnalysis(color as "white" | "black" | "both");
      setCurrentAnalysis(analysis);

      const actualPlatform = platform === "auto" ? "lichess" : platform;
      
      if (actualPlatform === "lichess") {
        await fetchLichessGames(
          username,
          timeControl,
          dateFilter,
          (count) => {
            setProgress(count);
            
            if (count > 2000 && !warning) {
              setWarning("Large dataset detected - analyzing continuously...");
            }
          },
          (gameBatch) => {
            // Analyze each batch as it arrives
            analysis = analyzeGamesIncremental(analysis, gameBatch, username);
            setCurrentAnalysis({...analysis});
            setProgress(analysis.totalGames);
          }
        );
      } else {
        const games = await fetchChessComGames(username, timeControl);
        
        if (games.length === 0) {
          toast.error("No games found for this user");
          setLoading(false);
          return;
        }

        // Analyze Chess.com games in one batch (already limited)
        analysis = analyzeGamesIncremental(analysis, games, username);
        setCurrentAnalysis(analysis);
      }

      if (analysis.totalGames === 0) {
        toast.error("No games found for this user");
        setLoading(false);
        return;
      }

      toast.success("Report generated!");
      
      const reportData = {
        username,
        platform: actualPlatform,
        timeControl,
        color,
        dateFilter,
        analysis: {
          ...analysis,
          openingTree: serializeOpeningTree(analysis.openingTree),
        },
        timestamp: Date.now(),
      };

      localStorage.setItem(cacheKey, JSON.stringify(reportData));
      navigate(`/report/${username}`, { state: reportData.analysis });
    } catch (error: any) {
      console.error("Scout error:", error);
      toast.error(error.message || "Failed to generate report. Try again.");
    } finally {
      setLoading(false);
      setProgress(null);
      setWarning(null);
      setCurrentAnalysis(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      
      <main className="flex-1 py-12">
        <div className="container mx-auto px-4 max-w-2xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl md:text-4xl font-bold text-foreground mb-3">
              Scout an Opponent
            </h1>
            <p className="text-muted-foreground">
              Enter their username and we'll analyze their games to create a complete profile
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Player Information</CardTitle>
              <CardDescription>
                Provide the opponent's username or upload a PGN file
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    placeholder="e.g., magnuscarlsen"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="text-base"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="platform">Platform</Label>
                  <Select value={platform} onValueChange={setPlatform}>
                    <SelectTrigger id="platform">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lichess">Lichess</SelectItem>
                      <SelectItem value="chesscom">Chess.com (may hit CORS)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="color">Your Color</Label>
                    <Select value={color} onValueChange={setColor}>
                      <SelectTrigger id="color">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="both">Both Colors</SelectItem>
                        <SelectItem value="white">White</SelectItem>
                        <SelectItem value="black">Black</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timeControl">Time Control</Label>
                    <Select value={timeControl} onValueChange={setTimeControl}>
                      <SelectTrigger id="timeControl">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="blitz">Blitz</SelectItem>
                        <SelectItem value="rapid">Rapid</SelectItem>
                        <SelectItem value="bullet">Bullet</SelectItem>
                        <SelectItem value="classical">Classical</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {platform === "lichess" && (
                  <div className="space-y-2">
                    <Label htmlFor="dateFilter">Date Range</Label>
                    <Select value={dateFilter} onValueChange={(v) => setDateFilter(v as "all" | "year" | "6months")}>
                      <SelectTrigger id="dateFilter">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Time</SelectItem>
                        <SelectItem value="year">Last Year</SelectItem>
                        <SelectItem value="6months">Last 6 Months</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {progress !== null && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        {currentAnalysis ? 'Analyzing games...' : 'Fetching games...'}
                      </span>
                      <span className="font-medium">{progress} games</span>
                    </div>
                    <Progress value={100} className="h-2" />
                    
                    {currentAnalysis && currentAnalysis.totalGames > 0 && (
                      <div className="text-xs text-muted-foreground space-y-1">
                        <div>✓ {currentAnalysis.totalGames} games analyzed</div>
                        {currentAnalysis.openingTree.children.size > 0 && (
                          <div>✓ {currentAnalysis.openingTree.children.size} opening moves found</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {warning && (
                  <div className="rounded-md bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 p-3">
                    <p className="text-sm text-amber-800 dark:text-amber-200">{warning}</p>
                  </div>
                )}

                <Button 
                  type="submit" 
                  disabled={loading}
                  className="w-full bg-primary hover:bg-primary-dark text-primary-foreground"
                >
                  {loading ? (
                    <>
                      <Loader2 className="mr-2 w-4 h-4 animate-spin" />
                      {progress ? `Analyzing ${progress} games...` : "Analyzing..."}
                    </>
                  ) : (
                    <>
                      <Search className="mr-2 w-4 h-4" />
                      Generate Scout Report
                    </>
                  )}
                </Button>
              </form>

              <div className="mt-6 pt-6 border-t border-border">
                <Button variant="outline" className="w-full">
                  <Upload className="mr-2 w-4 h-4" />
                  Upload PGN File Instead
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Scout;
