// Bundle scripts/trace-entry.ts with esbuild (already a vite dependency) and
// run it — lets the tournament-graph engine run from a plain Node terminal.
//
//   node scripts/trace-username.mjs --name "First Last" [--state XX]
//   node scripts/trace-username.mjs --id 12345678 [--budget 120] [--list]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-trace.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "trace-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
