// Access-control regression test for the resolvedHandles route.
//
// WHAT THIS GUARDS: resolve-identity runs with verify_jwt = false so anonymous
// scouting works (supabase/config.toml). That made the bulk moat read reachable
// with no credential at all. A single unauthenticated POST returned USCF
// member -> Chess.com handle mappings for up to 50 ids, plus an `evidence`
// blob whose labels quote crosstable pairings and so name OTHER real players.
// USCF ids are sequential, so that is a bulk de-anonymisation endpoint for a
// population that includes minors.
//
// Run:
//   node scripts/test-resolved-handles-access.mjs
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/test-resolved-handles-access.mjs   (also runs the opt-out case)
//
// Env overrides: SUPABASE_FN_URL, SUPABASE_ANON_KEY.
// Exits non-zero on any failure.

const FN = process.env.SUPABASE_FN_URL || "https://xqyszdjczchlgyisvtvo.supabase.co/functions/v1/resolve-identity";
const ANON = process.env.SUPABASE_ANON_KEY || "sb_publishable_BH3AoBttItAuh4mpSvgFTw_oKmPpKBU";
const REST = FN.replace(/\/functions\/v1\/.*$/, "/rest/v1");
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// A member id that is not a real USCF member, used only for the opt-out case.
const SYNTHETIC_ID = "99999999";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
  if (!ok) failures++;
}

async function post(body, headers) {
  const res = await fetch(FN, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// Real ids are read from the store when a service key is available, so the test
// proves suppression against genuine rows rather than only synthetic ones.
async function realIds(limit = 4) {
  if (!SRK) return [];
  try {
    const res = await fetch(`${REST}/resolved_handles?select=uscf_id&superseded_by=is.null&limit=${limit}`, {
      headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return Array.isArray(rows) ? rows.map((r) => r.uscf_id).filter(Boolean) : [];
  } catch { return []; }
}

const ids = (await realIds()).concat([SYNTHETIC_ID]);
console.log(`probing ${FN}`);
console.log(`using ${ids.length} id(s)${SRK ? " (incl. real stored ids)" : " (synthetic only; set SUPABASE_SERVICE_ROLE_KEY for the full suite)"}\n`);

// ---- 1. no credentials at all --------------------------------------------
{
  const { status, json } = await post({ resolvedHandles: { uscfIds: ids } }, {});
  const rows = Array.isArray(json?.handles) ? json.handles.length : -1;
  check("unauthenticated caller gets no rows", rows === 0, `HTTP ${status}, handles=${rows}, unauthorized=${json?.unauthorized}`);
}

// ---- 2. publishable (anon) key is not a session --------------------------
{
  const { status, json } = await post({ resolvedHandles: { uscfIds: ids } }, { apikey: ANON, Authorization: `Bearer ${ANON}` });
  const rows = Array.isArray(json?.handles) ? json.handles.length : -1;
  check("publishable key alone gets no rows", rows === 0, `HTTP ${status}, handles=${rows}, unauthorized=${json?.unauthorized}`);
}

// ---- 3. evidence must never cross the wire on this route -----------------
{
  const { json } = await post({ resolvedHandles: { uscfIds: ids } }, { apikey: ANON, Authorization: `Bearer ${ANON}` });
  const leaked = JSON.stringify(json ?? {}).includes('"evidence"');
  check("response carries no evidence field (it names third parties)", !leaked);
}

// ---- 4. an opt-out retracts an already-stored resolution ------------------
//
// This MUST use a real USCF member id that already has a stored row:
// handleMemberPreview returns {available:false} for an id MUIR does not know,
// before it ever looks at handles, so a synthetic id yields a false pass. The
// opt-out row is inserted and removed around the assertion, so the member's
// real row is suppressed only for the duration of the test.
const realForOptOut = (await realIds(1))[0];
if (SRK && realForOptOut) {
  const h = { apikey: SRK, Authorization: `Bearer ${SRK}`, "content-type": "application/json" };
  const dropOptOut = () =>
    fetch(`${REST}/handle_optouts?uscf_id=eq.${realForOptOut}`, { method: "DELETE", headers: h }).catch(() => {});
  try {
    await dropOptOut();
    // Baseline: without an opt-out the UI route does surface the handle, which
    // is what makes the suppression assertion below meaningful.
    const base = await post({ memberPreview: { uscfId: realForOptOut } }, { apikey: ANON, Authorization: `Bearer ${ANON}` });
    const baseFound = base.json?.available === true;
    const baseCount = Array.isArray(base.json?.resolvedHandles) ? base.json.resolvedHandles.length : 0;
    check("baseline: member resolves and memberPreview surfaces a handle", baseFound && baseCount > 0,
      `available=${base.json?.available} resolvedHandles=${baseCount}`);

    await fetch(`${REST}/handle_optouts`, {
      method: "POST", headers: { ...h, Prefer: "return=minimal" },
      body: JSON.stringify({ uscf_id: realForOptOut, platform: "chesscom", username: "access-control-test", note: "automated access-control test" }),
    });
    const after = await post({ memberPreview: { uscfId: realForOptOut } }, { apikey: ANON, Authorization: `Bearer ${ANON}` });
    const afterFound = after.json?.available === true;
    const afterCount = Array.isArray(after.json?.resolvedHandles) ? after.json.resolvedHandles.length : 0;
    check("opt-out retracts the stored handle (member still resolves)", afterFound && afterCount === 0,
      `available=${after.json?.available} resolvedHandles=${afterCount}`);
  } finally {
    await dropOptOut();
  }
} else {
  console.log(`SKIP  opt-out suppression (${SRK ? "no stored rows to test against" : "needs SUPABASE_SERVICE_ROLE_KEY"})`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
