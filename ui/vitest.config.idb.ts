import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A second project, for the tests that need IndexedDB.
 *
 * `fake-indexeddb/auto` works in the **node** environment, so this honours the
 * main config's deliberate choice to keep jsdom out rather than quietly
 * reversing it. It is a separate project rather than a setup file on the
 * existing one so the fast suite stays exactly as fast — the lock tests do real
 * PBKDF2 and are the slowest thing in the repo.
 *
 * Run alone with `pnpm test --project idb`. Root `pnpm test` runs both.
 */
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    name: "idb",
    include: ["src/**/*.idb.test.ts"],
    setupFiles: ["fake-indexeddb/auto"],
    server: {
      deps: {
        inline: [/@repo\//],
      },
    },
  },
});
