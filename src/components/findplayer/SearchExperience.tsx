import { useEffect, useMemo, useRef, useState } from "react";
import { Crown, Check, Loader2, ScrollText, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlayerQuery, SearchEvent } from "@/lib/identity";

interface SearchExperienceProps {
  query: PlayerQuery;
  /** Bounded tail of the live feed (the parent trims it — long traversals emit
   *  thousands of lines and an unbounded list freezes the tab). */
  events: SearchEvent[];
  /** Per-provider status, maintained incrementally by the parent. */
  providerStatus?: Record<string, "running" | "done">;
  /** Sticky "a match was found" flag (a match line may leave the bounded tail). */
  matched?: boolean;
  /** Opens the full, unabridged search log (every step, not just the tail). */
  onViewLog?: () => void;
}

// The orbiting source nodes. `match` decides which provider event lights them up.
const SOURCE_NODES: { key: string; label: string; match: (p?: string) => boolean }[] = [
  { key: "uscf", label: "US Chess", match: (p) => p === "uscf" },
  { key: "fide", label: "FIDE", match: (p) => p === "fide" },
  { key: "lichess", label: "Lichess", match: (p) => p === "lichess" },
  { key: "chesscom", label: "Chess.com", match: (p) => p === "chesscom" },
  { key: "web", label: "Web + AI", match: (p) => p === "google" },
  { key: "graph", label: "Opponent trace", match: (p) => p === "uscf-graph" },
];

// Ambient flavour lines that keep the headline alive between real events.
const AMBIENT_LINES = [
  "Searching US Chess…",
  "Searching FIDE…",
  "Searching Chess.com…",
  "Searching Lichess…",
  "Cross-referencing the open web…",
  "Finding tournament history…",
  "Looking for online-rated events…",
  "Reading tournament crosstables…",
  "Tracing opponents' online accounts…",
  "Matching games by date and colour…",
  "Following the tournament graph…",
  "Comparing ratings…",
  "Verifying online accounts…",
  "Building confidence graph…",
];

