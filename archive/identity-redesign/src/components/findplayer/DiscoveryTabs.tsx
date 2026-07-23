/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/components/findplayer/DiscoveryTabs.tsx
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  The four-door entry UI: By name (instant directory search; partial
       names + state + rating band), Tournament (event -> section ->
       crosstable), Browse (a state's players by strength), and I-have-an-ID
       (USCF ID / FIDE / username). Every door resolves to a single picked
       DiscoveryPick candidate.
WHY:   Core of Phase A — let a human converge on the exact person before any
       expensive traversal runs.
DEPENDS-ON:     src/components/findplayer/CandidateList.tsx,
                src/components/findplayer/TournamentPicker.tsx,
                src/components/findplayer/usStates.ts,
                src/lib/identity/directory.ts.
DEPENDED-ON-BY: src/pages/FindPlayer.tsx (redesign variant).
RESTORE:        Copy the source below to src/components/findplayer/DiscoveryTabs.tsx.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// DiscoveryTabs — the four-door entry to Find Player (Phase A).
//
// Replaces the single monolithic form with entry points that match what the
// user actually knows:
//   · By name    — instant directory search (full/partial name + state + band)
//   · Tournament — event → section → crosstable → "that's them"
//   · Browse     — a state's players, strongest first
//   · I have an ID — USCF ID lookup / FIDE ID / online username, front & center
//
// Every door ends the same way: a confirmed candidate handed to the parent
// (→ ConfirmPanel → the unchanged deep engine), or an explicit hand-off to
// deep discovery when the directory can't help (FIDE-only players, outages).
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  AtSign,
  ChevronDown,
  CloudOff,
  Compass,
  Fingerprint,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trophy,
  UserSearch,
} from "lucide-react";
import {
  searchDirectoryMembers,
  type DirectoryMember,
  type RosterPlayer,
} from "@/lib/identity/directory";
import CandidateList from "./CandidateList";
import TournamentPicker, { type TournamentPickContext } from "./TournamentPicker";
import { US_STATES } from "./usStates";

export type DiscoveryTab = "name" | "tournament" | "browse" | "id";

export interface DiscoveryPick {
  member: DirectoryMember;
  /** Set when the pick came off a tournament crosstable. */
  context?: TournamentPickContext;
  /** True when the row is roster-lite (no ratings yet) — ConfirmPanel enriches. */
  needsEnrich?: boolean;
}

interface DiscoveryTabsProps {
  initialTab?: DiscoveryTab;
  initialName?: string;
  onPick: (pick: DiscoveryPick) => void;
  /** "Can't find them / directory down / FIDE-only" → the deep-discovery form. */
  onDeepSearch: (prefillName?: string) => void;
}

