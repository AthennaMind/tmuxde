import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".turbo/vite",
  test: {
    maxWorkers: 2,
    environment: "node",
  },
});
