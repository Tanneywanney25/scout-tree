# ADR 0003 — One coverage floor for the index join: 90%, and a size floor

- **Status:** Accepted. The code change is applied and deployed after the
  2026-10-04 measurement batch finishes (the engine is frozen at tag
  `measure-20261004` until then); see "Rollout".
- **Date:** 2026-10-04
- **Branch:** `traversal/section-bfs`

## Problem

The index join matches a USCF section's crosstable against crawled tournament
rosters and accepts a candidate that explains enough of the crosstable.
`indexTrusted()` had two bars. The bulk pre-resolution required 90% coverage.
The search-time join, the path users see, also accepted a candidate at 75% when
it was the only candidate in the date window and the section had at least 10
players. The 90% floor came from evidence (three known false positives at
67–71%, 45 true matches all above 90%); the 75% clause came from the same three
cases and nothing else. Production ran looser than the standard the evidence
produced, and the difference was written down nowhere.

## What was measured

2026-10-04 01:00 UTC, on a snapshot of the store (7,527 crawled rosters, 6,057
cached online sections with a crosstable): every section joined exactly as
production joins it, then every accepted join cross-checked against identities
proven in a *different* section. A join is contradicted when more of its
cross-checkable members hold a different handle elsewhere than hold the same
one. Script and snapshot: session scratchpad `floor/` (`floor-run.mjs`,
re-runnable from the snapshot with no database request). A second agent
re-derived every number below with its own loader and code and got the same
counts; its corrections to the interpretation are folded in.

| Band | Sections | Contradicted | Member-level disagreement |
|---|---|---|---|
| **The clause: 75–90%, single candidate, ≥ 10 players** | 13 | **0 of 13** (95% CI 0–22.8%) | 6 of 473 = **1.3%**; 2.7% counting active edges only |
| ≥ 90%, any section | 4,383 | 6 of 4,382 = 0.1% | 180 of 62,551 = 0.3% |
| ≥ 90%, single candidate, ≥ 10 players (like for like) | 308 | 0 | 42 of 10,930 = 0.4%; 1.2% counting active edges only |
| 75–90%, rejected today, ≥ 10 players (several candidates) | 31 | 0 | pooled with the clause band: 20 of 961 = 2.1% |
| 75–90%, rejected today, < 10 players | 26 | **21 of 23** checkable | — |

Three things follow.

1. **The clause made no wrong tournament match, on 13 sections** (16 on a
   re-read fifteen minutes later, still none; each confirmed by 30 to 54
   members, at least 14 of them through game records rather than rosters). That
   bounds its error below about 20%, not below anything useful, and the band is
   uniform: 12 of the 13 are one Chess.com series and all have 34 to 78 players,
   a size at which a coincidental match is essentially impossible. Between 10
   and 33 players, where the clause would matter, there is almost no evidence:
   one section of 19 players that production linked under the clause (14 of 14
   members agree), and two of 12 and 16 players in the batch log whose
   crosstables this session's own cache sweep had already removed, so they
   could not be checked.
2. **Its handles are probably wrong more often, about two to three times the
   like-for-like rate under every counting rule:** 1.3% against 0.4% counting
   edges of every status, 2.7% against 1.2% on active edges, 3.6% against 1.9%
   when a member with both a matching and a different handle elsewhere is
   scored by the stronger evidence. This rests on 6 to 17 disagreements from a
   handful of members who recur across sections, so the naive intervals are too
   narrow; a section-clustered bootstrap puts the difference at +0.9 points
   (95% 0.02 to 1.9). Likely, not established.
3. **It buys almost nothing.** 13 of 4,396 accepted joins, 0.3%.

What separates right from wrong in the 75–90% band is section size, not the
candidate count: with ten or more players every join checked was right (44 of
44), with fewer than ten almost every one was wrong (21 of 23). The
single-candidate condition rejected no bad join.

## A second finding: the wrong matches are in tiny sections

All six contradicted joins at 90% and above have **3 to 5 players, 100%
coverage and several candidates**:

| Players who played | Joins ≥ 90% | Contradicted | Member-level disagreement |
|---|---|---|---|
| 3 | 16 | 1 | 3 of 39 = 7.7% |
| 4 | 279 | 3 | 13 of 1,109 = 1.2% |
| 5 | 311 | 2 | 9 of 1,546 = 0.6% |
| 6–7 | 649 | 0 | 12 of 4,184 = 0.3% |
| 8–9 | 577 | 0 | 9 of 4,784 = 0.2% |
| 10+ | 2,551 | 0 | 134 of 50,889 = 0.3% |

A three-round quad has few enough results that another quad of the same day can
reproduce them exactly. Coverage cannot see this: the coincidental match covers
100%. The six are in the store today, written by the bulk pre-resolution.

## Decision

1. **One floor, 90%, on every blind index join.** The 75% single-candidate
   clause is removed from `indexTrusted()`. The measurement does not show the
   clause to be unsafe; it shows that the clause is unmeasured in the size range
   where it could be, that its handles are probably worse, and that it is worth
   0.3% of joins. That does not justify a looser standard on the path users see
   than the one the evidence produced.
2. **No blind index join for a section of fewer than 4 players, on either
   path.** The bulk pre-resolution has refused them since `fabc2b5`; the
   search-time join gets the same rule in `indexTrusted()` in the same rollout.
   It had no size floor at all: an autopsy of this run found a search that
   linked a 3-player and a 2-player "side games" section of one organiser to
   another organiser's scholastic swisses. The 12 verified index links on
   sections under 4 players were retired (2 active edges retired, 28 edges that
   also rest on other sections had the reference removed), and the rollout
   retires whatever the frozen engine writes until it is deployed.
3. **The bulk pre-resolution writes no join the store contradicts** (more
   members holding a different proven handle than the same one). The six known
   wrong links were retired; of the 25 edges resting on them, the store's own
   conflict rules had already superseded 23.
4. **Recorded, not yet built:** the same store cross-check in the search-time
   join (`rosterIndex.ts`). Sections of 4 and 5 players stay joinable (99% of
   them are right) and are where it matters.

## Rollout

The measurement batch runs on frozen engine code, so the one-line change to
`supabase/functions/_shared/rosterIndexCore.ts` is not made while it runs. A
detached step (`acc7/apply-floor3.sh` in the session scratchpad, log `acc7/apply-floor.log`) waits for the
batch to log DONE, then makes the change, runs the alignment test, commits,
pushes, deploys `resolve-identity`, and calls the function once to check it
answers; if that check fails it reverts the commit and deploys the previous
code. If the step never ran, the change is:

```ts
export function indexTrusted(trusted: boolean, assigned: number, played: number, _candidates?: number, _strict?: boolean): boolean {
  if (!trusted || played < 4) return false;
  return assigned / played >= 0.9;
}
```

## What would reopen this

A clause band large and varied enough to bound its error: a few hundred
sections, including many of 10 to 33 players, with member-level disagreement at
the baseline. The band grows slowly as more sections are cached (13 to 16 in
fifteen minutes of this run), so the measurement can be repeated from
`floor/floor-run.mjs` once the store is several times larger.
