/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/pages/FindPlayer.tsx
Change-Type:    MODIFIED FILE (full redesign version)
------------------------------------------------------------
WHAT:  Page controller for the redesigned identity-discovery flow. Drives a
       five-phase state machine: discover -> confirm -> deep -> searching ->
       results. Phase A (discover/confirm) does cheap, interactive
       disambiguation against the public US Chess directory; Phase B
       (searching) runs the expensive resolution engine ONLY on a
       human-confirmed anchor.
WHY:   Replaced the single monolithic PlayerSearchForm ("throw a name at the
       engine and hope") with a confirm-first funnel so the engine anchors on
       the right person instead of guessing between namesakes.
DEPENDS-ON:     src/components/findplayer/DiscoveryTabs.tsx,
                src/components/findplayer/ConfirmPanel.tsx,
                src/components/findplayer/NoMatchDiagnosis.tsx,
                src/components/findplayer/SearchExperience.tsx (redesign variant),
                src/lib/identity (resolveIdentity, buildHandoff, writeHandoff).
DEPENDED-ON-BY: React Router route "/find-player" (app entry point for the page).
RESTORE:        Overwrite src/pages/FindPlayer.tsx with the source below (drop
                this banner). Requires all DEPENDS-ON files to be restored to
                src/ first. The pre-redesign version currently live on main is
                the single-form PlayerSearchForm variant.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ArrowLeft, Compass, ScrollText, ShieldCheck, Telescope } from "lucide-react";
import PlayerSearchForm from "@/components/findplayer/PlayerSearchForm";
import SearchExperience from "@/components/findplayer/SearchExperience";
import IdentityResults from "@/components/findplayer/IdentityResults";
import SearchLogDialog from "@/components/findplayer/SearchLogDialog";
import DiscoveryTabs, { type DiscoveryPick, type DiscoveryTab } from "@/components/findplayer/DiscoveryTabs";
import ConfirmPanel from "@/components/findplayer/ConfirmPanel";
import NoMatchDiagnosis from "@/components/findplayer/NoMatchDiagnosis";
import {
  resolveIdentity,
  buildHandoff,
  writeHandoff,
  type DiscoveredAccount,
  type PlayerQuery,
  type ResolutionResult,
  type ResolvedIdentity,
  type SearchEvent,
} from "@/lib/identity";

// The page's stages:
//   discover  — Phase A: search/browse the directory, pick the person
//   confirm   — the picked candidate + expectations + optional clues
//   deep      — the classic free-form detective form (fallback / FIDE-only)
//   searching — Phase B: the engine runs on a (usually) confirmed anchor
//   results   — identities, or the diagnosis of why none were found
type Phase = "discover" | "confirm" | "deep" | "searching" | "results";

// The live feed only ever renders the newest handful of lines, but a long
// traversal emits THOUSANDS of events — keeping them all in state makes every
// append re-render O(n) and eventually freezes the tab. Keep a bounded tail
// and track the tiny bits of derived state (provider status, match flag)
// incrementally instead of re-scanning the whole list each render.
const EVENT_TAIL_KEPT = 200;
const EVENT_TAIL_TRIM_AT = 260;

