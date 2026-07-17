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

// Compute how much a move lost, plus a white-relative eval for display.
//
// Stockfish reports `score cp` from the perspective of the side TO MOVE. So the
// eval of the position *before* the move is already from the mover's POV, and
// the eval *after* the move is from the opponent's POV. The mover's eval after
// the move is therefore the negation of the after-eval.
//
//   evalLoss = bestEval(beforeMove, mover POV) - actualEval(afterMove, mover POV)
//            = evalBeforeStm - ( -evalAfterStm )
//            = evalBeforeStm + evalAfterStm
//
// Evals are clamped so mate scores (±10000) don't make every move a "blunder".
export function computeMoveQuality(
  isWhite: boolean,
  evalBeforeStm: number,
  evalAfterStm: number
): { evalLoss: number; whitePovEval: number; classification: MoveClassification } {
  const CAP = 1500; // ~15 pawns; beyond this the position is already decided
  const before = Math.max(-CAP, Math.min(CAP, evalBeforeStm));
  const after = Math.max(-CAP, Math.min(CAP, evalAfterStm));

  // Floor at 0 — a "negative loss" just means the move kept/gained the eval.
  const evalLoss = Math.max(0, before + after);

  // After the move it's the opponent to move, so evalAfterStm is from the
  // opponent's POV. Convert to white's POV for display.
  const whitePovEval = isWhite ? -evalAfterStm : evalAfterStm;

  return { evalLoss, whitePovEval, classification: classifyMove(evalLoss, true) };
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
  // A single dispatch point for engine output. Each operation (init / analyze)
  // installs its own line handler while it runs and clears it when done, so
  // listeners can never accumulate across positions.
  private lineHandler: ((line: string) => void) | null = null;

  // Engine sources, tried in order. The first is a same-origin copy bundled in
  // /public so it works without any external network access; the CDNs are
  // fallbacks. All are the single-file asm.js build that runs as a standalone
  // Web Worker (no sibling .wasm needed).
  private static readonly ENGINE_URLS = [
    '/stockfish.js',
    'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js',
    'https://unpkg.com/stockfish.js@10.0.2/stockfish.js',
  ];

  async init(): Promise<void> {
    if (this.ready && this.worker) return;

    // Try to run the local copy directly as a worker first (fastest, no fetch).
    // Fall back to fetching from a CDN and running via a blob URL.
    try {
      this.worker = new Worker('/stockfish.js');
    } catch {
      let blobUrl: string | null = null;
      for (const url of StockfishEngine.ENGINE_URLS) {
        try {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          blobUrl = URL.createObjectURL(blob);
          break;
        } catch (error) {
          console.warn('[ENGINE] Failed to load from', url, error);
        }
      }
      if (!blobUrl) {
        throw new Error(
          'Could not load the chess engine. Check your network connection and try again.'
        );
      }
      this.worker = new Worker(blobUrl);
    }

    // Route every worker message to the currently-active line handler.
    this.worker.onmessage = (e: MessageEvent) => {
      const line = typeof e.data === 'string' ? e.data : (e.data?.data ?? '');
      if (line && this.lineHandler) this.lineHandler(line);
    };

    // Wait for the UCI handshake (uciok) with a guard timeout.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.lineHandler = null;
        reject(new Error('Chess engine timed out while starting up.'));
      }, 20000);

      this.worker!.onerror = (error) => {
        clearTimeout(timer);
        this.lineHandler = null;
        console.error('Stockfish worker error:', error);
        reject(new Error('The chess engine failed to start in this browser.'));
      };

      this.lineHandler = (line: string) => {
        if (line.startsWith('uciok')) {
          clearTimeout(timer);
          this.ready = true;
          this.lineHandler = null;
          resolve();
        }
      };

      this.worker!.postMessage('uci');
    });
  }

  async analyzePosition(fen: string, depth: number = 12): Promise<PositionAnalysis> {
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

    return new Promise<PositionAnalysis>((resolve) => {
      const lines: string[] = [];
      let settled = false;

      const finish = (result: PositionAnalysis) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.lineHandler = null;
        resolve(result);
      };

      // Fall back to the best partial result we've collected if the engine
      // takes too long, instead of discarding the position (eval 0).
      const timer = setTimeout(() => {
        this.worker?.postMessage('stop');
        finish(this.parseAnalysisOutput(lines, fen));
      }, 8000);

      this.lineHandler = (line: string) => {
        lines.push(line);
        if (line.startsWith('bestmove')) {
          finish(this.parseAnalysisOutput(lines, fen));
        }
      };

      // Stop anything pending, then search this position.
      this.worker!.postMessage('stop');
      this.worker!.postMessage(`position fen ${fen}`);
      this.worker!.postMessage(`go depth ${depth}`);
    });
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
    depth: number = 12,
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

      // Eval loss + display eval, handling Stockfish's side-to-move convention.
      const isWhite = move.color === 'w';
      const { evalLoss, whitePovEval, classification } = computeMoveQuality(
        isWhite,
        prevEval.evaluation,      // before the move: mover's POV
        positionAnalysis.evaluation // after the move: opponent's POV
      );

      if (classification === 'blunder') blunders++;
      else if (classification === 'mistake') mistakes++;
      else if (classification === 'inaccuracy') inaccuracies++;

      // Calculate accuracy (simplified formula)
      const accuracy = Math.max(0, 100 - Math.abs(evalLoss) / 3);
      totalAccuracy += accuracy;

      // White-relative eval of the position before the move, for display.
      const whitePovEvalBefore = isWhite ? evalBefore : -evalBefore;

      const moveAnalysis: MoveAnalysis = {
        moveNumber: Math.floor(i / 2) + 1,
        color: isWhite ? 'white' : 'black',
        move: move.san,
        moveUci: `${move.from}${move.to}${move.promotion || ''}`,
        fen: fenAfter,
        fenBefore,
        evaluation: whitePovEval,
        evalBefore: whitePovEvalBefore,
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
