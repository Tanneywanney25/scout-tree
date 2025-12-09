import { Chess } from "chess.js";

export type MoveClassification = 'brilliant' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder';

export interface PositionAnalysis {
  evaluation: number; // centipawns (positive = white advantage)
  bestMove: string; // UCI format like "e2e4"
  bestMoveSan: string; // SAN format like "e4"
  principalVariation: string[]; // Array of UCI moves
  depth: number;
  mate?: number; // Mate in X moves (positive = white mates, negative = black mates)
}

export interface MoveAnalysis {
  moveNumber: number;
  color: 'white' | 'black';
  move: string; // SAN like "Nf3"
  moveUci: string; // UCI like "g1f3"
  fen: string; // Position after the move
  fenBefore: string; // Position before the move
  evaluation: number; // Eval after the move
  evalBefore: number; // Eval before the move
  bestMove: string; // Best move SAN
  bestMoveUci: string; // Best move UCI
  bestMoveEval: number; // Eval if best move was played
  classification: MoveClassification;
  evalLoss: number; // How many centipawns lost
}

export interface GameAnalysis {
  moves: MoveAnalysis[];
  averageAccuracy: number;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
}

// Classify move based on evaluation loss
export function classifyMove(evalLoss: number, isPlayerTurn: boolean): MoveClassification {
  const loss = Math.abs(evalLoss);
  
  if (loss <= 10) return 'excellent';
  if (loss <= 25) return 'good';
  if (loss <= 100) return 'inaccuracy';
  if (loss <= 300) return 'mistake';
  return 'blunder';
}

// Get game phase based on material and move number
export function getGamePhase(fen: string, moveNumber: number): 'opening' | 'middlegame' | 'endgame' {
  if (moveNumber <= 12) return 'opening';
  
  // Count material
  const pieces = fen.split(' ')[0];
  let material = 0;
  for (const char of pieces) {
    if (char === 'q' || char === 'Q') material += 9;
    if (char === 'r' || char === 'R') material += 5;
    if (char === 'b' || char === 'B') material += 3;
    if (char === 'n' || char === 'N') material += 3;
  }
  
  if (material <= 26) return 'endgame';
  return 'middlegame';
}

// Convert UCI move to SAN
export function uciToSan(chess: Chess, uciMove: string): string {
  try {
    const from = uciMove.slice(0, 2);
    const to = uciMove.slice(2, 4);
    const promotion = uciMove.length > 4 ? uciMove[4] : undefined;
    
    const move = chess.move({ from, to, promotion });
    if (move) {
      chess.undo();
      return move.san;
    }
    return uciMove;
  } catch {
    return uciMove;
  }
}

// Stockfish Engine wrapper using Web Worker
export class StockfishEngine {
  private worker: Worker | null = null;
  private ready: boolean = false;
  private currentResolve: ((value: string) => void) | null = null;
  private outputBuffer: string[] = [];

