import { defineConfig } from "vitest/config";

// One run covers every workspace. Projects without their own config use
// defaults: node environment and standard test file patterns.
export default defineConfig({
  cacheDir: ".cache/vite",
  test: {
    maxWorkers: 4,
    projects: [
      "stt",
      "ui/vitest.config.ts",
      "ui/vitest.config.idb.ts",
      "packages/crypto",
      "packages/protocol",
    ],
  },
});
