import { useState, useEffect, useCallback, useRef } from "react";
import { Chess } from "chess.js";
import Chessboard from "chessboardjsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Play, Square, ChevronLeft, ChevronRight, RotateCcw, Brain } from "lucide-react";
import { toast } from "sonner";
import { 
  StockfishEngine, 
  type MoveAnalysis, 
  type GameAnalysis,
  getGamePhase 
} from "@/lib/engineAnalysis";
import { supabase } from "@/integrations/supabase/client";

interface StoredGame {
  pgn: string;
  white: string;
  black: string;
  result: string;
  date?: string;
  url?: string;
  timeControl?: string;
}

interface DeepAnalysisTabProps {
  games?: StoredGame[];
  username: string;
}

const classificationColors: Record<string, string> = {
  brilliant: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/50',
  excellent: 'bg-green-500/20 text-green-400 border-green-500/50',
  good: 'bg-green-500/10 text-green-300 border-green-500/30',
  inaccuracy: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
  mistake: 'bg-orange-500/20 text-orange-400 border-orange-500/50',
  blunder: 'bg-red-500/20 text-red-400 border-red-500/50',
};

const classificationSymbols: Record<string, string> = {
  brilliant: '!!',
  excellent: '!',
  good: '',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

export default function DeepAnalysisTab({ games = [], username }: DeepAnalysisTabProps) {
  const [selectedGameIndex, setSelectedGameIndex] = useState<number>(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  const [gameAnalysis, setGameAnalysis] = useState<GameAnalysis | null>(null);
  const [selectedMoveIndex, setSelectedMoveIndex] = useState<number>(-1);
  const [explanation, setExplanation] = useState<string | null>(null);
  const [loadingExplanation, setLoadingExplanation] = useState(false);
  const [boardPosition, setBoardPosition] = useState('start');
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  
  const engineRef = useRef<StockfishEngine | null>(null);
  const analysisCache = useRef<Map<number, GameAnalysis>>(new Map());

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (engineRef.current) {
        engineRef.current.terminate();
      }
    };
  }, []);

  // Update board position when move is selected
  useEffect(() => {
    if (selectedMoveIndex >= 0 && gameAnalysis?.moves[selectedMoveIndex]) {
      setBoardPosition(gameAnalysis.moves[selectedMoveIndex].fen);
    } else if (selectedMoveIndex === -1 && games[selectedGameIndex]) {
      setBoardPosition('start');
    }
  }, [selectedMoveIndex, gameAnalysis, games, selectedGameIndex]);

  const handleAnalyze = useCallback(async () => {
    if (!games[selectedGameIndex]) {
      toast.error('No game selected');
      return;
    }

    // Check cache first
    if (analysisCache.current.has(selectedGameIndex)) {
      setGameAnalysis(analysisCache.current.get(selectedGameIndex)!);
      setSelectedMoveIndex(0);
      toast.success('Loaded from cache');
      return;
    }

    setAnalyzing(true);
    setGameAnalysis(null);
    setSelectedMoveIndex(-1);
    setExplanation(null);

    try {
      // Initialize engine if needed
      if (!engineRef.current) {
        toast.loading('Loading chess engine...', { id: 'engine-load' });
        try {
          const engine = new StockfishEngine();
          await engine.init();
          engineRef.current = engine;
        } catch (initError) {
          // Don't keep a half-initialized engine around or retries will fail.
          engineRef.current = null;
          throw initError;
        } finally {
          toast.dismiss('engine-load');
        }
      }

      const game = games[selectedGameIndex];
      
      // Count moves first
      const tempChess = new Chess();
      tempChess.loadPgn(game.pgn);
      const totalMoves = tempChess.history().length;
      setAnalysisProgress({ current: 0, total: totalMoves });

      // Analyze with progress
      const result = await engineRef.current.analyzeGame(
        game.pgn,
        14, // depth 14 balances accuracy and speed for a single game
        (current, total, moveAnalysis) => {
          setAnalysisProgress({ current, total });
        }
      );

      // Cache result
      analysisCache.current.set(selectedGameIndex, result);
      
      setGameAnalysis(result);
      setSelectedMoveIndex(0);
      
      toast.success(`Analysis complete: ${result.blunders} blunders, ${result.mistakes} mistakes`);
    } catch (error) {
      console.error('Analysis error:', error);
      const message = error instanceof Error ? error.message : '';
      toast.error(message || 'Failed to analyze game. The engine may not be supported in this browser.');
    } finally {
      setAnalyzing(false);
    }
  }, [games, selectedGameIndex]);

  const fetchExplanation = useCallback(async (move: MoveAnalysis) => {
    // Only fetch for mistakes and blunders
    if (move.classification !== 'mistake' && move.classification !== 'blunder' && move.classification !== 'inaccuracy') {
      setExplanation(null);
      return;
    }

    // Check sessionStorage cache
    const cacheKey = `explain_${move.fenBefore}_${move.move}`;
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      setExplanation(cached);
      return;
    }

    setLoadingExplanation(true);
    try {
      const { data, error } = await supabase.functions.invoke('explain-move', {
        body: {
          fen: move.fenBefore,
          movePlayed: move.move,
          bestMove: move.bestMove,
          evalDiff: move.evalLoss,
          classification: move.classification,
          gamePhase: getGamePhase(move.fenBefore, move.moveNumber),
          playerColor: move.color
        }
      });

      if (error) {
        // Check for rate limit or payment errors
        const errorMessage = error.message || '';
        if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
          toast.error('Rate limit exceeded. Please wait a moment before requesting more explanations.');
          setExplanation('AI explanation temporarily unavailable due to rate limits.');
          return;
        } else if (errorMessage.includes('402') || errorMessage.includes('payment')) {
          toast.error('AI credits exhausted. Please add credits to continue.');
          setExplanation('AI explanation unavailable - credits needed.');
          return;
        }
        throw error;
      }

      const explanationText = data?.explanation || 'Unable to generate explanation.';
      setExplanation(explanationText);
      
      // Cache for session
      sessionStorage.setItem(cacheKey, explanationText);
    } catch (error) {
      console.error('Explanation error:', error);
      setExplanation('Failed to get AI explanation. Try again later.');
    } finally {
      setLoadingExplanation(false);
    }
  }, []);

  // Fetch explanation when move changes
  useEffect(() => {
    if (selectedMoveIndex >= 0 && gameAnalysis?.moves[selectedMoveIndex]) {
      fetchExplanation(gameAnalysis.moves[selectedMoveIndex]);
    } else {
      setExplanation(null);
    }
  }, [selectedMoveIndex, gameAnalysis, fetchExplanation]);

  const handlePrevMove = useCallback(() => {
    setSelectedMoveIndex(prev => Math.max(-1, prev - 1));
  }, []);

  const handleNextMove = useCallback(() => {
    if (!gameAnalysis) return;
    setSelectedMoveIndex(prev => Math.min(gameAnalysis.moves.length - 1, prev + 1));
  }, [gameAnalysis]);

  const handleReset = useCallback(() => {
    setSelectedMoveIndex(-1);
    setBoardPosition('start');
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handlePrevMove();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNextMove();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePrevMove, handleNextMove]);

  const selectedMove = selectedMoveIndex >= 0 ? gameAnalysis?.moves[selectedMoveIndex] : null;

  if (games.length === 0) {
    return (
      <Card className="border-border/50">
        <CardContent className="py-12 text-center">
          <Brain className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">
            No games available for deep analysis.
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
      {/* Game Selector */}
      <Card className="border-border/50">
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Select Game to Analyze</CardTitle>
          <CardDescription>
            Choose a game and run deep engine analysis with AI explanations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-4">
            <Select 
              value={selectedGameIndex.toString()} 
              onValueChange={(v) => {
                setSelectedGameIndex(parseInt(v));
                setGameAnalysis(null);
                setSelectedMoveIndex(-1);
                setExplanation(null);
              }}
            >
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Select a game" />
              </SelectTrigger>
              <SelectContent>
                {games.map((game, index) => (
                  <SelectItem key={index} value={index.toString()}>
                    {game.white} vs {game.black} ({game.result}) {game.date ? `- ${game.date}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            
            <Button 
              onClick={handleAnalyze} 
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
                  Analyze Game
                </>
              )}
            </Button>
          </div>

          {/* Progress bar during analysis */}
          {analyzing && (
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Analyzing moves...</span>
                <span>{analysisProgress.current} / {analysisProgress.total}</span>
              </div>
              <Progress value={(analysisProgress.current / Math.max(1, analysisProgress.total)) * 100} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Analysis Display */}
      {gameAnalysis && (
        <div className="grid lg:grid-cols-[1fr,300px] gap-6">
          {/* Board and Controls */}
          <Card className="border-border/50">
            <CardContent className="pt-6">
              {/* Navigation Controls */}
              <div className="flex items-center justify-center gap-2 mb-4">
                <Button variant="outline" size="icon" onClick={handleReset}>
                  <RotateCcw className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={handlePrevMove}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="px-4 text-sm text-muted-foreground min-w-[100px] text-center">
                  {selectedMoveIndex >= 0 
                    ? `Move ${Math.floor(selectedMoveIndex / 2) + 1}${selectedMoveIndex % 2 === 0 ? '.' : '...'}`
                    : 'Start'
                  }
                </span>
                <Button variant="outline" size="icon" onClick={handleNextMove}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setBoardOrientation(o => o === 'white' ? 'black' : 'white')}
                >
                  Flip
                </Button>
              </div>

              {/* Chessboard - transitionDuration={0} prevents animation artifacts */}
              <div className="flex justify-center">
                <Chessboard
                  position={boardPosition}
                  orientation={boardOrientation}
                  width={400}
                  draggable={false}
                  transitionDuration={0}
                  sparePieces={false}
                />
              </div>

              {/* Evaluation Bar */}
              {selectedMove && (
                <div className="mt-4 flex items-center justify-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Eval:</span>
                    <Badge variant={selectedMove.evaluation > 0 ? 'default' : 'secondary'}>
                      {selectedMove.evaluation >= 0 ? '+' : ''}{(selectedMove.evaluation / 100).toFixed(1)}
                    </Badge>
                  </div>
                  <Badge className={classificationColors[selectedMove.classification]}>
                    {selectedMove.classification.charAt(0).toUpperCase() + selectedMove.classification.slice(1)}
                    {classificationSymbols[selectedMove.classification] && ` ${classificationSymbols[selectedMove.classification]}`}
                  </Badge>
                </div>
              )}

              {/* AI Explanation */}
              {(explanation || loadingExplanation) && selectedMove && (
                <div className="mt-4 p-4 bg-muted/30 rounded-lg border border-border/50">
                  <div className="flex items-center gap-2 mb-2">
                    <Brain className="w-4 h-4 text-primary" />
                    <span className="text-sm font-medium">AI Explanation</span>
                  </div>
                  {loadingExplanation ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Generating explanation...
                    </div>
                  ) : (
                    <p className="text-sm text-foreground leading-relaxed">{explanation}</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Move List */}
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Moves</CardTitle>
              <div className="flex gap-2 text-xs text-muted-foreground">
                <span className="text-red-400">{gameAnalysis.blunders} blunders</span>
                <span className="text-orange-400">{gameAnalysis.mistakes} mistakes</span>
                <span className="text-yellow-400">{gameAnalysis.inaccuracies} inaccuracies</span>
              </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[500px] pr-4">
                <div className="space-y-1">
                  {gameAnalysis.moves.map((move, index) => {
                    const isSelected = index === selectedMoveIndex;
                    const showMoveNumber = move.color === 'white';
                    
                    return (
                      <button
                        key={index}
                        onClick={() => setSelectedMoveIndex(index)}
                        className={`w-full text-left px-2 py-1 rounded text-sm transition-colors ${
                          isSelected 
                            ? 'bg-primary/20 text-primary' 
                            : 'hover:bg-muted/50'
                        }`}
                      >
                        <span className="inline-flex items-center gap-2">
                          {showMoveNumber && (
                            <span className="text-muted-foreground w-8">{move.moveNumber}.</span>
                          )}
                          {!showMoveNumber && <span className="w-8" />}
                          <span className={`font-medium ${
                            move.classification === 'blunder' ? 'text-red-400' :
                            move.classification === 'mistake' ? 'text-orange-400' :
                            move.classification === 'inaccuracy' ? 'text-yellow-400' :
                            move.classification === 'excellent' ? 'text-green-400' :
                            'text-foreground'
                          }`}>
                            {move.move}
                            {classificationSymbols[move.classification]}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {move.evaluation >= 0 ? '+' : ''}{(move.evaluation / 100).toFixed(1)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
