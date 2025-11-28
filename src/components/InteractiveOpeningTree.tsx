import { useState, useMemo, useEffect } from "react";
import { Chess } from "chess.js";
import Chessboard from "chessboardjsx";
import { Button } from "./ui/button";
import { RotateCcw, FlipVertical } from "lucide-react";

interface MoveArrow {
  from: string;
  to: string;
  color: string;
  opacity: number;
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
}

export const InteractiveOpeningTree = ({ node, maxDepth = 10 }: InteractiveOpeningTreeProps) => {
  const [selectedPath, setSelectedPath] = useState<string[]>([]);
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">("white");

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

  // Find current node in tree and calculate arrows
  const arrows = useMemo(() => {
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

    // Determine whose turn it is
    const isWhiteToMove = selectedPath.length % 2 === 0;
    
    // Calculate total count for normalization
    const totalCount = currentNode.children.reduce((sum: number, child: SerializedOpeningNode) => sum + child.count, 0);
    
    // Create arrows for each possible move
    const chess = new Chess(currentPosition);
    const moveArrows: MoveArrow[] = [];
    
    currentNode.children.forEach((child: SerializedOpeningNode) => {
      try {
        const move = chess.move(child.san);
        if (move) {
          // Calculate opacity based on frequency - MORE DRAMATIC DIFFERENCES
          // Most common move = 1.0 opacity, scale down to 0.3 minimum for rare moves
          const frequency = child.count / totalCount;
          const opacity = Math.max(0.3, frequency);
          
          // Dark green for white moves, red for black moves
          const color = isWhiteToMove ? `rgba(46, 125, 50, ${opacity})` : `rgba(198, 40, 40, ${opacity})`;
          
          moveArrows.push({
            from: move.from,
            to: move.to,
            color,
            opacity
          });
          
          chess.undo();
        }
      } catch (error) {
        console.error("Error processing move for arrow:", error);
      }
    });
    
    return moveArrows;
  }, [node, selectedPath, currentPosition]);

  const handleMoveClick = (movePath: string[]) => {
    setSelectedPath(movePath);
  };

  const handleReset = () => {
    setSelectedPath([]);
  };

  const handleFlipBoard = () => {
    setBoardOrientation(prev => prev === "white" ? "black" : "white");
  };

  const handleMoveBack = () => {
    if (selectedPath.length > 0) {
      setSelectedPath(selectedPath.slice(0, -1));
    }
  };

  const handleMoveForward = () => {
    // Find current node
    let currentNode = node;
    for (const san of selectedPath) {
      const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
      if (!child) return;
      currentNode = child;
    }
    
    // Move to most popular child if available
    if (currentNode.children && currentNode.children.length > 0) {
      const mostPopular = currentNode.children.reduce((prev, curr) => 
        curr.count > prev.count ? curr : prev
      );
      setSelectedPath([...selectedPath, mostPopular.san]);
    }
  };

  const handleJumpToMove = (moveIndex: number) => {
    setSelectedPath(selectedPath.slice(0, moveIndex));
  };

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
  }, [selectedPath, node]);

  // Handle piece moves on the board
  const onDrop = ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string }) => {
    const chess = new Chess(currentPosition);
    
    // Find current node in tree
    let currentNode = node;
    for (const san of selectedPath) {
      const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
      if (!child) return;
      currentNode = child;
    }

    // Try to make the move
    try {
      const move = chess.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
      if (!move) return;

      // Check if this move exists in the opening tree
      const matchingChild = currentNode.children?.find((c: SerializedOpeningNode) => c.san === move.san);
      
      if (matchingChild) {
        // Valid move in the tree - add it to selected path
        setSelectedPath([...selectedPath, move.san]);
      }
    } catch (error) {
      console.error("Invalid move:", error);
    }
  };

  return (
    <div className="flex gap-6 h-[calc(100vh-12rem)] max-w-7xl mx-auto">
      {/* Left: Move List */}
      <div className="w-72 flex-shrink-0 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Moves</h3>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleFlipBoard}
              title="Flip board"
            >
              <FlipVertical className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={selectedPath.length === 0}
              title="Reset to start"
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
          </div>
        </div>
        
        {/* Move sequence display */}
        <div className="border border-border rounded-lg p-3 bg-card h-[calc(100%-3rem)] overflow-y-auto">
          {selectedPath.length > 0 ? (
            <div className="space-y-1">
              {Array.from({ length: Math.ceil(selectedPath.length / 2) }).map((_, pairIndex) => {
                const whiteMove = selectedPath[pairIndex * 2];
                const blackMove = selectedPath[pairIndex * 2 + 1];
                const whiteMoveIndex = pairIndex * 2;
                const blackMoveIndex = pairIndex * 2 + 1;
                
                return (
                  <div key={pairIndex} className="flex items-start gap-2 text-sm font-mono">
                    <span className="text-muted-foreground w-6">{pairIndex + 1}.</span>
                    <div className="flex gap-4 flex-1">
                      <span 
                        className="font-semibold cursor-pointer hover:text-primary transition-colors"
                        onClick={() => handleJumpToMove(whiteMoveIndex + 1)}
                      >
                        {whiteMove}
                      </span>
                      {blackMove && (
                        <span 
                          className="font-semibold cursor-pointer hover:text-primary transition-colors"
                          onClick={() => handleJumpToMove(blackMoveIndex + 1)}
                        >
                          {blackMove}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No moves yet. Use arrow keys or drag pieces on the board.</p>
          )}
        </div>
      </div>

      {/* Right: Chess Board */}
      <div className="flex-1 flex items-center justify-center">
        <div className="relative aspect-square w-full max-w-[600px] border-2 border-border rounded-lg overflow-hidden shadow-xl">
          <Chessboard 
            position={currentPosition}
            orientation={boardOrientation}
            draggable={true}
            onDrop={onDrop}
            boardStyle={{
              borderRadius: '0.5rem',
            }}
          />
          
          {/* Arrow overlay */}
          <svg 
            className="absolute inset-0 pointer-events-none" 
            viewBox="0 0 8 8"
            style={{ width: '100%', height: '100%' }}
          >
            <defs>
              <marker
                id="arrowhead-green"
                markerWidth="4"
                markerHeight="4"
                refX="2"
                refY="2"
                orient="auto"
              >
                <polygon points="0 0, 4 2, 0 4" fill="rgb(46, 125, 50)" />
              </marker>
              <marker
                id="arrowhead-red"
                markerWidth="4"
                markerHeight="4"
                refX="2"
                refY="2"
                orient="auto"
              >
                <polygon points="0 0, 4 2, 0 4" fill="rgb(198, 40, 40)" />
              </marker>
            </defs>
            {arrows.map((arrow, idx) => {
              const fromFile = arrow.from.charCodeAt(0) - 97;
              const fromRank = 8 - parseInt(arrow.from[1]);
              const toFile = arrow.to.charCodeAt(0) - 97;
              const toRank = 8 - parseInt(arrow.to[1]);
              
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
              
              const isGreen = arrow.color.includes('46, 125, 50');
              
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
                  markerEnd={`url(#arrowhead-${isGreen ? 'green' : 'red'})`}
                />
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
};

export default InteractiveOpeningTree;
