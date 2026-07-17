import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Search, ChevronDown, Sparkles, User } from "lucide-react";
import type { Federation, GameColor, PlayerQuery } from "@/lib/identity";

interface PlayerSearchFormProps {
  onSearch: (query: PlayerQuery) => void;
  disabled?: boolean;
  /** Optional initial name (e.g. deep-linked). */
  initialName?: string;
}

interface FormState {
  name: string;
  approxRating: string;
  federation: string; // "any" | Federation
  country: string;
  state: string;
  club: string;
  school: string;
  ageOrGrade: string;
  uscfId: string;
  fideId: string;
  usernameHint: string;
  tournamentName: string;
  tournamentRound: string;
  tournamentSection: string;
  tournamentBoard: string;
  tournamentColor: GameColor;
  additionalDetails: string;
}

const EMPTY: FormState = {
  name: "",
  approxRating: "",
  federation: "any",
  country: "",
  state: "",
  club: "",
  school: "",
  ageOrGrade: "",
  uscfId: "",
  fideId: "",
  usernameHint: "",
  tournamentName: "",
  tournamentRound: "",
  tournamentSection: "",
  tournamentBoard: "",
  tournamentColor: "unknown",
  additionalDetails: "",
};

const DETAIL_EXAMPLES = [
  "Usually plays in Washington",
  "High school player, ~1600 USCF",
  "Played at SuperNationals",
  "I think their Chess.com username starts with chess…",
];

