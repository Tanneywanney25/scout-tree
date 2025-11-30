import { useState, useMemo, useEffect, useCallback } from "react";
import { Chess } from "chess.js";
import Chessboard from "chessboardjsx";
import { Button } from "./ui/button";
import { RotateCcw, FlipVertical } from "lucide-react";
// import { OpeningTreeViewer } from "./OpeningTreeViewer";

interface MoveArrow {
  from: string;
  to: string;
  color: string;
  opacity: number;
  isScoutedPlayer: boolean;
}

interface SerializedOpeningNode {
  move: string;
  san: string;
  count: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  children?: any[];
  key?: string;
}

interface InteractiveOpeningTreeProps {
  node: SerializedOpeningNode;
  maxDepth?: number;
  playerColor: "white" | "black";
}

export const InteractiveOpeningTree = ({ node, maxDepth = 10, playerColor }: InteractiveOpeningTreeProps) => {
  const [selectedPath, setSelectedPath] = useState<string[]>([]);
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">("white");
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [possibleMoves, setPossibleMoves] = useState<string[]>([]);
  const [isOffTree, setIsOffTree] = useState(false);
  const [showArrows, setShowArrows] = useState(true);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);

  // Calculate the current position based on selected moves
  const currentPosition = useMemo(() => {
    const chess = new Chess();
    
    try {
      for (const san of selectedPath) {
        chess.move(san);
      }
    } catch (error) {
      console.error("Error applying moves:", error);
      return chess.fen();
    }
    
    return chess.fen();
  }, [selectedPath]);

  // Helper function to find king square
  const findKingSquare = (chess: Chess, color: 'w' | 'b'): string | null => {
    const board = chess.board();
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const piece = board[row][col];
        if (piece && piece.type === 'k' && piece.color === color) {
          return String.fromCharCode(97 + col) + (8 - row);
        }
      }
    }
    return null;
  };

  // Memoize square styles to prevent lag
  const squareStyles = useMemo(() => {
    const styles: { [square: string]: any } = {};
    const chess = new Chess(currentPosition);
    
    // Add last move highlighting (yellow)
    if (lastMove) {
      styles[lastMove.from] = { backgroundColor: 'rgba(155, 199, 0, 0.41)' };
      styles[lastMove.to] = { backgroundColor: 'rgba(155, 199, 0, 0.41)' };
    }
    
    // Add check highlighting (red radial gradient)
    if (chess.isCheck()) {
      const kingSquare = findKingSquare(chess, chess.turn());
      if (kingSquare) {
        styles[kingSquare] = {
          background: `radial-gradient(
            ellipse at center,
            rgba(255, 0, 0, 0.4) 0%,
            rgba(231, 0, 0, 0.3) 25%,
            rgba(169, 0, 0, 0) 89%,
            rgba(158, 0, 0, 0) 100%
          )`
        };
      }
    }
    
    // Add selected square highlighting (green)
    if (selectedSquare) {
      styles[selectedSquare] = {
        backgroundColor: 'rgba(20, 85, 30, 0.5)'
      };
    }
    
    // Add legal move indicators
    possibleMoves.forEach(square => {
      const piece = chess.get(square as any);
      const isCapture = piece && piece.color !== chess.turn();
      
      styles[square] = isCapture 
        ? {
            // Ring around edge for captures (Lichess style)
            background: `radial-gradient(
              transparent 0%,
              transparent 65%,
              rgba(20, 85, 30, 0.5) 65%,
              rgba(20, 85, 30, 0.5) 100%
            )`
          }
        : {
            // Dot in center for normal moves (Lichess style)
            background: `radial-gradient(
              rgba(20, 85, 30, 0.5) 22%,
              #208530 22%,
              rgba(0, 0, 0, 0.3) 22%,
              transparent 22%
            )`
          };
    });
    
    return styles;
  }, [possibleMoves, currentPosition, lastMove, selectedSquare]);

  // Find current node in tree and calculate arrows
  const arrows = useMemo(() => {
    // Don't show arrows if we're off the tree or if they're temporarily hidden
    if (isOffTree || !showArrows) {
      return [];
    }
    
    let currentNode = node;
    
    // Navigate to current position in tree
    for (const san of selectedPath) {
      const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
      if (!child) break;
      currentNode = child;
    }

    if (!currentNode.children || currentNode.children.length === 0) {
      return [];
    }

    // Sort children by frequency to find variations
    const sortedChildren = [...currentNode.children].sort((a, b) => b.count - a.count);
    
    if (sortedChildren.length === 0) {
      return [];
    }
    
    // Find the most common move's count for opacity scaling
    const maxCount = sortedChildren[0].count;
    
    // Determine whose turn it is at the current position
    // White moves first (even number of moves = white's turn)
    const isWhiteTurn = selectedPath.length % 2 === 0;
    const isScoutedPlayerTurn = (playerColor === "white" && isWhiteTurn) || (playerColor === "black" && !isWhiteTurn);
    
    // Create arrows for ALL moves with varying opacity
    const chess = new Chess(currentPosition);
    const moveArrows: MoveArrow[] = [];
    
    sortedChildren.forEach((child: SerializedOpeningNode) => {
      try {
        const move = chess.move(child.san);
        if (move) {
          // Calculate opacity: most common = 1.0, scale down to 0.2 minimum for rare moves
          const frequency = child.count / maxCount;
          // For opponent moves, make them all more transparent (max 0.4)
          const baseOpacity = isScoutedPlayerTurn ? frequency : Math.min(frequency * 0.5, 0.4);
          const opacity = Math.max(0.15, baseOpacity);
          
          // Darker green for scouted player, red for opponent
          const baseColor = isScoutedPlayerTurn ? '0, 100, 0' : '220, 38, 38'; // darker green : red
          const color = `rgba(${baseColor}, ${opacity})`;
          
          moveArrows.push({
            from: move.from,
            to: move.to,
            color,
            opacity,
            isScoutedPlayer: isScoutedPlayerTurn
          });
          
          chess.undo();
        }
      } catch (error) {
        console.error("Error processing move for arrow:", error);
      }
    });
    
    return moveArrows;
  }, [node, selectedPath, currentPosition, playerColor, isOffTree]);

  const handleMoveClick = useCallback((movePath: string[]) => {
    setSelectedPath(movePath);
  }, []);

  const handleReset = useCallback(() => {
    setSelectedPath([]);
    setIsOffTree(false);
  }, []);

  const handleFlipBoard = useCallback(() => {
    setBoardOrientation(prev => prev === "white" ? "black" : "white");
  }, []);

  const handleMoveBack = useCallback(() => {
    // Hide arrows first for smoother transition
    setShowArrows(false);
    
    setSelectedPath(prev => {
      if (prev.length === 0) return prev;
      const newPath = prev.slice(0, -1);
      
      // Check if we're back on the tree - if so, clear off-tree state
      let currentNode = node;
      let isOnTree = true;
      for (const san of newPath) {
        const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
        if (!child) {
          isOnTree = false;
          break;
        }
        currentNode = child;
      }
      
      // If we're back on tree, clear the off-tree flag
      if (isOnTree) {
        setIsOffTree(false);
      }
      
      return newPath;
    });
    
    // Show arrows after the board updates
    requestAnimationFrame(() => {
      setShowArrows(true);
    });
  }, [node, currentPosition, isOffTree, selectedPath]);

  const handleMoveForward = useCallback(() => {
    setSelectedPath(prev => {
      // Find current node
      let currentNode = node;
      for (const san of prev) {
        const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
        if (!child) return prev;
        currentNode = child;
      }
      
      // Move to most popular child if available
      if (currentNode.children && currentNode.children.length > 0) {
        const mostPopular = currentNode.children.reduce((prevChild, curr) => 
          curr.count > prevChild.count ? curr : prevChild
        );
        return [...prev, mostPopular.san];
      }
      return prev;
    });
  }, [node]);

  const handleJumpToMove = useCallback((moveIndex: number) => {
    setSelectedPath(prev => prev.slice(0, moveIndex));
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        handleMoveBack();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleMoveForward();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleMoveBack, handleMoveForward]);

  // Handle square clicks for click-to-move
  const onSquareClick = useCallback((square: string) => {
    const chess = new Chess(currentPosition);
    
    // Find current node in tree (only if not off tree)
    let currentNode = node;
    if (!isOffTree) {
      for (const san of selectedPath) {
        const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
        if (!child) break;
        currentNode = child;
      }
    }

    // If a square is already selected, try to move
    if (selectedSquare) {
      try {
        const move = chess.move({ from: selectedSquare, to: square, promotion: 'q' });
        if (move) {
          // Use requestAnimationFrame to batch state updates and reduce lag
          requestAnimationFrame(() => {
            // Allow ANY legal move
            setSelectedPath(prev => [...prev, move.san]);
            setLastMove({ from: selectedSquare, to: square });
            
            // Check if this move exists in the opening tree
            if (!isOffTree) {
              const matchingChild = currentNode.children?.find((c: SerializedOpeningNode) => c.san === move.san);
              if (!matchingChild) {
                // Move not in tree - mark as off tree
                setIsOffTree(true);
              }
            }
            
            // Clear selection
            setSelectedSquare(null);
            setPossibleMoves([]);
          });
          return;
        }
      } catch (error) {
        // Invalid move, try selecting the clicked square instead
      }
      
      // Clear selection
      setSelectedSquare(null);
      setPossibleMoves([]);
    } else {
      // Select the square and show possible moves
      const piece = chess.get(square as any);
      if (piece) {
        setSelectedSquare(square);
        
        // Get all legal moves from this square
        const moves = chess.moves({ square: square as any, verbose: true }) as any[];
        const destinations = moves.map((m: any) => m.to);
        setPossibleMoves(destinations);
      }
    }
  }, [node, selectedPath, currentPosition, selectedSquare, isOffTree]);

  // Handle piece drops (for drag-and-drop)
  const onDrop = useCallback(({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string }) => {
    const chess = new Chess(currentPosition);
    
    // Find current node in tree (only if not off tree)
    let currentNode = node;
    if (!isOffTree) {
      for (const san of selectedPath) {
        const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
        if (!child) return;
        currentNode = child;
      }
    }

    // Try to make the move
    try {
      const move = chess.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      if (!move) return;

      // Use requestAnimationFrame to batch state updates and reduce lag
      requestAnimationFrame(() => {
        // Allow ANY legal move
        setSelectedPath(prev => [...prev, move.san]);
        setLastMove({ from: sourceSquare, to: targetSquare });
        
        // Check if this move exists in the opening tree
        if (!isOffTree) {
          const matchingChild = currentNode.children?.find((c: SerializedOpeningNode) => c.san === move.san);
          if (!matchingChild) {
            // Move not in tree - mark as off tree
            setIsOffTree(true);
          }
        }
        
        // Clear any selection
        setSelectedSquare(null);
        setPossibleMoves([]);
      });
    } catch (error) {
      console.error("Invalid move:", error);
    }
  }, [node, selectedPath, currentPosition, isOffTree]);

  // Get current opening name
  const currentOpening = useMemo(() => {
    if (selectedPath.length === 0) return "Starting Position";
    
    let currentNode = node;
    for (const san of selectedPath) {
      const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
      if (!child) break;
      currentNode = child;
    }
    
    return currentNode.key || "Position";
  }, [node, selectedPath]);

  return (
    <div className="flex gap-8 items-start justify-center h-[calc(100vh-12rem)] max-w-7xl mx-auto px-4">
      {/* Main board area */}
      <div className="flex flex-col items-center gap-4">
        {/* Controls above board */}
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleFlipBoard}
            title="Flip board"
          >
            <FlipVertical className="w-4 h-4 mr-2" />
            Flip Board
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={selectedPath.length === 0}
            title="Reset to start"
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Reset
          </Button>
        </div>

        {/* Chess Board */}
        <div className="relative aspect-square w-full max-w-[600px] border-2 border-border rounded-lg overflow-hidden shadow-xl">
          <style>{`
            /* Fix dragged piece size */
            .piece-417db {
              width: 100% !important;
              height: 100% !important;
            }
            img[data-piece] {
              max-width: 100% !important;
              max-height: 100% !important;
            }
            /* Fix black queen appearing white */
            [data-piece="bQ"] img {
              filter: none !important;
            }
          `}</style>
          <Chessboard 
            position={currentPosition}
            orientation={boardOrientation}
            draggable={true}
            onDrop={onDrop}
            onSquareClick={onSquareClick}
            squareStyles={squareStyles}
            boardStyle={{
              borderRadius: '0.5rem',
            }}
            lightSquareStyle={{ backgroundColor: '#f0d9b5' }}
            darkSquareStyle={{ backgroundColor: '#b58863' }}
          />
          
          {/* Arrow overlay */}
          <svg 
            className="absolute inset-0 pointer-events-none" 
            viewBox="0 0 8 8"
            style={{ width: '100%', height: '100%' }}
          >
            <defs>
              {arrows.map((arrow, idx) => (
                <marker
                  key={`marker-${idx}`}
                  id={`arrowhead-${idx}`}
                  markerWidth="4"
                  markerHeight="4"
                  refX="2.5"
                  refY="2"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <polygon 
                    points="0 0, 4 2, 0 4" 
                    fill={arrow.isScoutedPlayer ? "rgb(0, 100, 0)" : "rgb(220, 38, 38)"} 
                    fillOpacity={arrow.opacity}
                  />
                </marker>
              ))}
            </defs>
            {arrows.map((arrow, idx) => {
              let fromFile = arrow.from.charCodeAt(0) - 97;
              let fromRank = 8 - parseInt(arrow.from[1]);
              let toFile = arrow.to.charCodeAt(0) - 97;
              let toRank = 8 - parseInt(arrow.to[1]);
              
              // Flip coordinates if board is oriented for black
              if (boardOrientation === "black") {
                fromFile = 7 - fromFile;
                fromRank = 7 - fromRank;
                toFile = 7 - toFile;
                toRank = 7 - toRank;
              }
              
              const x1 = fromFile + 0.5;
              const y1 = fromRank + 0.5;
              const x2 = toFile + 0.5;
              const y2 = toRank + 0.5;
              
              // Shorten arrow to prevent overlap with piece
              const dx = x2 - x1;
              const dy = y2 - y1;
              const length = Math.sqrt(dx * dx + dy * dy);
              const shortenBy = 0.25;
              const x2Shortened = x2 - (dx / length) * shortenBy;
              const y2Shortened = y2 - (dy / length) * shortenBy;
              
              return (
                <line
                  key={idx}
                  x1={x1}
                  y1={y1}
                  x2={x2Shortened}
                  y2={y2Shortened}
                  stroke={arrow.color}
                  strokeWidth="0.18"
                  strokeLinecap="round"
                  markerEnd={`url(#arrowhead-${idx})`}
                />
              );
            })}
          </svg>
        </div>
        
        {/* Opening name below board */}
        <div className="text-sm text-muted-foreground text-center max-w-[600px]">
          {currentOpening}
        </div>
      </div>

      {/* Move list on the side */}
      <div className="w-48 bg-card border border-border rounded-lg p-4 max-h-[600px] overflow-y-auto">
        <h3 className="text-sm font-semibold mb-3 border-b border-border pb-2">Moves</h3>
        <div className="space-y-1 text-sm">
          {selectedPath.length === 0 ? (
            <div className="text-muted-foreground">No moves yet</div>
          ) : (
            (() => {
              const moveRows: JSX.Element[] = [];
              for (let i = 0; i < selectedPath.length; i += 2) {
                const whiteMove = selectedPath[i];
                const blackMove = selectedPath[i + 1];
                const moveNumber = Math.floor(i / 2) + 1;
                const isCurrentWhite = i === selectedPath.length - 1;
                const isCurrentBlack = i + 1 === selectedPath.length - 1;
                
                moveRows.push(
                  <div key={i} className="grid grid-cols-[40px_1fr_1fr] gap-1 items-center">
                    <span className="text-muted-foreground text-right font-mono text-xs">
                      {moveNumber}.
                    </span>
                    <button
                      onClick={() => handleJumpToMove(i + 1)}
                      className={`text-left px-2 py-1 rounded transition-all font-mono text-xs ${
                        isCurrentWhite 
                          ? 'bg-primary text-primary-foreground font-semibold' 
                          : 'hover:bg-accent'
                      }`}
                    >
                      {whiteMove}
                    </button>
                    {blackMove ? (
                      <button
                        onClick={() => handleJumpToMove(i + 2)}
                        className={`text-left px-2 py-1 rounded transition-all font-mono text-xs ${
                          isCurrentBlack 
                            ? 'bg-primary text-primary-foreground font-semibold' 
                            : 'hover:bg-accent'
                        }`}
                      >
                        {blackMove}
                      </button>
                    ) : (
                      <div />
                    )}
                  </div>
                );
              }
              return moveRows;
            })()
          )}
        </div>
      </div>
    </div>
  );
};

export default InteractiveOpeningTree;
