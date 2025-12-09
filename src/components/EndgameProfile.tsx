import { useState, useEffect } from 'react';
import Chessboard from 'chessboardjsx';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  TrendingDown, 
  TrendingUp, 
  Target, 
  Loader2,
  ChevronRight,
  ChevronLeft,
  RotateCcw,
  Percent
} from 'lucide-react';
import { generateEndgameStats, EndgameReport, EndgameStats } from '@/lib/endgameStats';

interface StoredGame {
  pgn: string;
  white: string;
  black: string;
  result: string;
  date?: string;
}

interface EndgameProfileProps {
  games?: StoredGame[];
  username: string;
}

export function EndgameProfile({ games = [], username }: EndgameProfileProps) {
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [report, setReport] = useState<EndgameReport | null>(null);
  const [selectedEndgame, setSelectedEndgame] = useState<EndgameStats | null>(null);
  const [exampleIndex, setExampleIndex] = useState(0);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');

  const runAnalysis = async () => {
    if (games.length === 0) return;
    
    setAnalyzing(true);
    setProgress({ current: 0, total: games.length });
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const endgameReport = generateEndgameStats(
      games,
      username,
      (current, total) => {
        setProgress({ current, total });
      }
    );
    
    setReport(endgameReport);
    setAnalyzing(false);
    
    if (endgameReport.worstEndgames.length > 0) {
      setSelectedEndgame(endgameReport.worstEndgames[0]);
    }
  };

  useEffect(() => {
    setExampleIndex(0);
  }, [selectedEndgame]);

  if (games.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Target className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No games available for endgame analysis</p>
        </CardContent>
      </Card>
    );
  }

  const getPerformanceColor = (rating: 'excellent' | 'good' | 'average' | 'poor'): string => {
    switch (rating) {
      case 'excellent': return 'text-green-400 bg-green-500/20';
      case 'good': return 'text-blue-400 bg-blue-500/20';
      case 'average': return 'text-yellow-400 bg-yellow-500/20';
      case 'poor': return 'text-red-400 bg-red-500/20';
    }
  };

  const getDifficultyColor = (difficulty: 'easy' | 'medium' | 'hard'): string => {
    switch (difficulty) {
      case 'easy': return 'text-green-400';
      case 'medium': return 'text-yellow-400';
      case 'hard': return 'text-red-400';
    }
  };

  const currentFen = selectedEndgame?.examplePositions[exampleIndex] || 'start';

  return (
    <div className="space-y-6">
      {/* Analysis Control */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Endgame Analysis
          </CardTitle>
          <CardDescription>
            Track {username}'s endgame performance and conversion rates
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button 
            onClick={runAnalysis} 
            disabled={analyzing}
          >
            {analyzing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Analyzing {progress.current}/{progress.total}...
              </>
            ) : (
              <>
                <Target className="w-4 h-4 mr-2" />
                Analyze {games.length} Games
              </>
            )}
          </Button>

          {analyzing && (
            <div className="mt-4">
              <Progress value={(progress.current / Math.max(1, progress.total)) * 100} />
            </div>
          )}
        </CardContent>
      </Card>

      {report && (
        <>
          {/* Overview Stats */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Card>
              <CardContent className="pt-6 text-center">
                <div className="text-3xl font-bold">{report.totalEndgamesReached}</div>
                <div className="text-sm text-muted-foreground">Endgames Reached</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center">
                <div className="text-3xl font-bold flex items-center justify-center gap-1">
                  <Percent className="h-6 w-6" />
                  {Math.round(report.overallConversionRate * 100)}
                </div>
                <div className="text-sm text-muted-foreground">Conversion Rate</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center">
                <div className="text-3xl font-bold">{report.stats.length}</div>
                <div className="text-sm text-muted-foreground">Endgame Types</div>
              </CardContent>
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Left: Endgame Rankings */}
            <div className="space-y-4">
              {/* Weakest Endgames */}
              <Card className="border-red-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2 text-red-400">
                    <TrendingDown className="h-4 w-4" />
                    Weakest Endgames
                  </CardTitle>
                  <CardDescription>
                    {username} struggles to convert these endings
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {report.worstEndgames.map((stats) => (
                      <button
                        key={stats.type}
                        onClick={() => setSelectedEndgame(stats)}
                        className={`w-full text-left p-3 rounded-lg border transition-colors ${
                          selectedEndgame?.type === stats.type
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xl">{stats.info.icon}</span>
                            <span className="font-medium">{stats.info.label}</span>
                          </div>
                          <Badge className={getPerformanceColor(stats.performanceRating)}>
                            {Math.round(stats.winRate * 100)}% wins
                          </Badge>
                        </div>
                        <div className="text-sm text-muted-foreground mt-1 flex justify-between">
                          <span>{stats.gamesReached} games</span>
                          {stats.winningPositions > 0 && (
                            <span>
                              Conv: {Math.round(stats.conversionRate * 100)}%
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                    {report.worstEndgames.length === 0 && (
                      <p className="text-muted-foreground text-sm">Not enough data</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Best Endgames */}
              <Card className="border-green-500/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2 text-green-400">
                    <TrendingUp className="h-4 w-4" />
                    Best Endgames
                  </CardTitle>
                  <CardDescription>
                    {username} excels in these endings
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {report.bestEndgames.map((stats) => (
                      <button
                        key={stats.type}
                        onClick={() => setSelectedEndgame(stats)}
                        className={`w-full text-left p-3 rounded-lg border transition-colors ${
                          selectedEndgame?.type === stats.type
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xl">{stats.info.icon}</span>
                            <span className="font-medium">{stats.info.label}</span>
                          </div>
                          <Badge className={getPerformanceColor(stats.performanceRating)}>
                            {Math.round(stats.winRate * 100)}% wins
                          </Badge>
                        </div>
                        <div className="text-sm text-muted-foreground mt-1 flex justify-between">
                          <span>{stats.gamesReached} games</span>
                          {stats.winningPositions > 0 && (
                            <span>
                              Conv: {Math.round(stats.conversionRate * 100)}%
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                    {report.bestEndgames.length === 0 && (
                      <p className="text-muted-foreground text-sm">Not enough data</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* All Endgames */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">All Endgame Statistics</CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[200px]">
                    <div className="space-y-1">
                      {report.stats.map((stats) => (
                        <button
                          key={stats.type}
                          onClick={() => setSelectedEndgame(stats)}
                          className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                            selectedEndgame?.type === stats.type
                              ? 'bg-primary/10'
                              : 'hover:bg-muted/50'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span>{stats.info.icon} {stats.info.label}</span>
                            <span className={
                              stats.performanceRating === 'poor' ? 'text-red-400' :
                              stats.performanceRating === 'excellent' ? 'text-green-400' :
                              'text-muted-foreground'
                            }>
                              {Math.round(stats.winRate * 100)}% ({stats.gamesReached}g)
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>

            {/* Right: Selected Endgame Details */}
            <div className="space-y-4">
              {selectedEndgame ? (
                <>
                  {/* Endgame Info Card */}
                  <Card>
                    <CardHeader>
                      <div className="flex items-center gap-3">
                        <span className="text-3xl">{selectedEndgame.info.icon}</span>
                        <div>
                          <CardTitle className="flex items-center gap-2">
                            {selectedEndgame.info.label}
                            <Badge variant="outline" className={getDifficultyColor(selectedEndgame.info.difficulty)}>
                              {selectedEndgame.info.difficulty}
                            </Badge>
                          </CardTitle>
                          <CardDescription>
                            {selectedEndgame.info.description}
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      {/* Stats Grid */}
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="p-2 rounded bg-green-500/10">
                          <div className="text-lg font-bold text-green-400">{selectedEndgame.wins}</div>
                          <div className="text-xs text-muted-foreground">Wins</div>
                        </div>
                        <div className="p-2 rounded bg-muted/30">
                          <div className="text-lg font-bold">{selectedEndgame.draws}</div>
                          <div className="text-xs text-muted-foreground">Draws</div>
                        </div>
                        <div className="p-2 rounded bg-red-500/10">
                          <div className="text-lg font-bold text-red-400">{selectedEndgame.losses}</div>
                          <div className="text-xs text-muted-foreground">Losses</div>
                        </div>
                      </div>

                      {/* Conversion Rate */}
                      {selectedEndgame.winningPositions > 0 && (
                        <div className="p-3 rounded bg-muted/30">
                          <div className="flex justify-between items-center">
                            <span className="text-sm">Conversion Rate</span>
                            <span className="font-bold">
                              {Math.round(selectedEndgame.conversionRate * 100)}%
                            </span>
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Converted {selectedEndgame.converted} of {selectedEndgame.winningPositions} winning positions
                          </div>
                        </div>
                      )}

                      {/* Key Techniques */}
                      <div>
                        <h4 className="font-medium mb-2 flex items-center gap-2">
                          <Target className="h-4 w-4 text-primary" />
                          Key Techniques
                        </h4>
                        <ul className="space-y-1">
                          {selectedEndgame.info.keyTechniques.map((technique, i) => (
                            <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                              <span className="text-primary mt-1">•</span>
                              {technique}
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Common Mistakes */}
                      <div>
                        <h4 className="font-medium mb-2 flex items-center gap-2 text-red-400">
                          <TrendingDown className="h-4 w-4" />
                          Common Mistakes
                        </h4>
                        <ul className="space-y-1">
                          {selectedEndgame.info.commonMistakes.map((mistake, i) => (
                            <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                              <span className="text-red-400 mt-1">✗</span>
                              {mistake}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Example Position */}
                  {selectedEndgame.examplePositions.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-base">Example Position</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex justify-center mb-3">
                          <Chessboard
                            position={currentFen}
                            width={280}
                            orientation={boardOrientation}
                            draggable={false}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setExampleIndex(Math.max(0, exampleIndex - 1))}
                              disabled={exampleIndex === 0}
                            >
                              <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setExampleIndex(Math.min(selectedEndgame.examplePositions.length - 1, exampleIndex + 1))}
                              disabled={exampleIndex >= selectedEndgame.examplePositions.length - 1}
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </div>
                          <span className="text-sm text-muted-foreground">
                            {exampleIndex + 1} / {selectedEndgame.examplePositions.length}
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setBoardOrientation(o => o === 'white' ? 'black' : 'white')}
                          >
                            <RotateCcw className="h-4 w-4" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <Card>
                  <CardContent className="py-12 text-center">
                    <Target className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-muted-foreground">
                      Select an endgame type to view techniques
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