  async init(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        // Fetch the Stockfish script and create a blob URL to bypass CORS
        const stockfishUrl = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';
        const response = await fetch(stockfishUrl);
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        
        this.worker = new Worker(blobUrl);
        
        this.worker.onmessage = (e) => {
          const message = e.data;
          
          if (message === 'uciok') {
            this.ready = true;
            resolve();
          }
          
          if (message === 'readyok' && this.currentResolve) {
            this.currentResolve(this.outputBuffer.join('\n'));
            this.outputBuffer = [];
            this.currentResolve = null;
          }
          
          // Collect output lines
          if (typeof message === 'string') {
            this.outputBuffer.push(message);
          }
        };

        this.worker.onerror = (error) => {
          console.error('Stockfish worker error:', error);
          reject(error);
        };

        // Initialize UCI
        this.worker.postMessage('uci');
      } catch (error) {
        reject(error);
      }
    });
  }

  async analyzePosition(fen: string, depth: number = 18): Promise<PositionAnalysis> {
    if (!this.worker || !this.ready) {
      throw new Error('Engine not initialized');
    }

    // Check if position is terminal (checkmate/stalemate) - engine won't return bestmove
    try {
      const chess = new Chess(fen);
      if (chess.isGameOver()) {
        const isCheckmate = chess.isCheckmate();
        const turn = chess.turn();
        return {
          evaluation: isCheckmate ? (turn === 'w' ? -10000 : 10000) : 0,
          bestMove: '',
          bestMoveSan: '',
          principalVariation: [],
          depth: 0,
          mate: isCheckmate ? (turn === 'w' ? -1 : 1) : undefined
        };
      }
    } catch {
      // Continue with analysis if FEN parsing fails
    }

    // Stop any pending analysis first
    this.worker.postMessage('stop');

    // Create analysis promise with timeout
    const analysisPromise = new Promise<PositionAnalysis>((resolve) => {
      this.outputBuffer = [];
      
      // Set up position
      this.worker!.postMessage(`position fen ${fen}`);
      this.worker!.postMessage(`go depth ${depth}`);
      
      // Listen for bestmove
      const handler = (e: MessageEvent) => {
        const message = e.data;
        this.outputBuffer.push(message);
        
        if (typeof message === 'string' && message.startsWith('bestmove')) {
          this.worker!.removeEventListener('message', handler);
          
          // Parse the output
          const result = this.parseAnalysisOutput(this.outputBuffer, fen);
          this.outputBuffer = [];
          resolve(result);
        }
      };
      
      this.worker!.addEventListener('message', handler);
    });

    // Wrap with 10 second timeout
    const timeoutPromise = new Promise<PositionAnalysis>((resolve) => {
      setTimeout(() => {
        this.worker?.postMessage('stop');
        resolve({
          evaluation: 0,
          bestMove: '',
          bestMoveSan: '',
          principalVariation: [],
          depth: 0
        });
      }, 10000);
    });

    return Promise.race([analysisPromise, timeoutPromise]);
  }

  private parseAnalysisOutput(lines: string[], fen: string): PositionAnalysis {
    let evaluation = 0;
    let bestMove = '';
    let bestMoveSan = '';
    let pv: string[] = [];
    let depth = 0;
    let mate: number | undefined;

    // Find the last "info" line with depth data
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      
      if (line.startsWith('bestmove')) {
        const parts = line.split(' ');
        bestMove = parts[1] || '';
      }
      
      if (line.startsWith('info') && line.includes('depth') && line.includes('score')) {
        const depthMatch = line.match(/depth (\d+)/);
        if (depthMatch) depth = parseInt(depthMatch[1]);
        
        // Check for mate score
        const mateMatch = line.match(/score mate (-?\d+)/);
        if (mateMatch) {
          mate = parseInt(mateMatch[1]);
          evaluation = mate > 0 ? 10000 - mate * 100 : -10000 - mate * 100;
        } else {
          const cpMatch = line.match(/score cp (-?\d+)/);
          if (cpMatch) evaluation = parseInt(cpMatch[1]);
        }
        
        const pvMatch = line.match(/pv (.+)/);
        if (pvMatch) pv = pvMatch[1].split(' ');
        
        break;
      }
    }

    // Convert best move to SAN
    try {
      const chess = new Chess(fen);
      bestMoveSan = uciToSan(chess, bestMove);
    } catch {
      bestMoveSan = bestMove;
    }

    return {
      evaluation,
      bestMove,
      bestMoveSan,
      principalVariation: pv,
      depth,
      mate
    };
  }

  async analyzeGame(
    pgn: string,
    depth: number = 18,
    onProgress?: (current: number, total: number, analysis: MoveAnalysis) => void
  ): Promise<GameAnalysis> {
    const chess = new Chess();
    
    try {
      chess.loadPgn(pgn);
    } catch (error) {
      console.error('Failed to load PGN:', error);
      throw new Error('Invalid PGN');
    }

    const history = chess.history({ verbose: true });
    chess.reset();

    const moves: MoveAnalysis[] = [];
    let blunders = 0;
    let mistakes = 0;
    let inaccuracies = 0;
    let totalAccuracy = 0;

    // Analyze starting position
    let prevEval = await this.analyzePosition(chess.fen(), depth);
    
    for (let i = 0; i < history.length; i++) {
      const move = history[i];
      const fenBefore = chess.fen();
      const evalBefore = prevEval.evaluation;
      
      // Make the move
      chess.move(move.san);
      const fenAfter = chess.fen();
      
      // Analyze position after move
      const positionAnalysis = await this.analyzePosition(fenAfter, depth);
      
      // Calculate eval loss (from the perspective of the player who moved)
      const isWhite = move.color === 'w';
      const evalAfterForPlayer = isWhite ? -positionAnalysis.evaluation : positionAnalysis.evaluation;
      const evalBeforeForPlayer = isWhite ? evalBefore : -evalBefore;
      
      // Get best move evaluation
      const bestMoveEval = isWhite ? -prevEval.evaluation : prevEval.evaluation;
      
      // Eval loss = how much worse than the best move
      const evalLoss = bestMoveEval - evalAfterForPlayer;
      
      const classification = classifyMove(evalLoss, true);
      
      if (classification === 'blunder') blunders++;
      else if (classification === 'mistake') mistakes++;
      else if (classification === 'inaccuracy') inaccuracies++;

      // Calculate accuracy (simplified formula)
      const accuracy = Math.max(0, 100 - Math.abs(evalLoss) / 3);
      totalAccuracy += accuracy;

      const moveAnalysis: MoveAnalysis = {
        moveNumber: Math.floor(i / 2) + 1,
        color: isWhite ? 'white' : 'black',
        move: move.san,
        moveUci: `${move.from}${move.to}${move.promotion || ''}`,
        fen: fenAfter,
        fenBefore,
        evaluation: positionAnalysis.evaluation,
        evalBefore,
        bestMove: prevEval.bestMoveSan,
        bestMoveUci: prevEval.bestMove,
        bestMoveEval: prevEval.evaluation,
        classification,
        evalLoss
      };

      moves.push(moveAnalysis);
      prevEval = positionAnalysis;

      if (onProgress) {
        onProgress(i + 1, history.length, moveAnalysis);
      }

      // Yield to UI every few moves
      if (i % 3 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    return {
      moves,
      averageAccuracy: moves.length > 0 ? totalAccuracy / moves.length : 0,
      blunders,
      mistakes,
      inaccuracies
    };
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }
}

// Singleton instance
let engineInstance: StockfishEngine | null = null;

export async function getEngine(): Promise<StockfishEngine> {
  if (!engineInstance) {
    engineInstance = new StockfishEngine();
    await engineInstance.init();
  }
  return engineInstance;
}

export function terminateEngine(): void {
  if (engineInstance) {
    engineInstance.terminate();
    engineInstance = null;
  }
}
