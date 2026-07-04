import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
  ArrowRight,
  ExternalLink,
  Trophy,
  Flag,
  MapPin,
  Gauge,
  Sparkles,
  Plus,
  Minus,
  RotateCcw,
  ShieldCheck,
  Users,
} from "lucide-react";
import { ConfidenceBadge } from "./ConfidenceBadge";
import type { DiscoveredAccount, Platform, ResolutionResult, ResolvedIdentity } from "@/lib/identity";

interface IdentityResultsProps {
  result: ResolutionResult;
  onGenerate: (identity: ResolvedIdentity, accounts: DiscoveredAccount[]) => void;
  onReset: () => void;
}

const platformLabel: Record<Platform, string> = {
  lichess: "Lichess",
  chesscom: "Chess.com",
  chesskid: "ChessKid",
  icc: "ICC",
  other: "Other",
};

export function IdentityResults({ result, onGenerate, onReset }: IdentityResultsProps) {
  const { identities } = result;
  const [selectedId, setSelectedId] = useState(identities[0]?.id ?? "");

  if (identities.length === 0) {
    return <EmptyState query={result.query.name} onReset={onReset} />;
  }

  const multiple = identities.length > 1;

  return (
    <div className="space-y-6 animate-fade-in-up">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-foreground">
            {multiple ? `We found ${identities.length} possible matches` : "We found your opponent"}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {multiple
              ? "Pick the right person — each match explains itself below."
              : "Confirm the accounts and generate a full scout report."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onReset} className="self-start">
          <RotateCcw className="w-4 h-4 mr-2" />
          New search
        </Button>
      </div>

      <div className="space-y-4">
        {identities.map((identity) => (
          <IdentityCard
            key={identity.id}
            identity={identity}
            selected={selectedId === identity.id}
            selectable={multiple}
            onSelect={() => setSelectedId(identity.id)}
            onGenerate={onGenerate}
          />
        ))}
      </div>
    </div>
  );
}

