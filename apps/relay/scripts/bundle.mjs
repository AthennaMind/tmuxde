/** Bundle shared TypeScript packages into relay runtime. Native dependencies stay external. */
import path from "node:path";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");

await build({
  entryPoints: [path.join(ROOT, "src/index.ts")],
  outfile: path.join(ROOT, "dist/index.bundle.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["node-pty", "ws", "pino", "pino-pretty", "chokidar", "zod"],
  banner: {
    // Several of those externals are CJS and reach for `require` through
    // esbuild's interop shims, which do not exist in an ESM module scope.
    js: "import { createRequire as _relayCreateRequire } from 'module'; const require = _relayCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});
