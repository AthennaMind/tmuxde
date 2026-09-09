import type { NextConfig } from "next";

/**
 * Dev and production never share a build directory.
 *
 * PM2 serves the production build out of `.next` while it keeps running; a
 * `next dev` in the same checkout writes into that same tree and can hand the
 * live server half a build. Development therefore gets `.next-dev`, and
 * NEXT_DIST_DIR stays an explicit override for builds that need their own
 * directory (the CLI's stripped-env build of apps/web uses it).
 */
const distDir =
  process.env.NEXT_DIST_DIR ||
  (process.env.NODE_ENV === "development" ? ".next-dev" : ".next");

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
  transpilePackages: ["@repo/ui", "@repo/protocol", "@repo/crypto"],
  serverExternalPackages: ["pino", "pino-pretty"],
  // Monaco's codicon.ttf used to need an explicit webpack `asset/resource`
  // rule. Turbopack — the default bundler since Next 16 — already emits
  // unknown file types as static assets, so the rule is gone. Keeping a
  // `webpack` key here would additionally make `next build` fail outright
  // under Turbopack.
};

export default nextConfig;
