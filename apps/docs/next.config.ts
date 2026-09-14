import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

/**
 * Dev, build and serve each get their own directory. None of the three ever
 * share a tree.
 *
 *   .next-dev     `next dev`      — development
 *   .next-build   `next build`    — where a fresh build lands
 *   .next-serve   `next start` under PM2 (`NEXT_DIST_DIR`)
 *
 * The build output is deliberately NOT the directory the production process
 * reads. `next build` clears its dist directory before emitting into it, so
 * building into a tree that is being served strands that server with a
 * half-build it cannot require from. On 2026-09-09 a build did exactly that
 * to the marketing site: `.next` lost BUILD_ID, every top-level manifest and
 * all of server/chunks, and routes not already resident in memory began
 * throwing ChunkLoadError.
 *
 * Note this app sets output: "standalone" but PM2 runs `next start` against
 * it, so `.next-serve` is selected by NEXT_DIST_DIR in ecosystem.config.cjs
 * the same way the marketing site does it. *
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
