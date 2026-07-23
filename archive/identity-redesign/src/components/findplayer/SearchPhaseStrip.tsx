/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/components/findplayer/SearchPhaseStrip.tsx
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  Projects the engine's provider events into a live phase map
       (anchor -> trace -> web -> school -> name search), showing where the
       search is and what remains.
WHY:   Make the long Phase-B traversal legible at a glance.
DEPENDS-ON:     providerStatus map shape emitted by the resolver.
DEPENDED-ON-BY: src/components/findplayer/SearchExperience.tsx (redesign variant).
RESTORE:        Copy the source below to src/components/findplayer/SearchPhaseStrip.tsx.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// SearchPhaseStrip — "where are we, and what's left?" during the long search.
//
// A pure projection of the provider names the engine already emits into the
// event stream; no engine changes. Phases the engine skips (because an earlier
// one succeeded) simply never light up — the strip shows the plan, the pulse
// shows the position.
// ============================================================================

import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface SearchPhaseStripProps {
  /** Per-provider status, as maintained by the FindPlayer page. */
  providerStatus: Record<string, "running" | "done">;
}

// Ordered to match the engine's actual ladder (resolver.ts): anchor → trace →
// web index → school graph → name search. Each phase lights when any of its
// providers reports.
const PHASES: { label: string; providers: string[] }[] = [
  { label: "Anchor", providers: ["uscf", "fide", "ai", "chessresults"] },
  { label: "Tournament trace", providers: ["uscf-graph"] },
  { label: "Web index", providers: ["google"] },
  { label: "School graph", providers: ["school-graph"] },
  { label: "Name search", providers: ["lichess", "chesscom"] },
];

export function SearchPhaseStrip({ providerStatus }: SearchPhaseStripProps) {
  const statusOf = (providers: string[]): "idle" | "running" | "done" => {
    let st: "idle" | "running" | "done" = "idle";
    for (const p of providers) {
      const s = providerStatus[p];
      if (s === "running") return "running";
      if (s === "done") st = "done";
    }
    return st;
  };

  return (
    <div className="mt-4 flex flex-wrap items-center justify-center gap-x-1 gap-y-1.5">
      {PHASES.map((phase, i) => {
        const st = statusOf(phase.providers);
        return (
          <span key={phase.label} className="inline-flex items-center gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors",
                st === "done" && "bg-primary/15 text-primary",
                st === "running" && "bg-background/80 text-foreground ring-1 ring-primary/30",
                st === "idle" && "text-muted-foreground/70"
              )}
            >
              {st === "done" ? (
                <Check className="h-2.5 w-2.5" />
              ) : st === "running" ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : null}
              {phase.label}
            </span>
            {i < PHASES.length - 1 && <span className="text-[10px] text-muted-foreground/50">→</span>}
          </span>
        );
      })}
    </div>
  );
}

export default SearchPhaseStrip;
