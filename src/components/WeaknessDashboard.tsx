import { useState, useEffect, useCallback, useRef } from "react";
import { Chess } from "chess.js";
import Chessboard from "chessboardjsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, TrendingDown, Target, AlertTriangle, Lightbulb, Play, BarChart3, Brain } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { extractTrainingPositions, saveTrainingPositions } from "@/lib/trainingGeneration";
import { useAuth } from "@/hooks/useAuth";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";
import {
  StockfishEngine,
  type GameAnalysis,
} from "@/lib/engineAnalysis";
import {
  generateWeaknessReport,
  getSeverityColor,
  type WeaknessReport,
  type WeaknessSummary,
  type CategorizedMistake,
} from "@/lib/weaknessDetection";

interface StoredGame {
  pgn: string;
  white: string;
  black: string;
  result: string;
  date?: string;
  url?: string;
  timeControl?: string;
}

interface WeaknessDashboardProps {
  games?: StoredGame[];
  username: string;
}

// Colors for pie chart
const CHART_COLORS = [
  'hsl(0, 84%, 60%)',    // red
  'hsl(25, 95%, 53%)',   // orange
  'hsl(45, 93%, 47%)',   // yellow
  'hsl(142, 76%, 36%)',  // green
  'hsl(199, 89%, 48%)',  // blue
  'hsl(262, 83%, 58%)',  // purple
  'hsl(330, 81%, 60%)',  // pink
  'hsl(174, 72%, 40%)',  // teal
  'hsl(221, 83%, 53%)',  // indigo
];

const severityLabels = {
  high: 'High Priority',
  medium: 'Medium Priority',
  low: 'Low Priority',
};

