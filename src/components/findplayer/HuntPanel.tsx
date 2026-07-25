import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Check, Crown, Loader2, MoveRight, OctagonPause, ScrollText, Search, ShieldCheck } from "lucide-react";
import { ConfidenceBadge } from "./ConfidenceBadge";
import type { DiscoveredAccount, Platform, ProgressSnapshot, SearchEvent } from "@/lib/identity";
import { WorkCounters } from "./WorkCounters";

// The orbiting source nodes — the labor-illusion asset carried over from the
// old full-screen SearchExperience, now inline under the pinned anchor.
const SOURCE_NODES: { key: string; label: string; match: (p?: string) => boolean }[] = [
  { key: "uscf", label: "US Chess", match: (p) => p === "uscf" },
  { key: "fide", label: "FIDE", match: (p) => p === "fide" },
  { key: "lichess", label: "Lichess", match: (p) => p === "lichess" },
  { key: "chesscom", label: "Chess.com", match: (p) => p === "chesscom" },
  { key: "web", label: "Web + AI", match: (p) => p === "google" },
  { key: "graph", label: "Opponent trace", match: (p) => p === "uscf-graph" },
];

const AMBIENT_LINES = [
  "Reading their tournament crosstables…",
  "Tracing opponents' online accounts…",
  "Matching games by date and colour…",
  "Following the tournament graph…",
  "Cross-referencing the open web…",
  "Verifying online accounts…",
];

/** Plain-English phase label from provider activity. */
function phaseLabel(providerStatus: Map<string, "running" | "done">, events: SearchEvent[], matched: boolean): string {
  if (matched) return "Match found — assembling the profile";
  const active = (p: string) => providerStatus.has(p) || events.some((e) => e.provider === p);
  if (active("school-graph")) return "Tracing their schoolmates";
  if (active("uscf-graph")) return "Reading their tournament crosstables";
  if (active("google")) return "Searching the open web";
  return "Looking up who they are";
}

const PLATFORM_LABEL: Record<Platform, string> = {
  lichess: "Lichess",
  chesscom: "Chess.com",
  chesskid: "ChessKid",
  icc: "ICC",
  other: "Other",
};

interface HuntPanelProps {
  targetName: string;
  /** Bounded tail of the live feed (the parent trims it). */
  events: SearchEvent[];
  providerStatus?: Record<string, "running" | "done">;
  matched?: boolean;
  progress: ProgressSnapshot | null;
  /** Accounts streamed in by the resolver's onAccount — rendered as they land. */
  foundAccounts: DiscoveredAccount[];
  onViewLog?: () => void;
  /** SOFT stop: stand the engines down, keep everything found. */
  onStopKeep: () => void;
  /** Let the hunt continue while the user goes elsewhere. */
  onBackground?: () => void;
  /** True once a soft stop was requested (buttons disable, label changes). */
  stopping?: boolean;
}

/**
 * The hunt, inline — replaces the full-screen SearchExperience overlay. The
 * confirmed anchor stays pinned above; results stream in as they're found;
 * progress is COMPLETED work only (accumulating counters, no fake eased
 * percentage, no ETA); and the wait is never a hostage situation: background
 * it or stop-and-keep at any time.
 */
