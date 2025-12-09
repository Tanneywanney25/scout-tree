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

// Extract training positions from categorized mistakes
export function extractTrainingPositions(
  mistakes: CategorizedMistake[],
  maxPositions: number = 20
): Omit<TrainingPosition, 'id' | 'user_id' | 'created_at' | 'updated_at'>[] {
  // Filter for significant mistakes only (eval loss > 50cp) and those with required data
  const significantMistakes = mistakes.filter(m => {
    const evalLoss = Math.abs(m.move.evalLoss);
    return evalLoss > 50 && m.move.fenBefore && m.move.bestMove;
  });
  
  // Sort by eval loss (worst first) to prioritize biggest mistakes
  const sorted = significantMistakes.sort((a, b) => 
    Math.abs(b.move.evalLoss) - Math.abs(a.move.evalLoss)
  );
  
  // Take top N positions
  const selected = sorted.slice(0, maxPositions);
  
  return selected.map(mistake => ({
    fen: mistake.move.fenBefore,
    move_to_find: mistake.move.bestMove,
    move_to_find_uci: mistake.move.bestMove, // Use SAN as fallback
    weakness_category: mistake.category,
    difficulty: calculateDifficulty(Math.abs(mistake.move.evalLoss)),
    eval_loss: Math.round(Math.abs(mistake.move.evalLoss)),
    game_context: `Move ${mistake.move.moveNumber}: ${mistake.description}`,
    times_attempted: 0,
    times_correct: 0,
    mastery_level: 0,
    easiness_factor: 2.5,
    next_review: new Date().toISOString(),
  }));
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
