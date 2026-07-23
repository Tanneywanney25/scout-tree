/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  scripts/test-directory-entry.ts
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  Offline test entry: fakes MUIR in-memory and drives the REAL edge +
       directory-client code through the four validation scenarios (name+state,
       name only, partial name + rating band, browse/tournament) plus outage
       handling — 24 assertions.
WHY:   Prove the Phase-A path without network access.
DEPENDS-ON:     src/lib/identity/directory.ts, directoryCore.ts, and the
                resolve-identity edge handlers.
DEPENDED-ON-BY: scripts/test-directory.mjs (runner).
RESTORE:        Copy to scripts/.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// ============================================================================
// TEST HARNESS: the Phase-A directory (discovery UX redesign), offline
// (bundled + run by scripts/test-directory.mjs). Fakes the MUIR ratings API
// in-memory, then drives the REAL code the feature ships:
//   · edge:   directoryMemberSearch / searchRatedEvents / fetchEventRoster
//   · client: parseDirectoryMember / applyRatingBand / rankDirectoryMembers /
//             parseDirectoryEvent / parseDirectoryRoster
//
//   node scripts/test-directory.mjs
//
// Scenarios (the four validation cases from docs/ux-identity-redesign.md):
//   1. Full name + state  → the right candidates, active+online member ranked first
//   2. Name only          → homonyms across states all surface for the user to pick
//   3. Partial name + rating band → fuzzy match narrows correctly
//   4. Browse by state + tournament → state listing and event→roster→player walk
//   5. Directory outage   → empty results, never a throw; parsers reject junk
// ============================================================================

import {
  directoryMemberSearch,
  searchRatedEvents,
  fetchEventRoster,
  bestRating,
  type UscfSearchRow,
} from "../supabase/functions/resolve-identity/uscf";
import {
  parseDirectoryMember,
  parseDirectoryEvent,
  parseDirectoryRoster,
  applyRatingBand,
  rankDirectoryMembers,
  type DirectoryMember,
} from "../src/lib/identity/directoryCore";

// ---------------------------------------------------------------------------
// Fake MUIR
// ---------------------------------------------------------------------------

const R = (system: string, rating?: number) => ({ ratingSystem: system, rating, isProvisional: false });

const MEMBERS = [
  {
    id: "12345678",
    firstName: "Jane",
    lastName: "SMITH",
    stateRep: "WA",
    fideId: "3040498",
    status: "Active",
    expirationDate: "2027-01-31",
    ratings: [R("R", 1642), R("Q", 1500), R("OR", 1580)],
  },
  {
    id: "87654321",
    firstName: "Jane R",
    lastName: "SMITH",
    stateRep: "WA",
    status: "Expired",
    expirationDate: "2019-06-30",
    ratings: [R("R", 987)],
  },
  {
    id: "11223344",
    firstName: "Jane",
    lastName: "SMITH",
    stateRep: "NY",
    status: "Active",
    expirationDate: "2026-12-31",
    ratings: [R("R", 2101)],
  },
  {
    id: "15854931",
    firstName: "AARAV",
    lastName: "BHATI",
    stateRep: "IL",
    status: "Expired",
    expirationDate: "2020-11-30",
    ratings: [R("R", 360), R("Q", 359)],
  },
  {
    id: "16538484",
    firstName: "Tanush",
    lastName: "BHATIA",
    stateRep: "WA",
    fideId: "39970841",
    status: "Active",
    expirationDate: "2027-05-31",
    ratings: [R("R", 1696), R("Q", 1119), R("OR", 1072), R("OB", 1195)],
  },
];

const EVENTS = [
  {
    id: "202605250373",
    name: "2026 Washington Open",
    startDate: "2026-05-23",
    endDate: "2026-05-25",
    sectionCount: 2,
    playerCount: 309,
    stateCode: "WA",
    city: "REDMOND",
  },
  {
    id: "202607180273",
    name: "Grand Knights Classical Quads",
    startDate: "2026-07-18",
    endDate: "2026-07-18",
    sectionCount: 1,
    playerCount: 9,
    stateCode: "WA",
    city: "BELLEVUE",
  },
  {
    id: "202603150111",
    name: "NY Spring Masters",
    startDate: "2026-03-15",
    endDate: "2026-03-15",
    sectionCount: 1,
    playerCount: 24,
    stateCode: "NY",
    city: "NEW YORK",
  },
];

