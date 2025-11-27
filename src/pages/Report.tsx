import { useParams, useLocation } from "react-router-dom";
import Header from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Download, Copy, Check, ChevronRight } from "lucide-react";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import type { SerializedAnalysisResult } from "@/lib/chessAnalysis";
import OpeningTreeViewer from "@/components/OpeningTreeViewer";

const Report = () => {
  const { id } = useParams();
  const location = useLocation();
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<SerializedAnalysisResult | null>(null);

  useEffect(() => {
    // Get analysis from navigation state or fallback to cache
    if (location.state) {
      setAnalysis(location.state as SerializedAnalysisResult);
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

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedIndex(index);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedIndex(null), 2000);
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
    
    return `Player has ${analysis.totalGames} games analyzed as ${analysis.playerColor}. ` +
           (weakestLine ? `Weakest opening: ${weakestLine.line} (${(weakestLine.winRate * 100).toFixed(0)}% win rate in ${weakestLine.count} games). ` : '') +
           (strongestLine ? `Strongest opening: ${strongestLine.line} (${(strongestLine.winRate * 100).toFixed(0)}% win rate in ${strongestLine.count} games). ` : '') +
           `Target their weak lines and avoid or deeply prepare against their strongest lines.`;
  };

  const generateChecklist = () => {
    const items: string[] = [];
    
    if (analysis.weakestLines.length > 0) {
      items.push(`Target ${analysis.weakestLines[0].line} - their weakest line at ${(analysis.weakestLines[0].winRate * 100).toFixed(0)}%`);
    }
    
    if (analysis.strongestLines.length > 0) {
      items.push(`Avoid ${analysis.strongestLines[0].line} - they score ${(analysis.strongestLines[0].winRate * 100).toFixed(0)}% here`);
    }
    
    items.push(`${analysis.totalGames} games analyzed - data is ${analysis.totalGames > 100 ? 'highly' : 'moderately'} reliable`);
    items.push(`Analyzed as ${analysis.playerColor} - prepare color-specific lines`);
    
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
                {analysis.totalGames} games analyzed as {analysis.playerColor}
              </p>
            </div>
            <Button onClick={handleDownload} variant="outline">
              <Download className="mr-2 w-4 h-4" />
              Download JSON
            </Button>
          </div>

          <div className="grid lg:grid-cols-3 gap-6">
            {/* Left Column: Summary & Checklist */}
            <div className="lg:col-span-1 space-y-6">
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
            </div>

            {/* Right Column: Detailed Analysis */}
            <div className="lg:col-span-2 space-y-6">
              {/* Opening Tree */}
              <Card>
                <CardHeader>
                  <CardTitle>Opening Repertoire Tree</CardTitle>
                  <CardDescription>
                    Interactive move tree showing frequencies and win rates
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {analysis.openingTree ? (
                    <div className="max-h-[600px] overflow-y-auto pr-2">
                      <OpeningTreeViewer node={analysis.openingTree} maxDepth={15} />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">No opening tree data available</p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Weakest Opening Lines</CardTitle>
                  <CardDescription>
                    Lines where {id} struggles most (minimum 3 games)
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {analysis.weakestLines.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Not enough game data to identify weak lines
                    </p>
                  ) : (
                    analysis.weakestLines.map((line, index) => (
                      <div key={index} className="border border-border rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <code className="font-mono text-sm bg-muted px-2 py-1 rounded">
                            {line.line}
                          </code>
                          <Badge variant={
                            line.winRate < 0.3 ? "default" :
                            line.winRate < 0.4 ? "secondary" : "outline"
                          }>
                            {(line.winRate * 100).toFixed(0)}% win rate
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {line.count} games • Target this line in your preparation
                        </p>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Strongest Opening Lines</CardTitle>
                  <CardDescription>
                    Lines where {id} performs best - avoid or prepare deeply
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {analysis.strongestLines.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Not enough game data to identify strong lines
                    </p>
                  ) : (
                    analysis.strongestLines.map((line, index) => (
                      <div key={index} className="border border-border rounded-lg p-4">
                        <div className="flex items-center justify-between mb-2">
                          <code className="font-mono text-sm bg-muted px-2 py-1 rounded">
                            {line.line}
                          </code>
                          <Badge variant="default">
                            {(line.winRate * 100).toFixed(0)}% win rate
                          </Badge>
                        </div>
                        <div className="flex items-center justify-between">
                          <p className="text-sm text-muted-foreground">
                            {line.count} games • Avoid this line or prepare deeply
                          </p>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCopy(line.line, index)}
                            className="h-8 w-8 p-0"
                          >
                            {copiedIndex === index ? (
                              <Check className="w-3 h-3" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
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
              </Card>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Report;
