import { useState, useMemo } from "react";
import { Chess } from "chess.js";
import Chessboard from "chessboardjsx";
import { OpeningTreeViewer } from "./OpeningTreeViewer";
import { Button } from "./ui/button";
import { RotateCcw } from "lucide-react";

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

  const handleMoveClick = (movePath: string[]) => {
    setSelectedPath(movePath);
  };

  const handleReset = () => {
    setSelectedPath([]);
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-12rem)]">
      {/* Left: Move List */}
      <div className="w-64 flex-shrink-0 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Moves</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={selectedPath.length === 0}
          >
            <RotateCcw className="w-4 h-4" />
          </Button>
        </div>
        
        {/* Move sequence display */}
        <div className="border border-border rounded-lg p-3 bg-card h-[calc(100%-3rem)] overflow-y-auto">
          {selectedPath.length > 0 ? (
            <div className="space-y-1">
              {Array.from({ length: Math.ceil(selectedPath.length / 2) }).map((_, pairIndex) => {
                const whiteMove = selectedPath[pairIndex * 2];
                const blackMove = selectedPath[pairIndex * 2 + 1];
                return (
                  <div key={pairIndex} className="flex items-start gap-2 text-sm font-mono">
                    <span className="text-muted-foreground w-6">{pairIndex + 1}.</span>
                    <div className="flex gap-4 flex-1">
                      <span className="font-semibold">{whiteMove}</span>
                      {blackMove && <span className="font-semibold">{blackMove}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No moves yet. Click on moves in the opening tree.</p>
          )}
        </div>
      </div>

      {/* Center: Chess Board */}
      <div className="flex-1 flex items-center justify-center">
        <div className="aspect-square w-full max-w-[min(calc(100vh-14rem),100%)] border-2 border-border rounded-lg overflow-hidden shadow-lg">
          <Chessboard 
            position={currentPosition}
            orientation="white"
            draggable={false}
            boardStyle={{
              borderRadius: '0.5rem',
            }}
          />
        </div>
      </div>

      {/* Right: Opening Tree */}
      <div className="w-96 flex-shrink-0 space-y-4">
        <h3 className="text-sm font-semibold">Opening Tree</h3>
        <div className="h-[calc(100%-2rem)] overflow-y-auto border border-border rounded-lg p-4 bg-card">
          <OpeningTreeViewer 
            node={node} 
            maxDepth={maxDepth}
            onMoveClick={handleMoveClick}
            selectedPath={selectedPath}
          />
        </div>
      </div>
    </div>
  );
};

export default InteractiveOpeningTree;
