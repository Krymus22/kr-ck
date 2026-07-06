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
      // Slash-commands-full: tests /cd which uses Ink rendering + process.chdir.
      // In Stryker sandboxes, the Ink submit handler doesn't fire within the
      // test delay, so process.cwd() doesn't change. Excluding to let Stryker
      // run on all other test files.
      "src/__tests__/slash-commands-full.test.tsx",
    ],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
    },
  },
});
