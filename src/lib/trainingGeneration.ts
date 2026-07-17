import { Chess } from 'chess.js';
import { CategorizedMistake } from './weaknessDetection';
import { supabase } from '@/integrations/supabase/client';

export interface TrainingPosition {
  id?: string;
  user_id?: string;
  fen: string;
  move_to_find: string;
  move_to_find_uci: string;
  weakness_category: string;
  difficulty: number;
  eval_loss: number;
  game_context: string;
  explanation?: string;
  times_attempted: number;
  times_correct: number;
  mastery_level: number;
  easiness_factor: number;
  next_review: string;
  created_at?: string;
  updated_at?: string;
}

// Extended type for training that includes the necessary move data
export interface TrainingMistake extends CategorizedMistake {
  fen: string;
  bestMove: string;
  bestMoveUci?: string;
  evalLoss: number;
  gameContext?: string;
}

// Convert SAN move to UCI format
export function sanToUci(fen: string, sanMove: string): string | null {
  try {
    const chess = new Chess(fen);
    const move = chess.move(sanMove);
    if (!move) return null;
    
    // UCI format: from + to + promotion (e.g., "e2e4", "e7e8q")
    let uci = move.from + move.to;
    if (move.promotion) {
      uci += move.promotion;
    }
    return uci;
  } catch (e) {
    console.error('Error converting SAN to UCI:', e);
    return null;
  }
}

// Convert UCI move to SAN format
export function uciToSan(fen: string, uciMove: string): string | null {
  try {
    const chess = new Chess(fen);
    const from = uciMove.slice(0, 2);
    const to = uciMove.slice(2, 4);
    const promotion = uciMove.length > 4 ? uciMove.slice(4, 5) : undefined;
    
    const move = chess.move({ from, to, promotion });
    if (!move) return null;
    return move.san;
  } catch (e) {
    console.error('Error converting UCI to SAN:', e);
    return null;
  }
}

// Validate that a move is legal in a position
export function isMoveLegal(fen: string, move: string): boolean {
  try {
    const chess = new Chess(fen);
    
    // Try as SAN first
    try {
      const result = chess.move(move);
      return result !== null;
    } catch {
      // Not valid SAN, try as UCI
      if (move.length >= 4) {
        const from = move.slice(0, 2);
        const to = move.slice(2, 4);
        const promotion = move.length > 4 ? move.slice(4, 5) : undefined;
        try {
          const result = chess.move({ from, to, promotion });
          return result !== null;
        } catch {
          return false;
        }
      }
      return false;
    }
  } catch {
    return false;
  }
}

// Calculate difficulty 1-5 based on eval loss
export function calculateDifficulty(evalLoss: number): number {
  if (evalLoss < 100) return 1;
  if (evalLoss < 200) return 2;
  if (evalLoss < 300) return 3;
  if (evalLoss < 500) return 4;
  return 5;
}

// SM-2 Spaced Repetition Algorithm
export function calculateNextReview(
  quality: number, // 0-5, where 5 is perfect recall
  easinessFactor: number,
  consecutiveCorrect: number
): { nextReview: Date; newEasinessFactor: number; newInterval: number } {
  // Calculate new easiness factor
  let newEF = easinessFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  newEF = Math.max(1.3, newEF); // Minimum EF is 1.3

  let interval: number;
  
  if (quality < 3) {
    // Failed - reset to 1 day
    interval = 1;
  } else if (consecutiveCorrect === 0) {
    interval = 1;
  } else if (consecutiveCorrect === 1) {
    interval = 6;
  } else {
    // Use SM-2 formula for subsequent reviews
    const prevInterval = consecutiveCorrect === 2 ? 6 : Math.pow(newEF, consecutiveCorrect - 1) * 6;
    interval = Math.round(prevInterval * newEF);
  }

  // Cap at 365 days
  interval = Math.min(interval, 365);

  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + interval);

  return { nextReview, newEasinessFactor: newEF, newInterval: interval };
}

// Calculate quality score based on attempts needed
export function calculateQuality(attemptsNeeded: number, usedHint: boolean): number {
  if (attemptsNeeded === 1 && !usedHint) return 5; // Perfect
  if (attemptsNeeded === 1 && usedHint) return 4; // Good with hint
  if (attemptsNeeded === 2) return 3; // Hesitant
  if (attemptsNeeded === 3) return 2; // Difficult
  return 1; // Failed multiple times
}

// Calculate mastery level (0-5 stars) based on success rate and attempts
export function calculateMasteryLevel(timesCorrect: number, timesAttempted: number): number {
  if (timesAttempted === 0) return 0;
  const successRate = timesCorrect / timesAttempted;
  
  if (successRate >= 0.9 && timesAttempted >= 5) return 5;
  if (successRate >= 0.8 && timesAttempted >= 4) return 4;
  if (successRate >= 0.7 && timesAttempted >= 3) return 3;
  if (successRate >= 0.5 && timesAttempted >= 2) return 2;
  if (successRate > 0) return 1;
  return 0;
}