export default function WeaknessDashboard({ games = [], username }: WeaknessDashboardProps) {
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, currentGame: '' });
  const [report, setReport] = useState<WeaknessReport | null>(null);
  const [selectedWeakness, setSelectedWeakness] = useState<WeaknessSummary | null>(null);
  const [selectedExample, setSelectedExample] = useState<CategorizedMistake | null>(null);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  const [generatingTraining, setGeneratingTraining] = useState(false);
  
  const engineRef = useRef<StockfishEngine | null>(null);
  const abortRef = useRef(false);
  const navigate = useNavigate();
  const { user } = useAuth();
  
  // Collect all mistakes for training generation
  const allMistakes = report?.weaknesses.flatMap(w => w.examples) || [];

  const handleGenerateTraining = async () => {
    if (!user) {
      toast.error('Please sign in to generate training drills');
      navigate('/auth');
      return;
    }
    
    if (allMistakes.length === 0) {
      toast.error('No mistakes found to generate training from');
      return;
    }

    setGeneratingTraining(true);
    try {
      const positions = extractTrainingPositions(allMistakes, 20);
      const { saved, errors } = await saveTrainingPositions(positions);
      
      if (saved > 0) {
        toast.success(`Generated ${saved} training positions!`);
        navigate('/training');
      } else if (errors.length > 0) {
        toast.error(errors[0]);
      } else {
        toast.info('All positions already in your training library');
      }
    } catch (e) {
      toast.error('Failed to generate training positions');
    } finally {
      setGeneratingTraining(false);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current = true;
      if (engineRef.current) {
        engineRef.current.terminate();
      }
    };
  }, []);

  const runFullAnalysis = useCallback(async () => {
    if (games.length === 0) {
      toast.error('No games available');
      return;
    }

    // Limit to first 10 games for performance
    const gamesToAnalyze = games.slice(0, 10);
    
    setAnalyzing(true);
    setReport(null);
    setSelectedWeakness(null);
    setSelectedExample(null);
    abortRef.current = false;

    try {
      // Initialize engine if needed
      if (!engineRef.current) {
        toast.loading('Loading chess engine...', { id: 'engine-load' });
        engineRef.current = new StockfishEngine();
        await engineRef.current.init();
        toast.dismiss('engine-load');
      }

      const gameAnalyses: { analysis: GameAnalysis; gameIndex: number }[] = [];

      for (let i = 0; i < gamesToAnalyze.length; i++) {
        if (abortRef.current) break;

        const game = gamesToAnalyze[i];
        setProgress({
          current: i,
          total: gamesToAnalyze.length,
          currentGame: `${game.white} vs ${game.black}`,
        });

        try {
          const analysis = await engineRef.current.analyzeGame(
            game.pgn,
            14, // Lower depth for faster batch analysis
            () => {} // No per-move progress for batch
          );
          gameAnalyses.push({ analysis, gameIndex: i });
        } catch (err) {
          console.error(`Failed to analyze game ${i}:`, err);
          // Continue with other games
        }

        // Yield to UI
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (gameAnalyses.length === 0) {
        toast.error('Failed to analyze any games');
        return;
      }

      // Generate weakness report
      const weaknessReport = generateWeaknessReport(gameAnalyses);
      setReport(weaknessReport);
      
      toast.success(`Analyzed ${gameAnalyses.length} games. Found ${weaknessReport.weaknesses.length} weakness patterns.`);
    } catch (error) {
      console.error('Analysis error:', error);
      toast.error('Failed to complete analysis');
    } finally {
      setAnalyzing(false);
    }
  }, [games]);

  const stopAnalysis = useCallback(() => {
    abortRef.current = true;
    toast.info('Stopping analysis...');
  }, []);

  // Prepare chart data
  const chartData = report?.weaknesses.map((w, i) => ({
    name: w.label,
    value: w.count,
    color: CHART_COLORS[i % CHART_COLORS.length],
  })) || [];

  if (games.length === 0) {
    return (
      <Card className="border-border/50">
        <CardContent className="py-12 text-center">
          <TrendingDown className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">
            No games available for weakness detection.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Generate a scout report with games to use this feature.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Analysis Controls */}
      <Card className="border-border/50">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg flex items-center gap-2">
            <BarChart3 className="w-5 h-5" />
            Weakness Pattern Detection
          </CardTitle>
          <CardDescription>
            Analyze multiple games to identify recurring mistake patterns and get training recommendations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-4">
            <Button 
              onClick={runFullAnalysis} 
              disabled={analyzing}
              className="gap-2"
            >
              {analyzing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4" />
                  Analyze {Math.min(games.length, 10)} Games
                </>
              )}
            </Button>
            
            {analyzing && (
              <Button variant="outline" onClick={stopAnalysis}>
                Stop Analysis
              </Button>
            )}
          </div>

          {/* Progress during analysis */}
          {analyzing && (
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Analyzing: {progress.currentGame}</span>
                <span>Game {progress.current + 1} / {progress.total}</span>
              </div>
              <Progress value={((progress.current + 1) / Math.max(1, progress.total)) * 100} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      {report && (
        <>
          {/* Overview Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className="border-border/50">
              <CardContent className="pt-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-foreground">{report.gameCount}</p>
                  <p className="text-sm text-muted-foreground">Games Analyzed</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="pt-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-red-400">{report.totalBlunders}</p>
                  <p className="text-sm text-muted-foreground">Total Blunders</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="pt-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-orange-400">{report.totalMistakes}</p>
                  <p className="text-sm text-muted-foreground">Total Mistakes</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="pt-6">
                <div className="text-center">
                  <p className="text-3xl font-bold text-yellow-400">{report.totalInaccuracies}</p>
                  <p className="text-sm text-muted-foreground">Total Inaccuracies</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Generate Training Button */}
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="pt-6 flex items-center justify-between">
              <div>
                <p className="font-medium">Generate Training Drills</p>
                <p className="text-sm text-muted-foreground">Create spaced repetition drills from {allMistakes.length} mistakes</p>
              </div>
              <Button 
                onClick={handleGenerateTraining} 
                disabled={generatingTraining || allMistakes.length === 0}
              >
                {generatingTraining ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Brain className="w-4 h-4 mr-2" />}
                Generate Training
              </Button>
            </CardContent>
          </Card>

          {/* Main Content Grid */}
          <div className="grid lg:grid-cols-[1fr,400px] gap-6">
            {/* Left: Chart and Weakness Cards */}
            <div className="space-y-6">
              {/* Pie Chart */}
              {chartData.length > 0 && (
                <Card className="border-border/50">
                  <CardHeader>
                    <CardTitle className="text-base">Mistake Distribution</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="h-[300px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={chartData}
                            cx="50%"
                            cy="50%"
                            innerRadius={60}
                            outerRadius={100}
                            paddingAngle={2}
                            dataKey="value"
                          >
                            {chartData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip 
                            contentStyle={{ 
                              backgroundColor: 'hsl(var(--card))',
                              border: '1px solid hsl(var(--border))',
                              borderRadius: '8px',
                            }}
                            labelStyle={{ color: 'hsl(var(--foreground))' }}
                          />
                          <Legend 
                            verticalAlign="bottom"
                            height={36}
                            formatter={(value) => <span className="text-foreground text-sm">{value}</span>}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Weakness Priority Cards */}
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Weakness Priorities</h3>
                {report.weaknesses.length === 0 ? (
                  <Card className="border-border/50">
                    <CardContent className="py-8 text-center">
                      <Target className="w-8 h-8 mx-auto mb-2 text-green-400" />
                      <p className="text-muted-foreground">No significant weaknesses detected!</p>
                    </CardContent>
                  </Card>
                ) : (
                  report.weaknesses.map((weakness, index) => (
                    <Card 
                      key={weakness.category}
                      className={`border-border/50 cursor-pointer transition-all hover:border-primary/50 ${
                        selectedWeakness?.category === weakness.category ? 'ring-2 ring-primary/50' : ''
                      }`}
                      onClick={() => {
                        setSelectedWeakness(weakness);
                        setSelectedExample(weakness.examples[0] || null);
                      }}
                    >
                      <CardContent className="pt-6">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-2xl">{weakness.icon}</span>
                            <div>
                              <h4 className="font-semibold text-foreground">{weakness.label}</h4>
                              <p className="text-sm text-muted-foreground">
                                {weakness.count} occurrences • Avg loss: {weakness.avgEvalLoss}cp
                              </p>
                            </div>
                          </div>
                          <Badge className={getSeverityColor(weakness.severity)}>
                            {severityLabels[weakness.severity]}
                          </Badge>
                        </div>

                        {/* Recommendation */}
                        <div className="mt-4 p-3 bg-muted/30 rounded-lg flex items-start gap-2">
                          <Lightbulb className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                          <p className="text-sm text-foreground">{weakness.recommendation}</p>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </div>

            {/* Right: Example Position Viewer */}
            <div className="space-y-4">
              <Card className="border-border/50 sticky top-4">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    Example Position
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {selectedExample ? (
                    <div className="space-y-4">
                      {/* Board */}
                      <div className="flex justify-center">
                        <Chessboard
                          position={selectedExample.move.fenBefore}
                          orientation={boardOrientation}
                          width={350}
                          draggable={false}
                          transitionDuration={0}
                          sparePieces={false}
                        />
                      </div>

                      {/* Flip button */}
                      <div className="flex justify-center">
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => setBoardOrientation(o => o === 'white' ? 'black' : 'white')}
                        >
                          Flip Board
                        </Button>
                      </div>

                      {/* Move info */}
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Played:</span>
                          <span className="font-mono text-red-400">{selectedExample.move.move}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Best move:</span>
                          <span className="font-mono text-green-400">{selectedExample.move.bestMove}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Eval loss:</span>
                          <span className="font-mono">{Math.abs(selectedExample.move.evalLoss)}cp</span>
                        </div>
                        <p className="text-muted-foreground pt-2 border-t border-border/50">
                          {selectedExample.description}
                        </p>
                      </div>

                      {/* Example selector if multiple */}
                      {selectedWeakness && selectedWeakness.examples.length > 1 && (
                        <div className="pt-2 border-t border-border/50">
                          <p className="text-xs text-muted-foreground mb-2">More examples:</p>
                          <div className="flex gap-2 flex-wrap">
                            {selectedWeakness.examples.map((ex, i) => (
                              <Button
                                key={i}
                                variant={selectedExample === ex ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setSelectedExample(ex)}
                              >
                                {i + 1}
                              </Button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="py-12 text-center text-muted-foreground">
                      <Target className="w-8 h-8 mx-auto mb-2" />
                      <p>Select a weakness to see example positions</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
