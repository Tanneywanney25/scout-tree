import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  BadgeCheck,
  ChevronDown,
  MapPin,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Telescope,
  ExternalLink,
} from "lucide-react";
import { TraceabilityAlert } from "./TraceabilityAlert";
import type { CachedResolvedHandle, MemberPreview, MemberSearchHit } from "@/lib/identity";

/** The optional refinements the user can attach before the hunt. All genuinely
 *  optional now — the anchor is already pinned. */
export interface AnchorClues {
  approxRating: string;
  club: string;
  school: string;
  ageOrGrade: string;
  usernameHint: string;
  additionalDetails: string;
}

export const EMPTY_CLUES: AnchorClues = {
  approxRating: "",
  club: "",
  school: "",
  ageOrGrade: "",
  usernameHint: "",
  additionalDetails: "",
};

/** Grade/age text that indicates a scholastic (minor) player. */
export function looksLikeMinor(clues: AnchorClues): boolean {
  const t = clues.ageOrGrade.toLowerCase();
  if (/\b(elementary|middle school|junior high|high school|k-?\d|grade|scholastic)\b/.test(t)) return true;
  const num = t.match(/\b(\d{1,2})\b/);
  if (num && /grade|th|st|nd|rd/.test(t) && Number(num[1]) <= 12) return true;
  if (num && /age|yo|year/.test(t) && Number(num[1]) < 18) return true;
  return clues.school.trim().length > 0;
}

const RATING_LABELS: [keyof MemberSearchHit["ratings"], string][] = [
  ["regular", "Regular"],
  ["quick", "Quick"],
  ["blitz", "Blitz"],
  ["onlineRegular", "Online Regular"],
  ["onlineQuick", "Online Quick"],
  ["onlineBlitz", "Online Blitz"],
];

const PLATFORM_LABEL: Record<string, string> = {
  lichess: "Lichess",
  chesscom: "Chess.com",
  chesskid: "ChessKid",
  icc: "ICC",
  other: "Other",
};

interface AnchorCardProps {
  member: MemberSearchHit;
  /** Null while the preview call is in flight (the card renders immediately
   *  from the search hit; the traceability verdict fills in). */
  preview: MemberPreview | null;
  clues: AnchorClues;
  onCluesChange: (clues: AnchorClues) => void;
  /** Minor-safety override — only consulted when the clues suggest a minor. */
  socialAllowed: boolean;
  onSocialAllowedChange: (allowed: boolean) => void;
  /** Spend the credit: run discovery on this confirmed person. */
  onConfirm: () => void;
  onBack: () => void;
  /** A moat hit: jump straight to /scout with this already-confirmed handle. */
  onUseCachedHandle?: (handle: CachedResolvedHandle) => void;
  /** Anchor-only handoff: skip the hunt, take the identity to /scout. */
  onSkipToScout?: () => void;
  busy?: boolean;
}

/**
 * Step 2 of Door 1: confirm the person BEFORE the engine spends minutes and a
 * credit tracing them. Lands in one to three seconds off one cheap MUIR call
 * and does four jobs at once: confirms identity, sets expectations honestly,
 * gives the user a shippable result even if they stop here, and marks the
 * clean boundary where metering lives.
 */
