<!--
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  docs/ux-identity-redesign.md
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  The full design document + rationale for the identity-discovery
       redesign (Phase A/Phase B split, the four doors, ConfirmPanel
       expectations, NoMatchDiagnosis, degradation behavior).
WHY:   The canonical narrative spec behind every file archived here.
DEPENDS-ON:     nothing (documentation).
DEPENDED-ON-BY: nothing (reference).
RESTORE:        Copy to docs/ux-identity-redesign.md.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
-->

# Identity Discovery UX Redesign

**Branch:** `feature/identity-discovery-ux`
**Status:** Design + working prototype
**Scope:** The `/find-player` experience — how a user goes from "whatever they know" to a confirmed player identity. The underlying resolution engine (tournament-graph traversal, school resolver, Google-index fallback) is deliberately untouched.

---

## 1. Who uses Find Player, and what do they actually know?

| Persona | What they know | What they want | How the current flow treats them |
|---|---|---|---|
| **The prepared parent/coach** | Full name, state, often the USCF ID from a wallchart or pairing sheet | A scout report before round 2 | Well served — an ID or name+state anchors instantly |
| **The casual opponent** | A first name and a face; maybe "the kid who beat me in round 3 at the Washington Open" | "Who was that, and how do they play?" | Poorly served — they must produce a *full* name before the engine even starts, and the tournament they DO remember is buried in an optional collapsible |
| **The partial-recall user** | "Smith… Smyth? Around 1600, plays in WA" | Help narrowing it down | Not served — the form takes a partial name, but the engine silently auto-picks a USCF member and burns minutes traversing the wrong person's history |
| **The explorer** | A state, a section, a rating band ("who are the strong juniors in my state?") | To browse, then drill in | Not served at all — there is no browse path |
| **The online-only scout** | Just a Lichess/Chess.com username | Skip discovery entirely | Served, but the shortcut lives on a different page (`/scout`) and the empty state only mentions it after a failed search |

The current design optimizes for the first persona and funnels everyone else through the same single form → long opaque search → hope.

## 2. The current journey, mapped

```
/find-player
  └─ ONE form. Name required. 15 optional fields in a collapsible
     ("Add anything else you know": rating, federation, IDs, state,
      club, school, age, username hint, tournament×5, free text)
        │  submit
        ▼
  Full-screen "AI detective" overlay
     · orbiting source nodes, live narration feed, eased progress bar
     · runs the ENTIRE ladder for a bare name:
       anchor (USCF/FIDE/AI) → tournament-graph traversal (minutes,
       runs to exhaustion) → Google index → school social graph →
       platform name search
     · no ETA, no phase map, no intermediate decision points
        ▼
  Results: up to 4 identity cards (confidence, evidence chips, accounts)
     · pick accounts → Generate Scout Report → /scout
  OR
  Empty state: "Try adding more detail — a rating, state, federation,
     tournament name or username hint all sharpen the search"
```

Two facts about the backend make the UX gap obvious:

1. **The edge function already answers "who could this be?" in under a second.** `searchUscfByName()` hits the public MUIR API (`ratings-api.uschess.org/api/v1/members?Fuzzy=…`) and returns up to 25 real members with name, state, every rating system, FIDE ID and online-history flag. Today that list is consumed by a heuristic (`rankMembers`) that silently picks the top 4 — the user never sees it.
2. **The expensive part (graph traversal) is only worth running once the person is right.** The engine spends minutes tracing the auto-picked member's tournament history. If the ranker guessed the wrong John Smith, all of it is wasted, and the user can't tell why the results look off.

## 3. Friction points

**F1 — The engine guesses; it should ask.** For any ambiguous name the system commits minutes of traversal to a heuristically chosen member. A human can disambiguate "which of these 6 John Smiths in WA" in two seconds given ratings and cities — and a human-confirmed anchor is *more* accurate than any ranker, not less.

**F2 — Zero feedback before commitment.** Typing a name gives no signal whether it matches 0, 1 or 50 USCF members. Users can't tell a good query from a hopeless one until after a multi-minute search fails.

**F3 — One monolithic entry point.** Tournament, school, state and rating are treated as *evidence hints* for a name-led search, not as *starting points*. The casual opponent who remembers the event but not the surname has no path at all.

**F4 — The long wait is opaque and unbounded.** The progress bar is a time-eased animation, not progress. There's no phase map ("we're on step 2 of 5"), no expectation-setting ("this player has online-rated history, tracing usually works" vs "no online events — we'll be down to leads"), and the only control is abort.

**F5 — Failure doesn't teach.** The empty state gives generic advice. The result object already carries `providerStatus` with per-source notes ("Skipped — …", "No USCF match") but the empty state ignores it, so the user never learns *which* stage failed or *what specifically* would help.

**F6 — Power-user shortcuts are buried.** The USCF ID field only appears after picking "Federation → USCF" inside the collapsible. A user holding a pairing card with the ID on it has to discover a two-level-deep field.