const FindPlayer = () => {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("discover");
  const [events, setEvents] = useState<SearchEvent[]>([]);
  const [providerStatus, setProviderStatus] = useState<Record<string, "running" | "done">>({});
  const [matched, setMatched] = useState(false);
  const [activeQuery, setActiveQuery] = useState<PlayerQuery | null>(null);
  const [result, setResult] = useState<ResolutionResult | null>(null);
  const [pick, setPick] = useState<DiscoveryPick | null>(null);
  const [discoverTab, setDiscoverTab] = useState<DiscoveryTab>("name");
  const [discoverName, setDiscoverName] = useState("");
  const [deepPrefill, setDeepPrefill] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // The FULL, unabridged log — every event ever emitted, unlike the bounded
  // `events` tail above. Kept in a ref so appending is O(1) and never triggers
  // a re-render; the View Log dialog reads it on demand (and live-refreshes on
  // its own timer while the search runs).
  const fullLogRef = useRef<SearchEvent[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const getFullLog = useCallback(() => fullLogRef.current, []);

  const handleSearch = async (query: PlayerQuery) => {
    setActiveQuery(query);
    setEvents([]);
    setProviderStatus({});
    setMatched(false);
    setResult(null);
    fullLogRef.current = [];
    setPhase("searching");

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // A small floor so the search screen never just flashes; the real work
    // (USCF deep search + tournament-graph traversal) usually runs much longer.
    const minDisplay = new Promise((r) => setTimeout(r, 1200));

    try {
      const [res] = await Promise.all([
        resolveIdentity(query, {
          signal: controller.signal,
          onEvent: (event) => {
            fullLogRef.current.push(event); // full log, never trimmed
            setEvents((prev) =>
              prev.length >= EVENT_TAIL_TRIM_AT ? [...prev.slice(prev.length - EVENT_TAIL_KEPT), event] : [...prev, event]
            );
            if (event.provider) {
              const provider = event.provider;
              setProviderStatus((prev) => {
                const next = event.status === "done" ? "done" : prev[provider] ?? "running";
                return prev[provider] === next ? prev : { ...prev, [provider]: next };
              });
            }
            if (event.message.includes("✔ Match")) setMatched(true);
          },
        }),
        minDisplay,
      ]);
      if (controller.signal.aborted) return;
      setResult(res);
      setPhase("results");
    } catch (err: unknown) {
      if ((err as Error)?.name === "AbortError") return;
      console.error("[find-player] resolution failed:", err);
      toast.error(err instanceof Error ? err.message : "Search failed. Please try again.");
      setPhase("discover");
    }
  };

  const handleGenerate = (identity: ResolvedIdentity, accounts: DiscoveredAccount[]) => {
    const handoff = buildHandoff(identity, accounts);
    if (!handoff) {
      toast.error("No Lichess or Chess.com account selected — those are needed to fetch games.");
      return;
    }
    writeHandoff(handoff);
    toast.success(`Generating scout report for ${identity.name}…`);
    navigate("/scout");
  };

  const backToDiscovery = (tab: DiscoveryTab = "name", name = "") => {
    abortRef.current?.abort();
    setDiscoverTab(tab);
    setDiscoverName(name);
    setPick(null);
    setPhase("discover");
    setEvents([]);
    setProviderStatus({});
    setMatched(false);
    setResult(null);
  };

  const openDeep = (prefill?: string) => {
    abortRef.current?.abort();
    setDeepPrefill(prefill || "");
    setPhase("deep");
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />

      {phase === "searching" && activeQuery && (
        <SearchExperience
          query={activeQuery}
          events={events}
          providerStatus={providerStatus}
          matched={matched}
          onViewLog={() => setLogOpen(true)}
        />
      )}

      <SearchLogDialog open={logOpen} onOpenChange={setLogOpen} getLog={getFullLog} live={phase === "searching"} />

      <main className="flex-1 py-10 sm:py-14">
        <div className="container mx-auto px-4 max-w-3xl">
          {(phase === "discover" || phase === "deep") && (
            <div className="text-center mb-8">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 mb-4">
                <Telescope className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-foreground">Player Discovery</span>
              </div>
              <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
                Find anyone.
                <span className="block text-primary mt-2">Scout everyone.</span>
              </h1>
              <p className="mt-4 text-lg text-muted-foreground max-w-xl mx-auto">
                Start from whatever you know — a name, part of one, the tournament you met them at, or just their state.
                Pick the right person, and ScoutTree traces their real accounts across US Chess, FIDE, Lichess and
                Chess.com.
              </p>
            </div>
          )}

          {phase === "discover" && (
            <>
              <Card className="border-border/70 shadow-xl">
                <CardContent className="p-5 sm:p-8">
                  <DiscoveryTabs
                    key={`${discoverTab}:${discoverName}`}
                    initialTab={discoverTab}
                    initialName={discoverName}
                    onPick={(p) => {
                      setPick(p);
                      setPhase("confirm");
                    }}
                    onDeepSearch={openDeep}
                  />
                </CardContent>
              </Card>

              <div className="mt-8 grid sm:grid-cols-3 gap-4">
                <Highlight
                  icon={<Compass className="w-5 h-5 text-primary" />}
                  title="Start anywhere"
                  body="A partial name, a tournament, a state or an ID — every door leads to the same confirmed match."
                />
                <Highlight
                  icon={<ShieldCheck className="w-5 h-5 text-primary" />}
                  title="You confirm, we trace"
                  body="Pick the person from the real US Chess directory, then the engine anchors on them — no guessing between namesakes."
                />
                <Highlight
                  icon={<ScrollText className="w-5 h-5 text-primary" />}
                  title="Evidence, not guesses"
                  body="Ratings, IDs, states and tournament games all vote on a transparent confidence score."
                />
              </div>
            </>
          )}

          {phase === "confirm" && pick && (
            <ConfirmPanel
              member={pick.member}
              context={pick.context}
              needsEnrich={pick.needsEnrich}
              onBack={() => backToDiscovery(pick.context ? "tournament" : "name", pick.context ? "" : discoverName)}
              onConfirm={handleSearch}
            />
          )}

          {phase === "deep" && (
            <Card className="border-border/70 shadow-xl">
              <CardContent className="p-5 sm:p-8">
                <div className="mb-5 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-foreground">Deep discovery</h2>
                    <p className="text-sm text-muted-foreground">
                      The full detective: give it whatever you know and it works every source. Slower, but it never
                      needs a directory entry.
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => backToDiscovery("name", deepPrefill)}>
                    <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                    Back
                  </Button>
                </div>
                <PlayerSearchForm onSearch={handleSearch} disabled={false} initialName={deepPrefill} />
              </CardContent>
            </Card>
          )}

          {phase === "results" && result && (
            <>
              {result.identities.length > 0 ? (
                <>
                  <div className="mb-4 flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setLogOpen(true)}>
                      <ScrollText className="mr-2 h-3.5 w-3.5" />
                      View search log
                    </Button>
                  </div>
                  <IdentityResults result={result} onGenerate={handleGenerate} onReset={() => backToDiscovery()} />
                </>
              ) : (
                <>
                  <div className="mb-4 flex justify-end">
                    <Button variant="outline" size="sm" onClick={() => setLogOpen(true)}>
                      <ScrollText className="mr-2 h-3.5 w-3.5" />
                      View search log
                    </Button>
                  </div>
                  <NoMatchDiagnosis
                    result={result}
                    onRefine={() => backToDiscovery("name", result.query.name)}
                    onTournament={() => backToDiscovery("tournament")}
                    onDeep={() => openDeep(result.query.name)}
                  />
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
};

function Highlight({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-4">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mb-3">{icon}</div>
      <h3 className="font-semibold text-foreground text-sm">{title}</h3>
      <p className="text-xs text-muted-foreground mt-1">{body}</p>
    </div>
  );
}

export default FindPlayer;
