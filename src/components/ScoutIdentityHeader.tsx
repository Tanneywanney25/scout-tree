import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ConfidenceBadge } from "@/components/findplayer/ConfidenceBadge";
import { ExternalLink, Flag, Gauge, MapPin, ShieldCheck, Sparkles } from "lucide-react";
import type { ScoutIdentity } from "@/lib/identity";

interface ScoutIdentityHeaderProps {
  identity: ScoutIdentity;
}

const PLATFORM_LABEL: Record<string, string> = {
  lichess: "Lichess",
  chesscom: "Chess.com",
  chesskid: "ChessKid",
  icc: "ICC",
  other: "Other",
};

/**
 * Identity provenance header shown at the top of a scout report that was
 * launched from /find-player: how confident we are, what evidence backs it, the
 * verified accounts, and quick links to every external profile.
 */
export function ScoutIdentityHeader({ identity }: ScoutIdentityHeaderProps) {
  const lichess = identity.accounts.find((a) => a.platform === "lichess");
  const chesscom = identity.accounts.find((a) => a.platform === "chesscom");

  const externalLinks: { label: string; href: string }[] = [];
  if (chesscom) externalLinks.push({ label: "Open Chess.com", href: chesscom.profileUrl });
  if (lichess) externalLinks.push({ label: "Open Lichess", href: lichess.profileUrl });
  if (identity.fideId)
    externalLinks.push({ label: "Open FIDE", href: `https://ratings.fide.com/profile/${identity.fideId.replace(/\D/g, "")}` });
  if (identity.uscfId)
    externalLinks.push({ label: "Open USCF", href: `https://www.uschess.org/msa/MbrDtlMain.php?${identity.uscfId.replace(/\D/g, "")}` });

  return (
    <Card className="mb-6 border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardContent className="p-5 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary/80">
              <ShieldCheck className="w-4 h-4" />
              Verified identity
            </div>
            <h2 className="mt-1 text-2xl font-bold text-foreground truncate">{identity.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {identity.title && <span className="font-semibold text-primary">{identity.title}</span>}
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
              {identity.uscfId && <span className="text-xs">USCF #{identity.uscfId}</span>}
              {identity.fideId && <span className="text-xs">FIDE #{identity.fideId}</span>}
            </div>
          </div>
          <ConfidenceBadge value={identity.confidence} showBar className="items-start sm:items-end" />
        </div>

        {identity.reasoning && (
          <div className="flex gap-2 rounded-lg bg-muted/40 px-4 py-3 text-sm text-foreground/90">
            <Sparkles className="mt-0.5 w-4 h-4 shrink-0 text-primary" />
            <p>{identity.reasoning}</p>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Evidence sources */}
          {identity.sources.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Evidence sources
              </p>
              <div className="flex flex-wrap gap-1.5">
                {identity.sources.map((s) => (
                  <span key={s} className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs capitalize">
                    {PLATFORM_LABEL[s] || s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Verified accounts */}
          {identity.accounts.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Verified accounts
              </p>
              <div className="flex flex-wrap gap-2">
                {identity.accounts.map((a) => (
                  <a
                    key={a.platform + a.username}
                    href={a.profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 text-xs",
                      "hover:border-primary/40 transition-colors"
                    )}
                  >
                    <span className="font-medium text-foreground">{PLATFORM_LABEL[a.platform] || a.platform}</span>
                    <span className="text-muted-foreground">@{a.username}</span>
                    <ExternalLink className="w-3 h-3 text-primary" />
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Quick external links */}
        {externalLinks.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {externalLinks.map((link) => (
              <Button key={link.label} variant="outline" size="sm" asChild>
                <a href={link.href} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  {link.label}
                </a>
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default ScoutIdentityHeader;
