import { useState, useMemo } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
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
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Chess Board */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Position</h3>
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={selectedPath.length === 0}
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Reset
          </Button>
        </div>
        
        <div className="aspect-square w-full max-w-[500px] mx-auto border-2 border-border rounded-lg overflow-hidden shadow-lg">
          <Chessboard 
            options={{
              position: currentPosition,
              boardOrientation: "white",
              allowDragging: false,
              boardStyle: {
                borderRadius: '0.5rem',
              }
            }}
          />
        </div>

        {/* Move sequence display */}
        {selectedPath.length > 0 && (
          <div className="p-4 bg-muted/50 rounded-lg">
            <p className="text-sm text-muted-foreground mb-2">Move sequence:</p>
            <code className="text-sm font-mono">
              {selectedPath.map((san, index) => {
                const moveNumber = Math.floor(index / 2) + 1;
                const isWhiteMove = index % 2 === 0;
                return (
                  <span key={index}>
                    {isWhiteMove ? `${moveNumber}. ` : ""}
                    {san}{" "}
                  </span>
                );
              })}
            </code>
          </div>
        )}
      </div>

      {/* Opening Tree */}
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Opening Moves</h3>
        <div className="max-h-[600px] overflow-y-auto border border-border rounded-lg p-4 bg-card">
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
