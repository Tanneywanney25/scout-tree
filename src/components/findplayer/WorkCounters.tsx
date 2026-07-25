import { cn } from "@/lib/utils";
import type { ProgressSnapshot } from "@/lib/identity";

interface WorkCountersProps {
  progress: ProgressSnapshot | null;
  className?: string;
}

/**
 * Monotonic COMPLETED-work counters — deliberately no denominators on the
 * slow phases. "Traced 3 events · Checked 41 handles" recruits the labor
 * illusion (visible effort reads as value); "3 of 47" is the honest number
 * that tells the user this will take forever and drives abandonment. The one
 * denominator shown is the schoolmate roster, where forward motion through a
 * known list reads as progress, not as bad news.
 */
export function WorkCounters({ progress, className }: WorkCountersProps) {
  if (!progress) return null;
  const parts: string[] = [];
  if (progress.eventsTraced > 0) parts.push(`Traced ${progress.eventsTraced} event${progress.eventsTraced === 1 ? "" : "s"}`);
  if (progress.playersMapped > 0) parts.push(`Mapped ${progress.playersMapped} player${progress.playersMapped === 1 ? "" : "s"}`);
  if (progress.handlesChecked > 0) parts.push(`Checked ${progress.handlesChecked} handle${progress.handlesChecked === 1 ? "" : "s"}`);
  if (progress.matesTotal > 0) parts.push(`Resolved ${progress.matesResolved} of ${progress.matesTotal} schoolmates`);
  if (parts.length === 0) return null;
  return (
    <p className={cn("text-sm font-medium text-foreground/80 tabular-nums", className)}>
      {parts.join(" · ")}
    </p>
  );
}

export default WorkCounters;