export function PlayerSearchForm({ onSearch, disabled, initialName }: PlayerSearchFormProps) {
  const [form, setForm] = useState<FormState>({ ...EMPTY, name: initialName || "" });
  const [optionalOpen, setOptionalOpen] = useState(false);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const filledOptionalCount = useMemo(() => {
    let n = 0;
    for (const [k, v] of Object.entries(form)) {
      if (k === "name") continue;
      if (k === "federation" && v !== "any") n++;
      else if (k === "tournamentColor" && v !== "unknown") n++;
      else if (typeof v === "string" && v.trim() && k !== "federation" && k !== "tournamentColor") n++;
    }
    return n;
  }, [form]);

  const buildQuery = (): PlayerQuery => {
    const clean = (s: string) => (s.trim() ? s.trim() : undefined);
    const ratingNum = parseInt(form.approxRating, 10);
    return {
      name: form.name.trim(),
      approxRating: Number.isFinite(ratingNum) ? ratingNum : undefined,
      federation: form.federation !== "any" ? (form.federation as Federation) : undefined,
      country: clean(form.country),
      state: clean(form.state),
      club: clean(form.club),
      school: clean(form.school),
      ageOrGrade: clean(form.ageOrGrade),
      uscfId: clean(form.uscfId),
      fideId: clean(form.fideId),
      usernameHint: clean(form.usernameHint),
      tournamentName: clean(form.tournamentName),
      tournamentRound: clean(form.tournamentRound),
      tournamentSection: clean(form.tournamentSection),
      tournamentBoard: clean(form.tournamentBoard),
      tournamentColor: form.tournamentColor !== "unknown" ? form.tournamentColor : undefined,
      additionalDetails: clean(form.additionalDetails),
    };
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || disabled) return;
    onSearch(buildQuery());
  };

  const showUscf = form.federation === "USCF";
  const showFide = form.federation === "FIDE";
  const showTournamentExtras = form.tournamentName.trim().length > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* --- Required: the name --- */}
      <div className="relative rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-5 sm:p-6">
        <Label htmlFor="fp-name" className="flex items-center gap-2 text-base font-semibold">
          <User className="w-4 h-4 text-primary" />
          Who are you trying to scout?
        </Label>
        <p className="text-xs text-muted-foreground mt-1 mb-3">
          Just a name is enough — the less you know, the harder ScoutTree works.
        </p>
        <Input
          id="fp-name"
          autoFocus
          placeholder="e.g., Magnus Carlsen, or Jane Smith from your section"
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          className="h-12 text-base sm:text-lg"
        />
      </div>

      {/* --- Optional everything-else --- */}
      <Collapsible open={optionalOpen} onOpenChange={setOptionalOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" className="w-full flex items-center justify-between h-11">
            <span className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              Add anything else you know
              {filledOptionalCount > 0 && (
                <span className="ml-1 rounded-full bg-primary/15 text-primary text-xs font-semibold px-2 py-0.5">
                  {filledOptionalCount} added
                </span>
              )}
            </span>
            <ChevronDown className={cn("h-4 w-4 transition-transform", optionalOpen && "rotate-180")} />
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent className="space-y-6 mt-5">
          {/* Rating + federation */}
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Approximate rating">
              <Input
                type="number"
                placeholder="e.g., 1600"
                value={form.approxRating}
                onChange={(e) => update("approxRating", e.target.value)}
              />
            </Field>
            <Field label="Federation">
              <Select value={form.federation} onValueChange={(v) => update("federation", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any / unknown</SelectItem>
                  <SelectItem value="USCF">US Chess (USCF)</SelectItem>
                  <SelectItem value="FIDE">FIDE (International)</SelectItem>
                  <SelectItem value="LICHESS">Lichess</SelectItem>
                  <SelectItem value="CHESSCOM">Chess.com</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {/* Dynamic federation-specific id fields */}
          {showUscf && (
            <Field label="Do you know their USCF ID?" hint="Optional — a huge confidence booster if you have it.">
              <Input
                placeholder="e.g., 12345678"
                value={form.uscfId}
                onChange={(e) => update("uscfId", e.target.value)}
              />
            </Field>
          )}
          {showFide && (
            <Field label="Do you know their FIDE ID?" hint="Optional — a huge confidence booster if you have it.">
              <Input
                placeholder="e.g., 1503014"
                value={form.fideId}
                onChange={(e) => update("fideId", e.target.value)}
              />
            </Field>
          )}

          {/* Location */}
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Country">
              <Input placeholder="e.g., US" value={form.country} onChange={(e) => update("country", e.target.value)} />
            </Field>
            <Field label="State / Province">
              <Input placeholder="e.g., WA" value={form.state} onChange={(e) => update("state", e.target.value)} />
            </Field>
          </div>

          {/* Affiliations */}
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Club">
              <Input placeholder="Chess club" value={form.club} onChange={(e) => update("club", e.target.value)} />
            </Field>
            <Field label="School">
              <Input placeholder="School" value={form.school} onChange={(e) => update("school", e.target.value)} />
            </Field>
            <Field label="Age / Grade">
              <Input placeholder="e.g., 10th grade" value={form.ageOrGrade} onChange={(e) => update("ageOrGrade", e.target.value)} />
            </Field>
          </div>

          {/* Username hint */}
          <Field label="Username hint" hint='Anything like "starts with chess…" helps us guess their handle.'>
            <Input
              placeholder="e.g., I think it starts with chessmaster…"
              value={form.usernameHint}
              onChange={(e) => update("usernameHint", e.target.value)}
            />
          </Field>

          {/* Tournament context */}
          <div className="rounded-xl border border-border bg-muted/20 p-4 space-y-4">
            <Field label="Tournament name" hint="If they beat or played you at an event, name it.">
              <Input
                placeholder="e.g., Washington State Championship 2024"
                value={form.tournamentName}
                onChange={(e) => update("tournamentName", e.target.value)}
              />
            </Field>

            {showTournamentExtras && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-fade-in">
                <Field label="Round">
                  <Input placeholder="e.g., 3" value={form.tournamentRound} onChange={(e) => update("tournamentRound", e.target.value)} />
                </Field>
                <Field label="Section">
                  <Input placeholder="e.g., U1800" value={form.tournamentSection} onChange={(e) => update("tournamentSection", e.target.value)} />
                </Field>
                <Field label="Board">
                  <Input placeholder="e.g., 12" value={form.tournamentBoard} onChange={(e) => update("tournamentBoard", e.target.value)} />
                </Field>
                <Field label="Their color">
                  <Select value={form.tournamentColor} onValueChange={(v) => update("tournamentColor", v as GameColor)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unknown">Unknown</SelectItem>
                      <SelectItem value="white">White</SelectItem>
                      <SelectItem value="black">Black</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            )}
          </div>

          {/* Free-form details */}
          <Field label="Additional details" hint="Everything here becomes evidence.">
            <Textarea
              placeholder={`Tell us anything…\n• ${DETAIL_EXAMPLES.join("\n• ")}`}
              value={form.additionalDetails}
              onChange={(e) => update("additionalDetails", e.target.value)}
              rows={4}
              className="resize-none"
            />
          </Field>
        </CollapsibleContent>
      </Collapsible>

      <Button
        type="submit"
        disabled={!form.name.trim() || disabled}
        className="w-full h-12 text-base bg-primary hover:bg-primary-dark text-primary-foreground"
      >
        <Search className="mr-2 w-5 h-5" />
        Find Opponent
      </Button>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default PlayerSearchForm;
