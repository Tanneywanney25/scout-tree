// Bundle + run scripts/test-organizer-entry.ts (offline proof of the
// organizer-key extraction and the USCF-section → Lichess-tournament matcher).
//   node scripts/test-organizer.mjs <team-swiss.ndjson>
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-test-organizer.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "test-organizer-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
