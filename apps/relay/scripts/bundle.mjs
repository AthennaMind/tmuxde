/**
 * Bundle the relay into one runnable file.
 *
 * ## Why `tsc` alone is not enough
 *
 * `pnpm build` runs `tsc`, which emits `dist/*.js` that still import
 * `@repo/protocol` and `@repo/logger` as bare specifiers. Those workspace
 * packages publish **raw TypeScript** — `"exports": { ".": "./src/index.ts" }`
 * — with no build step of their own, because every real consumer compiles
 * them: `next` for the web app, `esbuild` for the CLI, `tsx` for `pnpm dev`.
 *
 * Plain `node dist/index.js` is the one consumer that does not, and it fails:
 *
 *     Cannot find module '/app/packages/protocol/src/types'
 *       imported from /app/packages/protocol/src/index.ts
 *
 * So `docker/Dockerfile.relay`'s `CMD ["node", "apps/relay/dist/index.js"]`
 * could never have started, and `pnpm --filter @app/relay start` has the same
 * problem for the same reason. This is the fix the CLI already uses — see
 * `apps/cli/scripts/build.mjs`, which bundles `apps/relay/src/runtime.ts` on
 * exactly these terms.
 *
 * ## What is inlined and what is not
 *
 * `@repo/*` is inlined, because it is source. Real npm dependencies stay
 * external and are resolved from `node_modules` at run time: `node-pty` is a
 * native addon that cannot be bundled at all, and bundling the others would
 * only make the image larger and the stack traces worse.
 */
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
