import { useParams, useLocation } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
// import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
// import { Badge } from "@/components/ui/badge";
import { Download } from "lucide-react";
// import { ChevronRight } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import type { SerializedAnalysisResult } from "@/lib/chessAnalysis";
import InteractiveOpeningTree from "@/components/InteractiveOpeningTree";
// import { OpeningLineBoard } from "@/components/OpeningLineBoard";

const Report = () => {
  const { id } = useParams();
  const location = useLocation();
  const [analysis, setAnalysis] = useState<SerializedAnalysisResult | null>(null);
  const [isLive, setIsLive] = useState(false);
  const updateIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Get analysis from navigation state or fallback to cache
    if (location.state) {
      const state = location.state as any;
      setAnalysis(state as SerializedAnalysisResult);
      setIsLive(state.isLive || false);
      
      // If it's a live report, poll for updates
      if (state.isLive && state.cacheKey) {
        console.log('Starting live polling with cache key:', state.cacheKey);
        
        updateIntervalRef.current = setInterval(() => {
          const cached = localStorage.getItem(state.cacheKey);
          if (cached) {
            const parsedCache = JSON.parse(cached);
            const updatedAnalysis = parsedCache.analysis;
            
            if (updatedAnalysis && updatedAnalysis.totalGames > 0) {
              console.log('Updating analysis with', updatedAnalysis.totalGames, 'games');
              setAnalysis(updatedAnalysis);
            }
            
            // Stop polling if analysis is complete
            if (parsedCache.complete) {
              console.log('Analysis complete, stopping polling');
              setIsLive(false);
              if (updateIntervalRef.current) {
                clearInterval(updateIntervalRef.current);
              }
            }
          }
        }, 300); // Poll every 300ms for fast updates
      }
    } else {
      // Try to load from cache
      const cacheKeys = Object.keys(localStorage).filter(key => key.startsWith('scout_'));
      if (cacheKeys.length > 0) {
        const latestCache = JSON.parse(localStorage.getItem(cacheKeys[0]) || '{}');
        if (latestCache.analysis) {
          setAnalysis(latestCache.analysis);
        }
      }
    }
    
    return () => {
      if (updateIntervalRef.current) {
        clearInterval(updateIntervalRef.current);
      }
    };
  }, [location.state]);

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


  if (!analysis) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Header />
        <main className="flex-1 py-8">
          <div className="container mx-auto px-4 text-center">
            <p className="text-muted-foreground">Loading analysis...</p>
          </div>
        </main>
      </div>
    );
  }

  const generateSummary = () => {
    const weakestLine = analysis.weakestLines[0];
    const strongestLine = analysis.strongestLines[0];
    
    const opponentColor = analysis.playerColor === "white" ? "White" : "Black";
    const yourColor = analysis.playerColor === "white" ? "Black" : "White";
    
    return `Analyzing ${id} playing as ${opponentColor} across ${analysis.totalGames} games. ` +
           (weakestLine ? `They struggle most after ${weakestLine.line} (${(weakestLine.winRate * 100).toFixed(0)}% win rate, ${weakestLine.count} games). ` : '') +
           (strongestLine ? `They excel after ${strongestLine.line} (${(strongestLine.winRate * 100).toFixed(0)}% win rate, ${strongestLine.count} games). ` : '') +
           `As ${yourColor}, exploit their weaknesses and avoid their strongest lines.`;
  };

  const generateChecklist = () => {
    const items: string[] = [];
    
    const opponentColor = analysis.playerColor === "white" ? "White" : "Black";
    const yourColor = analysis.playerColor === "white" ? "Black" : "White";
    
    if (analysis.weakestLines.length > 0) {
      const line = analysis.weakestLines[0];
      items.push(`Play ${line.line.split(' ').slice(1).join(' ')} - they score only ${(line.winRate * 100).toFixed(0)}% here`);
    }
    
    if (analysis.strongestLines.length > 0) {
      const line = analysis.strongestLines[0];
      items.push(`Avoid ${line.line.split(' ').slice(1).join(' ')} - they score ${(line.winRate * 100).toFixed(0)}% here`);
    }
    
    items.push(`${analysis.totalGames} games analyzed as ${opponentColor} - ${analysis.totalGames > 100 ? 'highly' : 'moderately'} reliable dataset`);
    items.push(`You play ${yourColor} - prepare your response repertoire`);
    
    return items;
  };

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
                {isLive && <span className="ml-2 text-primary animate-pulse">• Live updating...</span>}
              </p>
            </div>
            <Button onClick={handleDownload} variant="outline">
              <Download className="mr-2 w-4 h-4" />
              Download JSON
            </Button>
          </div>

          {/* Main Layout: Board and Lines */}
          <div className="flex justify-center">
            {analysis.openingTree && analysis.openingTree.children && analysis.openingTree.children.length > 0 ? (
              <InteractiveOpeningTree 
                node={analysis.openingTree} 
                maxDepth={15}
                playerColor={analysis.playerColor === "both" ? "white" : analysis.playerColor}
              />
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <p>No opening tree data available. The analysis may still be processing or no games were found.</p>
              </div>
            )}
          </div>

          {/* COMMENTED OUT FOR LATER - Left Sidebar: Summary & Checklist */}
          {/* <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>60-Second Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-foreground leading-relaxed">
                  {generateSummary()}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Pregame Checklist</CardTitle>
                <CardDescription>Review before the game starts</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {generateChecklist().map((item, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <ChevronRight className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <span className="text-foreground">{item}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div> */}

          {/* COMMENTED OUT FOR LATER - Right Sidebar: Stats */}
          {/* <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Statistics</CardTitle>
                <CardDescription>Key metrics</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Total Games</p>
                    <p className="text-2xl font-bold text-foreground">{analysis.totalGames}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Playing As</p>
                    <p className="text-xl font-semibold text-foreground capitalize">{analysis.playerColor}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Weak Lines</p>
                    <p className="text-2xl font-bold text-destructive">{analysis.weakestLines.length}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Strong Lines</p>
                    <p className="text-2xl font-bold text-primary">{analysis.strongestLines.length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div> */}

          {/* COMMENTED OUT FOR LATER - Bottom Section: Opening Lines */}
          {/* <div className="grid lg:grid-cols-2 gap-6 mt-6">
            <Card>
              <CardHeader>
                <CardTitle>Weakest Opening Lines</CardTitle>
                <CardDescription>
                  Lines where {id} (playing {analysis.playerColor}) struggles most - exploit these as {analysis.playerColor === "white" ? "Black" : "White"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {analysis.weakestLines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Not enough game data to identify weak lines
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    {analysis.weakestLines.map((line, index) => (
                      <OpeningLineBoard
                        key={index}
                        line={line.line}
                        winRate={line.winRate}
                        count={line.count}
                        isWeakLine={true}
                        playerColor={analysis.playerColor === "both" ? "white" : analysis.playerColor}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Strongest Opening Lines</CardTitle>
                <CardDescription>
                  Lines where {id} (playing {analysis.playerColor}) performs best - avoid or prepare deeply as {analysis.playerColor === "white" ? "Black" : "White"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {analysis.strongestLines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Not enough game data to identify strong lines
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    {analysis.strongestLines.map((line, index) => (
                      <OpeningLineBoard
                        key={index}
                        line={line.line}
                        winRate={line.winRate}
                        count={line.count}
                        isWeakLine={false}
                        playerColor={analysis.playerColor === "both" ? "white" : analysis.playerColor}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div> */}

          {/* COMMENTED OUT FOR LATER - Training Drill Section */}
          {/* <Card className="mt-6">
            <CardHeader>
              <CardTitle>Training Drill</CardTitle>
              <CardDescription>3 positions to practice before your game</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="bg-muted/30 border border-border rounded-lg p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  Training positions coming soon - requires engine analysis
                </p>
              </div>
            </CardContent>
          </Card> */}
        </div>
      </main>
    </div>
  );
};

export default Report;
