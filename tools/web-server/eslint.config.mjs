import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated copy of tools/web-flasher (see scripts/prepare-static.mjs);
    // the flasher has its own conventions and vendored minified libs.
    "public/**",
    "drizzle/**",
  ]),
]);

export default eslintConfig;
