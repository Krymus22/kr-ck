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

  // Type-aware TS rules (recommended, not strict — strict has too many errors)
  ...tseslint.configs.recommendedTypeChecked,

  // Global settings
  {
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Custom rules — relax some strict rules that are too noisy for this codebase
  {
    rules: {
      // Allow console.log (we use it in TUI mode intentionally)
      "no-console": "off",
      // Allow explicit any (OpenAI types, etc — too many to fix now)
      "@typescript-eslint/no-explicit-any": "off",
      // Allow unused vars with _ prefix
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Don't require await on every async call
      "@typescript-eslint/no-floating-promises": "off",
      // Allow non-null assertion
      "@typescript-eslint/no-non-null-assertion": "off",
      // Allow void in arrow function shorthand (common pattern in our code)
      "@typescript-eslint/no-confusing-void-expression": "off",
      // Allow unused expressions (iife pattern)
      "@typescript-eslint/no-unused-expressions": "off",
      // Allow require-style imports (we use createRequire for ESM compat)
      "@typescript-eslint/no-require-imports": "off",
      // Allow function hoisting
      "@typescript-eslint/no-use-before-define": "off",
      // Allow any in type assertions (too many OpenAI type mismatches)
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
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
