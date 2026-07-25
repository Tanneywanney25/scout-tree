import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { CalendarClock, ScrollText, Search, Sparkles, Telescope, Trophy } from "lucide-react";
import PlayerSearchForm from "@/components/findplayer/PlayerSearchForm";
import IdentityResults from "@/components/findplayer/IdentityResults";
import SearchLogDialog from "@/components/findplayer/SearchLogDialog";
import EntryModeTabs, { type EntryMode } from "@/components/findplayer/EntryModeTabs";
import UscfMemberPicker from "@/components/findplayer/UscfMemberPicker";
import AnchorCard, { AnchorPin, EMPTY_CLUES, looksLikeMinor, type AnchorClues } from "@/components/findplayer/AnchorCard";
import HandleEntry from "@/components/findplayer/HandleEntry";
import HuntPanel from "@/components/findplayer/HuntPanel";
import NoMatchDiagnosis from "@/components/findplayer/NoMatchDiagnosis";
import {
  buildHandoff,
  buildAnchorHandoff,
  buildCachedHandleHandoff,
  buildDirectHandleHandoff,
  fetchMemberPreview,
  writeHandoff,
  type AnchorHandoffInput,
  type CachedResolvedHandle,
  type DiscoveredAccount,
  type FidePlayerHit,
  type MemberPreview,
  type MemberSearchHit,
  type Platform,
  type PlayerQuery,
  type ResolvedIdentity,
} from "@/lib/identity";
import {
  clearHunt,
  getHuntFullLog,
  getHuntState,
  setHuntBackgrounded,
  softStopHunt,
  startDiscovery,
  startLegacySearch,
  subscribeHunt,
} from "@/lib/identity/huntStore";

function anchorInput(m: MemberSearchHit): AnchorHandoffInput {
  return {
    name: m.name,
    uscfId: m.uscfId,
    state: m.state,
    fideId: m.fideId,
    estimatedRating: m.rating ?? m.ratings.regular ?? m.ratings.onlineRegular,
    title: m.title,
  };
}

function cluesToQuery(clues: AnchorClues) {
  const clean = (s: string) => (s.trim() ? s.trim() : undefined);
  const rating = parseInt(clues.approxRating, 10);
  return {
    approxRating: Number.isFinite(rating) ? rating : undefined,
    club: clean(clues.club),
    school: clean(clues.school),
    ageOrGrade: clean(clues.ageOrGrade),
    usernameHint: clean(clues.usernameHint),
    additionalDetails: clean(clues.additionalDetails),
  };
}

