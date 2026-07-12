// ============================================================================
// TEST HARNESS: the school resolver's USCF-anchored schoolmate resolution,
// offline (bundled + run by scripts/test-school-uscf.mjs). Fakes the MUIR
// ratings API and the chess.com pub API in-memory, then drives the REAL
// engine end-to-end: NWSRS-shaped roster → findMemberId (real code, fake
// MUIR) → resolveUscfIdentity → social-graph crawl → candidate ranking.
//
//   node scripts/test-school-uscf.mjs
//
// Scenarios:
//   A. Two schoolmates resolve through their USCF IDs (one multi-match pick,
//      one no-USCF-record skip, one below-confidence discard) and the crawl
//      identifies the target's handle at the 2-mutual confidence cap (90%).
//      The Google name→handle fallback must NOT run.
//   B. No schoolmate has a USCF match → the engine falls back to name-based
//      discovery (the pre-existing route).
//   C. Hooks without the new USCF lookups (an older caller) still work.
// ============================================================================

import { findMemberId } from "../supabase/functions/resolve-identity/uscf";
import { runSchoolResolution, type SchoolResolverHooks } from "../src/lib/identity/schoolResolver";
import type { Schoolmate } from "../src/lib/identity/schoolTypes";

// ---------------------------------------------------------------------------
// Fake network
// ---------------------------------------------------------------------------

const J = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

// MUIR member rows, keyed by the Fuzzy search string (lowercased).
const muir: Record<string, Record<string, unknown>[]> = {
  "tanush bhatia": [
    {
      id: 16538484,
      firstName: "TANUSH",
      lastName: "BHATIA",
      stateRep: "WA",
      ratings: [
        { ratingSystem: "R", rating: 1612 },
        { ratingSystem: "OB", rating: 1490 },
      ],
    },
  ],
  // Two same-state homonyms — the roster rating (1550) must pick the 1548 one.
  "maya chen": [
    { id: 17000002, firstName: "MAYA", lastName: "CHEN", stateRep: "WA", ratings: [{ ratingSystem: "R", rating: 900 }] },
    {
      id: 17000001,
      firstName: "MAYA",
      lastName: "CHEN",
      stateRep: "WA",
      ratings: [
        { ratingSystem: "R", rating: 1548 },
        { ratingSystem: "OR", rating: 1500 },
      ],
    },
  ],
  // Only a SURNAME-INCOMPATIBLE member exists ("Leo Parker") — must be null.
  "leo park": [
    { id: 17000009, firstName: "LEO", lastName: "PARKER", stateRep: "OR", ratings: [{ ratingSystem: "R", rating: 1400 }] },
  ],
  "nina rao": [
    { id: 17000003, firstName: "NINA", lastName: "RAO", stateRep: "WA", ratings: [{ ratingSystem: "R", rating: 1305 }] },
  ],
};

// chess.com pub API fixtures.
const ccProfiles: Record<string, Record<string, unknown>> = {
  tanneywanney25: {
    username: "tanneywanney25",
    name: "Tanush Bhatia",
    country: "https://api.chess.com/pub/country/US",
    location: "Sammamish, WA",
    last_online: 1780000000,
    joined: 1600000000,
    url: "https://www.chess.com/member/tanneywanney25",
  },
  ninarao15: {
    username: "ninarao15",
    name: "Nina Rao",
    country: "https://api.chess.com/pub/country/US",
    last_online: 1780000000,
    joined: 1610000000,
    url: "https://www.chess.com/member/ninarao15",
  },
  kai0627: {
    username: "Kai0627",
    country: "https://api.chess.com/pub/country/US",
    location: "Sammamish, WA",
    last_online: 1780000000,
    joined: 1650000000,
    url: "https://www.chess.com/member/Kai0627",
  },
};

const ccStats: Record<string, Record<string, unknown>> = {
  tanneywanney25: { chess_rapid: { last: { rating: 1520 }, record: { win: 200, loss: 150, draw: 20 } } },
  ninarao15: { chess_rapid: { last: { rating: 1500 }, record: { win: 120, loss: 100, draw: 12 } } },
  kai0627: {
    chess_rapid: { last: { rating: 1480 }, record: { win: 120, loss: 100, draw: 10 } },
    chess_blitz: { last: { rating: 1420 }, record: { win: 50, loss: 40, draw: 5 } },
  },
};