// Minimum eval-loss (centipawns) to qualify as a drill, tuned to the user's
// rating. Lower-rated players train on clear, punishing mistakes; stronger
// players also get subtler ones (so drills aren't "too easy").
function minEvalLossForRating(rating?: number | null): number {
  if (!rating) return 120;
  if (rating < 1200) return 250;
  if (rating < 1600) return 180;
  if (rating < 2000) return 120;
  if (rating < 2400) return 80;
  return 60;
}

// A short, spoiler-free prompt shown before solving.
function buildContext(m: CategorizedMistake): string {
  const sideToMove = m.move.color === 'white' ? 'White' : 'Black';
  const cat = m.category.replace(/_/g, ' ');
  return `${sideToMove} to move (move ${m.move.moveNumber}). In the real game this turned into ${cat}. Find the strongest move.`;
}

// An insight revealed after the attempt.
function buildExplanation(m: CategorizedMistake): string {
  const loss = Math.abs(m.move.evalLoss);
  const sev = loss >= 300 ? 'a blunder' : loss >= 150 ? 'a mistake' : 'an inaccuracy';
  const cat = m.category.replace(/_/g, ' ');
  const lostPawns = (loss / 100).toFixed(1);
  return `The move actually played was ${sev} (${cat}) that gave up about ${lostPawns} pawns. ${m.description}`;
}

interface ExtractOptions {
  maxPositions?: number;
  maxPerGame?: number;
  /** Minimum gap (in full moves) between two drills taken from the same game. */
  minMoveGap?: number;
  userRating?: number | null;
}

// Extract training positions from categorized mistakes, diversified across
// games so drills aren't all consecutive plies from a single game.
export function extractTrainingPositions(
  mistakes: CategorizedMistake[],
  optionsOrMax: ExtractOptions | number = {}
): Omit<TrainingPosition, 'id' | 'user_id' | 'created_at' | 'updated_at'>[] {
  // Back-compat: allow a bare number for maxPositions.
  const options: ExtractOptions = typeof optionsOrMax === 'number' ? { maxPositions: optionsOrMax } : optionsOrMax;
  const { maxPositions = 20, maxPerGame = 3, minMoveGap = 6, userRating } = options;

  const minLoss = minEvalLossForRating(userRating);

  // Keep only significant, well-formed mistakes.
  const significant = mistakes.filter((m) => {
    const evalLoss = Math.abs(m.move.evalLoss);
    return evalLoss >= minLoss && m.move.fenBefore && m.move.bestMove && isMoveLegal(m.move.fenBefore, m.move.bestMove);
  });

  // Group by game and pick the most instructive, well-spaced positions per game.
  const byGame = new Map<number, CategorizedMistake[]>();
  for (const m of significant) {
    const arr = byGame.get(m.gameIndex) || [];
    arr.push(m);
    byGame.set(m.gameIndex, arr);
  }

  const perGamePicks = new Map<number, CategorizedMistake[]>();
  for (const [game, arr] of byGame.entries()) {
    const sorted = [...arr].sort((a, b) => Math.abs(b.move.evalLoss) - Math.abs(a.move.evalLoss));
    const picks: CategorizedMistake[] = [];
    const usedFens = new Set<string>();
    for (const m of sorted) {
      if (picks.length >= maxPerGame) break;
      if (usedFens.has(m.move.fenBefore)) continue;
      // Enforce a move-number gap so we don't grab the position right after.
      const tooClose = picks.some((p) => Math.abs(p.move.moveNumber - m.move.moveNumber) < minMoveGap);
      if (tooClose) continue;
      picks.push(m);
      usedFens.add(m.move.fenBefore);
    }
    perGamePicks.set(game, picks);
  }

  // Round-robin across games so the session draws from many games, hardest first.
  const queues = [...perGamePicks.values()].map((arr) =>
    arr.sort((a, b) => Math.abs(b.move.evalLoss) - Math.abs(a.move.evalLoss))
  );
  const selected: CategorizedMistake[] = [];
  const globalFens = new Set<string>();
  let round = 0;
  while (selected.length < maxPositions) {
    let added = false;
    for (const q of queues) {
      if (round < q.length) {
        const m = q[round];
        if (!globalFens.has(m.move.fenBefore)) {
          selected.push(m);
          globalFens.add(m.move.fenBefore);
          added = true;
          if (selected.length >= maxPositions) break;
        }
      }
    }
    if (!added) break;
    round++;
  }

  return selected.map((mistake) => {
    const fen = mistake.move.fenBefore;
    const sanMove = mistake.move.bestMove;
    const uciMove = sanToUci(fen, sanMove) || sanMove;

    return {
      fen,
      move_to_find: sanMove,
      move_to_find_uci: uciMove,
      weakness_category: mistake.category,
      difficulty: calculateDifficulty(Math.abs(mistake.move.evalLoss)),
      eval_loss: Math.round(Math.abs(mistake.move.evalLoss)),
      game_context: buildContext(mistake),
      explanation: buildExplanation(mistake),
      times_attempted: 0,
      times_correct: 0,
      mastery_level: 0,
      easiness_factor: 2.5,
      next_review: new Date().toISOString(),
    };
  });
}

