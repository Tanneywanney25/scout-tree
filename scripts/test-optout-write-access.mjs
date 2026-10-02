// Access-control regression test for the optOut WRITE route.
//
// WHAT THIS GUARDS: resolve-identity runs with verify_jwt = false so anonymous
// scouting works, and only `memberSearch` is rate-limited (index.ts:655). That
// left `optOut` as an unauthenticated, unlimited, irreversible write:
//
//   * Reproduced before the fix: POST {"optOut":{...}} with NO apikey and NO
//     Authorization returned {"stored":true} and the row landed.
//   * handle_optouts has no unique constraint, so duplicates accumulate.
//   * No DELETE exists anywhere in application code, so an opt-out cannot be
//     undone except by someone with direct database access.
//   * getResolvedHandles() honours an opt-out row WITHOUT checking `verified`,
//     which the schema reserves for "a human confirms the requester is (or
//     represents) the player". Honouring unverified rows is the right call for
//     privacy, but it means an attacker-written row suppresses disclosure for
//     that member - a denial of service against the whole moat once ids are
//     enumerated.
//
// So the gate belongs on the WRITE, not on the read.
//
// Run:
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/test-optout-write-access.mjs
// The service key is required: the test uses REAL stored member ids and
// asserts the real code path was exercised, because a synthetic id makes
// handleMemberPreview return available:false and the assertion then passes for
// the wrong reason (that happened once already).
//
// Exits non-zero on any failure.

const FN = process.env.SUPABASE_FN_URL || "https://xqyszdjczchlgyisvtvo.supabase.co/functions/v1/resolve-identity";
const ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_BH3AoBttItAuh4mpSvgFTw_oKmPpKBU";
const REST = FN.replace(/\/functions\/v1\/.*$/, "/rest/v1");
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SRK) {
  console.error("FATAL: SUPABASE_SERVICE_ROLE_KEY is required (real ids + cleanup).");
  process.exit(2);
}
const SH = { apikey: SRK, Authorization: `Bearer ${SRK}`, "content-type": "application/json" };

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
  if (!ok) failures++;
};

async function post(body, headers) {
  const res = await fetch(FN, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const rest = async (path, init = {}) => fetch(`${REST}${path}`, { headers: SH, ...init });

async function optOutRows(id) {
  const r = await rest(`/handle_optouts?uscf_id=eq.${id}&select=id`);
  if (!r.ok) return -1;
  const rows = await r.json();
  return Array.isArray(rows) ? rows.length : -1;
}
const dropOptOuts = (id) => rest(`/handle_optouts?uscf_id=eq.${id}`, { method: "DELETE" }).catch(() => {});

// A REAL stored member id, so memberPreview reaches the code under test.
const r = await rest("/resolved_handles?select=uscf_id&superseded_by=is.null&limit=1");
const realId = r.ok ? (await r.json())?.[0]?.uscf_id : null;
if (!realId) {
  console.error("FATAL: no stored resolved_handles row to test against.");
  process.exit(2);
}
console.log(`probing ${FN}\nusing real stored member id ${realId}\n`);

try {
  await dropOptOuts(realId);

  // ---- 0. baseline: the real path is genuinely exercised -------------------
  // If this fails, every assertion below is meaningless.
  const base = await post({ memberPreview: { uscfId: realId } }, { apikey: ANON, Authorization: `Bearer ${ANON}` });
  check(
    "baseline: member resolves and memberPreview surfaces a handle (path IS exercised)",
    base.json?.available === true && (base.json?.resolvedHandles?.length ?? 0) > 0,
    `available=${base.json?.available} resolvedHandles=${base.json?.resolvedHandles?.length ?? 0}`
  );

  // ---- 1. the write must be refused without credentials -------------------
  const before = await optOutRows(realId);
  const anon = await post(
    { optOut: { uscfId: realId, platform: "chesscom", username: "access-control-test", note: "automated test" } },
    {}
  );
  const after = await optOutRows(realId);
  check(
    "unauthenticated optOut writes nothing",
    after === before,
    `rows ${before} -> ${after}; response stored=${anon.json?.stored} unauthorized=${anon.json?.unauthorized}`
  );

  // ---- 2. and it must say WHY, so the gate is distinguishable from a no-op
  check(
    "refusal is explicit (unauthorized), not a silent no-op",
    anon.json?.unauthorized === true,
    `body=${JSON.stringify(anon.json)}`
  );

  // ---- 3. same with only a publishable key (an API key is not a session) --
  const withKey = await post(
    { optOut: { uscfId: realId, platform: "chesscom", username: "access-control-test", note: "automated test" } },
    { apikey: ANON, Authorization: `Bearer ${ANON}` }
  );
  check(
    "publishable key alone writes nothing",
    (await optOutRows(realId)) === before,
    `response stored=${withKey.json?.stored} unauthorized=${withKey.json?.unauthorized}`
  );

  // ---- 4. the privacy mechanism itself must still work --------------------
  // Gating the write must not weaken suppression: a legitimately recorded
  // opt-out (inserted here with the service role, as a reviewed request would
  // be) still has to retract the stored handle.
  await rest("/handle_optouts", {
    method: "POST",
    headers: { ...SH, Prefer: "return=minimal" },
    body: JSON.stringify({ uscf_id: realId, platform: "chesscom", username: "access-control-test", note: "automated test" }),
  });
  const suppressed = await post({ memberPreview: { uscfId: realId } }, { apikey: ANON, Authorization: `Bearer ${ANON}` });
  check(
    "a recorded opt-out still retracts the handle (member still resolves)",
    suppressed.json?.available === true && (suppressed.json?.resolvedHandles?.length ?? 0) === 0,
    `available=${suppressed.json?.available} resolvedHandles=${suppressed.json?.resolvedHandles?.length ?? 0}`
  );
} finally {
  await dropOptOuts(realId);
  const left = await optOutRows(realId);
  console.log(`\ncleanup: handle_optouts rows for ${realId} = ${left}`);
}

console.log(`${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
