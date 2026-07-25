import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowRight, AtSign } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Platform } from "@/lib/identity";

interface HandleEntryProps {
  onSubmit: (platform: Platform, username: string) => void;
  disabled?: boolean;
}

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: "chesscom", label: "Chess.com" },
  { value: "lichess", label: "Lichess" },
];

/**
 * Door 3: the user already knows the username. Thirty seconds of UI that hands
 * straight off to /scout — a meaningful share of users have the handle, and
 * the old flow made them prove they didn't first.
 */
export function HandleEntry({ onSubmit, disabled }: HandleEntryProps) {
  const [platform, setPlatform] = useState<Platform>("chesscom");
  const [username, setUsername] = useState("");
  const clean = username.trim().replace(/^@/, "");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!clean || disabled) return;
    onSubmit(platform, clean);
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent p-5 sm:p-6 space-y-4">
        <div>
          <Label className="flex items-center gap-2 text-base font-semibold">
            <AtSign className="w-4 h-4 text-primary" />
            Their username
          </Label>
          <p className="text-xs text-muted-foreground mt-1">
            Skip the detective work — go straight to the scout report.
          </p>
        </div>

        <div className="flex rounded-lg border border-border overflow-hidden w-fit">
          {PLATFORMS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setPlatform(p.value)}
              className={cn(
                "px-4 py-2 text-sm font-medium transition-colors",
                platform === p.value
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:text-foreground"
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <Input
          placeholder={platform === "chesscom" ? "e.g., hikaru" : "e.g., DrNykterstein"}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="h-12 text-base"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <Button type="submit" disabled={!clean || disabled} className="w-full h-12 text-base bg-primary hover:bg-primary-dark text-primary-foreground">
        <ArrowRight className="mr-2 w-5 h-5" />
        Scout this player
      </Button>
    </form>
  );
}

export default HandleEntry;
