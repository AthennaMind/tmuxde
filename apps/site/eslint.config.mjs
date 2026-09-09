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
    // The dev-server build directory (see `distDir` in next.config.ts). It is
    // generated output like `.next`, and linting it reports thousands of
    // problems in code nobody wrote.
    ".next-dev/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Archived pre-Next.js prototype. Kept as the content reference for the
    // port, never built or shipped — linting it reports on dead code.
    "_legacy/**",
  ]),
]);

export default eslintConfig;
