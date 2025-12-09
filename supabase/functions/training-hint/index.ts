import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    const systemPrompt = `You are a chess coach helping a student improve. You analyze positions and provide hints or explanations about the best move. Be encouraging but direct. Keep responses concise (2-3 sentences max).`;

    let userPrompt = '';
    
    if (hintLevel === 1) {
      userPrompt = `Position (FEN): ${fen}
The best move here relates to: ${weaknessCategory.replace(/_/g, ' ')}.
Give a subtle hint about what to look for without revealing the move. Focus on the type of idea.`;
    } else if (hintLevel === 2) {
      userPrompt = `Position (FEN): ${fen}
The best move is ${bestMove}. This is a ${weaknessCategory.replace(/_/g, ' ')} pattern.
Give a stronger hint - mention the piece that should move but not where.`;
    } else {
      userPrompt = `Position (FEN): ${fen}
The best move is ${bestMove}. This addresses a ${weaknessCategory.replace(/_/g, ' ')} weakness.
Explain why this move is best and what the student should learn from this position. Be educational.`;
    }

    console.log(`Generating hint level ${hintLevel} for position: ${fen}`);

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded, please try again later." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Payment required" }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const hint = data.choices?.[0]?.message?.content || "Think about the position carefully.";

    console.log(`Generated hint: ${hint.substring(0, 50)}...`);

    return new Response(JSON.stringify({ hint }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error in training-hint function:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