/** Debounce a value; used for search-as-you-type against the directory. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const rosterToMember = (p: RosterPlayer): DirectoryMember => ({
  id: p.uscfId,
  name: p.name,
  state: p.state,
  rating: p.rating,
  hasOnline: false, // unknown until enriched
});

export function DiscoveryTabs({ initialTab = "name", initialName = "", onPick, onDeepSearch }: DiscoveryTabsProps) {
  const [tab, setTab] = useState<DiscoveryTab>(initialTab);
  const [directoryDown, setDirectoryDown] = useState(false);

  // --- By name ---------------------------------------------------------------
  const [name, setName] = useState(initialName);
  const [nameState, setNameState] = useState("any");
  const [bandOpen, setBandOpen] = useState(false);
  const [minRating, setMinRating] = useState("");
  const [maxRating, setMaxRating] = useState("");
  const [nameResults, setNameResults] = useState<DirectoryMember[]>([]);
  const [nameLoading, setNameLoading] = useState(false);
  const [nameSearched, setNameSearched] = useState(false);
  const debouncedName = useDebounced(name, 450);
  const nameSeq = useRef(0);

  const band = useMemo(() => {
    const min = parseInt(minRating, 10);
    const max = parseInt(maxRating, 10);
    return {
      min: Number.isFinite(min) ? min : undefined,
      max: Number.isFinite(max) ? max : undefined,
    };
  }, [minRating, maxRating]);

  useEffect(() => {
    const q = debouncedName.trim();
    if (q.length < 3) {
      setNameResults([]);
      setNameSearched(false);
      return;
    }
    const seq = ++nameSeq.current;
    setNameLoading(true);
    searchDirectoryMembers({
      name: q,
      state: nameState !== "any" ? nameState : undefined,
      minRating: band.min,
      maxRating: band.max,
    }).then((res) => {
      if (seq !== nameSeq.current) return;
      setNameLoading(false);
      if (!res.available) {
        // Outage ≠ "no matches": show only the degrade banner, not both.
        setDirectoryDown(true);
        setNameSearched(false);
        setNameResults([]);
        return;
      }
      setNameSearched(true);
      setNameResults(res.members);
    });
  }, [debouncedName, nameState, band.min, band.max]);

  // --- Browse ------------------------------------------------------------------
  const [browseState, setBrowseState] = useState("");
  const [browseResults, setBrowseResults] = useState<DirectoryMember[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseSearched, setBrowseSearched] = useState(false);
  const browseSeq = useRef(0);

  useEffect(() => {
    if (!browseState) return;
    const seq = ++browseSeq.current;
    setBrowseLoading(true);
    searchDirectoryMembers({
      state: browseState,
      minRating: band.min,
      maxRating: band.max,
      size: 50,
    }).then((res) => {
      if (seq !== browseSeq.current) return;
      setBrowseLoading(false);
      if (!res.available) {
        setDirectoryDown(true);
        setBrowseSearched(false);
        setBrowseResults([]);
        return;
      }
      setBrowseSearched(true);
      setBrowseResults(res.members);
    });
  }, [browseState, band.min, band.max]);

  // --- I have an ID -----------------------------------------------------------
  const [uscfId, setUscfId] = useState("");
  const [idLoading, setIdLoading] = useState(false);
  const [idResult, setIdResult] = useState<DirectoryMember[] | null>(null);

  const lookupId = async () => {
    const id = uscfId.replace(/\D/g, "");
    if (id.length < 6) return;
    setIdLoading(true);
    setIdResult(null);
    const res = await searchDirectoryMembers({ uscfId: id });
    setIdLoading(false);
    if (!res.available) {
      setDirectoryDown(true);
      setIdResult([]);
      return;
    }
    setIdResult(res.members);
  };

  const ratingBand = (
    <Collapsible open={bandOpen} onOpenChange={setBandOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Rating range
          {(band.min !== undefined || band.max !== undefined) && (
            <span className="rounded-full bg-primary/15 px-2 py-0.5 font-semibold text-primary">
              {band.min ?? "0"}–{band.max ?? "any"}
            </span>
          )}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", bandOpen && "rotate-180")} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex items-center gap-2.5">
          <Input
            type="number"
            placeholder="Min (e.g. 1400)"
            value={minRating}
            onChange={(e) => setMinRating(e.target.value)}
            className="h-9 w-36"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="number"
            placeholder="Max (e.g. 1800)"
            value={maxRating}
            onChange={(e) => setMaxRating(e.target.value)}
            className="h-9 w-36"
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );

  return (
    <div className="space-y-5">
      {directoryDown && (
        <div className="flex items-start gap-2.5 rounded-xl border border-confidence-low/40 bg-confidence-low/5 p-3.5 text-sm">
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-confidence-low" />
          <div>
            <p className="text-foreground">The quick directory lookup isn't reachable right now.</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              You can still run full deep discovery — it uses every source, it just takes longer.
            </p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => onDeepSearch(name.trim() || undefined)}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              Run deep discovery
            </Button>
          </div>
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as DiscoveryTab)}>
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4">
          <TabsTrigger value="name" className="gap-1.5 py-2">
            <UserSearch className="h-4 w-4" />
            By name
          </TabsTrigger>
          <TabsTrigger value="tournament" className="gap-1.5 py-2">
            <Trophy className="h-4 w-4" />
            Tournament
          </TabsTrigger>
          <TabsTrigger value="browse" className="gap-1.5 py-2">
            <Compass className="h-4 w-4" />
            Browse
          </TabsTrigger>
          <TabsTrigger value="id" className="gap-1.5 py-2">
            <Fingerprint className="h-4 w-4" />
            I have an ID
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------- By name ------------------------------ */}
        <TabsContent value="name" className="mt-5 space-y-4">
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Name — even part of one works (e.g. “Bhati”)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-11 pl-9"
              />
            </div>
            <Select value={nameState} onValueChange={setNameState}>
              <SelectTrigger className="h-11 w-full sm:w-[150px]">
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
          </div>
          {ratingBand}

          <CandidateList
            members={nameResults}
            loading={nameLoading}
            searched={nameSearched}
            emptyHint="Check the spelling, widen the rating range, or try the tournament search — or run deep discovery below."
            onPick={(member) => onPick({ member })}
          />

          {name.trim().length > 0 && name.trim().length < 3 && (
            <p className="text-xs text-muted-foreground">Keep typing — the directory search starts at 3 letters.</p>
          )}

          <div className="rounded-xl border border-border bg-muted/20 p-3.5 text-sm">
            <p className="text-muted-foreground">
              Not in the list? Playing under FIDE only, or you're not sure of the name?
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => onDeepSearch(name.trim() || undefined)}>
              <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              Run deep discovery with what I typed
            </Button>
          </div>
        </TabsContent>

        {/* ----------------------------- Tournament ----------------------------- */}
        <TabsContent value="tournament" className="mt-5">
          <TournamentPicker
            onPick={(player, context) => onPick({ member: rosterToMember(player), context, needsEnrich: true })}
            onUnavailable={() => setDirectoryDown(true)}
          />
        </TabsContent>

        {/* ------------------------------- Browse ------------------------------- */}
        <TabsContent value="browse" className="mt-5 space-y-4">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
            <Select value={browseState || undefined} onValueChange={setBrowseState}>
              <SelectTrigger className="h-11 w-full sm:w-[220px]">
                <SelectValue placeholder="Pick a state to browse" />
              </SelectTrigger>
              <SelectContent>
                {US_STATES.map((s) => (
                  <SelectItem key={s.code} value={s.code}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ratingBand}
          </div>
          <CandidateList
            members={browseResults}
            loading={browseLoading}
            searched={browseSearched}
            emptyHint="No members in that state match the rating range."
            onPick={(member) => onPick({ member })}
          />
          {!browseState && (
            <p className="text-xs text-muted-foreground">
              Explore a state's players — strongest first. Narrow with the rating range to find the section you play in.
            </p>
          )}
        </TabsContent>

        {/* ----------------------------- I have an ID ---------------------------- */}
        <TabsContent value="id" className="mt-5 space-y-5">
          <div className="space-y-2">
            <Label className="text-sm">US Chess (USCF) ID</Label>
            <div className="flex gap-2.5">
              <Input
                placeholder="e.g. 12345678"
                value={uscfId}
                onChange={(e) => setUscfId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && lookupId()}
                className="h-11"
              />
              <Button onClick={lookupId} disabled={idLoading || uscfId.replace(/\D/g, "").length < 6} className="h-11 shrink-0">
                <Search className="mr-1.5 h-4 w-4" />
                Look up
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              From a pairing sheet, wallchart or uschess.org — the fastest, surest way in.
            </p>
          </div>

          {idLoading && <p className="text-sm text-muted-foreground">Looking up the member…</p>}
          {idResult && !idResult.length && !idLoading && (
            <p className="text-sm text-muted-foreground">No member found for that ID — double-check the digits.</p>
          )}
          {idResult && idResult.length > 0 && (
            <CandidateList members={idResult} searched onPick={(member) => onPick({ member })} />
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-muted/20 p-3.5">
              <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Fingerprint className="h-4 w-4 text-primary" />
                FIDE ID
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                International players aren't in the US Chess directory — deep discovery resolves FIDE IDs directly.
              </p>
              <Button variant="outline" size="sm" className="mt-2.5" onClick={() => onDeepSearch()}>
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                Deep discovery
              </Button>
            </div>
            <div className="rounded-xl border border-border bg-muted/20 p-3.5">
              <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <AtSign className="h-4 w-4 text-primary" />
                Online username
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Already know their Lichess or Chess.com handle? Skip discovery and scout it directly.
              </p>
              <Button variant="outline" size="sm" className="mt-2.5" asChild>
                <Link to="/scout">Enter a username</Link>
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default DiscoveryTabs;
