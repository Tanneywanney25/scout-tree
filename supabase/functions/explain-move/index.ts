import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callAI } from "../_shared/ai.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ExplainMoveRequest {
  fen: string;
  movePlayed: string;
  bestMove: string;
  evalDiff: number;
  classification: 'inaccuracy' | 'mistake' | 'blunder';
  gamePhase: 'opening' | 'middlegame' | 'endgame';
  playerColor: 'white' | 'black';
}

// Parse FEN to get a human-readable board description
function describeBoardFromFen(fen: string): string {
  const parts = fen.split(' ');
  const position = parts[0];
  const turn = parts[1] === 'w' ? 'White' : 'Black';
  
  const pieceCount: Record<string, number> = {
    'K': 0, 'Q': 0, 'R': 0, 'B': 0, 'N': 0, 'P': 0,
    'k': 0, 'q': 0, 'r': 0, 'b': 0, 'n': 0, 'p': 0
  };
  
  for (const char of position) {
    if (pieceCount[char] !== undefined) {
      pieceCount[char]++;
    }
  }
  
  const whitePieces = [];
  const blackPieces = [];
  
  if (pieceCount['Q'] > 0) whitePieces.push(`${pieceCount['Q']} queen${pieceCount['Q'] > 1 ? 's' : ''}`);
  if (pieceCount['R'] > 0) whitePieces.push(`${pieceCount['R']} rook${pieceCount['R'] > 1 ? 's' : ''}`);
  if (pieceCount['B'] > 0) whitePieces.push(`${pieceCount['B']} bishop${pieceCount['B'] > 1 ? 's' : ''}`);
  if (pieceCount['N'] > 0) whitePieces.push(`${pieceCount['N']} knight${pieceCount['N'] > 1 ? 's' : ''}`);
  if (pieceCount['P'] > 0) whitePieces.push(`${pieceCount['P']} pawn${pieceCount['P'] > 1 ? 's' : ''}`);
  
  if (pieceCount['q'] > 0) blackPieces.push(`${pieceCount['q']} queen${pieceCount['q'] > 1 ? 's' : ''}`);
  if (pieceCount['r'] > 0) blackPieces.push(`${pieceCount['r']} rook${pieceCount['r'] > 1 ? 's' : ''}`);
  if (pieceCount['b'] > 0) blackPieces.push(`${pieceCount['b']} bishop${pieceCount['b'] > 1 ? 's' : ''}`);
  if (pieceCount['n'] > 0) blackPieces.push(`${pieceCount['n']} knight${pieceCount['n'] > 1 ? 's' : ''}`);
  if (pieceCount['p'] > 0) blackPieces.push(`${pieceCount['p']} pawn${pieceCount['p'] > 1 ? 's' : ''}`);
  
  return `${turn} to move. White has: King, ${whitePieces.join(', ') || 'no other pieces'}. Black has: King, ${blackPieces.join(', ') || 'no other pieces'}.`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body: ExplainMoveRequest = await req.json();
    const { fen, movePlayed, bestMove, evalDiff, classification, gamePhase, playerColor } = body;
    
    console.log('[explain-move] Request:', { movePlayed, bestMove, evalDiff, classification, gamePhase });

    const boardDescription = describeBoardFromFen(fen);
    const evalLossPawns = Math.abs(evalDiff / 100).toFixed(1);

    // Build a focused chess coaching prompt with board context
    const prompt = `You are an expert chess coach. A ${playerColor} player made a ${classification} in the ${gamePhase}.

POSITION BEFORE THE MOVE:
FEN: ${fen}
${boardDescription}

THE MOVE:
Played: ${movePlayed} (this is the ${classification}, losing about ${evalLossPawns} pawns of evaluation)
Better move: ${bestMove}

TASK: In 2-3 clear sentences, explain:
1. The specific tactical or positional problem with ${movePlayed}
2. Why ${bestMove} is better and what it achieves

Be concrete and educational. Reference specific squares, pieces, or threats when relevant. Do not be vague.`;

    const ai = await callAI(
      'You are a chess coach helping students understand their mistakes. Give specific, actionable explanations using chess terminology. Always reference concrete squares and pieces.',
      prompt,
      250
    );

    if (!ai.ok) {
      console.error('[explain-move] AI error:', ai.status, ai.error);
      const status = ai.status === 429 ? 429 : ai.status === 402 ? 402 : 200;
      return new Response(JSON.stringify({
        error: ai.error,
        explanation:
          ai.status === 429
            ? 'AI explanation temporarily unavailable due to rate limits.'
            : 'AI explanation is unavailable. Add an ANTHROPIC_API_KEY secret to enable it.',
      }), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const explanation = ai.text || 'Unable to generate explanation.';
    console.log('[explain-move] Generated explanation:', explanation.substring(0, 100) + '...');

    return new Response(JSON.stringify({ explanation }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[explain-move] Error:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error',
      explanation: 'Unable to generate explanation at this time.'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
