// ============================================================================
// TEST HARNESS: simulate a chess.com PROFILE-shard outage around the real
// traversal (bundled by scripts/sim-profile-outage.mjs). Reproduces the live
// failure where api.chess.com/pub/player/<handle> kept failing for the very
// handle the pairing chains were naming, while the /games archives answered —
// the engine must count the votes and crown on structure alone.
//
//   SIM_OUTAGE_HANDLES=pircbishop [SIM_HEAL_MS=60000] \
//     node scripts/sim-profile-outage.mjs --id 14090705 --budget 900
//
// Only the profile (and /stats) endpoints of the listed handles are downed —
// game archives stay healthy, exactly like the observed patchy outage. The
// fake failure is the documented shard signature: a 404 whose body carries a
// 5xx "internal error" code. SIM_HEAL_MS > 0 brings the shard back after that
// many ms, to prove the end-of-run enrichment retry upgrades the evidence.
// ============================================================================

const realFetch = globalThis.fetch;
const outageHandles = (process.env.SIM_OUTAGE_HANDLES || "")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const healMs = Number(process.env.SIM_HEAL_MS || "0"); // 0 = never heals by time
// Deterministic alternative to SIM_HEAL_MS: the shard heals after this many
// PROFILE fetches were blocked (stats blocks mirror the state but don't
// count) — e.g. 4 lets one verifyChesscom (3 in-place attempts) fail, the
// next chain's vote fast-fail on the cooldown, and the end-of-run enrichment
// retry hit a healed shard.
const healAfterBlocks = Number(process.env.SIM_HEAL_AFTER_BLOCKS || "0"); // 0 = never heals by count
const simStart = Date.now();
let blockCount = 0;
let profileBlockCount = 0;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  const m = /api\.chess\.com\/pub\/player\/([^/?#]+)(\/stats)?$/i.exec(url);
  const timedOut = healMs > 0 && Date.now() - simStart >= healMs;
  const blockedOut = healAfterBlocks > 0 && profileBlockCount >= healAfterBlocks;
  if (m && outageHandles.includes(decodeURIComponent(m[1]).toLowerCase()) && !timedOut && !blockedOut) {
    blockCount++;
    if (!m[2]) profileBlockCount++;
    console.log(`  [SIM] profile shard DOWN for ${m[1]}${m[2] ? "/stats" : ""} (block #${blockCount})`);
    return new Response('{"code":500,"message":"Internal error"}', {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

if (!outageHandles.length) {
  console.error("SIM_OUTAGE_HANDLES is empty — nothing to simulate. Set it to a comma-separated handle list.");
  process.exit(1);
}
console.log(
  `[SIM] chess.com profile shard outage for: ${outageHandles.join(", ")}${
    healMs > 0 ? ` (heals after ${Math.round(healMs / 1000)}s)` : " (never heals)"
  }`
);

await import("./trace-entry");