**F7 — Partial names dead-end.** MUIR's fuzzy search happily matches "Bhati" → "Bhatia", but the UI never exposes it; a misremembered spelling just produces a weak name-match and low-confidence noise.

## 4. The redesign

### Principle

> **Cheap, interactive disambiguation first; expensive, automated discovery second — and only on a human-confirmed anchor.**

Split the experience into two phases that match the backend's cost structure:

- **Phase A — Find the person** (instant, interactive, free): search/browse the public US Chess member directory by whatever the user has: full name, partial name, state, rating band, or the tournament they met at. Show real candidates. Let the user confirm.
- **Phase B — Find their accounts** (the existing deep engine, unchanged): run `resolveIdentity` with the confirmed USCF ID pinned — which is exactly the input the engine is already best at.

### 4.1 Entry: four doors instead of one form

```
┌──────────────────────────────────────────────────────────┐
│  Find a player                                            │
│  ┌────────────┬──────────────┬───────────┬─────────────┐ │
│  │ By name ▣  │ By tournament │  Browse   │ I have an ID │ │
│  └────────────┴──────────────┴───────────┴─────────────┘ │
│                                                          │
│  [ name or partial name………………………………]  [State ▾] [🔍]     │
│   ⌄ optional: rating range slider                        │
│                                                          │
│  results appear here as you search (≤1s):                │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Jane Smith · WA · 1642 rgl · ⚡online history       │  │
│  │   USCF 12345678 · expires 2027    [This is them →] │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ Jane R Smith · WA · 987 rgl                         │  │
│  │   USCF 87654321 · expired 2019    [This is them →] │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Can't find them? → Run deep discovery with what I typed  │
│  Only know their online username? → enter it directly     │
└──────────────────────────────────────────────────────────┘
```

- **By name** (default): one search box + a state select + an optional rating-range filter. Fires the instant USCF directory search (debounced). Partial names work because MUIR's fuzzy search works. Every candidate row shows the disambiguators a human actually uses: state, ratings, online-history badge, membership status.
- **By tournament**: search rated events by name (optionally filtered to a state) → pick the event → pick the section → the crosstable roster appears → "That's who I played." Solves the casual-opponent persona in three clicks, and pre-fills tournament context for the engine's evidence.
- **Browse**: state (+ rating band) → the directory listing for that state, strongest first. Solves the explorer persona.
- **I have an ID**: front-and-center USCF ID / FIDE ID / online username fields. No more two-level-deep discovery for power users. A username routes straight to `/scout` (the existing behavior, now discoverable *before* a failed search).

**Fallback honesty:** the instant search needs the edge function. If it's unreachable, the panel says so and offers the deep-discovery path directly — the current behavior, clearly labeled, rather than a silent degrade.

### 4.2 Confirm: set expectations before the long wait

Picking a candidate shows a confirmation card built from data we already have (no extra calls):

```
┌──────────────────────────────────────────────────────────┐
│  Jane Smith                                    WA · USCF  │
│  Regular 1642 · Quick 1500 · Online Regular 1580          │
│  USCF 12345678 · FIDE 3040498                             │
│                                                          │
│  ⚡ Has online-rated US Chess history — we can usually     │
│     trace players like this to their real accounts        │
│     through the tournaments they played.                  │
│                                                          │
│  ⌄ Add optional clues (username hint, school, club)       │
│                                                          │
│  [← not them]        [Find their online accounts →]       │
└──────────────────────────────────────────────────────────┘
```

- The **traceability signal** (`hasOnline`) is the single best predictor of how well Phase B will go. Saying it up front converts the opaque wait into an informed one: "online history → the trace usually confirms accounts" vs "no online events → expect leads, not confirmations, unless the clues help."
- **Progressive disclosure**: the old form's most useful optional fields (username hint, school, club) survive here as an opt-in collapsible — they feed the fallback ladder exactly as before.
- The confirmed pick runs the **unchanged engine** with `uscfId`, `name`, and `state` pinned. A user-confirmed ID is the strongest anchor the engine accepts, so this *raises* accuracy over the auto-ranker while cutting wasted traversals.

### 4.3 Search: keep the theater, add a map

The full-screen detective overlay works — it just needs to answer "where are we, and what's left?" A slim phase strip is added under the progress bar, driven by the provider names the engine already emits (`uscf`, `uscf-graph`, `google`, `school-graph`, `lichess`/`chesscom`):

```
Anchor ✓ → Tournament trace ⟳ → Web index · School graph · Name search
```

Phases light up as their providers report; phases the engine skips (because an earlier one succeeded) render as skipped. No engine changes — it's a pure projection of the existing event stream.

### 4.4 Results: failure that teaches

The empty state becomes a diagnosis, rendered from `result.providerStatus` + the query:

