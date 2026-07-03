import { useEffect, useRef, useState } from "react";
import { Copy, Download, ScrollText } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { SearchEvent } from "@/lib/identity";

interface SearchLogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Reads the FULL unbounded log (kept in a parent ref — reading it here means
   *  the parent never re-renders per log line just to feed this dialog). */
  getLog: () => SearchEvent[];
  /** True while the search is still running — the dialog then live-refreshes. */
  live: boolean;
}

/** [+m:ss] elapsed since the first log line. */
function formatElapsed(ts: number, startTs: number): string {
  const ms = Math.max(0, ts - startTs);
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `+${m}:${String(s).padStart(2, "0")}`;
}

function statusGlyph(status: SearchEvent["status"]): string {
  if (status === "done") return "✓";
  if (status === "running") return "›";
  return "·";
}

function logToText(events: SearchEvent[]): string {
  if (!events.length) return "";
  const start = events[0].timestamp;
  return events
    .map((e) => `[${formatElapsed(e.timestamp, start)}] ${statusGlyph(e.status)} ${e.provider ? `(${e.provider}) ` : ""}${e.message}`)
    .join("\n");
}

/**
 * The full, unabridged search log. The live feed on the search screen only
 * shows a rotating handful of lines; this dialog shows every step the
 * detective took — appended live while the search runs, and available after
 * it finishes so you can retrace exactly how it got to the answer.
 */
export function SearchLogDialog({ open, onOpenChange, getLog, live }: SearchLogDialogProps) {
  const [snapshot, setSnapshot] = useState<SearchEvent[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Refresh the snapshot while open: on an interval while live (the parent ref
  // grows without re-rendering us), once on open when the search is finished.
  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      const log = getLog();
      setSnapshot((prev) => (prev.length === log.length ? prev : [...log]));
    };
    refresh();
    if (!live) return;
    const t = setInterval(refresh, 700);
    return () => clearInterval(t);
  }, [open, live, getLog]);

  // Auto-follow the newest lines while live, unless the user scrolled up.
  useEffect(() => {
    if (!open || !stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snapshot, open]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(logToText(snapshot));
      toast.success("Log copied to clipboard");
    } catch {
      toast.error("Couldn't copy the log");
    }
  };

  const handleDownload = () => {
    const blob = new Blob([logToText(snapshot)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "scouttree-search-log.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const startTs = snapshot[0]?.timestamp ?? Date.now();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="z-[60] max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-primary" />
            Search log
            {live && (
              <span className="ml-1 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                live
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {snapshot.length} step{snapshot.length === 1 ? "" : "s"} — everything the detective did, in order.
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="max-h-[60vh] overflow-y-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed"
        >
          {snapshot.length === 0 ? (
            <div className="text-muted-foreground">No log lines yet.</div>
          ) : (
            snapshot.map((e) => (
              <div key={e.id} className="flex items-start gap-2 whitespace-pre-wrap break-words">
                <span className="shrink-0 tabular-nums text-muted-foreground">[{formatElapsed(e.timestamp, startTs)}]</span>
                <span
                  className={cn(
                    "shrink-0",
                    e.status === "done" ? "text-confidence-high" : e.status === "running" ? "text-primary" : "text-muted-foreground"
                  )}
                >
                  {statusGlyph(e.status)}
                </span>
                <span className={cn(e.status === "info" ? "text-muted-foreground" : "text-foreground")}>{e.message}</span>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            <Copy className="mr-2 h-3.5 w-3.5" />
            Copy
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="mr-2 h-3.5 w-3.5" />
            Download .txt
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SearchLogDialog;
