import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
    
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

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

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: 'You are a chess coach helping students understand their mistakes. Give specific, actionable explanations using chess terminology. Always reference concrete squares and pieces.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 250,
        temperature: 0.7
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.error('[explain-move] Rate limit exceeded');
        return new Response(JSON.stringify({ 
          error: 'Rate limit exceeded, please try again later.',
          explanation: 'AI explanation temporarily unavailable due to rate limits.'
        }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (response.status === 402) {
        console.error('[explain-move] Payment required');
        return new Response(JSON.stringify({ 
          error: 'AI credits exhausted. Please add credits to continue.',
          explanation: 'AI explanation unavailable - credits needed.'
        }), {
          status: 402,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const errorText = await response.text();
      console.error('[explain-move] AI gateway error:', response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const explanation = data.choices?.[0]?.message?.content || 'Unable to generate explanation.';
    
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