function IdentityCard({
  identity,
  selected,
  selectable,
  onSelect,
  onGenerate,
}: {
  identity: ResolvedIdentity;
  selected: boolean;
  selectable: boolean;
  onSelect: () => void;
  onGenerate: (identity: ResolvedIdentity, accounts: DiscoveredAccount[]) => void;
}) {
  // Default selection: every verified account at ≥45% confidence, but always the
  // strongest one so "Generate" is never empty.
  const defaultSelected = useMemo(() => {
    const set = new Set(identity.accounts.filter((a) => a.confidence >= 0.45).map((a) => a.username + a.platform));
    if (set.size === 0 && identity.accounts[0]) set.add(identity.accounts[0].username + identity.accounts[0].platform);
    return set;
  }, [identity]);
  const [chosen, setChosen] = useState<Set<string>>(defaultSelected);

  const toggle = (a: DiscoveredAccount) => {
    const key = a.username + a.platform;
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const chosenAccounts = identity.accounts.filter((a) => chosen.has(a.username + a.platform));
  const expanded = selected || !selectable;

  return (
    <Card
      className={cn(
        "overflow-hidden transition-all duration-300",
        selectable && "cursor-pointer hover:border-primary/40",
        expanded ? "border-primary/50 ring-1 ring-primary/20 shadow-lg" : "opacity-90"
      )}
      onClick={selectable && !expanded ? onSelect : undefined}
    >
      <CardContent className="p-5 sm:p-6 space-y-5">
        {/* Identity header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            {selectable && (
              <span
                className={cn(
                  "mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                  selected ? "border-primary bg-primary" : "border-muted-foreground/40"
                )}
              >
                {selected && <span className="h-2 w-2 rounded-full bg-primary-foreground" />}
              </span>
            )}
            <div className="min-w-0">
              <h3 className="text-xl font-bold text-foreground truncate">{identity.name}</h3>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                {identity.title && (
                  <span className="font-semibold text-primary">{identity.title}</span>
                )}
                {identity.federation && (
                  <span className="inline-flex items-center gap-1">
                    <Flag className="w-3.5 h-3.5" />
                    {identity.federation}
                  </span>
                )}
                {(identity.state || identity.country) && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="w-3.5 h-3.5" />
                    {[identity.state, identity.country].filter(Boolean).join(", ")}
                  </span>
                )}
                {identity.estimatedRating && (
                  <span className="inline-flex items-center gap-1">
                    <Gauge className="w-3.5 h-3.5" />~{identity.estimatedRating}
                    {identity.estimatedRatingSource && (
                      <span className="text-xs opacity-70">({identity.estimatedRatingSource})</span>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>
          <ConfidenceBadge value={identity.confidence} showBar className="items-end text-right" />
        </div>

        {/* Reasoning */}
        <div className="rounded-lg bg-muted/40 px-4 py-3 text-sm text-foreground/90 flex gap-2">
          <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
          <p>{identity.reasoning}</p>
        </div>

        {expanded && (
          <>
            {/* Identifiers */}
            {(identity.uscfId || identity.fideId) && (
              <div className="flex flex-wrap gap-2 text-xs">
                {identity.uscfId && (
                  <span className="rounded-md border border-border bg-background px-2 py-1">USCF ID: {identity.uscfId}</span>
                )}
                {identity.fideId && (
                  <span className="rounded-md border border-border bg-background px-2 py-1">FIDE ID: {identity.fideId}</span>
                )}
              </div>
            )}

            {/* Evidence */}
            {identity.evidence.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Why we believe this
                </p>
                <div className="flex flex-wrap gap-2">
                  {identity.evidence.map((e, i) => (
                    <span
                      key={i}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs",
                        e.weight >= 0
                          ? "border-confidence-high/30 bg-confidence-high/10 text-foreground"
                          : "border-confidence-low/30 bg-confidence-low/10 text-foreground"
                      )}
                    >
                      {e.weight >= 0 ? <Plus className="w-3 h-3 text-confidence-high" /> : <Minus className="w-3 h-3 text-confidence-low" />}
                      {e.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Discovered accounts */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5" />
                Discovered accounts
                {identity.accounts.length > 0 && (
                  <span className="text-muted-foreground/70">({identity.accounts.length})</span>
                )}
              </p>
              {identity.accounts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No online accounts confidently linked yet. You can still generate a report by entering a username
                  manually.
                </p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  {identity.accounts.map((account) => (
                    <AccountCard
                      key={account.platform + account.username}
                      account={account}
                      checked={chosen.has(account.username + account.platform)}
                      onToggle={() => toggle(account)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Generate */}
            <div className="flex flex-col sm:flex-row gap-3 pt-1">
              <Button
                onClick={() => onGenerate(identity, chosenAccounts.length ? chosenAccounts : identity.accounts.slice(0, 1))}
                disabled={identity.accounts.length === 0}
                className="flex-1 h-11 bg-primary hover:bg-primary-dark text-primary-foreground"
              >
                <ArrowRight className="w-4 h-4 mr-2" />
                Generate Scout Report
                {chosenAccounts.length > 0 && (
                  <span className="ml-1.5 opacity-80">
                    ({chosenAccounts.length} account{chosenAccounts.length > 1 ? "s" : ""})
                  </span>
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AccountCard({
  account,
  checked,
  onToggle,
}: {
  account: DiscoveredAccount;
  checked: boolean;
  onToggle: () => void;
}) {
  const lastActive = account.lastActive ? new Date(account.lastActive) : null;
  // The green shield means "this account is confirmed to be THIS player", not
  // merely "this account exists". Every live account has verified === true (the
  // platform API answered), so the shield must NOT key off that alone — a
  // name-search / Google fallback lead can be a same-name stranger. Those carry
  // an explicit namesake caveat in their evidence; withhold the shield for them.
  const possibleNamesake = account.evidence?.some((e) => /namesake/i.test(e.label));
  const identityConfirmed = account.verified && !possibleNamesake;
  return (
    <div
      className={cn(
        "rounded-xl border p-3.5 transition-all",
        checked ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20" : "border-border bg-background hover:border-primary/30"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={onToggle} className="flex items-start gap-2.5 text-left min-w-0">
          {/* Presentational — the wrapping button owns the toggle to avoid double-firing. */}
          <Checkbox checked={checked} className="mt-0.5 pointer-events-none" tabIndex={-1} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="font-semibold text-foreground truncate">@{account.username}</span>
              {identityConfirmed ? (
                <ShieldCheck className="w-3.5 h-3.5 text-confidence-high shrink-0" aria-label="Identity confirmed through tournament games" />
              ) : possibleNamesake ? (
                <span className="text-[10px] font-medium text-confidence-low shrink-0" title="Same-name match from a name/Google search — not confirmed through this player's tournament games. Could be a different person.">
                  unconfirmed
                </span>
              ) : null}
            </span>
            <span className="block text-xs text-muted-foreground">{platformLabel[account.platform]}</span>
          </span>
        </button>
        <ConfidenceBadge value={account.confidence} size="sm" />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
        <Stat label="Rating" value={account.rating ? `${account.rating}` : "—"} />
        <Stat label="Games" value={account.gamesFound != null ? format(account.gamesFound) : "—"} />
        <Stat label="Last seen" value={lastActive ? relative(lastActive) : "—"} />
      </div>

      <a
        href={account.profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="w-3 h-3" />
        Open profile
      </a>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/40 py-1.5">
      <div className="font-semibold text-foreground">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

function EmptyState({ query, onReset }: { query: string; onReset: () => void }) {
  return (
    <div className="text-center py-12 animate-fade-in-up">
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
        <Trophy className="h-8 w-8 text-muted-foreground" />
      </div>
      <h2 className="text-xl font-bold text-foreground">No confident match for "{query}"</h2>
      <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
        Try adding more detail — an approximate rating, state, federation, a tournament name, or a username hint all
        sharpen the search dramatically.
      </p>
      <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
        <Button onClick={onReset}>
          <RotateCcw className="w-4 h-4 mr-2" />
          Refine search
        </Button>
        <Button variant="outline" asChild>
          <a href="/scout">Enter a username manually</a>
        </Button>
      </div>
    </div>
  );
}

function format(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}

function relative(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export default IdentityResults;
