import { useState, useMemo, useEffect } from "react";
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
          
          // Green for scouted player, red for opponent
          const baseColor = isScoutedPlayerTurn ? '34, 139, 34' : '220, 38, 38'; // green : red
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
    <div className="flex flex-col items-center gap-4 h-[calc(100vh-12rem)] max-w-7xl mx-auto">
      {/* Control buttons */}
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

      {/* COMMENTED OUT FOR LATER - Left: Opening Tree Viewer */}
      {/* <div className="w-80 flex-shrink-0 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Opening Tree</h3>
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
        
        <div className="border border-border rounded-lg p-3 bg-card h-[calc(100%-3rem)] overflow-y-auto">
          <OpeningTreeViewer 
            node={node} 
            maxDepth={maxDepth} 
            onMoveClick={handleMoveClick}
            selectedPath={selectedPath}
          />
        </div>
      </div> */}

      {/* Chess Board */}
      <div className="flex items-center justify-center flex-1">
        <div className="relative aspect-square w-full max-w-[700px] border-2 border-border rounded-lg overflow-hidden shadow-xl">
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
                    fill={arrow.isScoutedPlayer ? "rgb(34, 139, 34)" : "rgb(220, 38, 38)"} 
                    fillOpacity={arrow.opacity}
                  />
                </marker>
              ))}
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
      </div>
    </div>
  );
};

export default InteractiveOpeningTree;