const STANDINGS: Record<string, Record<number, unknown[]>> = {
  "202605250373": {
    1: [
      {
        memberId: "12345678",
        firstName: "Jane",
        lastName: "SMITH",
        stateRep: "WA",
        ratings: [{ preRating: 1642 }],
        roundOutcomes: [
          { roundNumber: 1, color: "White", outcome: "Win", opponentMemberId: "16538484", opponentFirstName: "Tanush", opponentLastName: "BHATIA" },
        ],
      },
      {
        memberId: "16538484",
        firstName: "Tanush",
        lastName: "BHATIA",
        stateRep: "WA",
        ratings: [{ preRating: 1696 }],
        roundOutcomes: [
          { roundNumber: 1, color: "Black", outcome: "Loss", opponentMemberId: "12345678", opponentFirstName: "Jane", opponentLastName: "SMITH" },
        ],
      },
    ],
    2: [
      {
        memberId: "87654321",
        firstName: "Jane R",
        lastName: "SMITH",
        stateRep: "WA",
        ratings: [{ preRating: 987 }],
        roundOutcomes: [],
      },
    ],
  },
};

let muirDown = false;
const J = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

function fullName(m: (typeof MEMBERS)[number]): string {
  return `${m.firstName} ${m.lastName}`.toLowerCase();
}

globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(String(input));
  if (muirDown) return J({ error: "boom" }, 500);
  if (url.hostname !== "ratings-api.uschess.org") return J({ error: "unexpected host" }, 404);
  const path = url.pathname.replace(/^\/api\/v1/, "");

  // /members?Fuzzy=&StateRep=&Size=
  if (path === "/members") {
    const fuzzy = (url.searchParams.get("Fuzzy") || "").toLowerCase().trim();
    const state = url.searchParams.get("StateRep") || "";
    let rows = MEMBERS;
    if (fuzzy) {
      // MUIR-ish fuzzy: any token substring-matches the full name.
      const tokens = fuzzy.split(/\s+/).filter(Boolean);
      rows = rows.filter((m) => tokens.every((t) => fullName(m).includes(t)));
    }
    if (state) rows = rows.filter((m) => m.stateRep === state);
    const size = parseInt(url.searchParams.get("Size") || "25", 10);
    return J({ items: rows.slice(0, size), offset: 0, pageSize: rows.length, hasNextPage: false });
  }

  // /members/{id}
  const memberMatch = path.match(/^\/members\/(\d+)$/);
  if (memberMatch) {
    const m = MEMBERS.find((x) => x.id === memberMatch[1]);
    return m ? J(m) : J({}, 404);
  }

  // /rated-events?Name=&StateCode=&Size=
  if (path === "/rated-events") {
    const name = (url.searchParams.get("Name") || "").toLowerCase().trim();
    const state = url.searchParams.get("StateCode") || "";
    let rows = EVENTS;
    if (name) rows = rows.filter((e) => e.name.toLowerCase().includes(name));
    if (state) rows = rows.filter((e) => e.stateCode === state);
    return J({ items: rows, offset: 0, hasNextPage: false });
  }

  // /rated-events/{id}
  const evMatch = path.match(/^\/rated-events\/(\d+)$/);
  if (evMatch) {
    const ev = EVENTS.find((e) => e.id === evMatch[1]);
    if (!ev) return J({}, 404);
    const sections = Object.keys(STANDINGS[ev.id] || {}).map((n) => ({
      number: parseInt(n, 10),
      name: parseInt(n, 10) === 1 ? "Open" : "Reserve",
    }));
    return J({ ...ev, sections });
  }

  // /rated-events/{id}/sections/{n}/standings
  const standingsMatch = path.match(/^\/rated-events\/(\d+)\/sections\/(\d+)\/standings$/);
  if (standingsMatch) {
    const items = STANDINGS[standingsMatch[1]]?.[parseInt(standingsMatch[2], 10)] || [];
    return J({ items, offset: 0, hasNextPage: false });
  }

  return J({ error: `unhandled path ${path}` }, 404);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Wire simulation: what the edge handler (memberToDirectoryRow) sends and the
// client parses. Mirrors handleSearchMembers in resolve-identity/index.ts.
// ---------------------------------------------------------------------------

function toWire(r: UscfSearchRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    state: r.state,
    fideId: r.fideId,
    title: r.title,
    status: r.status,
    expiration: r.expiration,
    hasOnline: r.hasOnline,
    rating: r.rating ?? bestRating(r.ratings),
    ratings: r.ratings,
  };
}

