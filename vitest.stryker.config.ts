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
    // CRITICAL: pool must be "forks" with singleThread to allow process.chdir().
    // Stryker runs tests in worker threads by default, and process.chdir() is
    // NOT supported in workers — it throws "process.chdir() is not supported
    // in workers". Using pool: "forks" + singleThread: true makes vitest use
    // child processes (which support chdir) instead of worker threads.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
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
      // ALL tests that use process.chdir() — Stryker runs tests in worker
      // threads, and process.chdir() throws "not supported in workers" in
      // Node.js. These tests pass in normal CI (vitest run) but fail in Stryker.
      // Found via: grep -rln "process.chdir\|\.chdir(" src/__tests__/
      "src/__tests__/agent-extended.test.ts",
      "src/__tests__/agentIntegration.test.ts",
      "src/__tests__/cross-module-edge-cases.test.ts",
      "src/__tests__/fileEdit-extended.test.ts",
      "src/__tests__/imagePaste-extended.test.ts",
      "src/__tests__/integration-modes-system.test.ts",
      "src/__tests__/manifestLoader-extended.test.ts",
      "src/__tests__/manifestLoader.test.ts",
      "src/__tests__/modeMigration-extended.test.ts",
      "src/__tests__/modeMigration.test.ts",
      "src/__tests__/property-modes-system.test.ts",
      "src/__tests__/property-new-modules.test.ts",
      "src/__tests__/rollbackStore-extended.test.ts",
      "src/__tests__/rollbackStore.test.ts",
      "src/__tests__/slash-commands-full.test.tsx",
      "src/__tests__/stress-modes-system.test.ts",
      "src/__tests__/strictQualityGate-extended.test.ts",
      "src/__tests__/strictQualityGate.test.ts",
      "src/__tests__/taskState-extended.test.ts",
      "src/__tests__/taskState.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
    },
  },
});
