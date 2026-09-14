/**
 * Finish a Next `output: "standalone"` build so it can actually be served.
 *
 * `next build` writes a self-contained server tree under
 * `.next/standalone/`, but deliberately leaves out two things it expects the
 * deployer to place: the client bundles in `.next/static` and everything in
 * `public/`. Without them the server boots and answers, but every page loads
 * without its JavaScript or assets.
 *
 * Running `next start` against a standalone build is the other trap — Next
 * warns "next start does not work with output: standalone" and the process
 * still serves, which is exactly the kind of half-working that survives a
 * smoke test and fails in a browser. PM2 runs `server.js` from here instead.
 *
 * This stages into the BUILD directory (`.next-build`), not the one being
 * served. Promotion is a separate, explicit step — see
 * scripts/promote-build.mjs — so that a build in progress can never leave the
 * running process reading a tree that is being rewritten underneath it.
 */
import { cp, access } from "node:fs/promises";
import path from "node:path";

const app = process.argv[2];
if (!app) {
  console.error(
    "usage: node scripts/prepare-standalone.mjs <apps/web|apps/docs>",
  );
  process.exit(2);
}

const REPO = path.resolve(import.meta.dirname, "..");
const APP_DIR = path.join(REPO, app);
// Matches `distDir` in each app's next.config.ts: builds land in .next-build
// unless NEXT_DIST_DIR overrides it (the CLI build uses .next-cli).
const DIST = process.env.NEXT_DIST_DIR || ".next-build";
const STANDALONE = path.join(APP_DIR, DIST, "standalone", app);

try {
  await access(path.join(STANDALONE, "server.js"));
} catch {
  console.error(
    `✗ No standalone server at ${STANDALONE}/server.js.\n` +
      `  Build first (into ${DIST}), and check next.config has output: "standalone".`,
  );
  process.exit(1);
}

// The standalone tree carries a dist directory named after `distDir`, not a
// literal `.next` — with NEXT_DIST_DIR=.next-cli the CLI build gets
// `.next-cli/` in there too. server.js resolves its static assets relative to
// that name, so the copy has to follow it rather than assume `.next`.
await cp(
  path.join(APP_DIR, DIST, "static"),
  path.join(STANDALONE, DIST, "static"),
  { recursive: true },
);

try {
  await cp(path.join(APP_DIR, "public"), path.join(STANDALONE, "public"), {
    recursive: true,
  });
} catch {
  // Not every app has a public/ directory.
}

console.log(`✓ standalone ready: ${STANDALONE}/server.js`);
