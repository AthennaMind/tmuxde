import { readFileSync } from "node:fs";

import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The version badge on the site is the version users will actually install, so
 * it is read from the package that gets published rather than typed by hand.
 * Hand-typing it is how the site ended up advertising 0.9.4 while npm served
 * 0.3.0.
 *
 * Read at config time and inlined as a build-time constant: `src/config/site.ts`
 * is imported by client components, so it cannot touch the filesystem itself.
 */
function publishedCliVersion(): string {
  const pkgUrl = new URL("../cli/package.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(pkgUrl, "utf8")) as {
    version?: string;
  };
  if (!version) {
    throw new Error(
      `apps/cli/package.json has no "version" field (read from ${pkgUrl.pathname})`,
    );
  }
  return version;
}

/**
 * Dev, build and serve each get their own directory. None of the three ever
 * share a tree.
 *
 *   .next-dev     `next dev`      — development
 *   .next-build   `next build`    — where a fresh build lands
 *   .next-serve   `next start`    — what PM2 actually serves (set via
 *                                   NEXT_DIST_DIR in ecosystem.config.cjs)
 *
 * The build output is deliberately NOT the directory the production server
 * reads. `next build` rewrites its dist directory in place: it clears the
 * manifests and chunks before emitting new ones, so building into the tree a
 * running `next start` is serving leaves that server with a half-build it
 * cannot require from. On 2026-09-09 a build did exactly that to the live
 * site — `.next` lost BUILD_ID, every top-level manifest and all of
 * server/chunks, and /pricing and /agents began throwing ChunkLoadError while
 * already-resident routes kept answering 200 from memory.
 *
 * Separating them means the worst a stray `turbo build` or `pnpm verify` can
 * do is leave a fresh build sitting unpromoted in `.next-build`. The live site
 * keeps serving. Promotion is an explicit step: `pnpm run promote`, which
 * swaps `.next-build` into place and reloads PM2.
 *
 * NEXT_DIST_DIR remains the explicit override, and is how the serve directory
 * is selected (the CLI's stripped-env build of apps/web uses it too).
 */
const distDir =
  process.env.NEXT_DIST_DIR ||
  (process.env.NODE_ENV === "development" ? ".next-dev" : ".next-build");

const nextConfig: NextConfig = {
  distDir,
  reactStrictMode: true,
  poweredByHeader: false,

  env: {
    NEXT_PUBLIC_MTMUX_VERSION: publishedCliVersion(),
  },
  // Trailing slashes create duplicate URLs; keep exactly one canonical form.
  trailingSlash: false,
  compress: true,

  images: {
    formats: ["image/avif", "image/webp"],
  },

  // `next start` is the production server (see ecosystem.config.cjs), so we
  // deliberately do NOT emit a standalone bundle — the two are alternatives,
  // not complements.

  async headers() {
    const securityHeaders = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "SAMEORIGIN" },
      { key: "Referrer-Policy", value: "origin-when-cross-origin" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
      },
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      },
    ];

    return [
      { source: "/:path*", headers: securityHeaders },
      // Next already serves /_next/static as immutable; overriding it breaks
      // dev-mode revalidation, so it is deliberately left alone.
      {
        source: "/:file(feed.xml|llms.txt|robots.txt|sitemap.xml)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, s-maxage=86400",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
