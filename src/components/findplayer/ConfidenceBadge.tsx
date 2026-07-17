import { cn } from "@/lib/utils";
import { confidenceLevel, confidencePercent } from "@/lib/identity";

interface ConfidenceBadgeProps {
  /** 0..1 confidence. */
  value: number;
  size?: "sm" | "md";
  showBar?: boolean;
  className?: string;
}

const LEVEL_STYLES: Record<string, string> = {
  high: "bg-confidence-high/15 text-confidence-high border-confidence-high/30",
  medium: "bg-confidence-medium/15 text-confidence-medium border-confidence-medium/30",
  low: "bg-confidence-low/15 text-confidence-low border-confidence-low/30",
};

const LEVEL_LABEL: Record<string, string> = {
  high: "High confidence",
  medium: "Possible match",
  low: "Low confidence",
};

/** A colour-coded confidence pill, optionally with a thin progress bar. */
export function ConfidenceBadge({ value, size = "md", showBar = false, className }: ConfidenceBadgeProps) {
  const level = confidenceLevel(value);
  const pct = confidencePercent(value);
  return (
    <div className={cn("inline-flex flex-col gap-1", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border font-semibold",
          LEVEL_STYLES[level],
          size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-sm"
        )}
      >
        <span className={cn("rounded-full", size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2")} style={{ backgroundColor: "currentColor" }} />
        {pct}% · {LEVEL_LABEL[level]}
      </span>
      {showBar && (
        <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${pct}%`,
              backgroundColor: `hsl(var(--confidence-${level}))`,
            }}
          />
        </div>
      )}
    </div>
  );
}

export default ConfidenceBadge;
