import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { callAI } from "../_shared/ai.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Parse move to get piece type
function getPieceFromMove(move: string): string {
  if (!move) return 'pawn';
  const firstChar = move.charAt(0);
  const pieceMap: Record<string, string> = {
    'N': 'knight', 'B': 'bishop', 'R': 'rook', 'Q': 'queen', 'K': 'king',
    'O': 'king' // Castling
  };
  return pieceMap[firstChar] || 'pawn';
}

// Get target square from move
function getTargetSquare(move: string): string {
  // Handle castling
  if (move === 'O-O') return 'kingside castling';
  if (move === 'O-O-O') return 'queenside castling';
  
  // Extract last 2 characters (the target square), ignoring check/mate symbols
  const cleaned = move.replace(/[+#=QRBN]$/, '');
  const match = cleaned.match(/([a-h][1-8])$/);
  return match ? match[1] : 'a key square';
}

// Describe the position material balance
function describeMaterial(fen: string): string {
  const position = fen.split(' ')[0];
  const turn = fen.split(' ')[1] === 'w' ? 'White' : 'Black';
  
  let whiteValue = 0, blackValue = 0;
  const values: Record<string, number> = { 'Q': 9, 'R': 5, 'B': 3, 'N': 3, 'P': 1, 'q': 9, 'r': 5, 'b': 3, 'n': 3, 'p': 1 };
  
  for (const char of position) {
    if (values[char]) {
      if (char === char.toUpperCase()) whiteValue += values[char];
      else blackValue += values[char];
    }
  }
  
  const diff = whiteValue - blackValue;
  if (Math.abs(diff) < 2) return `${turn} to move in a roughly equal position`;
  if (diff > 0) return `${turn} to move. White has a material advantage`;
  return `${turn} to move. Black has a material advantage`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { fen, bestMove, weaknessCategory, hintLevel } = await req.json();

    const materialDesc = describeMaterial(fen);
    const piece = getPieceFromMove(bestMove);
    const target = getTargetSquare(bestMove);
    const categoryReadable = weaknessCategory.replace(/_/g, ' ');

    let userPrompt = '';
    
    if (hintLevel === 1) {
      // Subtle hint - just the idea type
      userPrompt = `Position: ${fen}
${materialDesc}
The best move exploits a ${categoryReadable} pattern.

Give a subtle hint about what to look for in this position. Mention the TYPE of idea (tactic, positional concept) without revealing the move or piece. 1-2 sentences max.`;
    } else if (hintLevel === 2) {
      // Medium hint - reveal the piece
      userPrompt = `Position: ${fen}
${materialDesc}
The best move is with the ${piece} and relates to ${categoryReadable}.

Give a stronger hint mentioning that the ${piece} should move, but don't say where. Hint at what the ${piece} can accomplish. 1-2 sentences.`;
    } else {
      // Strong hint - almost reveal
      userPrompt = `Position: ${fen}
${materialDesc}
The best move is ${bestMove} (${piece} to ${target}). This is a ${categoryReadable} pattern.

Explain why this move works and what the student should learn. Be educational. 2-3 sentences.`;
    }

    console.log(`[training-hint] Generating hint level ${hintLevel} for position`);

    const ai = await callAI(
      "You are a chess coach giving hints to help students find the best move. Be encouraging but don't give away the answer unless asked. Use chess terminology appropriately.",
      userPrompt,
      150
    );

    if (!ai.ok) {
      console.error('[training-hint] AI error:', ai.status, ai.error);
      // Provide a useful non-AI fallback hint so training still works.
      const fallback =
        hintLevel >= 3
          ? `The best move is ${bestMove}.`
          : hintLevel === 2
            ? `Try moving the ${piece}.`
            : `Look for a ${categoryReadable} pattern in this position.`;
      const status = ai.status === 429 ? 429 : ai.status === 402 ? 402 : 200;
      return new Response(JSON.stringify({ error: ai.error, hint: fallback }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const hint = ai.text || "Think about the position carefully.";
    console.log(`[training-hint] Generated hint: ${hint.substring(0, 50)}...`);

    return new Response(JSON.stringify({ hint }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[training-hint] Error:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error',
      hint: 'Think carefully about the position.'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
