import { useEffect, useMemo, useRef, useState } from "react";
import { Crown, Check, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlayerQuery, SearchEvent } from "@/lib/identity";

interface SearchExperienceProps {
  query: PlayerQuery;
  events: SearchEvent[];
}

// The orbiting source nodes. `match` decides which provider event lights them up.
const SOURCE_NODES: { key: string; label: string; match: (p?: string) => boolean }[] = [
  { key: "uscf", label: "US Chess", match: (p) => p === "uscf" },
  { key: "fide", label: "FIDE", match: (p) => p === "fide" },
  { key: "lichess", label: "Lichess", match: (p) => p === "lichess" },
  { key: "chesscom", label: "Chess.com", match: (p) => p === "chesscom" },
  { key: "web", label: "Web + AI", match: (p) => p === "ai-web" },
  { key: "events", label: "Tournaments", match: (p) => p === "chessresults" },
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
  "Matching player identities…",
  "Comparing ratings…",
  "Checking tournament pairings…",
  "Searching archived events…",
  "Verifying online accounts…",
  "Building confidence graph…",
  "Almost done…",
];

export function SearchExperience({ query, events }: SearchExperienceProps) {
  const [ambientIdx, setAmbientIdx] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);

  // Cycle ambient headline lines for a continuous "thinking" feel.
  useEffect(() => {
    const t = setInterval(() => setAmbientIdx((i) => (i + 1) % AMBIENT_LINES.length), 1500);
    return () => clearInterval(t);
  }, []);

  // Auto-scroll the live feed to the newest line.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [events]);

  // Per-provider status (running vs done) for lighting up source nodes.
  const providerStatus = useMemo(() => {
    const map = new Map<string, "running" | "done">();
    for (const e of events) {
      if (!e.provider) continue;
      if (e.status === "done") map.set(e.provider, "done");
      else if (!map.has(e.provider)) map.set(e.provider, "running");
    }
    return map;
  }, [events]);

  const doneCount = SOURCE_NODES.filter((n) => {
    for (const [p, s] of providerStatus) if (n.match(p) && s === "done") return true;
    return false;
  }).length;
  const progress = Math.min(96, 12 + (doneCount / SOURCE_NODES.length) * 84);

  const latestRunning = [...events].reverse().find((e) => e.status === "running");
  const headline = latestRunning?.message || AMBIENT_LINES[ambientIdx];
  const recent = events.slice(-7);

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
          ScoutTree is investigating
        </p>
        <h2 className="text-2xl sm:text-3xl font-bold text-foreground min-h-[2.5rem] transition-all">
          {headline}
        </h2>
        <p className="text-muted-foreground mt-2">
          Resolving the identity of <span className="font-medium text-foreground">{query.name}</span>
        </p>

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
          className="mt-6 h-36 overflow-hidden rounded-xl border border-border bg-background/60 p-3 text-left backdrop-blur"
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
      </div>
    </div>
  );
}

export default SearchExperience;
