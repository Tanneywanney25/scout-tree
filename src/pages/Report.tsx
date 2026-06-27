import { useParams } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Download, Sparkles } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import type { SerializedAnalysisResult } from "@/lib/chessAnalysis";
import InteractiveOpeningTree from "@/components/InteractiveOpeningTree";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DeepAnalysisTab from "@/components/DeepAnalysisTab";
import WeaknessDashboard from "@/components/WeaknessDashboard";
import OpponentProfile from "@/components/OpponentProfile";
import { StructureWeaknesses } from "@/components/StructureWeaknesses";
import { EndgameProfile } from "@/components/EndgameProfile";
import { CircularProgress } from "@/components/CircularProgress";
import { runAdvancedAnalysis, type AdvancedAnalysisResult } from "@/lib/advancedAnalysis";
import { GamePlanCard } from "@/components/GamePlanCard";
import { useAuth } from "@/hooks/useAuth";
import { useProfile } from "@/hooks/useProfile";
import { saveScout } from "@/lib/savedScouts";
import { Bookmark } from "lucide-react";

type AdvancedStatus = "idle" | "running" | "done";

const Report = () => {
  const { id } = useParams();
  const [analysis, setAnalysis] = useState<SerializedAnalysisResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialPath, setInitialPath] = useState<string[]>([]);
  const [tab, setTab] = useState("opening-tree");

  // Advanced analysis runs at the page level (not inside the tab) so it keeps
  // going while the user browses the opening tree, and isn't cancelled by
  // switching tabs.
  const [advStatus, setAdvStatus] = useState<AdvancedStatus>("idle");
  const [advProgress, setAdvProgress] = useState({ percent: 0, processed: 0, total: 0 });
  const [advResult, setAdvResult] = useState<AdvancedAnalysisResult | null>(null);
  const advStartedRef = useRef(false);
  const advAbortRef = useRef<{ aborted: boolean }>({ aborted: false });
  const [saving, setSaving] = useState(false);

  const { user } = useAuth();
  const { profile } = useProfile();

  const handleSaveScout = async () => {
    if (!user) {
      toast.error("Sign in to save scouts.");
      return;
    }
    setSaving(true);
    const summary = {
      playingStyle: advResult?.profile?.playingStyle,
      exploitableWeaknesses: advResult?.profile?.exploitableWeaknesses,
      recommendations: advResult?.profile?.keyInsights?.slice(0, 3),
    };
    const { error } = await saveScout({
      opponent_username: id || "",
      platform: "lichess",
      player_color: analysis?.playerColor ?? null,
      total_games: analysis?.totalGames ?? 0,
      summary,
    });
    setSaving(false);
    if (error) toast.error(`Could not save: ${error}`);
    else toast.success("Scout saved to your account.");
  };

  // Abort any in-flight advanced run when leaving the page.
  useEffect(() => {
    return () => {
      advAbortRef.current.aborted = true;
    };
  }, []);

  const startAdvanced = () => {
    if (advStartedRef.current) return;
    advStartedRef.current = true;
    const games = analysis?.games || [];
    if (games.length === 0) {
      setAdvStatus("done");
      setAdvResult({ profile: null, structureReport: null, endgameReport: null, gamesAnalyzed: 0 });
      return;
    }
    setAdvStatus("running");
    setAdvProgress({ percent: 0, processed: 0, total: Math.min(games.length, 300) });
    runAdvancedAnalysis(games, id || "", {
      signal: advAbortRef.current,
      onProgress: (percent, processed, total) => setAdvProgress({ percent, processed, total }),
    })
      .then((result) => {
        if (advAbortRef.current.aborted) return;
        setAdvResult(result);
        setAdvStatus("done");
      })
      .catch((err) => {
        console.error("Advanced analysis failed:", err);
        setAdvStatus("done");
      });
  };

  useEffect(() => {
    const storedAnalysis = sessionStorage.getItem('scoutAnalysis');
    if (storedAnalysis) {
      try {
        const parsed = JSON.parse(storedAnalysis);
        
        // Validate tree structure
        if (!parsed.openingTree || typeof parsed.totalGames !== 'number') {
          throw new Error('Invalid analysis data structure');
        }
        
        console.log('[REPORT] Loaded analysis from sessionStorage:', parsed.totalGames, 'games');
        if (parsed.games) {
          console.log('[REPORT] Games available for deep analysis:', parsed.games.length);
        }
        setAnalysis(parsed);
        
        // Preserve the navigation state if it was passed
        if (parsed.initialSelectedPath && Array.isArray(parsed.initialSelectedPath)) {
          setInitialPath(parsed.initialSelectedPath);
        }
        
        sessionStorage.removeItem('scoutAnalysis'); // Clean up after use
      } catch (e) {
        console.error('Failed to parse analysis:', e);
        setLoadError('Failed to load analysis data. The data may be corrupted.');
      }
    } else {
      setLoadError('No analysis data found. Please generate a new scout report.');
    }
  }, []);

  // Friendly fallback so a crash inside one analysis tab can't take down the
  // whole report — the other tabs keep working.
  const tabErrorFallback = (feature: string) => (
    <div className="p-8 text-center border border-destructive/40 rounded-lg bg-destructive/5">
      <p className="text-destructive font-semibold">Couldn't render {feature}</p>
      <p className="text-sm text-muted-foreground mt-2">
        Something went wrong analyzing this data. Try the other tabs or generate a new report.
      </p>
    </div>
  );

  const handleDownload = () => {
    if (!analysis) return;
    
    const reportData = {
      player_id: id,
      total_games: analysis.totalGames,
      player_color: analysis.playerColor,
      opening_tree: analysis.openingTree,
      weakest_lines: analysis.weakestLines,
      strongest_lines: analysis.strongestLines,
      metadata: {
        generated_at: new Date().toISOString(),
      },
    };
    
    const blob = new Blob([JSON.stringify(reportData, null, 2)], { 
      type: "application/json" 
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scout-report-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Report downloaded");
  };

  if (!analysis || loadError) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Header />
        <main className="flex-1 py-8">
          <div className="container mx-auto px-4 text-center space-y-4">
            <p className="text-muted-foreground">
              {loadError || 'No analysis data available.'}
            </p>
            <p className="text-sm text-muted-foreground">
              Please generate a new scout report.
            </p>
            <Button onClick={() => window.location.href = '/scout'}>
              Return to Scout
            </Button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      
      <main className="flex-1 py-8">
        <div className="container mx-auto px-4 max-w-6xl">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">
                Scout Report: {id}
              </h1>
              <p className="text-muted-foreground">
                {analysis.totalGames} total games analyzed • Playing as {analysis.playerColor}
                {analysis.games && analysis.games.length > 0 && (
                  <span className="ml-2">• {analysis.games.length} games available for deep analysis</span>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              {user && (
                <Button onClick={handleSaveScout} variant="outline" disabled={saving}>
                  <Bookmark className="mr-2 w-4 h-4" />
                  {saving ? "Saving..." : "Save scout"}
                </Button>
              )}
              <Button onClick={handleDownload} variant="outline">
                <Download className="mr-2 w-4 h-4" />
                Download JSON
              </Button>
            </div>
          </div>

          {/* Opening Tree + grouped Advanced analyses */}
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTab(v);
              if (v === "advanced") startAdvanced();
            }}
            className="w-full"
          >
            <TabsList className="mb-6 flex-wrap">
              <TabsTrigger value="opening-tree">Opening Tree</TabsTrigger>
              <TabsTrigger value="advanced">
                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                Advanced
              </TabsTrigger>
              <TabsTrigger value="deep-analysis">
                Deep Analysis
                {analysis.games && analysis.games.length > 0 && (
                  <span className="ml-1.5 text-xs bg-primary/20 px-1.5 py-0.5 rounded">
                    {analysis.games.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="weakness-analysis">
                Weakness Analysis
              </TabsTrigger>
            </TabsList>

            <TabsContent value="opening-tree">
              <div className="flex justify-center">
                {analysis.openingTree && analysis.openingTree.count > 0 ? (
                  <ErrorBoundary fallback={
                    <div className="p-8 text-center border border-destructive/50 rounded-lg bg-destructive/10">
                      <p className="text-destructive font-semibold">Error rendering opening tree</p>
                      <p className="text-sm text-muted-foreground mt-2">The tree data may be too large or corrupted.</p>
                    </div>
                  }>
                    <InteractiveOpeningTree
                      node={analysis.openingTree}
                      maxDepth={15}
                      playerColor={analysis.playerColor === "both" ? "white" : analysis.playerColor}
                      initialSelectedPath={initialPath}
                    />
                  </ErrorBoundary>
                ) : (
                  <div className="text-center py-8 text-muted-foreground">
                    <p>No opening tree data available.</p>
                    {analysis.games && analysis.games.length > 0 && (
                      <p className="mt-2 text-sm">
                        {analysis.games.length} games were collected. Check the Advanced tab for analysis.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="advanced">
              <ErrorBoundary fallback={tabErrorFallback('the advanced analysis')}>
                {advStatus === "running" && (
                  <div className="flex flex-col items-center justify-center py-16 gap-4">
                    <CircularProgress
                      value={advProgress.percent}
                      label={`Analyzing ${advProgress.processed} / ${advProgress.total} games`}
                    />
                    <p className="text-sm text-muted-foreground max-w-md text-center">
                      Crunching opponent profile, pawn structures and endgames across as many
                      games as possible. You can switch to the Opening Tree while this runs —
                      it won't cancel.
                    </p>
                  </div>
                )}

                {advStatus === "done" && advResult && advResult.gamesAnalyzed > 0 && (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">
                      Advanced analysis of {advResult.gamesAnalyzed} games.
                    </p>

                    <GamePlanCard
                      openingTree={analysis.openingTree as any}
                      profile={advResult.profile}
                      structureReport={advResult.structureReport}
                      endgameReport={advResult.endgameReport}
                      opponentName={id || "your opponent"}
                      userRating={profile?.rating ?? null}
                      signedIn={!!user}
                    />

                    <Tabs defaultValue="profile" className="w-full">
                      <TabsList className="mb-4 flex-wrap">
                        <TabsTrigger value="profile">Opponent Profile</TabsTrigger>
                        <TabsTrigger value="pawn-structures">Pawn Structures</TabsTrigger>
                        <TabsTrigger value="endgames">Endgames</TabsTrigger>
                      </TabsList>
                      <TabsContent value="profile">
                        <OpponentProfile
                          username={id || ''}
                          precomputedProfile={advResult.profile}
                        />
                      </TabsContent>
                      <TabsContent value="pawn-structures">
                        <StructureWeaknesses
                          username={id || ''}
                          games={analysis.games}
                          precomputedReport={advResult.structureReport}
                          hideControls
                        />
                      </TabsContent>
                      <TabsContent value="endgames">
                        <EndgameProfile
                          username={id || ''}
                          games={analysis.games}
                          precomputedReport={advResult.endgameReport}
                          hideControls
                        />
                      </TabsContent>
                    </Tabs>
                  </div>
                )}

                {advStatus === "done" && (!advResult || advResult.gamesAnalyzed === 0) && (
                  <div className="text-center py-12 text-muted-foreground">
                    No games available for advanced analysis.
                  </div>
                )}
              </ErrorBoundary>
            </TabsContent>

            <TabsContent value="deep-analysis">
              <ErrorBoundary fallback={tabErrorFallback('deep analysis')}>
                <DeepAnalysisTab
                  games={analysis.games}
                  username={id || ''}
                />
              </ErrorBoundary>
            </TabsContent>

            <TabsContent value="weakness-analysis">
              <ErrorBoundary fallback={tabErrorFallback('weakness analysis')}>
                <WeaknessDashboard
                  games={analysis.games}
                  username={id || ''}
                />
              </ErrorBoundary>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
};

export default Report;
