import { cn } from "@/lib/utils";
import type { Evidence } from "@/lib/identity";

interface EvidenceLedgerProps {
  evidence: Pick<Evidence, "label" | "weight">[];
  /** Max rows rendered (strongest first). */
  limit?: number;
  className?: string;
}

/**
 * Weighted evidence bars with MAGNITUDE. The old chip cloud showed direction
 * only, which flattened a 4.0 FIDE-ID match and a 1.0 state match into two
 * chips that looked the same. Here every clue gets a bar proportional to
 * |weight| — green positive, red negative, sorted strongest first — so the
 * user can see at a glance WHAT the number is made of.
 */
export function EvidenceLedger({ evidence, limit = 8, className }: EvidenceLedgerProps) {
  const rows = [...evidence]
    .filter((e) => e.label && Math.abs(e.weight) > 0.001)
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, limit);
  if (rows.length === 0) return null;
  const maxAbs = Math.max(...rows.map((e) => Math.abs(e.weight)), 0.5);

  return (
    <div className={cn("space-y-1.5", className)}>
      {rows.map((e, i) => {
        const positive = e.weight >= 0;
        const pct = Math.max(6, (Math.abs(e.weight) / maxAbs) * 100);
        return (
          <div key={i} className="grid grid-cols-[72px_1fr_auto] items-center gap-2 text-xs">
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full", positive ? "bg-confidence-high" : "bg-confidence-low")}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-foreground/85 leading-snug min-w-0">{e.label}</span>
            <span
              className={cn(
                "font-semibold tabular-nums shrink-0",
                positive ? "text-confidence-high" : "text-confidence-low"
              )}
            >
              {positive ? "+" : "−"}
              {Math.abs(e.weight).toFixed(1)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default EvidenceLedger;
