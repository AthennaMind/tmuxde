import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// The dev container mounts node_modules read only, so the Vite default
// node_modules/.vite cannot be written. Compose mounts a cache volume at
// /workspace/ui/.vite instead. The absolute path keeps that location
// even when Vite starts from another working directory.
const inContainer =
  Boolean(process.env.TMUXDE_CONTAINER) || existsSync("/workspace");

// Language grammars and language service modes load on demand. Leaving them
// out of the named chunks keeps each one a separate lazy chunk. The statically
// imported contribution files come back in as dependencies of the core.
const lazyMonaco = /[\\/]esm[\\/]vs[\\/](basic-languages|language)[\\/][^\\/]+[\\/]/;
const lazyShiki = /[\\/](@shikijs[\\/](langs|themes)|shiki[\\/]dist[\\/](langs|themes))[\\/]/;

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Set by hand to match tsconfig paths. No tsconfig paths plugin.
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
  cacheDir: inContainer ? "/workspace/ui/.vite" : ".vite",
  server: {
    host: "0.0.0.0",
    port: 24100,
    // Caddy and the Go binary proxy a fixed port. Fail instead of moving.
    strictPort: true,
    // Requests arrive with the LOCAL_DOMAIN host through Caddy and with
    // 127.0.0.1 through the Go binary. Vite always allows IP addresses and
    // localhost. Any other Host is refused, which blocks DNS rebinding.
    allowedHosts: [process.env.LOCAL_DOMAIN || "localhost"],
    // What proxy.ts set under Next. Caddy adds CSP and Permissions-Policy.
    // The Go binary drops these on pages and sets its own.
    headers: {
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  },
  optimizeDeps: {
    // Workspace packages export TypeScript source and are not pre-bundled.
    // Scanning their sources up front finds their npm dependencies at start,
    // so the first visit to a lazy view does not trigger a reload. Explicit
    // entries replace the default HTML crawl, so index.html stays listed.
    entries: [
      "index.html",
      "../packages/{ui-kit,protocol,crypto}/src/**/*.{ts,tsx}",
      "!../packages/**/*.test.{ts,tsx}",
    ],
  },
  worker: {
    // Monaco starts its workers with type module. The default iife format
    // also rules out code splitting inside a worker.
    format: "es",
  },
  build: {
    outDir: "dist",
    // The Go binary embeds dist. Source maps would only add size.
    sourcemap: false,
    target: "es2022",
    // In kB. Monaco stays one deliberate chunk of about 3.8 MB and loads
    // only with the editor. The entry chunk is under 1 MB. This limit keeps
    // the build free of size warnings.
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      output: {
        // Rolldown replacement for the deprecated manualChunks. Large
        // libraries get their own chunk so an app change does not
        // invalidate them in the browser cache.
        codeSplitting: {
          groups: [
            {
              // A group also takes the dependencies of its modules. Monaco
              // lazy loads its languages through this helper, so without
              // its own chunk the helper sits in the monaco chunk and every
              // dynamic import in the app would load Monaco first.
              name: "preload-helper",
              test: /vite[\\/]preload-helper/,
              priority: 1,
            },
            {
              name: "monaco",
              // Not @monaco-editor/react. It imports react, and a group
              // pulls in its dependencies, so react would land here. Not the
              // ?worker wrappers either. Their importer would then load all
              // of Monaco up front.
              test: (id) =>
                /[\\/]node_modules[\\/]monaco-editor[\\/]/.test(id) &&
                !id.includes("?") &&
                !lazyMonaco.test(id),
            },
            {
              name: "shiki",
              test: (id) =>
                /[\\/]node_modules[\\/](shiki|@shikijs)[\\/]/.test(id) &&
                !lazyShiki.test(id),
            },
            {
              name: "xterm",
              test: /[\\/]node_modules[\\/]@xterm[\\/]/,
            },
          ],
        },
      },
    },
  },
});
