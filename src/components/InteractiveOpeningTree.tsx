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
  fen?: string;
}

interface InteractiveOpeningTreeProps {
  node: SerializedOpeningNode;
  maxDepth?: number;
  playerColor: "white" | "black";
  initialSelectedPath?: string[];
  onPathChange?: (path: string[]) => void;
}

export const InteractiveOpeningTree = ({ 
  node, 
  maxDepth = 10, 
  playerColor,
  initialSelectedPath = [],
  onPathChange
}: InteractiveOpeningTreeProps) => {
  const [selectedPath, setSelectedPathInternal] = useState<string[]>(initialSelectedPath);
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">("white");
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [possibleMoves, setPossibleMoves] = useState<string[]>([]);
  const [isOffTree, setIsOffTree] = useState(false);
  const [showArrows, setShowArrows] = useState(true);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [userArrows, setUserArrows] = useState<Array<{ from: string; to: string }>>([]);
  const [userCircles, setUserCircles] = useState<string[]>([]);
  const [rightClickStart, setRightClickStart] = useState<string | null>(null);

  // Wrapper to notify parent of path changes
  const setSelectedPath = useCallback((pathOrUpdater: string[] | ((prev: string[]) => string[])) => {
    setSelectedPathInternal(prev => {
      const newPath = typeof pathOrUpdater === 'function' ? pathOrUpdater(prev) : pathOrUpdater;
      if (onPathChange) {
        onPathChange(newPath);
      }
      return newPath;
    });
  }, [onPathChange]);

  // Build FEN-to-nodes lookup map for transposition detection (built AFTER tree is complete)
  const fenToNodes = useMemo(() => {
    const map = new Map<string, SerializedOpeningNode[]>();
    function traverse(n: SerializedOpeningNode) {
      if (n.fen) {
        if (!map.has(n.fen)) map.set(n.fen, []);
        map.get(n.fen)!.push(n);
      }
      n.children?.forEach(c => traverse(c));
    }
    traverse(node);
    return map;
  }, [node]);

  // Calculate aggregated stats for current position (transposition handling)
  const aggregatedStats = useMemo(() => {
    // Navigate to current node
    let currentNode = node;
    for (const san of selectedPath) {
      const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
      if (!child) return null;
      currentNode = child;
    }
    
    if (!currentNode.fen) return null;
    
    const allNodes = fenToNodes.get(currentNode.fen) || [];
    if (allNodes.length <= 1) return null; // No transposition
    
    // Aggregate stats across all paths to this position
    const totals = allNodes.reduce((acc, n) => ({
      count: acc.count + n.count,
      wins: acc.wins + n.wins,
      draws: acc.draws + n.draws,
      losses: acc.losses + n.losses,
    }), { count: 0, wins: 0, draws: 0, losses: 0 });
    
    return {
      pathCount: allNodes.length,
      totalGames: totals.count,
      winRate: totals.count > 0 
        ? (totals.wins + totals.draws * 0.5) / totals.count 
        : 0,
    };
  }, [fenToNodes, node, selectedPath]);

  // Get merged children for current position (handles transpositions - shows UNION of all children)
  const mergedChildren = useMemo(() => {
    // Navigate to current node
    let currentNode = node;
    for (const san of selectedPath) {
      const child = currentNode.children?.find((c: SerializedOpeningNode) => c.san === san);
      if (!child) return [];
      currentNode = child;
    }
    
    if (!currentNode.children) {
      return [];
    }
    
    // If no FEN or no transpositions, return normal children
    if (!currentNode.fen) {
      return currentNode.children;
    }
    
    const allNodes = fenToNodes.get(currentNode.fen);
    if (!allNodes || allNodes.length <= 1) {
      return currentNode.children; // No transposition, use normal children
    }
    
    // Collect ALL children from ALL transposed nodes
    const mergedMap = new Map<string, SerializedOpeningNode>();
    
    for (const n of allNodes) {
      for (const child of n.children || []) {
        if (!mergedMap.has(child.san)) {
          // First time seeing this move - clone it
          mergedMap.set(child.san, {
            ...child,
            count: 0,
            wins: 0,
            draws: 0,
            losses: 0,
          });
        }
        
        // Aggregate stats
        const merged = mergedMap.get(child.san)!;
        merged.count += child.count;
        merged.wins += child.wins;
        merged.draws += child.draws;
        merged.losses += child.losses;
      }
    }
    
    // Recalculate win rates and return as array
    const result: SerializedOpeningNode[] = [];
    for (const child of mergedMap.values()) {
      child.winRate = child.count > 0 
        ? (child.wins + child.draws * 0.5) / child.count 
        : 0;
      result.push(child);
    }
    
    return result;
  }, [node, selectedPath, fenToNodes]);

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
    
    // Add selected square highlighting (green #646F40)
    if (selectedSquare) {
      styles[selectedSquare] = {
        backgroundColor: '#646F40'
      };
    }
    
    // Add legal move indicators
    possibleMoves.forEach(square => {
      const piece = chess.get(square as any);
      const isCapture = piece && piece.color !== chess.turn();
      
      styles[square] = isCapture 
        ? {
            // Ring around edge for captures (Lichess style) - THINNER (80% instead of 65%)
            background: `radial-gradient(
              transparent 0%,
              transparent 80%,
              rgba(20, 85, 30, 0.5) 80%,
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

  // Find current node in tree and calculate arrows using merged children (handles transpositions)
  const arrows = useMemo(() => {
    // Don't show arrows if we're off the tree or if they're temporarily hidden
    if (isOffTree || !showArrows) {
      return [];
    }
    
    // Use merged children which contains union of all children from transposed positions
    if (!mergedChildren || mergedChildren.length === 0) {
      return [];
    }

    // Sort merged children by frequency to find variations
    const sortedChildren = [...mergedChildren].sort((a, b) => b.count - a.count);
    
    // Find the most common move's count for opacity scaling
    const maxCount = sortedChildren[0].count;
    
    // Determine whose turn it is at the current position
    // White moves first (even number of moves = white's turn)
    const isWhiteTurn = selectedPath.length % 2 === 0;
    const isScoutedPlayerTurn = (playerColor === "white" && isWhiteTurn) || (playerColor === "black" && !isWhiteTurn);
    
    // Create arrows for ALL moves with varying opacity
    const chess = new Chess(currentPosition);
    const moveArrows: MoveArrow[] = [];
    
    sortedChildren.forEach((child: SerializedOpeningNode, index: number) => {
      try {
        const move = chess.move(child.san);
        if (move) {
          // Calculate opacity based on frequency relative to top move
          const frequency = child.count / maxCount;
          let opacity: number;
          let color: string;
          
          if (isScoutedPlayerTurn) {
            // Scouted player: green #646F41
            // Top move = 1.0 opacity, others scale from 0.4 to 0.8
            opacity = index === 0 ? 1.0 : 0.4 + frequency * 0.4;
            color = `rgba(100, 111, 65, ${opacity})`;
          } else {
            // Opponent: Scarlet #900009
            // Top move = 1.0 opacity, others scale from 0.4 to 0.8
            opacity = index === 0 ? 1.0 : 0.4 + frequency * 0.4;
            color = `rgba(144, 0, 9, ${opacity})`;
          }
          
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
  }, [mergedChildren, selectedPath, currentPosition, playerColor, isOffTree, showArrows]);

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
    // Hide arrows immediately before position changes
    setShowArrows(false);
    
    setSelectedPath(prev => {
      if (prev.length === 0) return prev;
      const newPath = prev.slice(0, -1);
      
      // Update last move to show the move we're going back to
      if (newPath.length > 0) {
        // Find the from/to of the last move in new path
        const chess = new Chess();
        try {
          for (const san of newPath) {
            chess.move(san);
          }
          const history = chess.history({ verbose: true });
          if (history.length > 0) {
            const lastMoveInHistory = history[history.length - 1];
            setLastMove({ from: lastMoveInHistory.from, to: lastMoveInHistory.to });
          } else {
            setLastMove(null);
          }
        } catch (error) {
          setLastMove(null);
        }
      } else {
        setLastMove(null);
      }
      
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
    
    // Show arrows after a small delay to allow position to update first
    setTimeout(() => {
      setShowArrows(true);
    }, 50);
  }, [node]);

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
    // Handle right-click release if in progress
    if (rightClickStart) {
      handleSquareRightRelease(square);
      return;
    }
    
    // Clear user arrows and circles on left click
    setUserArrows([]);
    setUserCircles([]);
    
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
        // Invalid move, check if clicking a different piece of same color
      }
      
      // Check if clicking a different piece of the same color - show its moves immediately
      const clickedPiece = chess.get(square as any);
      if (clickedPiece && clickedPiece.color === chess.turn()) {
        // Clicking another piece of the same color - show its moves immediately
        setSelectedSquare(square);
        const moves = chess.moves({ square: square as any, verbose: true }) as any[];
        const destinations = moves.map((m: any) => m.to);
        setPossibleMoves(destinations);
        return;
      }
      
      // Clear selection (clicking empty square or opponent piece without valid move)
      setSelectedSquare(null);
      setPossibleMoves([]);
    } else {
      // Select the square and show possible moves
      const piece = chess.get(square as any);
      if (piece && piece.color === chess.turn()) {
        setSelectedSquare(square);
        
        // Get all legal moves from this square
        const moves = chess.moves({ square: square as any, verbose: true }) as any[];
        const destinations = moves.map((m: any) => m.to);
        setPossibleMoves(destinations);
      }
    }
  }, [node, selectedPath, currentPosition, selectedSquare, isOffTree]);

  // Handle right-click on squares for arrows and circles
  const handleSquareRightClick = useCallback((square: string) => {
    setRightClickStart(square);
  }, []);

  const handleSquareRightRelease = useCallback((square: string) => {
    if (!rightClickStart) return;
    
    if (rightClickStart === square) {
      // Same square = toggle circle
      setUserCircles(prev => prev.includes(square) 
        ? prev.filter(s => s !== square) 
        : [...prev, square]);
    } else {
      // Different square = toggle arrow
      setUserArrows(prev => {
        const exists = prev.some(a => a.from === rightClickStart && a.to === square);
        return exists 
          ? prev.filter(a => !(a.from === rightClickStart && a.to === square))
          : [...prev, { from: rightClickStart, to: square }];
      });
    }
    setRightClickStart(null);
  }, [rightClickStart]);

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

  // Format move path for display (e.g., "1.d4 Nf6 2.c4 e6")
  const formatMovePath = (path: string[]): string => {
    let result = '';
    for (let i = 0; i < path.length; i++) {
      if (i % 2 === 0) {
        result += `${Math.floor(i / 2) + 1}.`;
      }
      result += path[i];
      if (i < path.length - 1) {
        result += i % 2 === 0 ? '' : ' ';
      }
    }
    return result;
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 lg:gap-8 items-center lg:items-start justify-center min-h-[calc(100vh-12rem)] max-w-7xl mx-auto px-2 sm:px-4 pb-4">
      {/* Main board area */}
      <div className="flex flex-col items-center gap-3 sm:gap-4 w-full lg:w-auto">
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
        <div className="relative aspect-square w-full max-w-[340px] sm:max-w-[480px] md:max-w-[560px] lg:max-w-[640px] border-2 border-border rounded-lg overflow-hidden shadow-xl">
          <style>{`
            /* Fix dragged piece size and prevent ALL hover/drag scaling */
            .piece-417db,
            .piece-417db:hover,
            .piece-417db:active,
            .piece-417db:focus {
              width: 100% !important;
              height: 100% !important;
              max-width: 100% !important;
              max-height: 100% !important;
              transform: none !important;
              transition: none !important;
              scale: 1 !important;
              cursor: grab;
            }
            .piece-417db:active {
              cursor: grabbing;
            }
            img[data-piece],
            img[data-piece]:hover,
            img[data-piece]:active {
              max-width: 100% !important;
              max-height: 100% !important;
              width: 100% !important;
              height: 100% !important;
              transform: none !important;
              transition: none !important;
              scale: 1 !important;
            }
            /* Fix black queen appearing white */
            [data-piece="bQ"] img {
              filter: none !important;
            }
            
            /* ============================================= */
            /* Remove hover highlighting on squares */
            /* ============================================= */
            .square-55d63:hover,
            div[data-squareid]:hover {
              box-shadow: none !important;
            }
            
            /* ============================================= */
            /* Remove ALL drag/drop highlighting - no color change */
            /* ============================================= */
            .square-55d63.dragging,
            .square-55d63.drag-over,
            div[data-squareid].dragging,
            div[data-squareid].drag-over,
            [class*="drop"],
            [class*="drag"] {
              box-shadow: none !important;
              border: none !important;
              outline: none !important;
            }
            
            /* Remove chessboardjsx specific highlight classes */
            .hover-highlight,
            .highlight-square {
              display: none !important;
            }
            
            /* Disable transitions on squares */
            div[data-squareid],
            .square-55d63 {
              transition: none !important;
            }
          `}</style>
          <div 
            onContextMenu={(e) => e.preventDefault()}
            onMouseUp={(e) => {
              if (e.button === 2 && rightClickStart) {
                // Get square from mouse position
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const squareSize = rect.width / 8;
                let file = Math.floor(x / squareSize);
                let rank = Math.floor(y / squareSize);
                
                if (boardOrientation === "black") {
                  file = 7 - file;
                  rank = 7 - rank;
                }
                
                const fileChar = String.fromCharCode(97 + file);
                const rankChar = String(8 - rank);
                const square = fileChar + rankChar;
                
                handleSquareRightRelease(square);
              }
            }}
          >
          <Chessboard 
              position={currentPosition}
              orientation={boardOrientation}
              draggable={true}
              dropSquareStyle={{}} // Empty object = no override, keeps original square color
              onDrop={onDrop}
              onSquareClick={onSquareClick}
              onSquareRightClick={handleSquareRightClick}
              squareStyles={squareStyles}
              calcWidth={({ screenWidth }) => {
                // Calculate board width - larger sizes for better visibility
                if (screenWidth < 640) return Math.min(340, screenWidth - 24);
                if (screenWidth < 768) return Math.min(480, screenWidth - 24);
                if (screenWidth < 1024) return Math.min(560, screenWidth - 24);
                return Math.min(640, screenWidth - 280);
              }}
              boardStyle={{
                borderRadius: '0.5rem',
              }}
              lightSquareStyle={{ backgroundColor: '#f0d9b5' }}
              darkSquareStyle={{ backgroundColor: '#b58863' }}
            />
          </div>
          
          {/* Arrow overlay */}
          <svg 
            className="absolute inset-0 pointer-events-none" 
            viewBox="0 0 800 800"
            preserveAspectRatio="xMidYMid meet"
            style={{ width: '100%', height: '100%' }}
          >
            <defs>
              {arrows.map((arrow, idx) => (
                <marker
                  key={`marker-${idx}`}
                  id={`arrowhead-${idx}`}
                  markerWidth="60"
                  markerHeight="60"
                  refX="60"
                  refY="30"
                  orient="auto"
                  markerUnits="userSpaceOnUse"
                >
                  <polygon 
                    points="0 0, 60 30, 0 60" 
                    fill={arrow.isScoutedPlayer ? "#646F41" : "#900009"}
                    fillOpacity={arrow.opacity}
                  />
                </marker>
              ))}
            </defs>
            {arrows.map((arrow, idx) => {
              // Calculate file (a-h → 0-7) and rank (1-8 → visual row from top)
              let fromFile = arrow.from.charCodeAt(0) - 97; // a=0, h=7
              let fromRank = 8 - parseInt(arrow.from[1]);   // 8=0 (top), 1=7 (bottom)
              let toFile = arrow.to.charCodeAt(0) - 97;
              let toRank = 8 - parseInt(arrow.to[1]);
              
              // Flip coordinates if board is oriented for black
              if (boardOrientation === "black") {
                fromFile = 7 - fromFile;
                fromRank = 7 - fromRank;
                toFile = 7 - toFile;
                toRank = 7 - toRank;
              }
              
              // Calculate pixel centers in 800x800 viewBox (each square = 100px)
              const squareSize = 100;
              const x1 = fromFile * squareSize + squareSize / 2;
              const y1 = fromRank * squareSize + squareSize / 2;
              const x2 = toFile * squareSize + squareSize / 2;
              const y2 = toRank * squareSize + squareSize / 2;
              
              // Shorten arrow end to prevent overlap with arrowhead/piece
              const dx = x2 - x1;
              const dy = y2 - y1;
              const length = Math.sqrt(dx * dx + dy * dy);
              const shortenBy = 0; // No shortening - refX=60 places tip exactly at target center
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
                  strokeWidth="20"
                  strokeLinecap="round"
                  markerEnd={`url(#arrowhead-${idx})`}
                />
              );
            })}
            
            {/* User-drawn arrows (brand green #646F41) */}
            {userArrows.map((arrow, idx) => {
              let fromFile = arrow.from.charCodeAt(0) - 97;
              let fromRank = 8 - parseInt(arrow.from[1]);
              let toFile = arrow.to.charCodeAt(0) - 97;
              let toRank = 8 - parseInt(arrow.to[1]);
              
              if (boardOrientation === "black") {
                fromFile = 7 - fromFile;
                fromRank = 7 - fromRank;
                toFile = 7 - toFile;
                toRank = 7 - toRank;
              }
              
              // Use 800x800 viewBox coordinate system
              const squareSize = 100;
              const x1 = fromFile * squareSize + squareSize / 2;
              const y1 = fromRank * squareSize + squareSize / 2;
              const x2 = toFile * squareSize + squareSize / 2;
              const y2 = toRank * squareSize + squareSize / 2;
              
              const dx = x2 - x1;
              const dy = y2 - y1;
              const length = Math.sqrt(dx * dx + dy * dy);
              const shortenBy = 0;
              const x2Shortened = x2 - (dx / length) * shortenBy;
              const y2Shortened = y2 - (dy / length) * shortenBy;
              
              return (
                <g key={`user-arrow-${idx}`}>
                  <defs>
                    <marker
                      id={`user-arrowhead-${idx}`}
                      markerWidth="60"
                      markerHeight="60"
                      refX="60"
                      refY="30"
                      orient="auto"
                      markerUnits="userSpaceOnUse"
                    >
                      <polygon points="0 0, 60 30, 0 60" fill="#646F41" fillOpacity="0.8" />
                    </marker>
                  </defs>
                  <line
                    x1={x1}
                    y1={y1}
                    x2={x2Shortened}
                    y2={y2Shortened}
                    stroke="#646F41"
                    strokeWidth="20"
                    strokeOpacity="0.8"
                    strokeLinecap="round"
                    markerEnd={`url(#user-arrowhead-${idx})`}
                  />
                </g>
              );
            })}
            
            {/* User-drawn circles (brand green #646F41) */}
            {userCircles.map(square => {
              let file = square.charCodeAt(0) - 97;
              let rank = 8 - parseInt(square[1]);
              
              if (boardOrientation === "black") {
                file = 7 - file;
                rank = 7 - rank;
              }
              
              // Use 800x800 viewBox coordinate system
              const squareSize = 100;
              const cx = file * squareSize + squareSize / 2;
              const cy = rank * squareSize + squareSize / 2;
              
              return (
                <circle
                  key={`user-circle-${square}`}
                  cx={cx}
                  cy={cy}
                  r={35}
                  fill="none"
                  stroke="#646F41"
                  strokeWidth="6"
                  strokeOpacity="0.8"
                />
              );
            })}
          </svg>
        </div>
        
        {/* Opening name below board */}
        <div className="text-center max-w-[340px] sm:max-w-[480px] md:max-w-[560px] lg:max-w-[640px]">
          <div className="text-xs sm:text-sm text-muted-foreground">
            {currentOpening}
          </div>
          {/* Transposition indicator with aggregated stats */}
          {aggregatedStats && (
            <div className="text-xs text-muted-foreground mt-1 flex items-center justify-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/50 text-accent-foreground">
                ⇄ {aggregatedStats.pathCount} paths
              </span>
              <span>{aggregatedStats.totalGames} games total</span>
              <span>·</span>
              <span>{(aggregatedStats.winRate * 100).toFixed(0)}% win rate</span>
            </div>
          )}
        </div>
      </div>

      {/* Move list on the side */}
      <div className="w-full lg:w-48 bg-card border border-border rounded-lg p-3 sm:p-4 max-h-[200px] lg:max-h-[600px] overflow-y-auto">
        <h3 className="text-xs sm:text-sm font-semibold mb-2 sm:mb-3 border-b border-border pb-2">Moves</h3>
        <div className="space-y-1 text-xs sm:text-sm">
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
