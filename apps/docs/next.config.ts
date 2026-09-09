import { createMDX } from "fumadocs-mdx/next";
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
  distDir,
  output: "standalone",
  transpilePackages: ["@repo/ui"],
  pageExtensions: ["tsx", "ts", "jsx", "js"],

  /**
   * `/docs/claude-code-remote` was a single 491-word page with zero inbound
   * links, and it has been replaced by the eight-page `/docs/agents` section.
   *
   * A redirect rather than a deletion: the URL is published, it is the one
   * agent-related docs URL anything external could be pointing at, and a 404
   * throws away whatever authority it has accumulated. 308 rather than 307
   * because this is the shape of the site, not a migration we intend to undo —
   * a permanent redirect lets crawlers fold the old URL into the new one
   * instead of re-checking it forever.
   */
  async redirects() {
    return [
      {
        source: "/docs/claude-code-remote",
        destination: "/docs/agents/claude-code",
        permanent: true,
      },
    ];
  },
};

const withMDX = createMDX();

export default withMDX(nextConfig);
