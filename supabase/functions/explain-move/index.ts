import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ExplainMoveRequest {
  fen: string;
  movePlayed: string;
  bestMove: string;
  evalDiff: number; // centipawns lost (positive = bad move)
  classification: 'inaccuracy' | 'mistake' | 'blunder';
  gamePhase: 'opening' | 'middlegame' | 'endgame';
  playerColor: 'white' | 'black';
}

serve(async (req) => {
  // Handle CORS preflight
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

    // Build a focused chess coaching prompt
    const prompt = `You are an expert chess coach explaining a ${classification} to a club-level player.

Position (FEN): ${fen}
Player color: ${playerColor}
Game phase: ${gamePhase}
Move played: ${movePlayed} (loses approximately ${Math.abs(evalDiff / 100).toFixed(1)} pawns of evaluation)
Better move: ${bestMove}

In exactly 2-3 sentences, explain:
1. What is wrong with ${movePlayed} (concrete tactical or positional problem)
2. Why ${bestMove} is better (what it achieves)

Be specific and instructive. Use chess terminology appropriately. Focus on what the player can learn.`;

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
            content: 'You are a chess coach. Give concise, educational explanations for chess moves. Be direct and specific.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 200,
        temperature: 0.7
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded, please try again later.' }), {
          status: 429,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted. Please add credits to continue.' }), {
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
