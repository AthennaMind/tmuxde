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
