/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/components/findplayer/NoMatchDiagnosis.tsx
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  Replaces the generic empty state. Renders what each provider actually
       reported and ranks concrete next steps, with one-click pivots (e.g.
       jump to deep-discovery, widen the search, switch door).
WHY:   Turn "no match" from a dead end into a diagnosis with actionable pivots.
DEPENDS-ON:     src/lib/identity types (provider/result shapes).
DEPENDED-ON-BY: src/pages/FindPlayer.tsx (redesign variant).
RESTORE:        Copy the source below to src/components/findplayer/NoMatchDiagnosis.tsx.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// NoMatchDiagnosis — failure that teaches.
//
// The old empty state gave generic advice. This one reads the result's
// providerStatus (which the engine already fills with per-source notes) and
// renders (a) exactly what was tried and what each source said, and (b) the
// next steps ranked by which stage actually came up empty — with one-click
// pivots back into the discovery flow.
// ============================================================================

import { Button } from "@/components/ui/button";
import { Check, CloudOff, Lightbulb, RotateCcw, Search, Sparkles, Trophy } from "lucide-react";
import type { ResolutionResult } from "@/lib/identity";

interface NoMatchDiagnosisProps {
  result: ResolutionResult;
  /** Back to the discovery search, query name preserved. */
  onRefine: () => void;
  /** Jump straight to the tournament door. */
  onTournament: () => void;
  /** Open the deep-discovery form. */
  onDeep: () => void;
}

const PROVIDER_ORDER = ["uscf", "fide", "chessresults", "ai", "uscf-graph", "google", "school-graph", "lichess", "chesscom"];

export function NoMatchDiagnosis({ result, onRefine, onTournament, onDeep }: NoMatchDiagnosisProps) {
  const byName = new Map(result.providerStatus.map((p) => [p.name, p]));
  const ordered = [
    ...PROVIDER_ORDER.map((n) => byName.get(n)).filter((p): p is NonNullable<typeof p> => !!p),
    ...result.providerStatus.filter((p) => !PROVIDER_ORDER.includes(p.name)),
  ];

  const hadUscfAnchor = !!byName.get("uscf")?.notes?.some((n) => /member match/i.test(n));
  const graphRan = byName.has("uscf-graph");

  // Rank the advice by what actually failed.
  const suggestions: { icon: React.ReactNode; text: string; action?: { label: string; onClick: () => void } }[] = [];
  if (!hadUscfAnchor) {
    suggestions.push({
      icon: <Trophy className="h-4 w-4 text-primary" />,
      text: "We never pinned down who this is in the US Chess directory. If you remember a tournament you both played, find it and pick them straight off the crosstable.",
      action: { label: "Search by tournament", onClick: onTournament },
    });
    suggestions.push({
      icon: <Search className="h-4 w-4 text-primary" />,
      text: "Or refine the name — even a partial surname plus a state narrows the directory fast.",
      action: { label: "Refine the search", onClick: onRefine },
    });
  } else if (!graphRan) {
    suggestions.push({
      icon: <Lightbulb className="h-4 w-4 text-primary" />,
      text: "We found the person, but they have no online-rated US Chess events to trace. A username hint, school or club unlocks the fallback paths.",
      action: { label: "Add clues and retry", onClick: onRefine },
    });
  } else {
    suggestions.push({
      icon: <Lightbulb className="h-4 w-4 text-primary" />,
      text: "Every automated avenue ran dry. A username hint (even “starts with…”) or their school gives the fallbacks something concrete to work with.",
      action: { label: "Add clues and retry", onClick: onRefine },
    });
  }
  suggestions.push({
    icon: <Sparkles className="h-4 w-4 text-primary" />,
    text: "Learn their handle later? Enter it directly and skip discovery entirely.",
    action: { label: "Enter a username", onClick: () => (window.location.href = "/scout") },
  });

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <CloudOff className="h-7 w-7 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-bold text-foreground">No confident match for “{result.query.name}”</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
          Here's exactly what we tried and what would help most.
        </p>
      </div>

      {/* What we tried */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What we tried</p>
        <ul className="space-y-1.5">
          {ordered.map((p) => (
            <li key={p.name} className="flex items-start gap-2 text-sm">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="text-foreground/90">
                <span className="font-medium">{p.label}</span>
                {p.notes?.length ? <span className="text-muted-foreground"> — {p.notes[0]}</span> : p.available ? null : (
                  <span className="text-muted-foreground"> — unavailable</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* What would help */}
      <div className="space-y-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What would help most</p>
        {suggestions.map((s, i) => (
          <div key={i} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-card p-3.5">
            <div className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 shrink-0">{s.icon}</span>
              <p className="text-muted-foreground">{s.text}</p>
            </div>
            {s.action && (
              <Button size="sm" variant="outline" className="shrink-0" onClick={s.action.onClick}>
                {s.action.label}
              </Button>
            )}
          </div>
        ))}
      </div>

      <div className="flex justify-center">
        <Button variant="ghost" size="sm" onClick={onDeep}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Run deep discovery instead
        </Button>
      </div>
    </div>
  );
}

export default NoMatchDiagnosis;
