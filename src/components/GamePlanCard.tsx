import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Target, Swords, TrendingDown, Crown, Lightbulb, BookOpen } from "lucide-react";
import { buildGamePlan, type GamePlanInput } from "@/lib/gamePlan";

interface GamePlanCardProps extends GamePlanInput {
  userRating?: number | null;
  signedIn?: boolean;
}

export function GamePlanCard(props: GamePlanCardProps) {
  const plan = useMemo(() => buildGamePlan(props), [props]);
  const hasContent =
    plan.targetLines.length > 0 ||
    plan.weaknesses.length > 0 ||
    plan.endgameTips.length > 0 ||
    plan.structureTips.length > 0;

  if (!hasContent) return null;

  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Crown className="w-5 h-5 text-primary" />
          Your Game Plan
        </CardTitle>
        <CardDescription>{plan.headline}</CardDescription>
        {props.userRating ? (
          <Badge variant="secondary" className="w-fit mt-1">Tuned to ~{props.userRating}</Badge>
        ) : props.signedIn ? null : (
          <p className="text-xs text-muted-foreground mt-1">
            Add your rating in Settings to tune these suggestions to your level.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {plan.ratingNote && (
          <p className="text-sm text-foreground/90 flex items-start gap-2">
            <Lightbulb className="w-4 h-4 text-yellow-400 mt-0.5 shrink-0" />
            {plan.ratingNote}
          </p>
        )}

        {plan.targetLines.length > 0 && (
          <div>
            <h4 className="font-semibold flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-green-400" />
              Openings to aim for (their worst results)
            </h4>
            <div className="space-y-1.5">
              {plan.targetLines.map((l, i) => (
                <div key={i} className="flex items-center justify-between text-sm bg-muted/30 rounded px-3 py-2">
                  <span className="font-mono">{l.line}</span>
                  <span className="text-muted-foreground">
                    {Math.round(l.winRate * 100)}% over {l.games} games
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {plan.mainLines.length > 0 && (
          <div>
            <h4 className="font-semibold flex items-center gap-2 mb-2">
              <BookOpen className="w-4 h-4 text-primary" />
              Expect their favourites — be ready
            </h4>
            <div className="flex flex-wrap gap-2">
              {plan.mainLines.map((l, i) => (
                <Badge key={i} variant="outline" className="font-mono">
                  {l.line} ({l.games})
                </Badge>
              ))}
            </div>
          </div>
        )}

        {plan.weaknesses.length > 0 && (
          <div>
            <h4 className="font-semibold flex items-center gap-2 mb-2">
              <Swords className="w-4 h-4 text-red-400" />
              Exploit these
            </h4>
            <ul className="space-y-1 text-sm">
              {plan.weaknesses.map((w, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-red-400 mt-0.5">›</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(plan.structureTips.length > 0 || plan.endgameTips.length > 0) && (
          <div>
            <h4 className="font-semibold flex items-center gap-2 mb-2">
              <TrendingDown className="w-4 h-4 text-orange-400" />
              Steer the game here
            </h4>
            <ul className="space-y-1 text-sm">
              {[...plan.structureTips, ...plan.endgameTips].map((t, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-orange-400 mt-0.5">›</span>
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default GamePlanCard;
