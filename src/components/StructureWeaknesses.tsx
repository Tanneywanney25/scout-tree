import { useState, useEffect } from 'react';
import { Chess } from 'chess.js';
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
  RotateCcw
} from 'lucide-react';
import { generateStructureStats, StructureReport, StructureStats } from '@/lib/structureStats';

interface StoredGame {
  pgn: string;
  white: string;
  black: string;
  result: string;
  date?: string;
}

interface StructureWeaknessesProps {
  games?: StoredGame[];
  username: string;
}

export function StructureWeaknesses({ games = [], username }: StructureWeaknessesProps) {
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [report, setReport] = useState<StructureReport | null>(null);
  const [selectedStructure, setSelectedStructure] = useState<StructureStats | null>(null);
  const [exampleIndex, setExampleIndex] = useState(0);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');

  const runAnalysis = async () => {
    if (games.length === 0) return;
    
    setAnalyzing(true);
    setProgress({ current: 0, total: games.length });
    
    // Use setTimeout to allow UI to update
    await new Promise(resolve => setTimeout(resolve, 50));
    
    const structureReport = generateStructureStats(
      games,
      username,
      (current, total) => {
        setProgress({ current, total });
      }
    );
    
    setReport(structureReport);
    setAnalyzing(false);
    
    // Auto-select first weak structure
    if (structureReport.weakestStructures.length > 0) {
      setSelectedStructure(structureReport.weakestStructures[0]);
    }
  };

  // Reset example index when structure changes
  useEffect(() => {
    setExampleIndex(0);
  }, [selectedStructure]);

  if (games.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <Target className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">No games available for structure analysis</p>
        </CardContent>
      </Card>
    );
  }

  const getPerformanceColor = (rating: 'strong' | 'neutral' | 'weak'): string => {
    switch (rating) {
      case 'strong': return 'text-green-400 bg-green-500/20';
      case 'weak': return 'text-red-400 bg-red-500/20';
      default: return 'text-yellow-400 bg-yellow-500/20';
    }
  };

  const currentFen = selectedStructure?.examplePositions[exampleIndex] || 'start';

  return (
    <div className="space-y-6">
      {/* Analysis Control */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="h-5 w-5" />
            Pawn Structure Analysis
          </CardTitle>
          <CardDescription>
            Identify which pawn structures {username} struggles with and get strategic plans
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
        <div className="grid lg:grid-cols-2 gap-6">
          {/* Left: Structure Rankings */}
          <div className="space-y-4">
            {/* Weakest Structures */}
            <Card className="border-red-500/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2 text-red-400">
                  <TrendingDown className="h-4 w-4" />
                  Weakest Structures
                </CardTitle>
                <CardDescription>
                  {username} struggles most with these pawn structures
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {report.weakestStructures.map((stats) => (
                    <button
                      key={stats.type}
                      onClick={() => setSelectedStructure(stats)}
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                        selectedStructure?.type === stats.type
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xl">{stats.structure.icon}</span>
                          <span className="font-medium">{stats.structure.label}</span>
                        </div>
                        <Badge className={getPerformanceColor(stats.performanceRating)}>
                          {Math.round(stats.winRate * 100)}% wins
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {stats.gamesPlayed} games: {stats.wins}W / {stats.draws}D / {stats.losses}L
                      </div>
                    </button>
                  ))}
                  {report.weakestStructures.length === 0 && (
                    <p className="text-muted-foreground text-sm">Not enough data</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Strongest Structures */}
            <Card className="border-green-500/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2 text-green-400">
                  <TrendingUp className="h-4 w-4" />
                  Strongest Structures
                </CardTitle>
                <CardDescription>
                  {username} performs well in these structures
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {report.strongestStructures.map((stats) => (
                    <button
                      key={stats.type}
                      onClick={() => setSelectedStructure(stats)}
                      className={`w-full text-left p-3 rounded-lg border transition-colors ${
                        selectedStructure?.type === stats.type
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:border-primary/50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xl">{stats.structure.icon}</span>
                          <span className="font-medium">{stats.structure.label}</span>
                        </div>
                        <Badge className={getPerformanceColor(stats.performanceRating)}>
                          {Math.round(stats.winRate * 100)}% wins
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        {stats.gamesPlayed} games: {stats.wins}W / {stats.draws}D / {stats.losses}L
                      </div>
                    </button>
                  ))}
                  {report.strongestStructures.length === 0 && (
                    <p className="text-muted-foreground text-sm">Not enough data</p>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* All Structures */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">All Structure Statistics</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[200px]">
                  <div className="space-y-1">
                    {report.stats.map((stats) => (
                      <button
                        key={stats.type}
                        onClick={() => setSelectedStructure(stats)}
                        className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                          selectedStructure?.type === stats.type
                            ? 'bg-primary/10'
                            : 'hover:bg-muted/50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span>{stats.structure.icon} {stats.structure.label}</span>
                          <span className={
                            stats.performanceRating === 'weak' ? 'text-red-400' :
                            stats.performanceRating === 'strong' ? 'text-green-400' :
                            'text-muted-foreground'
                          }>
                            {Math.round(stats.winRate * 100)}% ({stats.gamesPlayed}g)
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          {/* Right: Selected Structure Details */}
          <div className="space-y-4">
            {selectedStructure ? (
              <>
                {/* Structure Info Card */}
                <Card>
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">{selectedStructure.structure.icon}</span>
                      <div>
                        <CardTitle>{selectedStructure.structure.label}</CardTitle>
                        <CardDescription>
                          {selectedStructure.structure.description}
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Stats */}
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div className="p-2 rounded bg-muted/30">
                        <div className="text-lg font-bold">{selectedStructure.gamesPlayed}</div>
                        <div className="text-xs text-muted-foreground">Games</div>
                      </div>
                      <div className="p-2 rounded bg-green-500/10">
                        <div className="text-lg font-bold text-green-400">{selectedStructure.wins}</div>
                        <div className="text-xs text-muted-foreground">Wins</div>
                      </div>
                      <div className="p-2 rounded bg-muted/30">
                        <div className="text-lg font-bold">{selectedStructure.draws}</div>
                        <div className="text-xs text-muted-foreground">Draws</div>
                      </div>
                      <div className="p-2 rounded bg-red-500/10">
                        <div className="text-lg font-bold text-red-400">{selectedStructure.losses}</div>
                        <div className="text-xs text-muted-foreground">Losses</div>
                      </div>
                    </div>

                    {/* Strategic Plans */}
                    <div>
                      <h4 className="font-medium mb-2 flex items-center gap-2">
                        <Target className="h-4 w-4 text-primary" />
                        Strategic Plans
                      </h4>
                      <ul className="space-y-1">
                        {selectedStructure.structure.strategicPlans.map((plan, i) => (
                          <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                            <span className="text-primary mt-1">•</span>
                            {plan}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Common Mistakes */}
                    <div>
                      <h4 className="font-medium mb-2 flex items-center gap-2 text-red-400">
                        <TrendingDown className="h-4 w-4" />
                        Common Mistakes to Avoid
                      </h4>
                      <ul className="space-y-1">
                        {selectedStructure.structure.commonMistakes.map((mistake, i) => (
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
                {selectedStructure.examplePositions.length > 0 && (
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
                            onClick={() => setExampleIndex(Math.min(selectedStructure.examplePositions.length - 1, exampleIndex + 1))}
                            disabled={exampleIndex >= selectedStructure.examplePositions.length - 1}
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {exampleIndex + 1} / {selectedStructure.examplePositions.length}
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
                    Select a structure to view strategic plans
                  </p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
