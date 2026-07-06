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
      // Slash command tests that use Ink rendering + process.chdir — flaky
      // in Stryker sandboxes because process.cwd() doesn't change as expected
      // inside .stryker-tmp/sandbox-XXXX/.
      "src/__tests__/slash-commands-full.test.tsx",
      "src/__tests__/slash-commands.test.tsx",
      "src/__tests__/slash-commands-extra.test.tsx",
      "src/__tests__/tui-interactions.test.tsx",
      "src/__tests__/tui-edge-cases.test.tsx",
      "src/__tests__/tui-deep-conversations.test.tsx",
      "src/__tests__/tui-render-snapshots.test.tsx",
      "src/__tests__/tui-tool-messages.test.tsx",
      "src/__tests__/tui-tokens-context-bar.test.tsx",
      "src/__tests__/tui-chatdisplay.test.tsx",
      "src/__tests__/ConfiguratorChat.test.tsx",
      "src/__tests__/QuestionPrompt.test.tsx",
      "src/__tests__/app-state-flow.test.ts",
      "src/__tests__/autocomplete-subcommands.test.ts",
      "src/__tests__/fase7-tui.test.tsx",
      "src/__tests__/integration-tui-new-components.test.tsx",
      "src/__tests__/hub-e2e.test.tsx",
      "src/__tests__/hub-mode-filter.test.tsx",
      "src/__tests__/tui-hub-pagination.test.tsx",
      "src/__tests__/tool-detection-hub.test.tsx",
      "src/__tests__/integration-configurator-flow.test.ts",
      "src/__tests__/integration-inbox-organize.test.ts",
      "src/__tests__/integration-modes-system.test.ts",
      "src/__tests__/integration-hub-modes-flow.test.tsx",
      "src/__tests__/snapshot-tests.test.tsx",
      "src/__tests__/cross-module-edge-cases.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "coverage",
    },
  },
});
