/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/components/findplayer/ConfirmPanel.tsx
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  The confirmation screen shown after a candidate is picked. Sets
       expectations for the long wait via the `hasOnline` traceability signal
       and keeps username-hint / school / club clues behind progressive
       disclosure before handing the confirmed anchor to the engine.
WHY:   Anchor the engine on a human-confirmed person and collect optional
       clues without cluttering the first screen.
DEPENDS-ON:     src/lib/identity types.
DEPENDED-ON-BY: src/pages/FindPlayer.tsx (redesign variant).
RESTORE:        Copy the source below to src/components/findplayer/ConfirmPanel.tsx.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// ConfirmPanel — Phase A → Phase B handoff.
//
// Shows the picked directory member with everything we already know (ratings
// table, IDs, state) plus the single best predictor of how discovery will go:
// whether they have online-rated US Chess history. Sets expectations BEFORE
// the long search, offers the old form's most useful clues behind progressive
// disclosure, and hands the engine a human-confirmed anchor (uscfId pinned).
// ============================================================================

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ArrowLeft, ArrowRight, ChevronDown, Compass, Flag, MapPin, Sparkles, Trophy, Zap } from "lucide-react";
import { searchDirectoryMembers, type DirectoryMember } from "@/lib/identity/directory";
import type { TournamentPickContext } from "./TournamentPicker";
import type { PlayerQuery } from "@/lib/identity";

interface ConfirmPanelProps {
  member: DirectoryMember;
  context?: TournamentPickContext;
  /** Roster-lite pick (no ratings yet) — fetch the full record on mount. */
  needsEnrich?: boolean;
  onBack: () => void;
  onConfirm: (query: PlayerQuery) => void;
}

const RATING_LABELS: [keyof NonNullable<DirectoryMember["ratings"]>, string][] = [
  ["regular", "Regular"],
  ["quick", "Quick"],
  ["blitz", "Blitz"],
  ["onlineRegular", "Online Regular"],
  ["onlineQuick", "Online Quick"],
  ["onlineBlitz", "Online Blitz"],
];

export function ConfirmPanel({ member: initial, context, needsEnrich, onBack, onConfirm }: ConfirmPanelProps) {
  const [member, setMember] = useState(initial);
  const [enriching, setEnriching] = useState(!!needsEnrich);
  const [cluesOpen, setCluesOpen] = useState(false);
  const [usernameHint, setUsernameHint] = useState("");
  const [school, setSchool] = useState("");
  const [club, setClub] = useState("");

  // Crosstable rows carry only name/rating/state; pull the full member record
  // (online systems, FIDE id, title) so the traceability signal is honest.
  useEffect(() => {
    if (!needsEnrich) return;
    let cancelled = false;
    searchDirectoryMembers({ uscfId: initial.id }).then((res) => {
      if (cancelled) return;
      setEnriching(false);
      if (res.available && res.members[0]) setMember(res.members[0]);
    });
    return () => {
      cancelled = true;
    };
  }, [initial.id, needsEnrich]);

  const ratingRows = RATING_LABELS.map(([key, label]) => ({ label, value: member.ratings?.[key] })).filter(
    (r): r is { label: string; value: number } => typeof r.value === "number"
  );

  const confirm = () => {
    const clean = (s: string) => (s.trim() ? s.trim() : undefined);
    onConfirm({
      name: member.name,
      uscfId: member.id,
      federation: "USCF",
      country: "US",
      state: member.state,
      fideId: member.fideId,
      approxRating: member.rating,
      usernameHint: clean(usernameHint),
      school: clean(school),
      club: clean(club),
      tournamentName: context?.tournamentName,
      tournamentSection: context?.sectionName,
    });
  };

  return (
    <Card className="border-border/70 shadow-xl animate-fade-in-up">
      <CardContent className="space-y-5 p-5 sm:p-8">
        {/* Who */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-bold text-foreground">{member.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {member.title && <span className="font-semibold text-primary">{member.title}</span>}
              <span className="inline-flex items-center gap-1">
                <Flag className="h-3.5 w-3.5" />
                USCF {member.id}
              </span>
              {member.state && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" />
                  {member.state}
                </span>
              )}
              {member.fideId && <span>FIDE {member.fideId}</span>}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Not them
          </Button>
        </div>

        {/* Context chip when they came off a crosstable */}
        {context && (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
            <Trophy className="h-3.5 w-3.5" />
            Picked from {context.tournamentName}
            {context.sectionName ? ` · ${context.sectionName}` : ""}
          </div>
        )}

        {/* Ratings we already have */}
        {enriching ? (
          <p className="text-sm text-muted-foreground">Pulling their full rating record…</p>
        ) : ratingRows.length > 0 ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {ratingRows.map((r) => (
              <div key={r.label} className="rounded-lg bg-muted/40 px-2 py-2 text-center">
                <div className="text-sm font-semibold text-foreground">{r.value}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.label}</div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Traceability — the honest expectation-setter */}
        <div
          className={cn(
            "flex items-start gap-2.5 rounded-xl border p-3.5 text-sm",
            member.hasOnline
              ? "border-confidence-high/40 bg-confidence-high/5"
              : "border-border bg-muted/20"
          )}
        >
          {member.hasOnline ? (
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-confidence-high" />
          ) : (
            <Compass className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <p className="text-muted-foreground">
            {member.hasOnline ? (
              <>
                <span className="font-medium text-foreground">Has online-rated US Chess history.</span> We can usually
                trace players like this to their real Lichess/Chess.com accounts through the online tournaments they
                played — expect a confident, evidence-backed match.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">No online-rated US Chess events on record.</span> We'll
                lean on the web index, school networks and name search instead — results may be leads to verify rather
                than confirmed accounts. Clues below help a lot.
              </>
            )}
          </p>
        </div>

        {/* Progressive disclosure: the clues that feed the fallback ladder */}
        <Collapsible open={cluesOpen} onOpenChange={setCluesOpen}>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="outline" className="flex h-10 w-full items-center justify-between">
              <span className="flex items-center gap-2 text-sm">
                <Sparkles className="h-4 w-4 text-primary" />
                Add optional clues (username hint, school, club)
              </span>
              <ChevronDown className={cn("h-4 w-4 transition-transform", cluesOpen && "rotate-180")} />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm">Username hint</Label>
              <Input
                placeholder='e.g. “I think it starts with chess…”'
                value={usernameHint}
                onChange={(e) => setUsernameHint(e.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-sm">School</Label>
                <Input placeholder="School" value={school} onChange={(e) => setSchool(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Club</Label>
                <Input placeholder="Chess club" value={club} onChange={(e) => setClub(e.target.value)} />
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <Button onClick={confirm} className="h-12 w-full bg-primary text-base text-primary-foreground hover:bg-primary-dark">
          Find their online accounts
          <ArrowRight className="ml-2 h-5 w-5" />
        </Button>
      </CardContent>
    </Card>
  );
}

export default ConfirmPanel;
