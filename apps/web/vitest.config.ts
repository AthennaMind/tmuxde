import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Node environment on purpose — these tests cover pure logic (the attach state
// machine) and the WebSocket client with a stubbed global, neither of which
// needs a DOM. Keeping jsdom out keeps the suite fast and dependency-light.
export default defineConfig({
  cacheDir: ".turbo/vite",
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    maxWorkers: 2,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `*.idb.test.ts` belongs to the sibling project in vitest.config.idb.ts,
    // which sets up fake-indexeddb. Without this they would also run here,
    // where there is no `indexedDB` at all.
    exclude: ["**/node_modules/**", "src/**/*.idb.test.ts"],
    // @repo/* workspace packages are published as raw TypeScript
    // (`"exports": "./src/index.ts"`), so they must be transformed rather than
    // externalised to node.
    server: {
      deps: {
        inline: [/@repo\//],
      },
    },
  },
});
