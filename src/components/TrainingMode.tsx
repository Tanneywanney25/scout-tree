import React, { useState, useCallback, useEffect } from 'react';
import { Chess, Square } from 'chess.js';
import Chessboard from 'chessboardjsx';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { 
  TrainingPosition, 
  updateTrainingPosition,
  sanToUci 
} from '@/lib/trainingGeneration';
import { 
  Lightbulb, 
  CheckCircle2, 
  XCircle, 
  RotateCcw, 
  ChevronRight,
  Star,
  Eye
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

// Compare moves using UCI format for reliability
function movesMatch(fen: string, playedMove: { from: string; to: string; promotion?: string }, targetSan: string, targetUci: string): boolean {
  // Build UCI from played move
  let playedUci = playedMove.from + playedMove.to;
  if (playedMove.promotion) {
    playedUci += playedMove.promotion;
  }
  
  // Compare with stored UCI
  if (playedUci === targetUci) {
    return true;
  }
  
  // Fallback: compare SAN
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: playedMove.from,
      to: playedMove.to,
      promotion: playedMove.promotion
    });
    if (move && move.san === targetSan) {
      return true;
    }
  } catch (e) {
    // Move comparison failed
  }
  
  return false;
}

interface TrainingModeProps {
  positions: TrainingPosition[];
  onComplete: () => void;
  onPositionComplete?: (positionId: string, correct: boolean) => void;
}

