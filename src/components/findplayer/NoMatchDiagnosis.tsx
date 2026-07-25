import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AtSign, Check, Lightbulb, RotateCcw, School, Search, Telescope, X } from "lucide-react";
import type { ResolutionResult } from "@/lib/identity";

interface NoMatchDiagnosisProps {
  result: ResolutionResult;
  /** The confirmed anchor, when the search ran through the picker flow. */
  anchor?: { name: string; state?: string; rating?: number } | null;
  /** Re-run discovery with a user-supplied partial handle — the single action
   *  with the highest expected information gain after everything else failed. */
  onRetryWithHint?: (hint: string) => void;
  onEnterHandle?: () => void;
  /** Offered when the school route was gated off (minor safety) or never ran. */
  onSchoolSearch?: () => void;
  /** Anchor-only handoff — leave with the identity even without a handle. */
  onSkipToScout?: () => void;
  onReset: () => void;
}

interface CheckedLine {
  ok: boolean;
  text: string;
}

/**
 * Failure that goes somewhere. providerStatus[] and phaseTimings already carry
 * everything needed to say what was tried, what was ruled out, the most likely
 * explanation, and the ONE next step ranked by expected information gain —
 * which is the labor illusion paying off at exactly the moment the user is
 * deciding whether ScoutTree is worth anything.
 */
export function NoMatchDiagnosis({
  result,
  anchor,
  onRetryWithHint,
  onEnterHandle,
  onSchoolSearch,
  onSkipToScout,
  onReset,
}: NoMatchDiagnosisProps) {
  const [hint, setHint] = useState("");

  const name = anchor?.name || result.query.name;
  const subtitle = [anchor?.state, anchor?.rating ? `${anchor.rating} USCF` : null].filter(Boolean).join(", ");

  const { checked, explanation, schoolGated } = useMemo(() => {
    const status = result.providerStatus;
    const byName = (n: string) => status.find((s) => s.name === n);
    const lines: CheckedLine[] = [];

    const graph = byName("uscf-graph");
    const noOnlineHistory = !graph;
    if (graph) {
      const t = result.phaseTimings?.["Tournament-graph traversal"];
      lines.push({
        ok: true,
        text: `Traced their online US Chess events${
          result.partialOpponents ? ` — confirmed ${result.partialOpponents} of their opponents' accounts` : ""
        }${t ? ` (${Math.round(t / 1000)}s of tracing)` : ""}`,
      });
    } else {
      lines.push({ ok: false, text: "No online-rated US Chess events on file — no tournament trail to follow" });
    }

    const google = byName("google");
    if (google) {
      lines.push(
        google.available
          ? { ok: true, text: "Searched the web index across the name's variants" }
          : { ok: false, text: "Web search unavailable this run" }
      );
    }

    const school = byName("school-graph");
    const gated = !!school?.notes?.some((n) => /minor-safety/i.test(n));
    if (school) {
      lines.push(
        gated
          ? { ok: false, text: "School/social tracing skipped (minor-safety gate)" }
          : school.available
            ? { ok: true, text: `Checked the school route${school.notes?.length ? ` — ${school.notes[0]}` : ""}` }
            : { ok: false, text: "School lookup unavailable" }
      );
    }

    for (const p of status.filter((s) => s.name === "lichess" || s.name === "chesscom")) {
      const skipped = p.notes?.some((n) => /^Skipped/i.test(n));
      if (!skipped) lines.push({ ok: p.available, text: `${p.label} name search${p.available ? "" : " unavailable"}` });
    }

    let explanation: string;
    if (noOnlineHistory) {
      explanation =
        "They have no online-rated US Chess history, so the strongest discovery route never existed for them. If they play online at all, it's under a handle nothing public ties to their name.";
    } else if (result.partialOpponents && result.partialOpponents > 0) {
      explanation = `We confirmed ${result.partialOpponents} of their tournament opponents' accounts, but their own games never surfaced — they most likely play on a platform with no public game records (ICC and ChessKid publish none), or under a second account.`;
    } else if (google && !google.available) {
      explanation = "The web-search index was unreachable this run, which removed a whole discovery route — retrying later may genuinely do better.";
    } else if (gated) {
      explanation = "The tournament record alone didn't pin down an account, and school-based tracing stayed off for this scholastic player.";
    } else {
      explanation = "Everything checkable was checked — their account most likely uses a handle unrelated to their name, which no public source ties back to them.";
    }

    return { checked: lines, explanation, schoolGated: gated };
  }, [result]);

  return (
    <Card className="border-border/70 shadow-lg animate-fade-in-up">
      <CardContent className="p-5 sm:p-6 space-y-5">
        <div>
          <h2 className="text-xl font-bold text-foreground">
            No confirmed account for {name}
            {subtitle ? <span className="text-muted-foreground font-medium"> ({subtitle})</span> : null}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            That's a real answer too — here's exactly what we ruled out.
          </p>
        </div>

        {/* --- What we checked --- */}
        <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What we checked</p>
          {checked.map((c, i) => (
            <p key={i} className="flex items-start gap-2 text-sm">
              {c.ok ? (
                <Check className="w-4 h-4 text-confidence-high mt-0.5 shrink-0" />
              ) : (
                <X className="w-4 h-4 text-confidence-low mt-0.5 shrink-0" />
              )}
              <span className="text-foreground/85">{c.text}</span>
            </p>
          ))}
        </div>

        {/* --- Most likely explanation --- */}
        <div className="flex items-start gap-2.5 rounded-xl border border-border bg-background p-4 text-sm">
          <Lightbulb className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <p className="text-foreground/90">
            <span className="font-semibold">Most likely explanation: </span>
            {explanation}
          </p>
        </div>

        {/* --- The one thing that would help most --- */}
        {onRetryWithHint && (
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 space-y-3">
            <p className="text-sm text-foreground/90">
              <span className="font-semibold">What would help most:</span> if you know roughly what their handle looks
              like — even the first few characters — that alone usually cracks it.
            </p>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (hint.trim()) onRetryWithHint(hint.trim());
              }}
            >
              <Input
                placeholder='e.g., "starts with wa…" or "something like knightrider"'
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                className="h-10"
              />
              <Button type="submit" disabled={!hint.trim()} className="h-10 shrink-0">
                <Search className="w-4 h-4 mr-2" />
                Search again
              </Button>
            </form>
          </div>
        )}

        {/* --- Every exit leads somewhere --- */}
        <div className="flex flex-wrap gap-2">
          {onEnterHandle && (
            <Button variant="outline" size="sm" onClick={onEnterHandle}>
              <AtSign className="w-3.5 h-3.5 mr-1.5" />
              Enter a handle directly
            </Button>
          )}
          {schoolGated && onSchoolSearch && (
            <Button variant="outline" size="sm" onClick={onSchoolSearch}>
              <School className="w-3.5 h-3.5 mr-1.5" />
              Enable the school search
            </Button>
          )}
          {onSkipToScout && (
            <Button variant="outline" size="sm" onClick={onSkipToScout}>
              <Telescope className="w-3.5 h-3.5 mr-1.5" />
              Take the confirmed identity to Scout
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onReset}>
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            New search
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default NoMatchDiagnosis;
