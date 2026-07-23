/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/components/findplayer/TournamentPicker.tsx
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  The Tournament door's drill-down: search rated events -> pick a section
       -> load its crosstable roster -> "that's them". Produces a DiscoveryPick.
WHY:   Let users who remember only the event/where-they-met find the player
       from a real roster instead of typing a name.
DEPENDS-ON:     src/lib/identity/directory.ts (searchRatedEvents / fetchEventRoster),
                src/components/findplayer/CandidateList.tsx,
                src/components/findplayer/usStates.ts.
DEPENDED-ON-BY: src/components/findplayer/DiscoveryTabs.tsx.
RESTORE:        Copy the source below to src/components/findplayer/TournamentPicker.tsx.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// TournamentPicker — "find them through the tournament you met them at".
//
// The casual-opponent path: search rated events by name (optionally a state),
// pick the event, pick the section, and pick your opponent off the real
// crosstable roster. Three clicks from "the kid who beat me in round 3 at the
// Washington Open" to a confirmed USCF identity — no surname required.
// ============================================================================

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { ArrowLeft, ArrowRight, CalendarDays, MapPin, Search, Trophy, Users } from "lucide-react";
import {
  searchDirectoryEvents,
  fetchDirectoryRoster,
  type DirectoryEvent,
  type DirectoryRoster,
  type RosterPlayer,
} from "@/lib/identity/directory";
import { US_STATES } from "./usStates";

export interface TournamentPickContext {
  tournamentName: string;
  eventId: string;
  sectionName?: string;
}

interface TournamentPickerProps {
  onPick: (player: RosterPlayer, context: TournamentPickContext) => void;
  /** The directory backend failed — parent shows the degrade banner. */
  onUnavailable: () => void;
}

export function TournamentPicker({ onPick, onUnavailable }: TournamentPickerProps) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState("any");
  const [events, setEvents] = useState<DirectoryEvent[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<DirectoryEvent | null>(null);
  const [roster, setRoster] = useState<DirectoryRoster | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [sectionIdx, setSectionIdx] = useState(0);
  const searchSeq = useRef(0);

  const runSearch = async () => {
    if (!query.trim() && state === "any") return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setSelected(null);
    setRoster(null);
    const res = await searchDirectoryEvents({ name: query.trim() || undefined, state: state !== "any" ? state : undefined, size: 20 });
    if (seq !== searchSeq.current) return;
    setSearching(false);
    if (!res.available) {
      onUnavailable();
      setEvents([]);
      return;
    }
    setEvents(res.events);
  };

  const openEvent = async (ev: DirectoryEvent) => {
    setSelected(ev);
    setRoster(null);
    setSectionIdx(0);
    setRosterLoading(true);
    const res = await fetchDirectoryRoster(ev.eventId);
    setRosterLoading(false);
    if (!res.available || !res.roster) {
      onUnavailable();
      setSelected(null);
      return;
    }
    setRoster(res.roster);
  };

  // --- Stage 3: the crosstable roster -------------------------------------
  if (selected && (roster || rosterLoading)) {
    const sections = roster?.sections ?? [];
    const section = sections[sectionIdx];
    return (
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-foreground truncate">{selected.name}</p>
            <p className="text-xs text-muted-foreground">
              {[selected.startDate, selected.city, selected.state].filter(Boolean).join(" · ")}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => { setSelected(null); setRoster(null); }}>
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Other events
          </Button>
        </div>

        {rosterLoading ? (
          <div className="space-y-2.5" aria-busy="true">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : (
          <>
            {sections.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {sections.map((s, i) => (
                  <button
                    key={s.number}
                    type="button"
                    onClick={() => setSectionIdx(i)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      i === sectionIdx
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/40"
                    )}
                  >
                    {s.name || `Section ${s.number}`}
                    <span className="ml-1 opacity-60">({s.players.length})</span>
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">Pick your opponent off the crosstable:</p>
            <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
              {(section?.players ?? []).map((p) => (
                <div
                  key={p.uscfId}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:border-primary/40"
                >
                  <div className="min-w-0 text-sm">
                    <span className="font-medium text-foreground">{p.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {[p.rating ? `${p.rating}` : null, p.state].filter(Boolean).join(" · ")}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2.5 text-xs"
                    onClick={() =>
                      onPick(p, { tournamentName: selected.name, eventId: selected.eventId, sectionName: section?.name })
                    }
                  >
                    That's them
                    <ArrowRight className="ml-1 h-3 w-3" />
                  </Button>
                </div>
              ))}
              {section && !section.players.length && (
                <p className="py-4 text-center text-xs text-muted-foreground">No players listed in this section.</p>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // --- Stages 1–2: search + event list -------------------------------------
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2.5 sm:flex-row">
        <Input
          placeholder='Tournament name, e.g. "Washington Open"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && runSearch()}
          className="h-11"
        />
        <div className="flex gap-2.5">
          <Select value={state} onValueChange={setState}>
            <SelectTrigger className="h-11 w-[130px] shrink-0">
              <SelectValue placeholder="State" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any state</SelectItem>
              {US_STATES.map((s) => (
                <SelectItem key={s.code} value={s.code}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={runSearch} disabled={searching || (!query.trim() && state === "any")} className="h-11 shrink-0">
            <Search className="mr-1.5 h-4 w-4" />
            Search
          </Button>
        </div>
      </div>

      {searching && (
        <div className="space-y-2.5" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      )}

      {!searching && events && !events.length && (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 p-6 text-center">
          <Trophy className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">No rated events matched</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Try fewer words — event names in the US Chess database are often abbreviated.
          </p>
        </div>
      )}

      {!searching && events && events.length > 0 && (
        <div className="space-y-2.5">
          <p className="text-xs text-muted-foreground">Pick the event you played them at:</p>
          {events.map((ev) => (
            <button
              key={ev.eventId}
              type="button"
              onClick={() => openEvent(ev)}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-card p-3.5 text-left transition-colors hover:border-primary/40"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-foreground">{ev.name}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {ev.startDate && (
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="h-3 w-3" />
                      {ev.startDate}
                    </span>
                  )}
                  {(ev.city || ev.state) && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="h-3 w-3" />
                      {[ev.city, ev.state].filter(Boolean).join(", ")}
                    </span>
                  )}
                  {typeof ev.playerCount === "number" && (
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {ev.playerCount} players
                    </span>
                  )}
                </div>
              </div>
              <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      {!searching && events === null && (
        <p className="text-xs text-muted-foreground">
          Remember the event but not their full name? Find the tournament and pick them straight off the crosstable.
        </p>
      )}
    </div>
  );
}

export default TournamentPicker;