const game = (a: string, b: string) => ({ white: { username: a }, black: { username: b } });
const ccMonths: Record<string, { games: unknown[] }> = {
  tanneywanney25: {
    games: [
      game("tanneywanney25", "Kai0627"),
      game("Kai0627", "tanneywanney25"),
      game("tanneywanney25", "Kai0627"),
      game("Kai0627", "tanneywanney25"),
      game("tanneywanney25", "Kai0627"),
      game("tanneywanney25", "randomguy"),
      game("randomguy", "tanneywanney25"),
    ],
  },
  ninarao15: {
    games: [
      game("ninarao15", "Kai0627"),
      game("Kai0627", "ninarao15"),
      game("ninarao15", "Kai0627"),
      game("Kai0627", "ninarao15"),
      game("otherdude", "ninarao15"),
    ],
  },
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);

  // --- MUIR ratings API -----------------------------------------------------
  const search = /ratings-api\.uschess\.org\/api\/v1\/members\?(.+)$/i.exec(url);
  if (search) {
    const params = new URLSearchParams(search[1]);
    const fuzzy = (params.get("Fuzzy") || "").toLowerCase().trim();
    const state = params.get("StateRep");
    let items = muir[fuzzy] || [];
    if (state) items = items.filter((it) => String(it.stateRep).toUpperCase() === state.toUpperCase());
    return J({ items, hasNextPage: false });
  }
  if (/ratings-api\.uschess\.org\//i.test(url)) return J({ code: 0, message: "not in fixture" }, 404);

  // --- chess.com pub API ------------------------------------------------------
  let m = /api\.chess\.com\/pub\/player\/([^/?#]+)\/stats$/i.exec(url);
  if (m) {
    const u = decodeURIComponent(m[1]).toLowerCase();
    return ccStats[u] ? J(ccStats[u]) : J({ code: 0, message: "Not found" }, 404);
  }
  m = /api\.chess\.com\/pub\/player\/([^/?#]+)\/games\/archives$/i.exec(url);
  if (m) {
    const u = decodeURIComponent(m[1]).toLowerCase();
    return ccMonths[u]
      ? J({ archives: [`https://api.chess.com/pub/player/${u}/games/2026/05`] })
      : J({ archives: [] });
  }
  m = /api\.chess\.com\/pub\/player\/([^/?#]+)\/games\/\d{4}\/\d{2}$/i.exec(url);
  if (m) {
    const u = decodeURIComponent(m[1]).toLowerCase();
    return J(ccMonths[u] || { games: [] });
  }
  m = /api\.chess\.com\/pub\/player\/([^/?#]+)\/clubs$/i.exec(url);
  if (m) return J({ clubs: [] });
  m = /api\.chess\.com\/pub\/player\/([^/?#]+)$/i.exec(url);
  if (m) {
    const u = decodeURIComponent(m[1]).toLowerCase();
    return ccProfiles[u] ? J(ccProfiles[u]) : J({ code: 0, message: "Not found" }, 404);
  }
  if (/api\.chess\.com\//i.test(url)) return J({ code: 0, message: "not in fixture" }, 404);

  // --- lichess: nothing exists in this scenario ------------------------------
  if (/lichess\.org\//i.test(url)) return new Response("Not Found", { status: 404 });

  console.error(`  [FAKE-NET] unexpected outbound request: ${url}`);
  return new Response("blocked by test harness", { status: 404 });
}) as typeof fetch;
void realFetch; // the harness never lets a request out

// ---------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
};

const roster: Schoolmate[] = [
  { name: "Tanush Bhatia", rating: 1600, source: "nwsrs-school-report" },
  { name: "Maya Chen", rating: 1550, source: "nwsrs-school-report" },
  { name: "Leo Park", rating: 1400, source: "nwsrs-school-report" },
  { name: "Nina Rao", rating: 1300, source: "nwsrs-school-report" },
];

function baseHooks(findUsernamesCalls: string[]): SchoolResolverHooks {
  return {
    findSchool: async () => [
      {
        school: "Skyline High School",
        state: "WA",
        source: "nwsrs",
        sourceLabel: "Chess Ratings NorthWest (NWSRS)",
        confidence: 0.9,
      },
    ],
    findSchoolmates: async () => roster,
    fetchFriends: async () => [],
    findUsernames: async (req) => {
      findUsernamesCalls.push(req.name);
      return [];
    },
  };
}

const input = { name: "Aditya Brahmachary", state: "WA", uscfId: "32215520", targetRating: 1500 };

async function scenarioA() {
  console.log("\n=== Scenario A: USCF-anchored schoolmate resolution ===\n");
  const logs: string[] = [];
  const googleCalls: string[] = [];
  const hooks: SchoolResolverHooks = {
    ...baseHooks(googleCalls),
    findUscfId: ({ firstName, lastName, state, rating }) => findMemberId(firstName, lastName, state, rating),
    resolveUscfIdentity: async ({ uscfId }) => {
      // Stands in for the tournament-graph traversal (exercised by its own
      // harnesses); the wrapper's plumbing is what scenario A validates.
      if (uscfId === "16538484") return { platform: "chesscom", username: "tanneywanney25", confidence: 0.92 };
      if (uscfId === "17000001") return { platform: "chesscom", username: "mchen_maybe", confidence: 0.55 };
      if (uscfId === "17000003") return { platform: "chesscom", username: "ninarao15", confidence: 0.86 };
      return null;
    },
  };
  const result = await runSchoolResolution(input, {
    log: (m) => {
      logs.push(m);
      console.log(`  ${m}`);
    },
    hooks,
  });

  const has = (s: string) => logs.some((l) => l.includes(s));
  check("A1 found a match", result.found);
  check("A2 two schoolmates resolved", result.schoolmatesResolved === 2, `got ${result.schoolmatesResolved}`);
  const top = result.accounts[0];
  check("A3 top account is @Kai0627 on chess.com", top?.username === "Kai0627" && top?.platform === "chesscom", `got ${top?.username}@${top?.platform}`);
  check("A4 confidence ≥ 90%", (top?.confidence ?? 0) >= 0.899, `got ${Math.round((top?.confidence ?? 0) * 100)}%`);
  check("A5 logged the USCF ID find", has("found USCF ID 16538484 for Tanush Bhatia"));
  check("A6 logged the resolution", has("resolved Tanush Bhatia to @tanneywanney25 at 92% (USCF #16538484)"));
  check("A7 multi-match picked by rating", has("found USCF ID 17000001 for Maya Chen"));
  check("A8 no-USCF-record mate skipped", has("no USCF member found for Leo Park"));
  check("A9 below-70% mate discarded", has("below the 70% bar") && has("@mchen_maybe"));
  check("A10 Google fallback did NOT run", googleCalls.length === 0, `called for: ${googleCalls.join(", ")}`);
}

async function scenarioB() {
  console.log("\n=== Scenario B: no USCF matches → name-search fallback ===\n");
  const logs: string[] = [];
  const googleCalls: string[] = [];
  const hooks: SchoolResolverHooks = {
    ...baseHooks(googleCalls),
    findUscfId: async () => null,
    resolveUscfIdentity: async () => null,
  };
  const result = await runSchoolResolution(input, {
    log: (m) => {
      logs.push(m);
      console.log(`  ${m}`);
    },
    hooks,
  });
  check("B1 fell back to name-based discovery", logs.some((l) => l.includes("falling back to name-based handle discovery")));
  check("B2 Google fallback ran for the roster", googleCalls.length > 0, `calls=${googleCalls.length}`);
  check("B3 nothing resolved (empty index)", !result.found && result.schoolmatesResolved === 0);
}

async function scenarioC() {
  console.log("\n=== Scenario C: hooks without USCF lookups (older caller) ===\n");
  const logs: string[] = [];
  const googleCalls: string[] = [];
  const result = await runSchoolResolution(input, {
    log: (m) => {
      logs.push(m);
      console.log(`  ${m}`);
    },
    hooks: baseHooks(googleCalls),
  });
  check("C1 no USCF-route log without the hooks", !logs.some((l) => l.includes("USCF route")));
  check("C2 name-based discovery still ran", googleCalls.length > 0, `calls=${googleCalls.length}`);
  check("C3 degrades to not-found gracefully", !result.found);
}

async function unitFindMemberId() {
  console.log("\n=== findMemberId unit checks (fake MUIR) ===\n");
  const t = await findMemberId("Tanush", "Bhatia", "WA");
  check("U1 exact match", t?.uscfId === "16538484", JSON.stringify(t));
  check("U2 carries the member's rating", t?.rating === 1612, JSON.stringify(t));
  const m = await findMemberId("Maya", "Chen", "WA", 1550);
  check("U3 multi-match: closest rating wins", m?.uscfId === "17000001", JSON.stringify(m));
  const l = await findMemberId("Leo", "Park", "WA");
  check("U4 surname-incompatible homonym rejected", l === null, JSON.stringify(l));
  const none = await findMemberId("Zoe", "Nobody", "WA");
  check("U5 unknown name → null", none === null, JSON.stringify(none));
}

async function main() {
  await unitFindMemberId();
  await scenarioA();
  await scenarioB();
  await scenarioC();
  console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(10);
});
