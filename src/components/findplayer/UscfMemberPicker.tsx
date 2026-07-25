import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Search, Loader2, Globe2, School, AtSign, MapPin, UserRound } from "lucide-react";
import {
  searchUscfMembers,
  searchFidePlayers,
  type MemberSearchHit,
  type FidePlayerHit,
} from "@/lib/identity";

// The full state list MUIR's StateRep filter accepts.
const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI",
  "SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

interface UscfMemberPickerProps {
  /** The user tapped a real US Chess member. */
  onSelect: (member: MemberSearchHit) => void;
  /** The user chose a FIDE-registry person instead (no USCF record). */
  onFideSelect?: (hit: FidePlayerHit) => void;
  /** "Skip to school-based search" — the legacy full-detective flow. */
  onLegacySearch?: (name: string) => void;
  /** "Enter a handle directly" — jump to Door 3. */
  onEnterHandle?: () => void;
  disabled?: boolean;
}

/**
 * The live USCF member picker — the single most visible change of the
 * redesign. One field, results as you type, each row a REAL person with the
 * state/rating/online facts that disambiguate homonyms instantly. The USCF ID
 * stops being an input and becomes an output.
 *
 * Search grammar matches what MSA veterans have in their fingers: "Smith,
 * John", "John Smith", a bare member ID — the edge normalises all of them.
 */
