import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // config.ts throws unless a non-default AUTH_TOKEN is present; provide one
    // so importing modules under test doesn't blow up. Individual tests that
    // need specific ALLOWED_PATHS override process.env and dynamically import.
    env: {
      AUTH_TOKEN: "vitest-non-default-token",
      ALLOWED_PATHS: "/tmp",
    },
  },
});