export function AnchorCard({
  member,
  preview,
  clues,
  onCluesChange,
  socialAllowed,
  onSocialAllowedChange,
  onConfirm,
  onBack,
  onUseCachedHandle,
  onSkipToScout,
  busy,
}: AnchorCardProps) {
  const [cluesOpen, setCluesOpen] = useState(false);

  const filledClues = useMemo(
    () => Object.values(clues).filter((v) => v.trim().length > 0).length,
    [clues]
  );
  const minor = looksLikeMinor(clues);
  const optedOut = preview?.optedOut === true;
  const cachedHandles = preview?.resolvedHandles?.filter((h) => h.platform === "chesscom" || h.platform === "lichess") ?? [];

  const update = <K extends keyof AnchorClues>(key: K, value: string) =>
    onCluesChange({ ...clues, [key]: value });

  const ratings = RATING_LABELS.filter(([k]) => member.ratings[k] !== undefined);

  return (
    <Card className="border-primary/40 ring-1 ring-primary/15 shadow-lg animate-fade-in-up">
      <CardContent className="p-5 sm:p-6 space-y-5">
        {/* --- Header --- */}
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="text-xl sm:text-2xl font-bold text-foreground truncate">{member.name}</h3>
              {member.title && <span className="text-sm font-bold text-primary shrink-0">{member.title}</span>}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {member.state && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {member.state}
                </span>
              )}
              <span>US Chess ID {member.uscfId}</span>
              {member.fideId && <span>FIDE {member.fideId}</span>}
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-confidence-high/40 bg-confidence-high/10 px-2.5 py-1 text-xs font-semibold text-confidence-high shrink-0">
            <BadgeCheck className="w-3.5 h-3.5" />
            US Chess
          </span>
        </div>

        {/* --- Ratings --- */}
        {ratings.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {ratings.map(([key, label]) => (
              <span key={key} className="rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-sm">
                <span className="text-xs text-muted-foreground mr-1.5">{label}</span>
                <span className="font-semibold tabular-nums text-foreground">{member.ratings[key]}</span>
              </span>
            ))}
          </div>
        )}

        {/* --- Opt-out: discovery is refused, the anchor itself still shows --- */}
        {optedOut ? (
          <div className="flex items-start gap-2.5 rounded-xl border border-confidence-low/40 bg-confidence-low/5 p-3.5 text-sm">
            <ShieldAlert className="w-4 h-4 text-confidence-low mt-0.5 shrink-0" />
            <p className="text-muted-foreground">
              <span className="font-semibold text-foreground">This player has asked not to be traced.</span> ScoutTree
              honors opt-out requests, so account discovery is disabled for them. You can still scout a handle you already
              know.
            </p>
          </div>
        ) : (
          <>
            {/* --- Traceability verdict (fills in when the preview lands) --- */}
            {preview ? (
              <TraceabilityAlert preview={preview} />
            ) : (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            )}

            {/* --- Moat hit: an earlier hunt already confirmed their account --- */}
            {cachedHandles.length > 0 && (
              <div className="rounded-xl border border-confidence-high/40 bg-confidence-high/5 p-3.5 space-y-2.5">
                <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldCheck className="w-4 h-4 text-confidence-high" />
                  Already found — a previous search confirmed {cachedHandles.length === 1 ? "this account" : "these accounts"}:
                </p>
                {cachedHandles.map((h) => (
                  <div key={h.platform + h.username} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-foreground min-w-0 truncate">
                      <span className="font-semibold">@{h.username}</span>
                      <span className="text-muted-foreground"> · {PLATFORM_LABEL[h.platform] || h.platform} · {Math.round(h.confidence * 100)}%</span>
                    </span>
                    {onUseCachedHandle && (
                      <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => onUseCachedHandle(h)}>
                        <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                        Use this account
                      </Button>
                    )}
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">Or run a fresh hunt below to re-verify and look for more.</p>
              </div>
            )}

            {/* --- Minor-safety gate --- */}
            {minor && (
              <div className="rounded-xl border border-confidence-medium/40 bg-confidence-medium/5 p-3.5 space-y-2.5 text-sm">
                <p className="flex items-start gap-2 text-muted-foreground">
                  <ShieldAlert className="w-4 h-4 text-confidence-medium mt-0.5 shrink-0" />
                  <span>
                    <span className="font-semibold text-foreground">Looks like a scholastic player.</span> We identify
                    competitors from public tournament records only — school-roster and social-graph tracing stays off for
                    minors.
                  </span>
                </p>
                <label className="flex items-start gap-2 cursor-pointer">
                  <Checkbox
                    checked={socialAllowed}
                    onCheckedChange={(v) => onSocialAllowedChange(v === true)}
                    className="mt-0.5"
                  />
                  <span className="text-xs text-muted-foreground">
                    Enable school-based tracing anyway (e.g. you're their coach or parent and authorized to look them up).
                  </span>
                </label>
              </div>
            )}

            {/* --- Optional clues --- */}
            <Collapsible open={cluesOpen} onOpenChange={setCluesOpen}>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="outline" className="w-full flex items-center justify-between h-10">
                  <span className="flex items-center gap-2 text-sm">
                    <Sparkles className="w-4 h-4 text-primary" />
                    Add anything else you know
                    <span className="text-xs text-muted-foreground">(optional{filledClues > 0 ? `, ${filledClues} added` : ""})</span>
                  </span>
                  <ChevronDown className={cn("h-4 w-4 transition-transform", cluesOpen && "rotate-180")} />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-4 mt-4">
                <div className="grid sm:grid-cols-3 gap-3">
                  <ClueField label="Online rating (if known)">
                    <Input type="number" placeholder="e.g., 1450" value={clues.approxRating} onChange={(e) => update("approxRating", e.target.value)} />
                  </ClueField>
                  <ClueField label="Club">
                    <Input placeholder="Chess club" value={clues.club} onChange={(e) => update("club", e.target.value)} />
                  </ClueField>
                  <ClueField label="School">
                    <Input placeholder="School" value={clues.school} onChange={(e) => update("school", e.target.value)} />
                  </ClueField>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <ClueField label="Age / Grade">
                    <Input placeholder="e.g., 10th grade" value={clues.ageOrGrade} onChange={(e) => update("ageOrGrade", e.target.value)} />
                  </ClueField>
                  <ClueField label="Username hint">
                    <Input placeholder='e.g., "starts with chess…"' value={clues.usernameHint} onChange={(e) => update("usernameHint", e.target.value)} />
                  </ClueField>
                </div>
                <ClueField label="Anything else">
                  <Textarea
                    rows={2}
                    className="resize-none"
                    placeholder="Every detail becomes evidence."
                    value={clues.additionalDetails}
                    onChange={(e) => update("additionalDetails", e.target.value)}
                  />
                </ClueField>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}

        {/* --- Actions --- */}
        <div className="space-y-2 pt-1">
          <div className="flex flex-col sm:flex-row gap-3">
            {!optedOut && (
              <Button
                onClick={onConfirm}
                disabled={busy}
                className="flex-1 h-11 bg-primary hover:bg-primary-dark text-primary-foreground"
              >
                <Telescope className="w-4 h-4 mr-2" />
                Find their online accounts
              </Button>
            )}
            <Button variant="outline" onClick={onBack} disabled={busy} className={cn("h-11", optedOut && "flex-1")}>
              <Search className="w-4 h-4 mr-2" />
              Not them, search again
            </Button>
          </div>
          {!optedOut && (
            <p className="text-center text-xs text-muted-foreground">
              Usually 30 s – 3 min. We work every avenue to exhaustion — you can stop anytime and keep what we've found.
            </p>
          )}
          {onSkipToScout && (
            <p className="text-center">
              <button
                type="button"
                onClick={onSkipToScout}
                className="text-xs font-medium text-primary hover:underline"
              >
                Skip the hunt — I'll enter their handle on the scout page myself
              </button>
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ClueField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

/** The slim pinned variant shown above the hunt panel — the anchor never
 *  leaves the screen while the engine works. */
export function AnchorPin({ member, className }: { member: MemberSearchHit; className?: string }) {
  const rating = member.rating ?? member.ratings.regular ?? member.ratings.onlineRegular;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3",
        className
      )}
    >
      <BadgeCheck className="w-4 h-4 text-confidence-high shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <span className="font-semibold text-foreground">{member.name}</span>
        <span className="text-muted-foreground">
          {member.state ? ` · ${member.state}` : ""}
          {rating ? ` · ${rating}` : ""} · US Chess ID {member.uscfId}
        </span>
      </div>
    </div>
  );
}

export default AnchorCard;
