-- Create function to update timestamps (if not exists)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- Create training_positions table for spaced repetition training
CREATE TABLE public.training_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
    fen TEXT NOT NULL,
    move_to_find TEXT NOT NULL,
    move_to_find_uci TEXT NOT NULL,
    weakness_category TEXT NOT NULL,
    difficulty INTEGER NOT NULL CHECK (difficulty >= 1 AND difficulty <= 5),
    eval_loss INTEGER NOT NULL,
    game_context TEXT,
    explanation TEXT,
    times_attempted INTEGER NOT NULL DEFAULT 0,
    times_correct INTEGER NOT NULL DEFAULT 0,
    mastery_level INTEGER NOT NULL DEFAULT 0 CHECK (mastery_level >= 0 AND mastery_level <= 5),
    easiness_factor DECIMAL(3,2) NOT NULL DEFAULT 2.50,
    next_review TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.training_positions ENABLE ROW LEVEL SECURITY;

-- Create policies for user access
CREATE POLICY "Users can view their own training positions"
ON public.training_positions
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own training positions"
ON public.training_positions
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own training positions"
ON public.training_positions
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own training positions"
ON public.training_positions
FOR DELETE
USING (auth.uid() = user_id);

-- Create indexes for efficient queries
CREATE INDEX idx_training_positions_user_id ON public.training_positions(user_id);
CREATE INDEX idx_training_positions_next_review ON public.training_positions(next_review);
CREATE INDEX idx_training_positions_weakness ON public.training_positions(weakness_category);

-- Create trigger for updated_at
CREATE TRIGGER update_training_positions_updated_at
BEFORE UPDATE ON public.training_positions
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();