- *What we tried*: each provider with its actual note ("US Chess: no member match", "Tournament graph: no online events to trace", "Google index: nothing verifiable", "School graph: skipped").
- *What would help most*, ranked by what actually failed:
  - no USCF anchor → "Try the tournament search — find the event you met them at and pick them off the crosstable."
  - anchor but no online events → "A username hint or their school unlocks the fallback paths."
  - everything ran dry → "Enter their online username directly if you learn it."
- One-click pivots back into Phase A with the query preserved (switch to tournament tab, edit the name, pick a different candidate).

The success path keeps `IdentityResults` as is — evidence chips, confidence badges and namesake warnings are already the strongest part of the current UX.

## 5. Architecture changes

### New edge-function modes (thin wrappers, no new data sources)

All three ride the existing throttled/retrying MUIR client in `supabase/functions/resolve-identity/uscf.ts`; the browser can't call MUIR directly (no CORS). They are additive — every existing mode is untouched.

| Mode | Request | Response | Backing |
|---|---|---|---|
| `searchMembers` | `{ searchMembers: { name?, state?, minRating?, maxRating?, size? } }` | `{ available, members: DirectoryMember[] }` | existing `searchUscfByName` + a state-only listing variant |
| `searchEvents` | `{ searchEvents: { name?, state?, size? } }` | `{ available, events: DirectoryEvent[] }` | `GET /rated-events?Name=&StateCode=` (verified live) |
| `eventRoster` | `{ eventRoster: { eventId } }` | `{ available, sections: [{ name, number, players: [{ uscfId, name, rating, state }] }] }` | existing `fetchEventSections` + `fetchSectionPlayers` |

`DirectoryMember` carries `id, name, state, ratings{…}, hasOnline, fideId, title, status, expiration` — everything the candidate card renders.

### New client library

`src/lib/identity/directory.ts` — `searchMembers()`, `searchEvents()`, `fetchEventRoster()`, each calling the edge function with a short timeout, memoized, and resolving to `{ available: false }` on any failure so the UI can offer the deep-discovery fallback instead of erroring. Client-side rating-band filtering guards against the API ignoring `MinRating`/`MaxRating`.

### New UI components (`src/components/findplayer/`)

| Component | Role |
|---|---|
| `DiscoveryTabs` | The four-door entry: name / tournament / browse / ID |
| `CandidateList` + `CandidateCard` | Directory results with disambiguators and "This is them" |
| `TournamentPicker` | Event search → section → crosstable roster |
| `ConfirmPanel` | The confirmation card with the traceability signal + optional clues |
| `SearchPhaseStrip` | The phase map inside the search overlay |
| `NoMatchDiagnosis` | The provider-status-driven empty state |

`PlayerSearchForm` survives as the body of the "deep discovery" path (reached from "Can't find them?"), so nothing regresses for users who preferred the old flow, and FIDE-only/international players — who will never appear in the US Chess directory — still have a first-class path.

### Engine changes

**None.** `resolveIdentity(query)` already accepts `uscfId` and treats it as a near-decisive anchor; the school resolver and tournament-graph paths are untouched. The redesign changes *what query the engine receives* (a confirmed one), not how it resolves.

## 6. Why this maintains or improves accuracy

- A human-confirmed USCF ID replaces a heuristic top-4 guess as the traversal anchor — strictly better input, same engine.
- The tournament path pins both the person *and* tournament context (event name feeds `tournament-overlap` evidence exactly as before).
- Confidence scoring, namesake caps (`NAME_FALLBACK_MAX_CONFIDENCE`, `GOOGLE_FALLBACK_MAX_CONFIDENCE`) and the evidence UI are unchanged.
- Deep discovery from a bare name remains available — it's a labeled fallback rather than the only door.

## 7. Validation scenarios

| Scenario | Path through the new flow |
|---|---|
| Full name + state (current success case) | Name tab → 1–2 candidates → confirm → engine runs with pinned ID. Same success, minus the guessing risk. |
| Only a name (current failure case) | Name tab → candidate list gives instant signal (0, 3 or 40 matches) → user disambiguates by state/rating shown on the cards, or picks "deep discovery" knowingly. |
| Partial name + rating range | MUIR fuzzy matches the fragment; the rating filter trims the list; candidate cards do the rest. |
| Browse a state / tournament | Browse tab lists the state's players by strength; tournament tab walks event → section → roster. Both end at the same confirm panel. |

Offline test coverage (`scripts/test-directory.mjs`) fakes the MUIR API in-memory (same pattern as `test-school-uscf.mjs`) and drives the real edge handlers + client library through all four scenarios, plus the edge-unavailable degrade.

## 8. Out of scope / future

- **Typeahead-as-you-type** into the engine itself (the current prototype debounces a directory search; wiring it into a `cmdk` command palette is a cosmetic follow-up).
- **NWSRS / state-association directories** as additional Phase-A sources for scholastic players (the school resolver already consumes them in Phase B).
- **Saved candidates / recent searches** for coaches who scout the same section repeatedly.
- **FIDE directory search** for the tournament path abroad (chess-results.com would be the Phase-A analog; today FIDE-only players use deep discovery).
