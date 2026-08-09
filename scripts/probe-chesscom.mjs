// Bundle scripts/probe-chesscom.ts with esbuild and run it (same pattern as
// trace-username.mjs). Phase 0 diagnostic — see probe-chesscom.ts header.
//
//   node scripts/probe-chesscom.mjs [--n 20] [--gap 350] [--conc 8] [--pairs f.json]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-probe.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "probe-chesscom.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
