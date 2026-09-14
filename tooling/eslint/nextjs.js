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
      // Every sibling Next output directory (`distDir` in each app's
      // next.config.ts): .next-cli for the CLI build, .next-dev for the dev
      // server, .next-build and .next-serve for the build/serve split, plus
      // .next-prev from a promote. All generated, same as `.next`. Matched by
      // prefix so a new one cannot quietly start reporting thousands of
      // problems in code nobody wrote.
      ".next-*/**",
      ".source/**",
      "out/**",
    ],
  },
];
