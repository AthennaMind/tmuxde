import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    // Every sibling build directory (see `distDir` in next.config.ts):
    // .next-dev, .next-build, .next-serve, plus .next-prev and any
    // .next-broken-* kept around by a promote or a rollback. These are all
    // generated output like `.next`, and linting them reports thousands of
    // problems in code nobody wrote. Matched by prefix so a new one added
    // later cannot quietly reintroduce that noise.
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Archived pre-Next.js prototype. Kept as the content reference for the
    // port, never built or shipped — linting it reports on dead code.
    "_legacy/**",
  ]),
]);

export default eslintConfig;
