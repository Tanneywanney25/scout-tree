# ADR 0002 — Online series the roster index cannot reach

- **Status:** Accepted. A permanent limitation, recorded so it is not attempted again.
- **Date:** 2026-10-04
- **Branch:** `traversal/section-bfs`

## Problem

Identity resolution works by matching a USCF online section's crosstable to the
tournament it was played in, on a platform whose rosters and results are public
(Chess.com tournament brackets, Lichess swiss exports). A section played
somewhere with no public roster cannot be matched by any amount of crawling.
Target discovery on 2026-10-03 (`docs/roster-index.md`, "Mass pre-resolution and
target discovery") found two large series outside the index and settled one of
them.

## Permanently unreachable: HERMOVENEXT / Impact Coaching Network

About **653 cached online sections** (HerMoveNext "Her League", Impact Coaching
Network scholastic leagues, and the school events rated under the ICN
affiliate).

**Mechanism.** The organiser runs its own playing server. Its league page
(`impactcoachingnetwork.org/onlinescholasticchessleague`) names the venue as the
"ICN Online Playing Platform" at `online.impactcoachingnetwork.org` and requires
an active US Chess ID; that host redirects to a login page titled "Chess
Platform". There is no public tournament list, roster, pairing or game export,
and no documented API. HerMoveNext's RSVP page says players in its US Chess
rated matches must be "logged in to both chess platform and Zoom"; it does not
name the platform. A Lichess team search for the organiser returns only an
unofficial three-member team with no events, and the Chess.com tournament lists
of two members hold no matching event.

**What was not verified.** That Her League (2021-03 to 2026-06) uses the same
ICN server as the ICN leagues; the software behind the server. Neither changes
the conclusion: no public roster was found for either.

**Decision.** Treat these sections like ICC and ChessKid sections: untraceable.
Do not crawl for them, do not queue them for the roster crawler, and do not
spend discovery time on them again. A player whose only online-rated sections
are in this series cannot be resolved from tournament play; the search should
say so rather than walk.

**What would reopen this.** The organiser publishing results pages or an export,
or moving the leagues to a public platform. Logging in with an account to scrape
the private server is not an option the project takes.

## Unresolved, not impossible: PLAY N STAY (Chess NYC)

About **659 cached online sections**, 2020-04-19 to 2021-05-16, named
"SECTION n" (up to 24 per event), three rounds each, with no affiliate in the
cached records.

**What is known.** The organiser is Chess NYC ("Play N Stay Online Chess
League hosts 3 USCF rated matches every Sunday"); no page names the platform.
Of 17 identities already held for the first 60 members, 15 are Lichess (14
strong) and 2 Chess.com. Chess NYC's Lichess teams have swisses whose names
("TAG 1 Rapid" and similar) do not match the series, and with 217 section dates
in 13 months their date overlap is at chance level. One member's Lichess games
in that period are all casual direct challenges (`source: friend`), which would
mean the pairings were made by hand and no tournament roster exists.

**Status.** Probably unreachable through tournament rosters, but that rests on
one member. The check that settles it: for two or three members with strong
Lichess identities, export their games on a Play N Stay date
(`/api/games/user/{name}?since=…&until=…`) and see whether the opponents are the
members' crosstable opponents and whether `source` is `friend` or `swiss`. If
they are direct challenges against crosstable opponents, the series can still be
resolved, not through the roster index but by aligning the crosstable against
members' own game lists (the existing section walk does this from a seed
handle). If nothing matches, record it here as unreachable.

## Consequences

- Roughly 1,300 of the ~7,100 online sections the five crawled series do not
  explain are accounted for: 653 permanently out of reach, 659 pending one
  check.
- Coverage figures for the roster index should be stated against the reachable
  population, with these named as the known hole.