export function UscfMemberPicker({ onSelect, onFideSelect, onLegacySearch, onEnterHandle, disabled }: UscfMemberPickerProps) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<string>("any");
  const [hits, setHits] = useState<MemberSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false); // a completed search answered the CURRENT input
  const [rateLimited, setRateLimited] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  // FIDE branch (step 1b): shown after "Search FIDE instead".
  const [fideMode, setFideMode] = useState(false);
  const [fideHits, setFideHits] = useState<FidePlayerHit[]>([]);
  const [fideLoading, setFideLoading] = useState(false);

  const seqRef = useRef(0);

  // Debounced live search: 250ms after the last keystroke, from 3 characters
  // (or any digits-only member ID). Stale responses are dropped by sequence.
  useEffect(() => {
    const q = query.trim();
    const isId = /^\d{6,}$/.test(q.replace(/\D/g, "")) && /^[\d\s-]+$/.test(q);
    if (q.length < 3 && !isId) {
      setHits([]);
      setSearched(false);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const t = setTimeout(async () => {
      const res = await searchUscfMembers({ name: q, state: state === "any" ? undefined : state, limit: 8 });
      if (seq !== seqRef.current) return; // a newer keystroke superseded us
      setHits(res.hits);
      setRateLimited(!!res.rateLimited);
      setUnavailable(!res.available && !res.rateLimited);
      setSearched(true);
      setLoading(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query, state]);

  const runFideSearch = async () => {
    setFideMode(true);
    setFideLoading(true);
    const rows = await searchFidePlayers(query.trim());
    setFideHits(rows);
    setFideLoading(false);
  };

  const lastNameOnly = useMemo(() => {
    const tokens = query.trim().replace(/,/g, " ").split(/\s+/).filter(Boolean);
    return tokens.length > 1 ? tokens[tokens.length - 1] : null;
  }, [query]);

  const showNoMatch = searched && !loading && hits.length === 0 && !fideMode && !unavailable && !rateLimited;

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="member-picker" className="flex items-center gap-2 text-base font-semibold">
          <UserRound className="w-4 h-4 text-primary" />
          Who are you scouting?
        </Label>
        <p className="text-xs text-muted-foreground mt-1">
          Searching US Chess. Just a name is enough — pick the right person before we go hunting.
        </p>
      </div>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            id="member-picker"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder="Opponent's name, as it appears on the pairing sheet"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setFideMode(false);
            }}
            className="h-12 pl-9 text-base"
          />
          {loading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-primary" />}
        </div>
        <Select value={state} onValueChange={setState} disabled={disabled}>
          <SelectTrigger className="h-12 w-[92px] shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any</SelectItem>
            {US_STATES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* --- Live results --- */}
      {hits.length > 0 && !fideMode && (
        <div className="rounded-xl border border-border bg-background overflow-hidden divide-y divide-border animate-fade-in">
          {hits.map((m) => (
            <button
              key={m.uscfId}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(m)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-primary/5 focus:bg-primary/5 focus:outline-none"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-foreground truncate">{m.name}</span>
                  {m.title && <span className="text-xs font-semibold text-primary shrink-0">{m.title}</span>}
                </div>
                <div className="mt-0.5 flex items-center gap-2.5 text-xs text-muted-foreground">
                  {m.state && (
                    <span className="inline-flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {m.state}
                    </span>
                  )}
                  <span>ID {m.uscfId}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {m.hasOnline && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-confidence-high/10 text-confidence-high border border-confidence-high/30">
                    online
                  </Badge>
                )}
                <span className="text-sm font-semibold tabular-nums text-foreground">{m.rating ?? "unr."}</span>
              </div>
            </button>
          ))}
          {state !== "any" && (
            <button
              type="button"
              onClick={() => setState("any")}
              className="w-full px-4 py-2.5 text-left text-xs font-medium text-primary hover:bg-primary/5 transition-colors"
            >
              Not here? Search all 50 states →
            </button>
          )}
        </div>
      )}

      {/* --- Availability problems (never a dead end) --- */}
      {rateLimited && (
        <p className="text-xs text-muted-foreground">Searching a little too fast — give it a few seconds and type again.</p>
      )}
      {unavailable && (
        <div className="rounded-xl border border-border bg-muted/30 p-4 text-sm space-y-2">
          <p className="text-muted-foreground">
            The US Chess search isn't reachable right now. You can still run the full detective search on the name alone.
          </p>
          {onLegacySearch && (
            <Button type="button" variant="outline" size="sm" onClick={() => onLegacySearch(query.trim())}>
              Run the full search anyway
            </Button>
          )}
        </div>
      )}

      {/* --- Step 1b: empty is a BRANCH, not an error --- */}
      {showNoMatch && (
        <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3 animate-fade-in">
          <p className="text-sm font-semibold text-foreground">
            No US Chess member found for "{query.trim()}"{state !== "any" ? ` in ${state}` : ""}.
          </p>
          <p className="text-xs text-muted-foreground">That usually means one of these:</p>
          <div className="space-y-2">
            <NoMatchAction
              icon={<Globe2 className="w-4 h-4" />}
              label="They're rated somewhere other than US Chess"
              action="Search FIDE"
              onClick={runFideSearch}
            />
            {state !== "any" && (
              <NoMatchAction
                icon={<MapPin className="w-4 h-4" />}
                label="Their state of record may differ"
                action="Search all states"
                onClick={() => setState("any")}
              />
            )}
            {lastNameOnly && (
              <NoMatchAction
                icon={<Search className="w-4 h-4" />}
                label="The name may be spelled differently on file"
                action={`Try "${lastNameOnly}" only`}
                onClick={() => setQuery(lastNameOnly)}
              />
            )}
            {onLegacySearch && (
              <NoMatchAction
                icon={<School className="w-4 h-4" />}
                label="They're new or unrated"
                action="Skip to school-based search"
                onClick={() => onLegacySearch(query.trim())}
              />
            )}
            {onEnterHandle && (
              <NoMatchAction
                icon={<AtSign className="w-4 h-4" />}
                label="You already know their handle"
                action="Enter it directly"
                onClick={onEnterHandle}
              />
            )}
          </div>
        </div>
      )}

      {/* --- FIDE branch --- */}
      {fideMode && (
        <div className="rounded-xl border border-border bg-background overflow-hidden animate-fade-in">
          <div className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground bg-muted/40">
            FIDE registry
          </div>
          {fideLoading ? (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> Searching FIDE…
            </div>
          ) : fideHits.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted-foreground">No FIDE-registered player matches that name either.</p>
          ) : (
            <div className="divide-y divide-border">
              {fideHits.map((f) => (
                <button
                  key={f.fideId}
                  type="button"
                  onClick={() => onFideSelect?.(f)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                    onFideSelect ? "hover:bg-primary/5" : "cursor-default"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground truncate">{f.name}</span>
                      {f.title && <span className="text-xs font-semibold text-primary shrink-0">{f.title}</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {[f.federation, f.year ? `b. ${f.year}` : null, `FIDE ${f.fideId}`].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-foreground shrink-0">
                    {f.standard ?? f.rapid ?? f.blitz ?? "unr."}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NoMatchAction({
  icon,
  label,
  action,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
        <span className="text-primary shrink-0">{icon}</span>
        <span className="truncate">{label}</span>
      </span>
      <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}

export default UscfMemberPicker;
