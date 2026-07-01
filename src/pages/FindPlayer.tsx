import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { Search, Sparkles, Telescope } from "lucide-react";
import PlayerSearchForm from "@/components/findplayer/PlayerSearchForm";
import SearchExperience from "@/components/findplayer/SearchExperience";
import IdentityResults from "@/components/findplayer/IdentityResults";
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

type Phase = "input" | "searching" | "results";

const FindPlayer = () => {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("input");
  const [events, setEvents] = useState<SearchEvent[]>([]);
  const [activeQuery, setActiveQuery] = useState<PlayerQuery | null>(null);
  const [result, setResult] = useState<ResolutionResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleSearch = async (query: PlayerQuery) => {
    setActiveQuery(query);
    setEvents([]);
    setResult(null);
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
          onEvent: (event) => setEvents((prev) => [...prev, event]),
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
      setPhase("input");
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

  const handleReset = () => {
    abortRef.current?.abort();
    setPhase("input");
    setEvents([]);
    setResult(null);
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />

      {phase === "searching" && activeQuery && <SearchExperience query={activeQuery} events={events} />}

      <main className="flex-1 py-10 sm:py-14">
        <div className="container mx-auto px-4 max-w-3xl">
          {phase !== "results" && (
            <div className="text-center mb-8">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20 mb-4">
                <Telescope className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium text-foreground">AI Opponent Discovery</span>
              </div>
              <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-foreground">
                Find anyone.
                <span className="block text-primary mt-2">Scout everyone.</span>
              </h1>
              <p className="mt-4 text-lg text-muted-foreground max-w-xl mx-auto">
                You don't need a username. Tell ScoutTree whatever you know and our AI detective discovers their real
                identity and online accounts across US Chess, FIDE, Lichess and Chess.com.
              </p>
            </div>
          )}

          {phase === "input" && (
            <Card className="border-border/70 shadow-xl">
              <CardContent className="p-5 sm:p-8">
                <PlayerSearchForm onSearch={handleSearch} disabled={false} />
              </CardContent>
            </Card>
          )}

          {phase === "input" && (
            <div className="mt-8 grid sm:grid-cols-3 gap-4">
              <Highlight
                icon={<Search className="w-5 h-5 text-primary" />}
                title="The less you know"
                body="A name is all it takes. Every extra clue sharpens the match."
              />
              <Highlight
                icon={<Sparkles className="w-5 h-5 text-primary" />}
                title="Evidence, not guesses"
                body="Ratings, IDs, states and tournaments all vote on a confidence score."
              />
              <Highlight
                icon={<Telescope className="w-5 h-5 text-primary" />}
                title="One click to scout"
                body="Confirm the identity and jump straight into a full scout report."
              />
            </div>
          )}

          {phase === "results" && result && (
            <IdentityResults result={result} onGenerate={handleGenerate} onReset={handleReset} />
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