// Save training positions to database
export async function saveTrainingPositions(
  positions: Omit<TrainingPosition, 'id' | 'user_id' | 'created_at' | 'updated_at'>[]
): Promise<{ saved: number; errors: string[] }> {
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return { saved: 0, errors: ['User not authenticated'] };
  }

  const errors: string[] = [];
  let saved = 0;

  // Check for existing positions with same FEN to avoid duplicates
  const { data: existing } = await supabase
    .from('training_positions')
    .select('fen')
    .eq('user_id', user.id);

  const existingFens = new Set(existing?.map(p => p.fen) || []);

  for (const position of positions) {
    if (existingFens.has(position.fen)) {
      continue; // Skip duplicates
    }

    const { error } = await supabase
      .from('training_positions')
      .insert({
        ...position,
        user_id: user.id,
      });

    if (error) {
      errors.push(`Failed to save position: ${error.message}`);
    } else {
      saved++;
      existingFens.add(position.fen);
    }
  }

  return { saved, errors };
}

// Fetch positions due for review
export async function fetchDuePositions(limit: number = 20): Promise<TrainingPosition[]> {
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from('training_positions')
    .select('*')
    .eq('user_id', user.id)
    .lte('next_review', new Date().toISOString())
    .order('next_review', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('Error fetching due positions:', error);
    return [];
  }

  return (data || []) as TrainingPosition[];
}

// Fetch all training positions for dashboard
export async function fetchAllTrainingPositions(): Promise<TrainingPosition[]> {
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return [];
  }

  const { data, error } = await supabase
    .from('training_positions')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching training positions:', error);
    return [];
  }

  return (data || []) as TrainingPosition[];
}

// Update position after training attempt
export async function updateTrainingPosition(
  positionId: string,
  correct: boolean,
  attemptsNeeded: number,
  usedHint: boolean
): Promise<boolean> {
  // Fetch current position
  const { data: position, error: fetchError } = await supabase
    .from('training_positions')
    .select('*')
    .eq('id', positionId)
    .single();

  if (fetchError || !position) {
    console.error('Error fetching position:', fetchError);
    return false;
  }

  const newTimesAttempted = position.times_attempted + 1;
  const newTimesCorrect = position.times_correct + (correct ? 1 : 0);
  
  const quality = correct ? calculateQuality(attemptsNeeded, usedHint) : 1;
  const consecutiveCorrect = correct ? 
    Math.floor(position.times_correct / Math.max(1, position.times_attempted) * newTimesAttempted) : 0;
  
  const { nextReview, newEasinessFactor } = calculateNextReview(
    quality,
    Number(position.easiness_factor),
    consecutiveCorrect
  );

  const newMasteryLevel = calculateMasteryLevel(newTimesCorrect, newTimesAttempted);

  const { error: updateError } = await supabase
    .from('training_positions')
    .update({
      times_attempted: newTimesAttempted,
      times_correct: newTimesCorrect,
      mastery_level: newMasteryLevel,
      easiness_factor: newEasinessFactor,
      next_review: nextReview.toISOString(),
    })
    .eq('id', positionId);

  if (updateError) {
    console.error('Error updating position:', updateError);
    return false;
  }

  return true;
}

// Delete a training position
export async function deleteTrainingPosition(positionId: string): Promise<boolean> {
  const { error } = await supabase
    .from('training_positions')
    .delete()
    .eq('id', positionId);

  if (error) {
    console.error('Error deleting position:', error);
    return false;
  }

  return true;
}

// Get training statistics
export async function getTrainingStats(): Promise<{
  total: number;
  dueToday: number;
  masteryDistribution: number[];
  weaknessBreakdown: Record<string, number>;
}> {
  const { data: { user } } = await supabase.auth.getUser();
  
  if (!user) {
    return { total: 0, dueToday: 0, masteryDistribution: [0, 0, 0, 0, 0, 0], weaknessBreakdown: {} };
  }

  const { data, error } = await supabase
    .from('training_positions')
    .select('*')
    .eq('user_id', user.id);

  if (error || !data) {
    return { total: 0, dueToday: 0, masteryDistribution: [0, 0, 0, 0, 0, 0], weaknessBreakdown: {} };
  }

  const now = new Date();
  const dueToday = data.filter(p => new Date(p.next_review) <= now).length;
  
  const masteryDistribution = [0, 0, 0, 0, 0, 0]; // 0-5 stars
  const weaknessBreakdown: Record<string, number> = {};

  data.forEach(p => {
    masteryDistribution[p.mastery_level]++;
    weaknessBreakdown[p.weakness_category] = (weaknessBreakdown[p.weakness_category] || 0) + 1;
  });

  return {
    total: data.length,
    dueToday,
    masteryDistribution,
    weaknessBreakdown,
  };
}
