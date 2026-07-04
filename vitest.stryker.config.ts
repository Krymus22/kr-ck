import { defineConfig } from "vitest/config";

/**
 * Vitest config for Stryker mutation testing.
 * Excludes tests that depend on network or external state — these are
 * flaky in CI and cause Stryker's dry run to fail.
 *
 * Stryker requires ALL tests to pass in the initial dry run. If any test
 * fails, Stryker aborts with "There were failed tests in the initial test run."
 *
 * Excluded test files:
 * - apiResearcher tests (depend on Bing/NPM/GitHub/SO/MDN APIs)
 * - lspClient tests (depend on LSP servers being installed)
 * - integration tests that call external services
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.test.tsx"],
    exclude: [
      "node_modules/**",
      "dist/**",
      // Network-dependent tests — flaky in CI
      "src/__tests__/apiResearcher.test.ts",
      "src/__tests__/apiResearcher-extended.test.ts",
      "src/__tests__/apiResearcher-deep.test.ts",
      "src/__tests__/apiResearcher-official.test.ts",
      // LSP tests — depend on LSP servers installed
      "src/__tests__/lspClient.test.ts",
      "src/__tests__/lspClient-extended.test.ts",
      // Integration tests that may call external services
      "src/__tests__/integration-agent-flow.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
    },
  },
});