const FindPlayer = () => {
  const navigate = useNavigate();
  // The hunt lives in a module-level store so it SURVIVES navigation — this
  // page is just a subscriber. Returning here re-attaches to a running hunt.
  const hunt = useSyncExternalStore(subscribeHunt, getHuntState);

  const [mode, setMode] = useState<EntryMode>("person");
  const [member, setMember] = useState<MemberSearchHit | null>(null);
  const [preview, setPreview] = useState<MemberPreview | null>(null);
  const [clues, setClues] = useState<AnchorClues>(EMPTY_CLUES);
  const [socialOverride, setSocialOverride] = useState(false);
  /** Non-null → the legacy free-text detective form is open, prefilled. */
  const [legacyName, setLegacyName] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  // Coming back to the page (e.g. via the background banner) un-backgrounds.
  useEffect(() => {
    setHuntBackgrounded(false);
  }, []);

  // The AnchorCard renders instantly from the search hit; the preview (rating
  // detail, traceability, opt-out, cached handles) fills in ~1-2s later.
  useEffect(() => {
    if (!member) {
      setPreview(null);
      return;
    }
    let alive = true;
    fetchMemberPreview(member.uscfId).then((p) => {
      if (!alive) return;
      // If the preview call failed, synthesize one from the search hit so the
      // traceability verdict (driven by hasOnline) still renders.
      setPreview(p.available ? p : { available: true, member });
    });
    return () => {
      alive = false;
    };
  }, [member]);

  useEffect(() => {
    if (hunt.phase === "done" && hunt.error) toast.error(hunt.error);
  }, [hunt.phase, hunt.error]);

  const resetAll = () => {
    clearHunt();
    setMember(null);
    setPreview(null);
    setClues(EMPTY_CLUES);
    setSocialOverride(false);
    setLegacyName(null);
  };

  // --- Actions -------------------------------------------------------------

  const handleConfirmAnchor = () => {
    if (!member) return;
    const minor = looksLikeMinor(clues);
    startDiscovery(member, {
      clues: cluesToQuery(clues),
      allowSocial: minor ? socialOverride : true,
    });
  };

  const handleUseCachedHandle = (handle: CachedResolvedHandle) => {
    if (!member) return;
    const handoff = buildCachedHandleHandoff(anchorInput(member), {
      platform: handle.platform,
      username: handle.username,
      confidence: handle.confidence,
    });
    if (!handoff) return;
    writeHandoff(handoff);
    toast.success(`Scouting @${handle.username} from the previous confirmation…`);
    navigate("/scout");
  };

  const handleSkipToScout = () => {
    const m = member ?? hunt.anchor;
    if (!m) return;
    writeHandoff(buildAnchorHandoff(anchorInput(m)));
    toast.success(`Taking ${m.name}'s confirmed identity to the scout page.`);
    navigate("/scout");
  };

  const handleDirectHandle = (platform: Platform, username: string) => {
    writeHandoff(buildDirectHandleHandoff(platform, username));
    navigate("/scout");
  };

  const handleLegacySearch = (query: PlayerQuery) => {
    setLegacyName(null);
    startLegacySearch(query);
  };

  const handleFideSelect = (hit: FidePlayerHit) => {
    // A FIDE-only player has no USCF trail — run the combined pipeline with
    // the FIDE ID pinned (it anchors platform-profile matches decisively).
    startLegacySearch({ name: hit.name, fideId: hit.fideId, federation: "FIDE" });
  };

  const handleRetryWithHint = (hint: string) => {
    const nextClues = { ...clues, usernameHint: hint };
    setClues(nextClues);
    if (hunt.kind === "discovery" && hunt.anchor) {
      const minor = looksLikeMinor(nextClues);
      startDiscovery(hunt.anchor, {
        clues: cluesToQuery(nextClues),
        allowSocial: minor ? socialOverride : true,
      });
    } else {
      startLegacySearch({ ...((hunt.result?.query ?? { name: hunt.targetName }) as PlayerQuery), usernameHint: hint });
    }
  };

  const handleEnableSchoolSearch = () => {
    setSocialOverride(true);
    if (hunt.kind === "discovery" && hunt.anchor) {
      startDiscovery(hunt.anchor, { clues: cluesToQuery(clues), allowSocial: true });
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

  const handleBackground = () => {
    setHuntBackgrounded(true);
    toast.info("Still searching — we'll keep at it while you do something else.", {
      description: "A banner will follow you around with live progress.",
    });
    navigate("/scout");
  };

  // --- Render --------------------------------------------------------------

  const hunting = hunt.phase === "running";
  const done = hunt.phase === "done" && !!hunt.result;
  const noMatch = done && hunt.result!.identities.length === 0;
  const showHero = !done && !hunting;

  const diagnosisAnchor = hunt.anchor
    ? {
        name: hunt.anchor.name,
        state: hunt.anchor.state,
        rating: hunt.anchor.rating ?? hunt.anchor.ratings.regular,
      }
    : null;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />

      <SearchLogDialog open={logOpen} onOpenChange={setLogOpen} getLog={getHuntFullLog} live={hunting} />

      <main className="flex-1 py-10 sm:py-14">
        <div className="container mx-auto px-4 max-w-3xl">
          {showHero && (
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
                Pick the right person first — then our AI detective traces their real online accounts across US Chess,
                FIDE, Lichess and Chess.com.
              </p>
            </div>
          )}

          {/* --- The hunt: pinned anchor + inline panel ------------------- */}
          {hunting && (
            <div className="space-y-4">
              {hunt.anchor && <AnchorPin member={hunt.anchor} />}
              <HuntPanel
                targetName={hunt.targetName}
                events={hunt.events}
                providerStatus={hunt.providerStatus}
                matched={hunt.matched}
                progress={hunt.progress}
                foundAccounts={hunt.foundAccounts}
                onViewLog={() => setLogOpen(true)}
                onStopKeep={softStopHunt}
                onBackground={handleBackground}
                stopping={hunt.stopping}
              />
            </div>
          )}

          {/* --- Results -------------------------------------------------- */}
          {done && !noMatch && (
            <>
              <div className="mb-4 flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setLogOpen(true)}>
                  <ScrollText className="mr-2 h-3.5 w-3.5" />
                  View search log
                </Button>
              </div>
              <IdentityResults result={hunt.result!} onGenerate={handleGenerate} onReset={resetAll} />
            </>
          )}
          {done && noMatch && (
            <div className="space-y-4">
              {hunt.anchor && <AnchorPin member={hunt.anchor} />}
              <NoMatchDiagnosis
                result={hunt.result!}
                anchor={diagnosisAnchor}
                onRetryWithHint={handleRetryWithHint}
                onEnterHandle={() => {
                  resetAll();
                  setMode("handle");
                }}
                onSchoolSearch={handleEnableSchoolSearch}
                onSkipToScout={hunt.anchor ? handleSkipToScout : undefined}
                onReset={resetAll}
              />
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setLogOpen(true)}>
                  <ScrollText className="mr-2 h-3.5 w-3.5" />
                  View search log
                </Button>
              </div>
            </div>
          )}
          {hunt.phase === "done" && !hunt.result && (
            <Card className="border-border/70">
              <CardContent className="p-6 text-center space-y-3">
                <p className="text-sm text-muted-foreground">{hunt.error || "The search failed. Please try again."}</p>
                <Button variant="outline" onClick={resetAll}>
                  Start over
                </Button>
              </CardContent>
            </Card>
          )}

          {/* --- Entry ----------------------------------------------------- */}
          {!hunting && !done && hunt.phase !== "done" && (
            <>
              {member ? (
                <AnchorCard
                  member={member}
                  preview={preview}
                  clues={clues}
                  onCluesChange={setClues}
                  socialAllowed={socialOverride}
                  onSocialAllowedChange={setSocialOverride}
                  onConfirm={handleConfirmAnchor}
                  onBack={() => {
                    setMember(null);
                    setPreview(null);
                  }}
                  onUseCachedHandle={handleUseCachedHandle}
                  onSkipToScout={handleSkipToScout}
                />
              ) : (
                <Card className="border-border/70 shadow-xl">
                  <CardContent className="p-5 sm:p-8">
                    <EntryModeTabs
                      mode={mode}
                      onModeChange={setMode}
                      personContent={
                        legacyName !== null ? (
                          <div className="space-y-4">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm text-muted-foreground">
                                Full detective search — no US Chess record needed.
                              </p>
                              <Button variant="ghost" size="sm" onClick={() => setLegacyName(null)}>
                                Back to the picker
                              </Button>
                            </div>
                            <PlayerSearchForm onSearch={handleLegacySearch} initialName={legacyName} />
                          </div>
                        ) : (
                          <UscfMemberPicker
                            onSelect={(m) => {
                              setMember(m);
                              setClues(EMPTY_CLUES);
                              setSocialOverride(false);
                            }}
                            onFideSelect={handleFideSelect}
                            onLegacySearch={(name) => setLegacyName(name)}
                            onEnterHandle={() => setMode("handle")}
                          />
                        )
                      }
                      tournamentContent={<TournamentTeaser onPersonSearch={() => setMode("person")} />}
                      handleContent={<HandleEntry onSubmit={handleDirectHandle} />}
                    />
                  </CardContent>
                </Card>
              )}

              {!member && legacyName === null && (
                <div className="mt-8 grid sm:grid-cols-3 gap-4">
                  <Highlight
                    icon={<Search className="w-5 h-5 text-primary" />}
                    title="Confirm the person first"
                    body="Pick them from the official database — no wasted searches on the wrong John Smith."
                  />
                  <Highlight
                    icon={<Sparkles className="w-5 h-5 text-primary" />}
                    title="Evidence, not guesses"
                    body="Ratings, IDs, states and real tournament games all vote on a confidence score."
                  />
                  <Highlight
                    icon={<Telescope className="w-5 h-5 text-primary" />}
                    title="Never a hostage"
                    body="Background the hunt, stop and keep results, or leave with the identity alone."
                  />
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
};

function TournamentTeaser({ onPersonSearch }: { onPersonSearch: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center space-y-3">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <Trophy className="w-6 h-6 text-primary" />
      </div>
      <h3 className="font-semibold text-foreground">Scan a whole section — coming soon</h3>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Pick your event, load the roster, and resolve every opponent overnight so the answer is already there when
        pairings go up.
      </p>
      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <CalendarClock className="w-3.5 h-3.5" />
        In the meantime, scout opponents one at a time:
      </div>
      <Button variant="outline" size="sm" onClick={onPersonSearch}>
        <Search className="w-3.5 h-3.5 mr-1.5" />
        Search by name
      </Button>
    </div>
  );
}

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
