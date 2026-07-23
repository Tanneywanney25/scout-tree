<!--
============================================================
ARCHIVED REDESIGN ARCHITECTURE — MASTER MANIFEST
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
============================================================
This directory holds the COMPLETE, restorable source of the "identity
discovery redesign" (the confirm-first, four-door Player Discovery UX). It was
removed from the active application and preserved here on purpose. Nothing in
this folder is compiled, linted, bundled, or executed: `archive/` is outside
the TypeScript `include` ("src"), is added to the eslint `ignores`, and none of
these files are imported by any live module.

Every file in this folder begins with an `ARCHIVED REDESIGN ARCHITECTURE`
banner (block comment for code, HTML comment for markdown) describing WHAT it
did, WHY it existed, what it DEPENDS-ON, what DEPENDED-ON it, and how to
RESTORE it. A future reader (human or AI) can reconstruct the whole feature
from this manifest plus those banners.

To find everything: search the repository for the marker string
    ARCHIVED REDESIGN ARCHITECTURE
============================================================
-->

# Identity Discovery Redesign — Archived Architecture

## What this was

A redesign of the **Find Player** page from a single "type a name and hope"
form into a **confirm-first funnel**, split into two phases:

- **Phase A — cheap, interactive disambiguation** against the public US Chess
  directory. Four entry "doors": **By name**, **Tournament**, **Browse**, and
  **I have an ID**. The user converges on the exact person and confirms them.
- **Phase B — the expensive resolution engine** (the intelligence layer:
  `resolver` / `conductor` / engines) runs **only on a human-confirmed
  anchor**, so it never has to guess between namesakes.

The public-facing copy of this design was the "ScoutTree — Find anyone. Scout
everyone. / Player Discovery" landing experience with the four doors, the
"You confirm, we trace" / "Evidence, not guesses" highlights, live phase strip,
and the NoMatchDiagnosis empty state.

## What was KEPT ACTIVE (NOT archived — this is the intelligence layer)

The redesign explicitly left the resolution engine untouched. These live on and
are unrelated to this archive:

- `src/lib/identity/resolver.ts`, `conductor.ts`, `net.ts`,
  `uscfGraphEngine.ts`, `schoolResolver.ts`, `providers/schoolResolver.ts`
- `supabase/functions/resolve-identity/*` — the pre-existing resolution modes.
- The live `src/pages/FindPlayer.tsx` (single-form `PlayerSearchForm` variant)
  and the live `SearchExperience.tsx`.

## File map

| Archived path (under this folder) | Original path | Type |
|---|---|---|
| `src/pages/FindPlayer.tsx` | `src/pages/FindPlayer.tsx` | MODIFIED (full redesign version) |
| `src/components/findplayer/SearchExperience.tsx` | same | MODIFIED (full redesign version) |
| `src/components/findplayer/DiscoveryTabs.tsx` | same | NEW |
| `src/components/findplayer/CandidateList.tsx` | same | NEW |
| `src/components/findplayer/ConfirmPanel.tsx` | same | NEW |
| `src/components/findplayer/NoMatchDiagnosis.tsx` | same | NEW |
| `src/components/findplayer/SearchPhaseStrip.tsx` | same | NEW |
| `src/components/findplayer/TournamentPicker.tsx` | same | NEW |
| `src/components/findplayer/usStates.ts` | same | NEW |
| `src/lib/identity/directory.ts` | same | NEW |
| `src/lib/identity/directoryCore.ts` | same | NEW |
| `supabase/functions/resolve-identity/index.ts` | same | MODIFIED (full redesign version) |
| `supabase/functions/resolve-identity/uscf.ts` | same | MODIFIED (full redesign version) |
| `scripts/test-directory-entry.ts` | same | NEW |
| `scripts/test-directory.mjs` | same | NEW |
| `docs/ux-identity-redesign.md` | same | NEW (design doc) |
| `patches/*.delta.patch` | — | Exact unified diffs for the MODIFIED files |

## Dependency graph (redesign cluster only)

```
FindPlayer.tsx (redesign)
├── DiscoveryTabs.tsx
│   ├── CandidateList.tsx
│   ├── TournamentPicker.tsx ──> directory.ts, CandidateList.tsx, usStates.ts
│   ├── usStates.ts
│   └── directory.ts ──> directoryCore.ts ──> [edge] resolve-identity: searchMembers/searchEvents/eventRoster
│                                                        └── uscf.ts: directoryMemberSearch/searchRatedEvents/fetchEventRoster
├── ConfirmPanel.tsx ──> directory.ts
├── NoMatchDiagnosis.tsx
└── SearchExperience.tsx (redesign) ──> SearchPhaseStrip.tsx

scripts/test-directory.mjs ──> test-directory-entry.ts ──> directory.ts, directoryCore.ts, edge handlers
```

The four NEW files (`directory.ts`, `directoryCore.ts`, and the edge additions)
are a **separate Phase-A directory client** — they are NOT part of the live
intelligence layer and were archived on purpose.

## How to restore the whole feature

1. Copy every **NEW** file from its archived path back to its `Original-Path`
   (strip the leading `ARCHIVED …` banner comment). Order doesn't matter for
   NEW files; imports resolve once all are present.
2. For the four **MODIFIED** files, either:
   - replace the live file with the archived full redesign version (strip the
     banner), **or**
   - apply the matching `patches/<name>.delta.patch` on top of the live file
     to reapply only the redesign delta.
   The redesign changes to `SearchExperience.tsx`, `index.ts`, and `uscf.ts`
   are **purely additive**; `FindPlayer.tsx` is a full rewrite of the page
   controller.
3. Remove `archive` from the eslint `ignores` list only if you want these
   restored copies re-linted from here (normally you just delete the archive
   after restoring).
4. Re-run: `npm run build` and (for Phase A) `node scripts/test-directory.mjs`.

## Provenance

Original commit: `1b31ced` — "feat(find-player): redesign identity discovery
around user-confirmed candidates". Use `git show 1b31ced` for the original
author commit message and full diff.
