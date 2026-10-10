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
    },
  },
  {
    // Ignore generated Next.js build files.
    ignores: [
      "next-env.d.ts",
      ".next/**",
      ".next-*/**",
      ".source/**",
      "out/**",
    ],
  },
];
