/*
============================================================
ARCHIVED REDESIGN ARCHITECTURE
Feature-Branch: feature/identity-discovery-ux
Commit:         1b31ced
Archived-On:    2026-07-23
Status:         INACTIVE — preserved for reference/restoration
Original-Path:  scripts/test-directory.mjs
Change-Type:    NEW FILE
------------------------------------------------------------
WHAT:  Thin runner that compiles/executes test-directory-entry.ts.
WHY:   Single command to run the Phase-A offline suite.
DEPENDS-ON:     scripts/test-directory-entry.ts.
DEPENDED-ON-BY: nothing (test entry point).
RESTORE:        Copy to scripts/.
------------------------------------------------------------
The verbatim source of this file follows the banner below.
Full architecture map + restore procedure:
  archive/identity-redesign/MANIFEST.md
============================================================
*/

// Bundle + run scripts/test-directory-entry.ts (the offline test of the
// Phase-A directory: member/event search, rosters, parsing, ranking).
//   node scripts/test-directory.mjs
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-test-directory.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "test-directory-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outfile,
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
