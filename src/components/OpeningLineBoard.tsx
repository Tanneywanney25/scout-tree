import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Chess } from "chess.js";
import Chessboard from "chessboardjsx";

interface OpeningLineBoardProps {
  line: string;
  winRate: number;
  count: number;
  isWeakLine: boolean;
  playerColor: "white" | "black";
}

export const OpeningLineBoard = ({ line, winRate, count, isWeakLine, playerColor }: OpeningLineBoardProps) => {
  // Calculate the final position after the moves
  const getFinalPosition = () => {
    const chess = new Chess();
    const moves = line.trim().split(/\s+/);
    
    for (const move of moves) {
      try {
        chess.move(move);
      } catch (e) {
        console.error(`Invalid move: ${move}`, e);
        break;
      }
    }
    
    return chess.fen();
  };

  const opponentColor = playerColor === "white" ? "Black" : "White";
  
  return (
    <Card className="overflow-hidden hover:border-primary/50 transition-all">
      <div className="aspect-square w-full">
        <Chessboard
          position={getFinalPosition()}
          width={280}
          orientation={playerColor === "white" ? "black" : "white"}
          draggable={false}
          boardStyle={{
            borderRadius: "0px",
          }}
          lightSquareStyle={{ backgroundColor: "hsl(var(--chess-board-light))" }}
          darkSquareStyle={{ backgroundColor: "hsl(var(--chess-board-dark))" }}
        />
      </div>
      <div className="p-4 space-y-2">
        <div className="flex items-center justify-between">
          <Badge 
            variant={isWeakLine ? "destructive" : "default"}
            className="text-xs"
          >
            {(winRate * 100).toFixed(0)}% win rate
          </Badge>
          <span className="text-xs text-muted-foreground">{count} games</span>
        </div>
        <code className="text-xs font-mono text-foreground/80 block truncate" title={line}>
          {line}
        </code>
        <p className="text-xs text-muted-foreground">
          {isWeakLine 
            ? `As ${opponentColor}, steer into this line`
            : `Avoid or prepare counter-play`
          }
        </p>
      </div>
    </Card>
  );
};
