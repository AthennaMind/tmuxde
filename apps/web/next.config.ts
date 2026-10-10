import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir:
    process.env.NEXT_DIST_DIR ||
    (process.env.NODE_ENV === "development" ? ".next-dev" : ".next-build"),
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1", process.env.LOCAL_DOMAIN || "localhost"],
  transpilePackages: ["@repo/ui", "@repo/protocol", "@repo/crypto"],
};

export default nextConfig;
