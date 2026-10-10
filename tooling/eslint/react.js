import baseConfig from "./base.js";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  ...baseConfig,
  {
    // React code runs in the browser (and service workers) — expose those
    // globals so `window`, `document`, `self`, `caches`, etc. aren't no-undef.
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    plugins: {
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      // Preserve existing hook checks. Compiler rules need separate adoption.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
