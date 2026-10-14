import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Node environment on purpose. These tests cover pure logic (the attach
// state machine, the protocol codec, the lock crypto) and the WebSocket
// client with a stubbed global. None of them needs a DOM. Keeping jsdom out
// keeps the suite fast and light on dependencies.
//
// Two projects share this root config. One `vitest run` runs both. Run one
// alone with `pnpm test --project unit` or `pnpm test --project idb`.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  // node_modules is a read only volume in the container, so the Vite default
  // cache dir node_modules/.vite cannot be written. .cache is a cache volume.
  cacheDir: ".cache/vite",
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          // *.idb.test.ts belongs to the idb project. Without this they would
          // also run here, where there is no indexedDB at all.
          exclude: ["**/node_modules/**", "src/**/*.idb.test.ts"],
        },
      },
      {
        // Tests that need IndexedDB. fake-indexeddb/auto works in the node
        // environment, so jsdom stays out. A separate project keeps the setup
        // file away from the fast suite. The lock tests do real PBKDF2 and
        // are the slowest tests in the repo.
        extends: true,
        test: {
          name: "idb",
          include: ["src/**/*.idb.test.ts"],
          setupFiles: ["fake-indexeddb/auto"],
        },
      },
    ],
  },
});
