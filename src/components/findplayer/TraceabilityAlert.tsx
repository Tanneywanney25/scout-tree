import { Zap, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MemberPreview } from "@/lib/identity";

interface TraceabilityAlertProps {
  preview: MemberPreview;
  className?: string;
}

/**
 * The expectation-setter on the AnchorCard: `hasOnline` (plus the cheap event
 * estimate) is the strongest available predictor of whether the expensive
 * tournament-graph hunt will pay off. Saying so BEFORE the wait is the
 * cheapest anti-abandonment intervention there is — and it lets the user skip
 * runs that were never going to work.
 */
export function TraceabilityAlert({ preview, className }: TraceabilityAlertProps) {
  const member = preview.member;
  if (!member) return null;
  const named = preview.onlineEventsNamed ?? 0;
  const era = preview.pandemicEraEvents ?? 0;

  if (member.hasOnline) {
    const eventLine =
      named > 0
        ? `${named} online-rated US Chess event${named === 1 ? "" : "s"} on file${era > 0 ? ` (plus ${era} from the online era worth checking)` : ""}.`
        : era > 0
          ? `Online US Chess ratings on file, with ${era} event${era === 1 ? "" : "s"} from the online era to check.`
          : "Online US Chess ratings on file.";
    return (
      <div
        className={cn(
          "flex items-start gap-2.5 rounded-xl border border-confidence-high/40 bg-confidence-high/5 p-3.5 text-sm",
          className
        )}
      >
        <Zap className="w-4 h-4 text-confidence-high mt-0.5 shrink-0" />
        <p className="text-foreground/90">
          <span className="font-semibold">Good news: {eventLine}</span>{" "}
          <span className="text-muted-foreground">
            That's the trail we follow to find their account — the strongest kind of match we can make.
          </span>
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-xl border border-confidence-medium/40 bg-confidence-medium/5 p-3.5 text-sm",
        className
      )}
    >
      <Info className="w-4 h-4 text-confidence-medium mt-0.5 shrink-0" />
      <p className="text-foreground/90">
        <span className="font-semibold">Heads up: no online-rated US Chess events on file.</span>{" "}
        <span className="text-muted-foreground">
          We'll fall back to web search and school connections — slower, and less likely to end in a confirmed match.
        </span>
      </p>
    </div>
  );
}

export default TraceabilityAlert;
