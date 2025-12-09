import { useParams } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import type { SerializedAnalysisResult } from "@/lib/chessAnalysis";
import InteractiveOpeningTree from "@/components/InteractiveOpeningTree";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DeepAnalysisTab from "@/components/DeepAnalysisTab";
import WeaknessDashboard from "@/components/WeaknessDashboard";
import OpponentProfile from "@/components/OpponentProfile";

const Report = () => {
  const { id } = useParams();
  const [analysis, setAnalysis] = useState<SerializedAnalysisResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialPath, setInitialPath] = useState<string[]>([]);

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
            <Button onClick={handleDownload} variant="outline">
              <Download className="mr-2 w-4 h-4" />
              Download JSON
            </Button>
          </div>

          {/* Tabs for Opening Tree, Deep Analysis, Weakness Analysis, and Opponent Profile */}
          <Tabs defaultValue="opening-tree" className="w-full">
            <TabsList className="mb-6 flex-wrap">
              <TabsTrigger value="opening-tree">Opening Tree</TabsTrigger>
              <TabsTrigger value="opponent-profile">
                Opponent Profile
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
                {analysis.openingTree && analysis.totalGames > 0 ? (
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
                    <p>No opening tree data available. No games were found or analysis incomplete.</p>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="opponent-profile">
              <OpponentProfile 
                games={analysis.games} 
                username={id || ''} 
              />
            </TabsContent>

            <TabsContent value="deep-analysis">
              <DeepAnalysisTab 
                games={analysis.games} 
                username={id || ''} 
              />
            </TabsContent>

            <TabsContent value="weakness-analysis">
              <WeaknessDashboard 
                games={analysis.games} 
                username={id || ''} 
              />
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
};

export default Report;
