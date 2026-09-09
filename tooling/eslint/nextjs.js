import reactConfig from "./react.js";
import nextPlugin from "@next/eslint-plugin-next";

export default [
  ...reactConfig,
  {
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // Next.js specific rules
      "react/no-unescaped-entities": "off",
    },
  },
  {
    // Framework-generated files — not authored, so don't lint them.
    // `.next-cli` is the CLI build's separate Next output directory; see
    // apps/cli/scripts/build.mjs.
    ignores: [
      "next-env.d.ts",
      ".next/**",
      ".next-cli/**",
      // The dev-server output directory (`distDir` in each app's
      // next.config.ts). Generated code, same as `.next`.
      ".next-dev/**",
      ".source/**",
      "out/**",
    ],
  },
];