export function TrainingMode({ positions, onComplete, onPositionComplete }: TrainingModeProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [chess] = useState(() => new Chess());
  const [boardPosition, setBoardPosition] = useState('start');
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [usedHint, setUsedHint] = useState(false);
  const [hintLevel, setHintLevel] = useState(0);
  const [currentHint, setCurrentHint] = useState<string | null>(null);
  const [loadingHint, setLoadingHint] = useState(false);
  const [showAnswer, setShowAnswer] = useState(false);
  const [result, setResult] = useState<'correct' | 'incorrect' | null>(null);
  const [sessionStats, setSessionStats] = useState({ correct: 0, incorrect: 0 });

  const currentPosition = positions[currentIndex];
  const isComplete = currentIndex >= positions.length;
  const progress = (currentIndex / positions.length) * 100;

  // Initialize board with current position
  useEffect(() => {
    if (currentPosition) {
      try {
        chess.load(currentPosition.fen);
        setBoardPosition(currentPosition.fen);
        setSelectedSquare(null);
        setAttempts(0);
        setUsedHint(false);
        setHintLevel(0);
        setCurrentHint(null);
        setShowAnswer(false);
        setResult(null);
      } catch (e) {
        console.error('Invalid FEN:', currentPosition.fen);
      }
    }
  }, [currentPosition, chess]);

  const handleSquareClick = useCallback((square: Square) => {
    if (result) return;

    const piece = chess.get(square);
    
    if (selectedSquare) {
      // Try to make a move
      try {
        const moveData = {
          from: selectedSquare,
          to: square,
          promotion: 'q' as const // Auto-promote to queen
        };
        
        const move = chess.move(moveData);

        if (move) {
          // Use UCI comparison for reliability
          const isCorrect = currentPosition && movesMatch(
            currentPosition.fen,
            { from: selectedSquare, to: square, promotion: move.promotion },
            currentPosition.move_to_find,
            currentPosition.move_to_find_uci
          );
          
          setAttempts(prev => prev + 1);
          
          if (isCorrect) {
            setBoardPosition(chess.fen());
            setResult('correct');
            setSessionStats(prev => ({ ...prev, correct: prev.correct + 1 }));
            toast.success('Correct!');
            
            // Update in database
            if (currentPosition?.id) {
              updateTrainingPosition(currentPosition.id, true, attempts + 1, usedHint);
              onPositionComplete?.(currentPosition.id, true);
            }
          } else {
            // Wrong move - undo and try again
            chess.undo();
            setBoardPosition(currentPosition?.fen || 'start');
            
            if (attempts >= 2) {
              // After 3 attempts, show the answer
              setResult('incorrect');
              setSessionStats(prev => ({ ...prev, incorrect: prev.incorrect + 1 }));
              setShowAnswer(true);
              toast.error('Incorrect. See the correct move.');
              
              if (currentPosition?.id) {
                updateTrainingPosition(currentPosition.id, false, attempts + 1, usedHint);
                onPositionComplete?.(currentPosition.id, false);
              }
            } else {
              toast.error(`Incorrect. ${2 - attempts} attempts remaining.`);
            }
          }
        }
      } catch (e) {
        // Invalid move
      }
      setSelectedSquare(null);
    } else if (piece && piece.color === chess.turn()) {
      setSelectedSquare(square);
    }
  }, [selectedSquare, chess, currentPosition, attempts, usedHint, result, onPositionComplete]);

  const handleDrop = useCallback(({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string }) => {
    if (result) return;

    try {
      const move = chess.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: 'q'
      });

      if (move) {
        // Use UCI comparison for reliability
        const isCorrect = currentPosition && movesMatch(
          currentPosition.fen,
          { from: sourceSquare, to: targetSquare, promotion: move.promotion },
          currentPosition.move_to_find,
          currentPosition.move_to_find_uci
        );
        
        setAttempts(prev => prev + 1);
        
        if (isCorrect) {
          setBoardPosition(chess.fen());
          setResult('correct');
          setSessionStats(prev => ({ ...prev, correct: prev.correct + 1 }));
          toast.success('Correct!');
          
          if (currentPosition?.id) {
            updateTrainingPosition(currentPosition.id, true, attempts + 1, usedHint);
            onPositionComplete?.(currentPosition.id, true);
          }
        } else {
          chess.undo();
          
          if (attempts >= 2) {
            setResult('incorrect');
            setSessionStats(prev => ({ ...prev, incorrect: prev.incorrect + 1 }));
            setShowAnswer(true);
            toast.error('Incorrect. See the correct move.');
            
            if (currentPosition?.id) {
              updateTrainingPosition(currentPosition.id, false, attempts + 1, usedHint);
              onPositionComplete?.(currentPosition.id, false);
            }
          } else {
            toast.error(`Incorrect. ${2 - attempts} attempts remaining.`);
          }
        }
      }
    } catch (e) {
      // Invalid move
    }
  }, [chess, currentPosition, attempts, usedHint, result, onPositionComplete]);

  const requestHint = async () => {
    if (!currentPosition || loadingHint) return;
    
    setLoadingHint(true);
    setUsedHint(true);
    const nextHintLevel = hintLevel + 1;
    setHintLevel(nextHintLevel);

    try {
      const { data, error } = await supabase.functions.invoke('training-hint', {
        body: {
          fen: currentPosition.fen,
          bestMove: currentPosition.move_to_find,
          weaknessCategory: currentPosition.weakness_category,
          hintLevel: nextHintLevel
        }
      });

      if (error) {
        // Check for rate limit or payment errors
        const errorMessage = error.message || '';
        if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
          toast.error('Rate limit exceeded. Please wait a moment.');
        } else if (errorMessage.includes('402') || errorMessage.includes('payment')) {
          toast.error('AI credits exhausted. Please add credits.');
        }
        throw error;
      }
      
      // Use hint from response, or fallback if there was an error returned
      setCurrentHint(data.hint || data.error);
    } catch (e) {
      console.error('Error getting hint:', e);
      // Provide fallback hint
      if (nextHintLevel === 1) {
        setCurrentHint(`Look for a ${currentPosition.weakness_category.replace(/_/g, ' ')} pattern.`);
      } else if (nextHintLevel === 2) {
        const piece = currentPosition.move_to_find.charAt(0);
        const pieceNames: Record<string, string> = { 'N': 'knight', 'B': 'bishop', 'R': 'rook', 'Q': 'queen', 'K': 'king' };
        setCurrentHint(`Try moving the ${pieceNames[piece] || 'pawn'}.`);
      } else {
        setCurrentHint(`The correct move is ${currentPosition.move_to_find}.`);
      }
    } finally {
      setLoadingHint(false);
    }
  };

  const showCorrectMove = () => {
    if (!currentPosition) return;
    
    try {
      chess.load(currentPosition.fen);
      chess.move(currentPosition.move_to_find);
      setBoardPosition(chess.fen());
      setShowAnswer(true);
    } catch (e) {
      console.error('Error showing correct move:', e);
    }
  };

  const nextPosition = () => {
    if (currentIndex < positions.length - 1) {
      setCurrentIndex(prev => prev + 1);
    } else {
      onComplete();
    }
  };

  const resetPosition = () => {
    if (currentPosition) {
      chess.load(currentPosition.fen);
      setBoardPosition(currentPosition.fen);
      setSelectedSquare(null);
    }
  };

  // Render completion screen
  if (isComplete || positions.length === 0) {
    return (
      <Card className="max-w-lg mx-auto">
        <CardHeader>
          <CardTitle className="text-center">Session Complete!</CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-4">
          <div className="flex justify-center gap-8">
            <div className="text-center">
              <div className="text-3xl font-bold text-green-500">{sessionStats.correct}</div>
              <div className="text-sm text-muted-foreground">Correct</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-red-500">{sessionStats.incorrect}</div>
              <div className="text-sm text-muted-foreground">Incorrect</div>
            </div>
          </div>
          <div className="text-muted-foreground">
            {sessionStats.correct > sessionStats.incorrect 
              ? 'Great job! Keep practicing to improve your mastery.'
              : 'Keep practicing! These positions will appear again for review.'}
          </div>
          <Button onClick={onComplete}>Back to Dashboard</Button>
        </CardContent>
      </Card>
    );
  }

  const turn = chess.turn() === 'w' ? 'White' : 'Black';
  const difficulty = currentPosition?.difficulty || 1;

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span>Position {currentIndex + 1} of {positions.length}</span>
          <span>{Math.round(progress)}% complete</span>
        </div>
        <Progress value={progress} className="h-2" />
      </div>

      {/* Session stats */}
      <div className="flex justify-center gap-4 text-sm">
        <span className="text-green-500">✓ {sessionStats.correct}</span>
        <span className="text-red-500">✗ {sessionStats.incorrect}</span>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Chessboard */}
        <div className="flex justify-center">
          <Chessboard
            position={boardPosition}
            onSquareClick={handleSquareClick}
            onDrop={handleDrop}
            orientation={chess.turn() === 'w' ? 'white' : 'black'}
            width={Math.min(400, window.innerWidth - 48)}
            draggable={!result}
            squareStyles={selectedSquare ? {
              [selectedSquare]: { backgroundColor: 'hsl(var(--primary) / 0.3)' }
            } : {}}
          />
        </div>

        {/* Controls and info */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{turn} to move</CardTitle>
                <div className="flex gap-1">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star 
                      key={i} 
                      className={`h-4 w-4 ${i < difficulty ? 'fill-yellow-500 text-yellow-500' : 'text-muted'}`} 
                    />
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Badge variant="secondary">
                {currentPosition?.weakness_category.replace(/_/g, ' ')}
              </Badge>
              
              {currentPosition?.game_context && (
                <p className="text-sm text-muted-foreground">
                  {currentPosition.game_context}
                </p>
              )}

              {/* Attempts indicator */}
              <div className="flex gap-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div 
                    key={i} 
                    className={`w-3 h-3 rounded-full ${
                      i < attempts 
                        ? 'bg-red-500' 
                        : 'bg-muted'
                    }`} 
                  />
                ))}
                <span className="text-xs text-muted-foreground ml-2">
                  {3 - attempts} attempts left
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Hint display */}
          {currentHint && (
            <Card className="bg-muted/50">
              <CardContent className="pt-4">
                <div className="flex gap-2">
                  <Lightbulb className="h-5 w-5 text-yellow-500 shrink-0" />
                  <p className="text-sm">{currentHint}</p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Result display */}
          {result && (
            <Card className={result === 'correct' ? 'border-green-500 bg-green-500/10' : 'border-red-500 bg-red-500/10'}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2">
                  {result === 'correct' ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-500" />
                  )}
                  <span className="font-medium">
                    {result === 'correct' 
                      ? 'Correct!' 
                      : `The correct move was ${currentPosition?.move_to_find}`}
                  </span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            {!result && (
              <>
                <Button 
                  variant="outline" 
                  onClick={requestHint}
                  disabled={loadingHint || hintLevel >= 3}
                >
                  <Lightbulb className="h-4 w-4 mr-2" />
                  {loadingHint ? 'Loading...' : `Hint ${hintLevel}/3`}
                </Button>
                
                <Button 
                  variant="outline" 
                  onClick={resetPosition}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Reset
                </Button>

                {attempts >= 2 && (
                  <Button 
                    variant="outline" 
                    onClick={showCorrectMove}
                  >
                    <Eye className="h-4 w-4 mr-2" />
                    Show Answer
                  </Button>
                )}
              </>
            )}

            {result && (
              <Button onClick={nextPosition}>
                {currentIndex < positions.length - 1 ? (
                  <>
                    Next Position
                    <ChevronRight className="h-4 w-4 ml-2" />
                  </>
                ) : (
                  'Finish Session'
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
