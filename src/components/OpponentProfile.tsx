import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { 
  User, Clock, Brain, TrendingUp, TrendingDown, 
  Target, AlertTriangle, Lightbulb, Zap, Shield,
  BookOpen, Swords, Timer, Activity
} from "lucide-react";
import {
  generateOpponentProfile,
  getStyleColor,
  getMentalStrengthColor,
  type OpponentProfile as OpponentProfileType,
} from "@/lib/opponentProfiling";

interface StoredGame {
  pgn: string;
  white: string;
  black: string;
  result: string;
  date?: string;
  url?: string;
  timeControl?: string;
}

interface OpponentProfileProps {
  games?: StoredGame[];
  username: string;
}

const styleIcons = {
  activist: Swords,
  pragmatist: Target,
  reflector: Shield,
  theoretician: BookOpen,
};

const styleLabels = {
  activist: 'Activist',
  pragmatist: 'Pragmatist',
  reflector: 'Reflector',
  theoretician: 'Theoretician',
};

const mentalLabels = {
  resilient: 'Resilient',
  steady: 'Steady',
  fragile: 'Fragile',
};

export default function OpponentProfile({ games = [], username }: OpponentProfileProps) {
  const [profile, setProfile] = useState<OpponentProfileType | null>(null);

  // Generate profile when games change
  useEffect(() => {
    if (games.length > 0) {
      // Map StoredGame to GameData format
      const gameData = games.map(g => ({
        pgn: g.pgn,
        white: g.white,
        black: g.black,
        winner: g.result === '1-0' ? 'white' : g.result === '0-1' ? 'black' : undefined,
        timeControl: g.timeControl,
      }));
      
      const generated = generateOpponentProfile(gameData, username);
      setProfile(generated);
    }
  }, [games, username]);

  if (games.length === 0) {
    return (
      <Card className="border-border/50">
        <CardContent className="py-12 text-center">
          <User className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">
            No games available for profiling.
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Generate a scout report with games to use this feature.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!profile) {
    return (
      <Card className="border-border/50">
        <CardContent className="py-12 text-center">
          <Activity className="w-12 h-12 mx-auto mb-4 text-muted-foreground animate-pulse" />
          <p className="text-muted-foreground">Generating profile...</p>
        </CardContent>
      </Card>
    );
  }

  const StyleIcon = styleIcons[profile.playingStyle];

  return (
    <div className="space-y-6">
      {/* Header with Playing Style */}
      <Card className="border-border/50 bg-gradient-to-br from-card to-card/50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-2xl flex items-center gap-3">
                <User className="w-6 h-6" />
                {username}
              </CardTitle>
              <CardDescription className="mt-1">
                Based on {profile.gamesAnalyzed} analyzed games
              </CardDescription>
            </div>
            <Badge className={`${getStyleColor(profile.playingStyle)} text-lg px-4 py-2`}>
              <StyleIcon className="w-5 h-5 mr-2" />
              {styleLabels[profile.playingStyle]}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm text-muted-foreground">Style confidence:</span>
            <Progress value={profile.styleConfidence} className="w-32 h-2" />
            <span className="text-sm font-medium">{profile.styleConfidence}%</span>
          </div>
          <p className="text-foreground">{profile.styleDescription}</p>
        </CardContent>
      </Card>

      {/* Stats Grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Time Management */}
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary" />
              Time Management
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Time trouble rate</span>
              <span className={`font-semibold ${
                profile.timeManagement.timeTroubleRate > 30 ? 'text-red-400' : 
                profile.timeManagement.timeTroubleRate > 15 ? 'text-yellow-400' : 
                'text-green-400'
              }`}>
                {profile.timeManagement.timeTroubleRate}%
              </span>
            </div>
            <Progress 
              value={profile.timeManagement.timeTroubleRate} 
              className="h-2"
            />
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground">Win rate in time trouble</span>
              <span className="font-medium">{profile.timeManagement.timeTroubleWinRate}%</span>
            </div>
            {profile.timeManagement.timeTroubleRate > 25 && (
              <div className="flex items-center gap-2 text-xs text-orange-400 bg-orange-500/10 p-2 rounded">
                <AlertTriangle className="w-3 h-3" />
                Prone to time pressure errors
              </div>
            )}
          </CardContent>
        </Card>

        {/* Mental Game */}
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Brain className="w-4 h-4 text-primary" />
              Mental Game
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Mental strength</span>
              <Badge className={getMentalStrengthColor(profile.mentalGame.mentalStrength)}>
                {mentalLabels[profile.mentalGame.mentalStrength]}
              </Badge>
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <TrendingUp className="w-3 h-3 text-green-400" />
                  Comeback rate
                </span>
                <span className="font-medium">{profile.mentalGame.comebackRate}%</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <TrendingDown className="w-3 h-3 text-red-400" />
                  Collapse rate
                </span>
                <span className="font-medium">{profile.mentalGame.collapseRate}%</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Draw hold rate</span>
                <span className="font-medium">{profile.mentalGame.drawHoldRate}%</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Game Length Preferences */}
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Timer className="w-4 h-4 text-primary" />
              Game Length
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Average game</span>
              <span className="font-semibold">{profile.gameLength.avgGameLength} moves</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="p-2 bg-muted/30 rounded">
                <p className="font-semibold text-foreground">{profile.gameLength.shortGames}</p>
                <p className="text-muted-foreground">Short</p>
                <p className="text-muted-foreground">(&lt;25)</p>
              </div>
              <div className="p-2 bg-muted/30 rounded">
                <p className="font-semibold text-foreground">{profile.gameLength.mediumGames}</p>
                <p className="text-muted-foreground">Medium</p>
                <p className="text-muted-foreground">(25-50)</p>
              </div>
              <div className="p-2 bg-muted/30 rounded">
                <p className="font-semibold text-foreground">{profile.gameLength.longGames}</p>
                <p className="text-muted-foreground">Long</p>
                <p className="text-muted-foreground">(&gt;50)</p>
              </div>
            </div>
            <div className="text-xs text-muted-foreground text-center">
              {profile.gameLength.prefersEndgame 
                ? '🏰 Prefers endgames' 
                : '⚔️ Prefers tactical battles'}
            </div>
          </CardContent>
        </Card>

        {/* Opening Style */}
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="w-4 h-4 text-primary" />
              Opening Style
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Opening diversity</span>
              <span className="font-medium">{profile.openingStyle.openingDiversity} openings</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Gambits played</span>
              <span className="font-medium">{profile.openingStyle.gambitsPlayed}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Solid openings</span>
              <span className="font-medium">{profile.openingStyle.solidOpenings}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Avg deviation ply</span>
              <span className="font-medium">~{profile.openingStyle.mainlineDeviation}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Key Insights */}
      {profile.keyInsights.length > 0 && (
        <Card className="border-border/50">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-yellow-400" />
              Key Insights
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {profile.keyInsights.map((insight, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <span className="text-foreground">{insight}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Exploitable Weaknesses */}
      {profile.exploitableWeaknesses.length > 0 && (
        <Card className="border-border/50 border-red-500/30">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-red-400">
              <Target className="w-4 h-4" />
              Exploitable Weaknesses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {profile.exploitableWeaknesses.map((weakness, i) => (
                <Badge key={i} variant="outline" className="text-red-400 border-red-500/50">
                  {weakness}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pre-game Checklist */}
      <Card className="border-border/50 bg-gradient-to-br from-primary/5 to-transparent">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="w-4 h-4 text-primary" />
            60-Second Pre-Game Checklist
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <span className="text-primary font-bold">1.</span>
              <span>
                Playing style: <strong className={getStyleColor(profile.playingStyle).split(' ')[0]}>
                  {styleLabels[profile.playingStyle]}
                </strong> - {profile.playingStyle === 'activist' ? 'expect early aggression' : 
                  profile.playingStyle === 'reflector' ? 'expect long maneuvering game' :
                  profile.playingStyle === 'theoretician' ? 'expect deep preparation' :
                  'expect practical, adaptive play'}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary font-bold">2.</span>
              <span>
                Time trouble: {profile.timeManagement.timeTroubleRate > 20 
                  ? `YES (${profile.timeManagement.timeTroubleRate}%) - push for complications after move 30`
                  : `Low risk (${profile.timeManagement.timeTroubleRate}%) - don't rely on time pressure`}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary font-bold">3.</span>
              <span>
                Mental game: {profile.mentalGame.mentalStrength === 'fragile'
                  ? 'Fragile - stay calm when ahead, they may crack'
                  : profile.mentalGame.mentalStrength === 'resilient'
                  ? 'Resilient - stay focused, they fight back well'
                  : 'Steady - expect consistent play throughout'}
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary font-bold">4.</span>
              <span>
                Game length: Avg {profile.gameLength.avgGameLength} moves - 
                {profile.gameLength.prefersEndgame 
                  ? ' comfortable in endgames, consider keeping pieces on'
                  : ' prefers middlegame, consider simplification if ahead'}
              </span>
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