export function SearchExperience({ query, events, providerStatus: providerStatusProp, matched: matchedProp, onViewLog }: SearchExperienceProps) {
  const [ambientIdx, setAmbientIdx] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const startRef = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  // Cycle ambient headline lines for a continuous "thinking" feel.
  useEffect(() => {
    const t = setInterval(() => setAmbientIdx((i) => (i + 1) % AMBIENT_LINES.length), 1800);
    return () => clearInterval(t);
  }, []);

  // A ticking clock so the progress bar fills smoothly over the (long) search.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 400);
    return () => clearInterval(t);
  }, []);

  // Auto-scroll the live feed to the newest line.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  // Per-provider status (running vs done) for lighting up source nodes —
  // provided incrementally by the parent; the fallback scan only runs when the
  // component is used standalone with a full event list.
  const providerStatus = useMemo(() => {
    const map = new Map<string, "running" | "done">();
    if (providerStatusProp) {
      for (const [p, s] of Object.entries(providerStatusProp)) map.set(p, s);
      return map;
    }
    for (const e of events) {
      if (!e.provider) continue;
      if (e.status === "done") map.set(e.provider, "done");
      else if (!map.has(e.provider)) map.set(e.provider, "running");
    }
    return map;
  }, [providerStatusProp, events]);

  const doneCount = SOURCE_NODES.filter((n) => {
    for (const [p, s] of providerStatus) if (n.match(p) && s === "done") return true;
    return false;
  }).length;

  // The tournament-graph traversal is the long pole (it runs until exhausted),
  // so drive progress primarily off elapsed time — an eased curve that fills
  // slowly and never jumps to 100% — with a small floor from completed sources.
  const graphActive = providerStatus.has("uscf-graph") || events.some((e) => e.provider === "uscf-graph");
  const schoolActive = providerStatus.has("school-graph") || events.some((e) => e.provider === "school-graph");
  const matched = matchedProp ?? events.some((e) => /✔ Match/.test(e.message));
  const elapsed = now - startRef.current;
  const timeFill = 96 * (1 - Math.exp(-elapsed / 55_000));
  const milestoneFloor = Math.min(32, (doneCount / SOURCE_NODES.length) * 32);
  const progress = matched ? 99 : Math.min(97, Math.max(milestoneFloor, timeFill));

  // The school phase runs long and quiet; the conductor's heartbeat (and the
  // resolver's own lines) carry "N of M schoolmates" — surface the latest as an
  // explicit readout so the user always sees forward motion, not a frozen line.
  const schoolProgress = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const m = events[i].message.match(/(\d+)\s+of\s+(\d+)\s+schoolmates/i);
      if (m) return { resolved: Number(m[1]), total: Number(m[2]) };
    }
    return null;
  }, [events]);

  const latestRunning = [...events].reverse().find((e) => e.status === "running");
  const headline = latestRunning?.message || AMBIENT_LINES[ambientIdx];
  const recent = events.slice(-8);
  const phaseLabel = matched
    ? "Match found — assembling the profile"
    : schoolActive
      ? "Tracing schoolmates"
      : graphActive
        ? "Tracing tournament opponents"
        : "Investigating";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-background/95 backdrop-blur-xl">
      {/* Animated gradient backdrop */}
      <div
        className="absolute inset-0 -z-10 opacity-70"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 35%, hsl(var(--primary) / 0.18), transparent 70%), radial-gradient(40% 40% at 80% 80%, hsl(var(--primary) / 0.10), transparent 70%)",
        }}
      />

      <div className="w-full max-w-xl px-6 text-center">
        {/* --- The scanner --- */}
        <div className="relative mx-auto mb-10 h-64 w-64">
          {/* Pulse rings */}
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="absolute inset-0 rounded-full border border-primary/40 animate-pulse-ring"
              style={{ animationDelay: `${i * 0.8}s` }}
            />
          ))}
          {/* Rotating conic ring */}
          <div
            className="absolute inset-4 rounded-full animate-spin-slow"
            style={{
              background: "conic-gradient(from 0deg, transparent, hsl(var(--primary) / 0.35), transparent 55%)",
              mask: "radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px))",
              WebkitMask: "radial-gradient(farthest-side, transparent calc(100% - 6px), #000 calc(100% - 5px))",
            }}
          />
          {/* Source nodes around the ring */}
          {SOURCE_NODES.map((node, i) => {
            const angle = (i / SOURCE_NODES.length) * Math.PI * 2 - Math.PI / 2;
            const radius = 118;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
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
                    "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-all duration-500 backdrop-blur",
                    status === "done"
                      ? "border-primary/40 bg-primary/15 text-primary shadow-[0_0_18px_-4px_hsl(var(--primary))]"
                      : status === "running"
                        ? "border-primary/30 bg-background/80 text-foreground"
                        : "border-border bg-background/60 text-muted-foreground"
                  )}
                >
                  {status === "done" ? (
                    <Check className="w-3 h-3" />
                  ) : status === "running" ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-current opacity-50" />
                  )}
                  {node.label}
                </div>
              </div>
            );
          })}
          {/* Center */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-xl animate-float">
              <Crown className="h-9 w-9" />
            </div>
          </div>
        </div>

        {/* --- Headline --- */}
        <p className="text-xs uppercase tracking-widest text-primary/80 font-semibold mb-2">
          ScoutTree · {phaseLabel}
        </p>
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground min-h-[2.5rem] transition-all">
          {headline}
        </h2>
        <p className="text-muted-foreground mt-2">
          Resolving the identity of <span className="font-medium text-foreground">{query.name}</span>
        </p>

        {/* --- School-phase progress readout (the long, quiet phase) --- */}
        {schoolActive && !matched && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {schoolProgress
              ? `Resolving schoolmates… ${schoolProgress.resolved} of ${schoolProgress.total} resolved`
              : "Resolving schoolmates…"}
          </div>
        )}

        {/* --- Progress --- */}
        <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-primary-light transition-all duration-700"
            style={{ width: `${progress}%` }}
          />
        </div>

        {/* --- Live reasoning feed --- */}
        <div
          ref={feedRef}
          className="mt-6 h-44 overflow-hidden rounded-xl border border-border bg-background/60 p-3 text-left backdrop-blur"
        >
          <div className="space-y-1.5">
            {recent.map((e) => (
              <div key={e.id} className="flex items-start gap-2 text-sm animate-fade-in">
                <span className="mt-0.5 shrink-0">
                  {e.status === "done" ? (
                    <Check className="w-3.5 h-3.5 text-confidence-high" />
                  ) : e.status === "running" ? (
                    <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
                  ) : (
                    <Search className="w-3.5 h-3.5 text-muted-foreground" />
                  )}
                </span>
                <span className={cn("leading-snug", e.status === "done" ? "text-muted-foreground" : "text-foreground")}>
                  {e.message}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* --- Full log access: the feed above only shows the newest lines --- */}
        {onViewLog && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              onClick={onViewLog}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur transition-colors hover:text-foreground hover:border-primary/40"
            >
              <ScrollText className="h-3.5 w-3.5" />
              View full log
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default SearchExperience;
