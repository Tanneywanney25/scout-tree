// Bundle + run scripts/test-school-uscf-entry.ts (the offline test of the
// school resolver's USCF-anchored schoolmate resolution).
//   node scripts/test-school-uscf.mjs
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-test-school-uscf.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "test-school-uscf-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
