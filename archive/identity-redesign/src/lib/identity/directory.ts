/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/lib/identity/directory.ts
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  The Phase-A directory client. Graceful-degrade wrappers over the
       resolve-identity edge modes (searchMembers / searchEvents /
       eventRoster) with per-query memoization; on outage it degrades to an
       explicit failure the UI surfaces as a banner rather than a silent empty
       result.
WHY:   Cheap, interactive directory lookups that never touch the expensive
       resolution engine.
DEPENDS-ON:     src/lib/identity/directoryCore.ts (pure helpers),
                supabase/functions/resolve-identity edge modes
                searchMembers / searchEvents / eventRoster.
DEPENDED-ON-BY: src/components/findplayer/DiscoveryTabs.tsx,
                src/components/findplayer/TournamentPicker.tsx,
                src/components/findplayer/ConfirmPanel.tsx.
NOTE:           NOT part of the live intelligence layer (resolver / conductor /
                engines). This is a separate Phase-A client and is intentionally
                inactive here.
RESTORE:        Copy the source below to src/lib/identity/directory.ts. Requires
                the supabase edge modes (archived under
                archive/identity-redesign/supabase/...) to be restored too.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// Player directory client — Phase A of the discovery UX (network layer).
//
// Instant, cheap lookups against the public US Chess member directory (via the
// resolve-identity edge function's directory modes) so the USER can find and
// confirm the person before the expensive resolution engine runs:
//
//   searchDirectoryMembers  — name / partial name / state / rating band → rows
//   searchDirectoryEvents   — tournament name / state → rated events
//   fetchDirectoryRoster    — event → sections → crosstable roster
//
// Everything degrades gracefully: any failure resolves to { available: false }
// so the UI can offer deep discovery instead of erroring. The pure half
// (types, parsing, ranking, filtering) lives in ./directoryCore.ts so the
// offline harness (scripts/test-directory.mjs) can drive the same code.
// ============================================================================

import { supabase } from "@/integrations/supabase/client";
import {
  applyRatingBand,
  parseDirectoryEvent,
  parseDirectoryMember,
  parseDirectoryRoster,
  rankDirectoryMembers,
  type DirectoryEvent,
  type DirectoryMember,
  type DirectoryRoster,
} from "./directoryCore";

export * from "./directoryCore";

export interface MemberSearchRequest {
  name?: string;
  state?: string;
  uscfId?: string;
  minRating?: number;
  maxRating?: number;
  size?: number;
}

export interface MemberSearchResult {
  available: boolean;
  members: DirectoryMember[];
}

export interface EventSearchResult {
  available: boolean;
  events: DirectoryEvent[];
}

export interface RosterResult {
  available: boolean;
  roster: DirectoryRoster | null;
}

/** Same hard-timeout invoke pattern as edgeClient's — a hung request must
 *  degrade to "directory unavailable", never wedge the search box. */
async function invokeDirectory(body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      supabase.functions.invoke("resolve-identity", { body }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    if (!result) return null;
    const { data, error } = result as { data: Record<string, unknown> | null; error: { message?: string } | null };
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Short-lived memo per request key: typeahead re-fires the same query as the
// user backspaces, and the directory answer doesn't change mid-session.
// Failures are never remembered.
const memo = new Map<string, Promise<{ available: boolean }>>();
function memoized<T extends { available: boolean }>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit) return hit as Promise<T>;
  const p = fn();
  memo.set(key, p);
  p.then(
    (r) => {
      if (!r.available) memo.delete(key);
      else setTimeout(() => memo.delete(key), ttlMs);
    },
    () => memo.delete(key)
  );
  return p;
}

export async function searchDirectoryMembers(req: MemberSearchRequest, signal?: AbortSignal): Promise<MemberSearchResult> {
  const name = (req.name || "").trim();
  const state = (req.state || "").trim();
  const uscfId = (req.uscfId || "").trim();
  if (!name && !state && !uscfId) return { available: true, members: [] };
  const key = JSON.stringify(["members", name.toLowerCase(), state.toUpperCase(), uscfId, req.minRating, req.maxRating, req.size]);
  return memoized(key, 5 * 60_000, async () => {
    if (signal?.aborted) return { available: false, members: [] };
    const data = await invokeDirectory(
      {
        searchMembers: {
          name: name || undefined,
          state: state || undefined,
          uscfId: uscfId || undefined,
          minRating: req.minRating,
          maxRating: req.maxRating,
          size: req.size,
        },
      },
      20_000
    );
    if (!data || data.available === false || !Array.isArray(data.members)) {
      return { available: false, members: [] };
    }
    const members = (data.members as unknown[]).map(parseDirectoryMember).filter((m): m is DirectoryMember => !!m);
    const banded = applyRatingBand(members, req.minRating, req.maxRating);
    return { available: true, members: rankDirectoryMembers(banded, { name, state }) };
  });
}

export async function searchDirectoryEvents(
  req: { name?: string; state?: string; size?: number },
  signal?: AbortSignal
): Promise<EventSearchResult> {
  const name = (req.name || "").trim();
  const state = (req.state || "").trim();
  if (!name && !state) return { available: true, events: [] };
  const key = JSON.stringify(["events", name.toLowerCase(), state.toUpperCase(), req.size]);
  return memoized(key, 5 * 60_000, async () => {
    if (signal?.aborted) return { available: false, events: [] };
    const data = await invokeDirectory({ searchEvents: { name: name || undefined, state: state || undefined, size: req.size } }, 20_000);
    if (!data || data.available === false || !Array.isArray(data.events)) {
      return { available: false, events: [] };
    }
    const events = (data.events as unknown[]).map(parseDirectoryEvent).filter((e): e is DirectoryEvent => !!e);
    return { available: true, events };
  });
}

export async function fetchDirectoryRoster(eventId: string, signal?: AbortSignal): Promise<RosterResult> {
  const id = (eventId || "").trim();
  if (!id) return { available: false, roster: null };
  const key = JSON.stringify(["roster", id]);
  return memoized(key, 10 * 60_000, async () => {
    if (signal?.aborted) return { available: false, roster: null };
    const data = await invokeDirectory({ eventRoster: id }, 45_000);
    const roster = data && data.available !== false ? parseDirectoryRoster(data.roster, id) : null;
    return roster ? { available: true, roster } : { available: false, roster: null };
  });
}
