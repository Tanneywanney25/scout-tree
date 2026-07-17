// Bundle scripts/trace-school-entry.ts with esbuild (already a vite dependency)
// and run it — lets the school-based social-graph resolver run from a plain Node
// terminal (the fallback for players with zero online USCF tournament history).
//
//   node scripts/trace-school.mjs --id 32215520
//   node scripts/trace-school.mjs --name "Aditya Brahmachary" --state WA
//   node scripts/trace-school.mjs --id 32215520 --seed-mate tanneywanney25:chesscom:"Tanush Bhatia"
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-school.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "trace-school-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
