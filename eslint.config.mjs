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
    "out/**",
    "build/**",
    // Exported thesis/defence artifacts are distributable documents, not app source.
    "docs/thesis/defense-deck/**/*.js",
    "docs/thesis/ppt/**/*.js",
    "ios/**/build/**",
    "ios/App/App/public/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
