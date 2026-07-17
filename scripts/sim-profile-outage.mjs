// Bundle scripts/sim-profile-outage-entry.ts with esbuild and run it — the
// tournament-graph engine under a simulated chess.com profile-shard outage.
//
//   SIM_OUTAGE_HANDLES=pircbishop node scripts/sim-profile-outage.mjs --id 14090705 [--budget 900]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-sim-outage.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "sim-profile-outage-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
