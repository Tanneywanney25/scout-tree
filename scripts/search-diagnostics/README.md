# Search diagnostics

Throwaway-turned-durable measurement scripts for the SearXNG retrieval layer.
Kept because the questions they answer recur, and because two of them already
caught claims that were wrong. All are zero-cost and hit only free endpoints.

| Script | Answers | Needs retrieval working? | Caveats |
|---|---|---|---|
| `engine-health.mjs` | Are the engines suspended, and do suspensions decay? | no | **One query per run by design.** Run on a timer with `--append` and read the JSONL. Exits non-zero when retrieval is unusable. |
| `harvest-coverage.mjs` | Do correct handles appear literally in result URLs? (the premise of the rejected "drop the model" proposal) | **yes** | Ground truth comes from chess.com's own API, so it is biased toward titled players — an upper bound. Excludes players that returned no hits rather than counting them as misses. Needs ~100 queries, which currently re-suspends the engines partway through. |
| `stagger-trial.mjs` | Does staggering queries recover blocked engines? | **yes** | Interleaves conditions and cools down between runs, because blocking is cumulative. Repeated identical queries may be served from SearXNG's own cache, so trust the per-engine `unresponsive` counts over the hit counts. |
| `handle-name-resemblance.mjs` | How often does a handle resemble the player's real name? (bounds any name-similarity verifier) | no — chess.com API only | Reports a STRICT and a LENIENT bound; the lenient one is the defensible figure. An earlier strict-only version over-reported by 9 points. |
| `proxy-retry-cost.mjs` | What does an unreachable optional AI backend cost per call? | no | Models both `geminiFetch` retry branches. An earlier version modelled only the 5xx branch and reported 2ms instead of ~25s. |

## The one number to re-measure on a schedule

Engine suspension. Measured 2026-10-02: after ~5 hours idle, duckduckgo +
google cse + wikipedia had recovered (26 results); brave and google (CAPTCHA)
had not. Capacity inside that window was about **12 queries** before
re-suspension, and duckduckgo then escalated from `timeout` to `access denied`.
A discovery request costs 8 queries, so this address supports roughly one or
two lookups per recovery window. If that ratio ever improves materially, the
decision recorded in `docs/adr/0001-searxng-search-pipeline.md` should be
revisited.

```bash
node scripts/search-diagnostics/engine-health.mjs --append
```
