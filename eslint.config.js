// ESLint flat config with type-aware rules.
// Catches bugs that TypeScript strict mode misses:
// - unused variables/imports
// - unsafe assignments (any without explicit cast)
// - floating promises (missing await)
// - hook dependency issues

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Base JS rules
  js.configs.recommended,

  // Type-aware TS rules (needs parserOptions.project)
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,

  // Global settings
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Custom rules — relax some strict rules that are too noisy
  {
    rules: {
      // Allow console.log (we use it in TUI mode intentionally)
      "no-console": "off",
      // Allow explicit any in specific cases (OpenAI types, etc)
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow unused vars with _ prefix (convention)
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Don't require await on every async call (too noisy)
      "@typescript-eslint/no-floating-promises": "warn",
      // Allow non-null assertion (we use it carefully)
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },

  // Ignore patterns
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "reports/**",
      ".stryker-tmp/**",
      "e2e/**",
      "scripts/**",
      "*.config.ts",
      "*.config.js",
      "vitest-setup.ts",
    ],
  },
);
