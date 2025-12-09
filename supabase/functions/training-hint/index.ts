import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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
    
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

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

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { 
            role: "system", 
            content: "You are a chess coach giving hints to help students find the best move. Be encouraging but don't give away the answer unless asked. Use chess terminology appropriately." 
          },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 150,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.error('[training-hint] Rate limit exceeded');
        return new Response(JSON.stringify({ 
          error: "Rate limit exceeded, please try again later.",
          hint: `Look for a ${categoryReadable} pattern in this position.`
        }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        console.error('[training-hint] Payment required');
        return new Response(JSON.stringify({ 
          error: "Payment required",
          hint: hintLevel >= 3 ? `The correct move is ${bestMove}.` : `Try moving the ${piece}.`
        }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error("[training-hint] AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const hint = data.choices?.[0]?.message?.content || "Think about the position carefully.";

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