export function HuntPanel({
  targetName,
  events,
  providerStatus: providerStatusProp,
  matched: matchedProp,
  progress,
  foundAccounts,
  onViewLog,
  onStopKeep,
  onBackground,
  stopping,
}: HuntPanelProps) {
  const [ambientIdx, setAmbientIdx] = useState(0);
  const [now, setNow] = useState(Date.now());
  const startRef = useRef(Date.now());
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setInterval(() => setAmbientIdx((i) => (i + 1) % AMBIENT_LINES.length), 2200);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  const providerStatus = useMemo(() => {
    const map = new Map<string, "running" | "done">();
    if (providerStatusProp) for (const [p, s] of Object.entries(providerStatusProp)) map.set(p, s);
    else
      for (const e of events) {
        if (!e.provider) continue;
        if (e.status === "done") map.set(e.provider, "done");
        else if (!map.has(e.provider)) map.set(e.provider, "running");
      }
    return map;
  }, [providerStatusProp, events]);

  const matched = matchedProp ?? events.some((e) => /✔ Match/.test(e.message));
  const latestRunning = [...events].reverse().find((e) => e.status === "running");
  const headline = latestRunning?.message || AMBIENT_LINES[ambientIdx];
  const recent = events.slice(-7);
  const elapsed = Math.max(0, Math.floor((now - startRef.current) / 1000));
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <Card className="border-border/70 shadow-lg overflow-hidden animate-fade-in-up">
      <CardContent className="p-5 sm:p-6 space-y-5">
        {/* --- Phase + clock --- */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">{phaseLabel(providerStatus, events, matched)}</p>
          <span className="text-sm tabular-nums text-muted-foreground">{clock}</span>
        </div>

        {/* --- Indeterminate bar: honest motion, no fake percentage --- */}
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full w-full animate-gradient-pan rounded-full"
            style={{
              background:
                "linear-gradient(90deg, hsl(var(--primary) / 0.15), hsl(var(--primary)) 40%, hsl(var(--primary) / 0.15) 80%)",
              backgroundSize: "200% 100%",
            }}
          />
        </div>

        <div className="flex flex-col sm:flex-row gap-5">
          {/* --- The scanner (compact) --- */}
          <div className="relative mx-auto sm:mx-0 h-44 w-44 shrink-0">
            {[0, 1].map((i) => (
              <span
                key={i}
                className="absolute inset-0 rounded-full border border-primary/40 animate-pulse-ring"
                style={{ animationDelay: `${i * 1.1}s` }}
              />
            ))}
            <div
              className="absolute inset-3 rounded-full animate-spin-slow"
              style={{
                background: "conic-gradient(from 0deg, transparent, hsl(var(--primary) / 0.35), transparent 55%)",
                mask: "radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))",
                WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 5px), #000 calc(100% - 4px))",
              }}
            />
            {SOURCE_NODES.map((node, i) => {
              const angle = (i / SOURCE_NODES.length) * Math.PI * 2 - Math.PI / 2;
              const x = Math.cos(angle) * 82;
              const y = Math.sin(angle) * 82;
              let status: "idle" | "running" | "done" = "idle";
              for (const [p, s] of providerStatus) if (node.match(p)) status = s;
              return (
                <div
                  key={node.key}
                  className="absolute left-1/2 top-1/2"
                  style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}
                >
                  <div
                    className={cn(
                      "flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium whitespace-nowrap transition-all duration-500 backdrop-blur",
                      status === "done"
                        ? "border-primary/40 bg-primary/15 text-primary"
                        : status === "running"
                          ? "border-primary/30 bg-background/80 text-foreground"
                          : "border-border bg-background/60 text-muted-foreground"
                    )}
                  >
                    {status === "done" ? (
                      <Check className="w-2.5 h-2.5" />
                    ) : status === "running" ? (
                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                    ) : (
                      <span className="w-1 h-1 rounded-full bg-current opacity-50" />
                    )}
                    {node.label}
                  </div>
                </div>
              );
            })}
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg animate-float">
                <Crown className="h-6 w-6" />
              </div>
            </div>
          </div>

          {/* --- Headline + counters + feed --- */}
          <div className="min-w-0 flex-1 space-y-3">
            <p className="text-base font-semibold text-foreground leading-snug min-h-[2.5rem]">{headline}</p>
            <WorkCounters progress={progress} />
            <div
              ref={feedRef}
              className="h-32 overflow-hidden rounded-xl border border-border bg-background/60 p-2.5 text-left"
            >
              <div className="space-y-1">
                {recent.map((e) => (
                  <div key={e.id} className="flex items-start gap-1.5 text-xs animate-fade-in">
                    <span className="mt-0.5 shrink-0">
                      {e.status === "done" ? (
                        <Check className="w-3 h-3 text-confidence-high" />
                      ) : e.status === "running" ? (
                        <Loader2 className="w-3 h-3 text-primary animate-spin" />
                      ) : (
                        <Search className="w-3 h-3 text-muted-foreground" />
                      )}
                    </span>
                    <span className={cn("leading-snug", e.status === "done" ? "text-muted-foreground" : "text-foreground/90")}>
                      {e.message}
                    </span>
                  </div>
                ))}
                {recent.length === 0 && (
                  <p className="text-xs text-muted-foreground">Warming up the search for {targetName}…</p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* --- Found so far: results stream in live --- */}
        {foundAccounts.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Found so far</p>
            <div className="space-y-2">
              {foundAccounts.map((a) => {
                const namesake = a.evidence?.some((e) => /namesake/i.test(e.label));
                return (
                  <div
                    key={a.platform + a.username}
                    className="flex items-center justify-between gap-3 rounded-xl border border-confidence-high/30 bg-confidence-high/5 px-3.5 py-2.5 animate-fade-in"
                  >
                    <span className="flex items-center gap-2 min-w-0 text-sm">
                      {!namesake && <ShieldCheck className="w-4 h-4 text-confidence-high shrink-0" />}
                      <span className="font-semibold text-foreground truncate">@{a.username}</span>
                      <span className="text-muted-foreground shrink-0">
                        {PLATFORM_LABEL[a.platform]}
                        {a.rating ? ` · ${a.rating}` : ""}
                      </span>
                    </span>
                    <ConfidenceBadge value={a.confidence} size="sm" />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* --- Controls: the wait is never a hostage situation --- */}
        <div className="flex flex-col sm:flex-row items-center gap-3 pt-1">
          {onBackground && (
            <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onBackground} disabled={stopping}>
              <MoveRight className="w-4 h-4 mr-2" />
              Keep searching in background
            </Button>
          )}
          <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={onStopKeep} disabled={stopping}>
            <OctagonPause className="w-4 h-4 mr-2" />
            {stopping ? "Stopping — keeping results…" : "Stop and keep what you found"}
          </Button>
          {onViewLog && (
            <button
              type="button"
              onClick={onViewLog}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors sm:ml-auto"
            >
              <ScrollText className="h-3.5 w-3.5" />
              View full log
            </button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default HuntPanel;
