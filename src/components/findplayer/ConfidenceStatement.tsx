import { cn } from "@/lib/utils";
import type { DiscoveredAccount } from "@/lib/identity";

/** What kind of proof stands behind an account's confidence number. */
export type ProofKind = "id-anchored" | "tournament-verified" | "name-only";

/** Classify the account's strongest proof from its evidence trail. */
export function proofKind(account: Pick<DiscoveredAccount, "evidence" | "verified">): ProofKind {
  const ev = account.evidence || [];
  if (ev.some((e) => (e.kind === "fide-id-match" || e.kind === "uscf-id-match") && e.weight >= 3.5)) return "id-anchored";
  const namesake = ev.some((e) => /namesake/i.test(e.label));
  if (!namesake && ev.some((e) => (e.kind === "shared-opponent" || e.kind === "tournament-overlap") && e.weight > 0)) {
    return "tournament-verified";
  }
  return "name-only";
}

interface ConfidenceStatementProps {
  account: DiscoveredAccount;
  className?: string;
}

/**
 * A "72%" arriving cold at the end of an opaque wait means nothing. This turns
 * the number into the sentence the user actually needs: what we believe, and
 * WHAT KIND of proof stands behind it. Presentation only — no threshold or cap
 * changes anywhere.
 */
export function ConfidenceStatement({ account, className }: ConfidenceStatementProps) {
  const c = account.confidence;
  const proof = proofKind(account);

  let headline: string;
  let detail: string;
  let tone: "high" | "medium" | "low";

  if (c >= 0.9 && proof === "id-anchored") {
    headline = "Confirmed.";
    detail = "Their federation ID is linked on this account — the strongest match there is.";
    tone = "high";
  } else if (c >= 0.75) {
    headline = "Very likely them.";
    detail =
      proof === "tournament-verified"
        ? "Matched through games they actually played in a US Chess event."
        : "Multiple independent details line up, but no tournament game pins it down.";
    tone = "high";
  } else if (c >= 0.45) {
    headline = "Probably them, worth a look.";
    detail =
      proof === "tournament-verified"
        ? "Tournament evidence points here, but not conclusively."
        : "Same name and similar details — no tournament game confirms it.";
    tone = "medium";
  } else {
    headline = "Weak lead.";
    detail = "Could easily be someone else with the same name. Check the profile before trusting it.";
    tone = "low";
  }

  return (
    <p className={cn("text-sm leading-snug", className)}>
      <span
        className={cn(
          "font-semibold",
          tone === "high" && "text-confidence-high",
          tone === "medium" && "text-confidence-medium",
          tone === "low" && "text-confidence-low"
        )}
      >
        {headline}
      </span>{" "}
      <span className="text-muted-foreground">{detail}</span>
    </p>
  );
}

export default ConfidenceStatement;
