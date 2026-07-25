import { useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { getHuntState, subscribeHunt } from "@/lib/identity/huntStore";

/**
 * The slim follow-you-around banner for a backgrounded hunt. Rendered once at
 * the app root; shows on every page EXCEPT /find-player whenever a hunt is
 * running or has finished unviewed — so leaving the page never means losing
 * the search.
 */
export function HuntBanner() {
  const hunt = useSyncExternalStore(subscribeHunt, getHuntState);
  const location = useLocation();
  const navigate = useNavigate();
  const [dismissedAt, setDismissedAt] = useState(0);

  if (location.pathname === "/find-player") return null;
  if (hunt.phase === "idle") return null;
  if (dismissedAt === hunt.startedAt) return null;
  if (hunt.phase === "done" && !hunt.result) return null; // errors surface on the page itself

  const running = hunt.phase === "running";
  const found = running
    ? hunt.foundAccounts.length
    : hunt.result?.identities.reduce((n, i) => n + i.accounts.length, 0) ?? 0;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[calc(100%-2rem)] max-w-sm animate-fade-in-up">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card shadow-xl px-4 py-3">
        {running ? (
          <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-confidence-high shrink-0" />
        )}
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium text-foreground truncate">
            {running ? `Still tracing ${hunt.targetName}…` : `Search for ${hunt.targetName} finished`}
          </p>
          <p className="text-xs text-muted-foreground">
            {found > 0
              ? `${found} account${found === 1 ? "" : "s"} found${running ? " so far" : ""}`
              : running
                ? "Working the tournament trail"
                : "No confirmed account — see what was ruled out"}
          </p>
        </div>
        <Button size="sm" variant={running ? "outline" : "default"} className="shrink-0" onClick={() => navigate("/find-player")}>
          View
        </Button>
        <button
          type="button"
          onClick={() => setDismissedAt(hunt.startedAt)}
          className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

export default HuntBanner;
