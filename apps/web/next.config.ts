import type { NextConfig } from "next";

/**
 * Dev, build and serve each get their own directory. None of the three ever
 * share a tree.
 *
 *   .next-dev     `next dev`      — development
 *   .next-build   `next build`    — where a fresh build lands
 *   .next-serve   the standalone server PM2 boots
 *
 * The build output is deliberately NOT the directory the production process
 * reads. `next build` clears its dist directory before emitting into it, so
 * building into a tree that is being served strands that server with a
 * half-build it cannot require from. On 2026-09-09 a build did exactly that
 * to the marketing site: `.next` lost BUILD_ID, every top-level manifest and
 * all of server/chunks, and routes not already resident in memory began
 * throwing ChunkLoadError.
 *
 * apps/web is the one app PM2 boots by standalone server path rather than
 * `next start`, so its serve directory is named in ecosystem.config.cjs's
 * `script` field (.next-serve/standalone/apps/web/server.js) rather than by
 * NEXT_DIST_DIR. prepare-standalone.mjs stages .next/static and public/ into
 * the build tree before it is promoted. *
 * So the worst a stray `turbo build` can do is leave a fresh build sitting
 * unpromoted in `.next-build`; the running process keeps serving. Promotion
 * is an explicit step: `scripts/promote-build.mjs`.
 *
 * NEXT_DIST_DIR remains the explicit override (the CLI's stripped-env build
 * of apps/web uses it to build into `.next-cli`).
 */
const distDir =
  process.env.NEXT_DIST_DIR ||
  (process.env.NODE_ENV === "development" ? ".next-dev" : ".next-build");

const nextConfig: NextConfig = {
  output: "standalone",
  // Next 16 takes a build lock per output directory. The CLI build shells out
  // to `next build` while turbo may be running the app's own build in the same
  // pass, so the CLI points here at a separate directory — otherwise the two
  // collide and `pnpm build` fails. It also keeps the CLI's deliberately
  // stripped NEXT_PUBLIC_* environment out of the developer's .next.
  distDir,
  // Next's dev-tools overlay anchors to the bottom of the viewport, which on a
  // phone lands squarely on our bottom nav and swallows taps on the Terminal
  // tab — the app is unusable on mobile in dev. Dev-only surface, so turning it
  // off costs nothing and makes `pnpm dev` honest about the mobile layout.
  devIndicators: false,
  /**
   * `next dev` serves its own chunks and its HMR socket cross-origin-guarded,
   * and 127.0.0.1 is a different origin from the localhost it binds.
   *
   * Playwright's `baseURL` is `http://127.0.0.1:<port>`, so every spec loaded
   * a page whose dev resources Next refused:
   *
   *     Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr
   *     from "127.0.0.1"
   *
   * The page server-renders and then never hydrates — so the app sits on
   * `LockGate`'s "Checking whether this device is locked" spinner forever,
   * because the effect that would clear it belongs to a React tree that was
   * never brought to life. Five of the seven specs in
   * `e2e/mobile-command-bar.spec.ts` fail on it today, and the reason nobody
   * noticed is that `.github/workflows/ci.yml` has no Playwright job at all.
   *
   * Dev-only: `allowedDevOrigins` governs `next dev` and nothing else.
   */
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: ["@repo/ui", "@repo/protocol", "@repo/crypto"],
  serverExternalPackages: ["pino", "pino-pretty"],
  // Monaco's codicon.ttf used to need an explicit webpack `asset/resource`
  // rule. Turbopack — the default bundler since Next 16 — already emits
  // unknown file types as static assets, so the rule is gone. Keeping a
  // `webpack` key here would additionally make `next build` fail outright
  // under Turbopack.
};

export default nextConfig;
