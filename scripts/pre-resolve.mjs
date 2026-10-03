// Bundle + run scripts/pre-resolve-entry.ts (mass pre-resolution of USCF
// online sections against the roster index; docs/roster-index.md).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/pre-resolve.mjs \
//     [--source cache|queued|both] [--concurrency 8] [--minutes N] [--limit N] [--shard i/n] [--dry-run]
//
// Safe to run again at any time: progress lives in preresolve_section, and a
// resolved or already-linked section is never processed twice.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-pre-resolve.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "pre-resolve-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
