/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/components/findplayer/CandidateList.tsx
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  Renders directory search results as a list of pickable candidate cards
       (name, state, rating, IDs), emitting a DiscoveryPick when one is chosen.
WHY:   Shared presentation for every entry door's candidate results.
DEPENDS-ON:     src/lib/identity types only (presentational).
DEPENDED-ON-BY: src/components/findplayer/DiscoveryTabs.tsx,
                src/components/findplayer/TournamentPicker.tsx.
RESTORE:        Copy the source below to src/components/findplayer/CandidateList.tsx.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// CandidateList — the "which of these is your player?" list for Phase A.
//
// Renders directory members with the disambiguators a human actually uses
// (state, ratings, online-history badge, membership status) and a single
// unambiguous action per row. The whole point of the redesign: the USER picks
// the person; the engine never guesses among homonyms again.
// ============================================================================

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { ArrowRight, Gauge, MapPin, UserSearch, Zap } from "lucide-react";
import type { DirectoryMember } from "@/lib/identity/directory";

interface CandidateListProps {
  members: DirectoryMember[];
  loading?: boolean;
  /** Something was searched (distinguishes "no results" from "not searched yet"). */
  searched?: boolean;
  emptyHint?: string;
  onPick: (member: DirectoryMember) => void;
}

export function CandidateList({ members, loading, searched, emptyHint, onPick }: CandidateListProps) {
  if (loading) {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-label="Searching the US Chess directory">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[76px] w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!members.length) {
    if (!searched) return null;
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
        <UserSearch className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">No US Chess members matched</p>
        {emptyHint && <p className="mt-1 text-xs text-muted-foreground">{emptyHint}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-muted-foreground">
        {members.length} match{members.length > 1 ? "es" : ""} in the US Chess directory — pick your player:
      </p>
      {members.map((m) => (
        <CandidateRow key={m.id} member={m} onPick={() => onPick(m)} />
      ))}
    </div>
  );
}

function CandidateRow({ member, onPick }: { member: DirectoryMember; onPick: () => void }) {
  const lapsed = member.status ? /expired|inactive|deceased/i.test(member.status) : false;
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-3.5 transition-colors hover:border-primary/40",
        lapsed && "opacity-80"
      )}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-semibold text-foreground truncate">{member.name}</span>
          {member.title && <span className="text-xs font-semibold text-primary">{member.title}</span>}
          {member.hasOnline && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
              title="Has online-rated US Chess events — their real accounts can usually be traced through tournaments they played."
            >
              <Zap className="h-3 w-3" />
              online history
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {member.state && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {member.state}
            </span>
          )}
          {typeof member.rating === "number" && (
            <span className="inline-flex items-center gap-1">
              <Gauge className="h-3 w-3" />
              {member.rating}
            </span>
          )}
          <span>USCF {member.id}</span>
          {lapsed && <span className="text-confidence-low">membership {member.status?.toLowerCase()}</span>}
        </div>
      </div>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onPick}>
        This is them
        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export default CandidateList;