function throughClient(rows: UscfSearchRow[], query: { name?: string; state?: string }, band?: { min?: number; max?: number }): DirectoryMember[] {
  const parsed = rows.map((r) => parseDirectoryMember(toWire(r))).filter((m): m is DirectoryMember => !!m);
  const banded = applyRatingBand(parsed, band?.min, band?.max);
  return rankDirectoryMembers(banded, query);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.error(`  ✘ ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

async function main() {
  // --- Scenario 1: full name + state (the current success case) -------------
  console.log("\nScenario 1 — full name + state:");
  {
    const rows = await directoryMemberSearch({ name: "Jane Smith", state: "WA" });
    check("returns exactly the two WA Jane Smiths", rows.length === 2 && rows.every((r) => r.state === "WA"), rows.map((r) => r.name));
    const ranked = throughClient(rows, { name: "Jane Smith", state: "WA" });
    check("active 1642 Jane Smith ranks above the expired 987 one", ranked[0]?.id === "12345678", ranked.map((m) => m.id));
    check("online-history flag survives the wire", ranked[0]?.hasOnline === true);
    check("full rating table survives the wire", ranked[0]?.ratings?.onlineRegular === 1580 && ranked[0]?.ratings?.regular === 1642);
  }

  // --- Scenario 2: name only (the current failure case) ---------------------
  console.log("\nScenario 2 — name only:");
  {
    const rows = await directoryMemberSearch({ name: "Jane Smith" });
    check("all three homonyms surface for the user to disambiguate", rows.length === 3, rows.map((r) => `${r.name}/${r.state}`));
    const ranked = throughClient(rows, { name: "Jane Smith" });
    check("every candidate carries its state for human disambiguation", ranked.every((m) => !!m.state));
  }

  // --- Scenario 3: partial name + rating band --------------------------------
  console.log("\nScenario 3 — partial name + rating band:");
  {
    const rows = await directoryMemberSearch({ name: "Bhati" });
    check("fuzzy matches both Bhati and Bhatia", rows.length === 2, rows.map((r) => r.name));
    const ranked = throughClient(rows, { name: "Bhati" }, { min: 1500, max: 1800 });
    check("rating band 1500–1800 leaves only the 1696 Bhatia", ranked.length === 1 && ranked[0].id === "16538484", ranked.map((m) => `${m.name}:${m.rating}`));
  }

  // --- Scenario 4a: browse a state -------------------------------------------
  console.log("\nScenario 4a — browse by state (no name):");
  {
    const rows = await directoryMemberSearch({ state: "WA" });
    check("state-only browse returns every WA member", rows.length === 3 && rows.every((r) => r.state === "WA"), rows.map((r) => r.name));
    const empty = await directoryMemberSearch({});
    check("no name AND no state short-circuits to empty (never a full dump)", empty.length === 0);
  }

  // --- Scenario 4b: tournament → roster → player -----------------------------
  console.log("\nScenario 4b — tournament path:");
  {
    const events = await searchRatedEvents({ name: "washington" });
    check("event search finds the Washington Open", events.length === 1 && events[0].eventId === "202605250373", events);
    check("event card fields present (city title-cased, players, dates)", events[0]?.city === "Redmond" && events[0]?.playerCount === 309 && events[0]?.startDate === "2026-05-23");

    const wireEvents = events.map((e) => parseDirectoryEvent(e)).filter(Boolean);
    check("client event parser round-trips the wire shape", wireEvents.length === 1);

    const stateEvents = await searchRatedEvents({ state: "WA" });
    check("event browse by state works without a name", stateEvents.length === 2);

    const roster = await fetchEventRoster("202605250373");
    check("roster loads both sections", roster?.sections.length === 2, roster?.sections.map((s) => s.name));
    const open = roster?.sections.find((s) => s.number === 1);
    check("crosstable rows carry uscfId + name + rating + state", !!open && open.players.length === 2 && open.players.every((p) => p.uscfId && p.name && p.rating && p.state));

    const clientRoster = parseDirectoryRoster(roster, "202605250373");
    const pickedRow = clientRoster?.sections[0].players.find((p) => p.uscfId === "16538484");
    check("client roster parser yields a pickable player row", !!pickedRow && pickedRow.name === "Tanush Bhatia");

    // The pick → enrich step: the confirm panel fetches the full member by ID.
    const enrichedRows = await directoryMemberSearch({ name: "Tanush Bhatia" });
    const enriched = throughClient(enrichedRows, { name: "Tanush Bhatia" })[0];
    check("enriched member restores hasOnline + FIDE id for the confirm panel", enriched?.hasOnline === true && enriched?.fideId === "39970841");
  }

  // --- Scenario 5: outage + junk ---------------------------------------------
  console.log("\nScenario 5 — outage degrades, parsers reject junk:");
  {
    muirDown = true;
    const rows = await directoryMemberSearch({ name: "Jane Smith", state: "WA" });
    check("MUIR 500s degrade to an empty list, never a throw", Array.isArray(rows) && rows.length === 0);
    const events = await searchRatedEvents({ name: "washington" });
    check("event search degrades the same way", Array.isArray(events) && events.length === 0);
    muirDown = false;

    check("member parser rejects junk", parseDirectoryMember(null) === null && parseDirectoryMember({ id: 5 }) === null);
    check("event parser rejects junk", parseDirectoryEvent({}) === null);
    check("roster parser rejects junk", parseDirectoryRoster({ nope: true }, "x") === null);
    check(
      "rating band drops unrated members when a band is set",
      applyRatingBand([{ id: "1", name: "X", hasOnline: false } as DirectoryMember], 1000, 2000).length === 0
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Harness crashed:", e);
  process.exit(1);
});
