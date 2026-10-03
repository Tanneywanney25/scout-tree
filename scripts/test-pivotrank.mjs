// Bundle + run scripts/test-pivotrank-entry.ts (first-resolved-pivot-rank proof).
//   node scripts/test-pivotrank.mjs
import { build } from "esbuild";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "node_modules", ".scouttree-test-pivotrank.mjs");

await build({
  entryPoints: [path.join(root, "scripts", "test-pivotrank-entry.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  alias: { "@": path.join(root, "src") },
  // sectionBfs pulls in the Supabase client, which reads Vite env at import.
  define: { "import.meta.env": "{}" },
  // ...and constructs itself against localStorage; an in-memory stand-in.
  banner: {
    js: "const __m = new Map(); globalThis.localStorage ??= { getItem: (k) => (__m.has(k) ? __m.get(k) : null), setItem: (k, v) => void __m.set(k, String(v)), removeItem: (k) => void __m.delete(k), clear: () => __m.clear(), key: (i) => [...__m.keys()][i] ?? null, get length() { return __m.size; } };",
  },
  logLevel: "warning",
});

const child = spawn(process.execPath, [outfile], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
