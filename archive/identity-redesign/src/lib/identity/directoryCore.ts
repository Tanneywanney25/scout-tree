/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  src/lib/identity/directoryCore.ts
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  Pure, side-effect-free helpers for the directory client: request
       shaping, response parsing/normalization, memo keys. No network, no DOM
       — trivially unit-testable.
WHY:   Keep directory.ts thin and testable (scripts/test-directory* drive
       these directly).
DEPENDS-ON:     nothing (pure).
DEPENDED-ON-BY: src/lib/identity/directory.ts, scripts/test-directory-entry.ts.
RESTORE:        Copy the source below to src/lib/identity/directoryCore.ts.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// Directory core — the pure half of the Phase-A directory client.
//
// Types, wire parsing, ranking and filtering, with NO network or Supabase
// imports so the offline test harness (scripts/test-directory.mjs) can drive
// the exact code the UI uses. The network layer lives in ./directory.ts.
// ============================================================================

export interface DirectoryMember {
  id: string;
  name: string;
  state?: string;
  fideId?: string;
  title?: string;
  status?: string;
  expiration?: string;
  /** Any OR/OQ/OB rating on record → the tournament trace has events to work. */
  hasOnline: boolean;
  /** Best single rating for display/sorting. */
  rating?: number;
  ratings?: {
    regular?: number;
    quick?: number;
    blitz?: number;
    onlineRegular?: number;
    onlineQuick?: number;
    onlineBlitz?: number;
  };
}

export interface DirectoryEvent {
  eventId: string;
  name: string;
  startDate?: string;
  endDate?: string;
  sectionCount?: number;
  playerCount?: number;
  state?: string;
  city?: string;
}

export interface RosterPlayer {
  uscfId: string;
  name: string;
  rating?: number;
  state?: string;
}

export interface RosterSection {
  number: number;
  name?: string;
  players: RosterPlayer[];
}

export interface DirectoryRoster {
  eventId: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  sections: RosterSection[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);

/** Parse a wire member row defensively (the edge is trusted but versions drift). */
export function parseDirectoryMember(raw: unknown): DirectoryMember | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || typeof r.name !== "string" || !r.name) return null;
  const rr = (r.ratings && typeof r.ratings === "object" ? (r.ratings as Record<string, unknown>) : {}) as Record<string, unknown>;
  return {
    id: r.id,
    name: r.name,
    state: str(r.state),
    fideId: str(r.fideId),
    title: str(r.title),
    status: str(r.status),
    expiration: str(r.expiration),
    hasOnline: r.hasOnline === true,
    rating: num(r.rating),
    ratings: {
      regular: num(rr.regular),
      quick: num(rr.quick),
      blitz: num(rr.blitz),
      onlineRegular: num(rr.onlineRegular),
      onlineQuick: num(rr.onlineQuick),
      onlineBlitz: num(rr.onlineBlitz),
    },
  };
}

export function parseDirectoryEvent(raw: unknown): DirectoryEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.eventId !== "string" || !e.eventId || typeof e.name !== "string") return null;
  return {
    eventId: e.eventId,
    name: e.name,
    startDate: str(e.startDate),
    endDate: str(e.endDate),
    sectionCount: num(e.sectionCount),
    playerCount: num(e.playerCount),
    state: str(e.state),
    city: str(e.city),
  };
}

export function parseDirectoryRoster(raw: unknown, eventId: string): DirectoryRoster | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.sections)) return null;
  const sections: RosterSection[] = (r.sections as unknown[])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      number: num(s.number) ?? 0,
      name: str(s.name),
      players: Array.isArray(s.players)
        ? (s.players as unknown[])
            .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
            .filter((p) => typeof p.uscfId === "string" && typeof p.name === "string")
            .map((p) => ({
              uscfId: p.uscfId as string,
              name: p.name as string,
              rating: num(p.rating),
              state: str(p.state),
            }))
        : [],
    }));
  return {
    eventId,
    name: str(r.name),
    startDate: str(r.startDate),
    endDate: str(r.endDate),
    sections,
  };
}

/** Rating-band filter. Belt-and-suspenders: the edge filters too, but a stale
 *  deployment must not silently ignore the user's band. */
export function applyRatingBand(members: DirectoryMember[], minRating?: number, maxRating?: number): DirectoryMember[] {
  if (minRating === undefined && maxRating === undefined) return members;
  return members.filter((m) => {
    if (typeof m.rating !== "number") return false;
    if (minRating !== undefined && m.rating < minRating) return false;
    if (maxRating !== undefined && m.rating > maxRating) return false;
    return true;
  });
}

/** Presentation order for candidate lists: exact-ish name hits first, then
 *  state matches, then current members, then strength. Pure and testable. */
export function rankDirectoryMembers(members: DirectoryMember[], query: { name?: string; state?: string }): DirectoryMember[] {
  const qName = (query.name || "").toLowerCase().replace(/\s+/g, " ").trim();
  const qTokens = qName.split(" ").filter(Boolean);
  const score = (m: DirectoryMember): number => {
    let s = 0;
    const n = m.name.toLowerCase();
    for (const t of qTokens) if (n.includes(t)) s += 2;
    if (qName && n === qName) s += 2;
    if (query.state && m.state && query.state.toUpperCase() === m.state.toUpperCase()) s += 1.5;
    if (m.status && /expired|inactive|deceased/i.test(m.status)) s -= 1;
    if (typeof m.rating === "number") s += Math.min(1, m.rating / 2500);
    if (m.hasOnline) s += 0.25;
    return s;
  };
  return [...members].sort((a, b) => score(b) - score(a));
}
