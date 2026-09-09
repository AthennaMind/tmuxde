import { execSync, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

/**
 * Boot the bundle and make one real request.
 *
 * A typecheck cannot catch what broke here before: a dependency that resolves
 * at build time but not at runtime, or a workspace import Node cannot follow.
 * Both produce a dist that fails on its first line, and both are invisible
 * until someone runs it. So the build runs it.
 */
async function bootCheck(outfile) {
  const port = 24999;
  // 30s, not the 4s this used to allow. The point of the check is "does the
  // bundle run at all", and a cold CI runner importing better-auth, drizzle and
  // a native better-sqlite3 binding is legitimately slower than a warm laptop —
  // the first CI run failed here with the process alive, silent, and still
  // starting. A generous ceiling still catches a bundle that dies on its first
  // line, because that exits and is reported immediately.
  const deadline = Date.now() + 30_000;
  const child = spawn(process.execPath, [outfile], {
    cwd: ROOT,
    env: { ...process.env, API_PORT: String(port), API_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`exited with ${child.exitCode}:\n${output}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          const body = await res.json();
          if (body.status !== "ok")
            throw new Error(`bad health: ${body.status}`);
          return;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Say which of the two failures this was: silence means it never got to
    // listening, output means it started and something else went wrong.
    throw new Error(
      `never answered /health in 30s (process ${
        child.exitCode === null ? "still running" : `exited ${child.exitCode}`
      }):\n${output || "  (no output at all)"}`,
    );
  } finally {
    child.kill("SIGKILL");
  }
}

await rm(path.join(ROOT, "dist"), { recursive: true, force: true });

console.log("→ typecheck");
run("tsc --noEmit");

console.log("→ bundle (esbuild)");
// esbuild rather than a bare `tsc` emit. @repo/protocol and @repo/crypto are
// published as raw TypeScript with extensionless relative imports, which Node
// cannot resolve at runtime — a plain tsc build produces a dist that crashes on
// `node dist/index.js`. Bundling inlines the workspace packages and leaves the
// real npm deps external, exactly as apps/cli does.
const { build } = await import("esbuild");
await build({
  entryPoints: [path.join(ROOT, "src/index.ts")],
  outfile: path.join(ROOT, "dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [
    "ws",
    "pino",
    "pino-pretty",
    "zod",
    // These stay external for a reason sharper than bundle size.
    //
    // `zod` above is external, so every bundled import of it collapses onto
    // *this* package's copy — zod 3, because @repo/protocol's schemas are
    // written against it. better-auth needs zod 4 (it calls `.meta()`, which
    // does not exist in 3), and pnpm gives it its own nested copy. Inlining
    // better-auth therefore rewrote its zod 4 import to the flattened zod 3
    // and the bundle died on its first line with
    // `z.coerce.boolean(...).meta is not a function`.
    //
    // Leaving them external lets Node resolve each package's own dependency
    // tree, which is the only thing that gets two major versions of one
    // library right. `better-sqlite3` additionally has a native binding that
    // cannot be bundled at all.
    "better-auth",
    "better-auth/*",
    "@better-auth/*",
    "better-sqlite3",
    "drizzle-orm",
    "drizzle-orm/*",
    "dodopayments",
    "@dodopayments/*",
  ],
  banner: {
    js: "import { createRequire as _mtmuxCreateRequire } from 'module'; const require = _mtmuxCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

console.log("→ boot check");
await bootCheck(path.join(ROOT, "dist/index.js"));

console.log("✓ build complete");
