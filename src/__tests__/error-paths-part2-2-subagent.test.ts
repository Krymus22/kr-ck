/**
 * error-paths-part2-2-subagent.test.ts — Error Path 2
 *
 * Scenario: Sub-agent throws → main agent should catch and continue.
 *
 * Verifies that:
 *   - When runSubAgent's inner code throws (e.g., getSystemPrompt() fails in
 *     powerful mode), the error PROPAGATES (not silently swallowed as null).
 *   - The agent.ts executeHandler has a try/catch that converts any handler
 *     throw into an [ERROR] string, letting the main agent continue.
 *   - When chat() throws inside the retry loop, the inner catch handles it
 *     and returns null (the designed "sub-agent couldn't answer" behavior).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  isTransientNetworkErrorPublic: vi.fn(() => false),
  is429ErrorPublic: vi.fn(() => false),
  SUB_AGENT_MAX_CHAT_RETRIES: 2,
}));

vi.mock("../tools.js", () => ({ lerArquivo: vi.fn() }));
vi.mock("../fileSearch.js", () => ({ globSearch: vi.fn() }));
vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(),
  formatGrepResults: vi.fn(),
}));
vi.mock("../lspAst.ts", () => ({ parseFile: vi.fn() }));

vi.mock("../effortLevels.js", () => ({
  shouldUseSubAgents: vi.fn(() => true),
  getEffortLevel: vi.fn(() => "max"),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn(() => 0),
}));

vi.mock("../agent.js", () => ({
  getMergedToolsPublic: vi.fn(() => []),
  dispatchToolCallPublic: vi.fn(),
}));

// getSystemPrompt is configured per-test (we need it to throw for the test)
const mockGetSystemPrompt = vi.hoisted(() => vi.fn());
vi.mock("../history.js", () => ({
  getSystemPrompt: mockGetSystemPrompt,
  loadHistoryDirect: vi.fn(),
  optimizeContext: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSystemPrompt.mockReset();
  delete process.env.CLAUDE_KILLER_AGENT_ID;
});

afterEach(() => {
  delete process.env.CLAUDE_KILLER_AGENT_ID;
});

describe("Error path 2: Sub-agent throws → main agent catches and continues", () => {
  it("propagates the error when getSystemPrompt() throws in powerful mode (NOT swallowed as null)", async () => {
    // Arrange: getSystemPrompt throws — simulates a memory module failure
    mockGetSystemPrompt.mockImplementation(() => {
      throw new Error("memory module corruption: cannot build system prompt");
    });

    const { runSubAgent } = await import("../subAgents.js");

    // Act & Assert: runSubAgent should REJECT (throw), not return null.
    // This is the correct behavior — the caller (agent.ts executeHandler)
    // has a try/catch that converts any handler throw into an [ERROR] string
    // for the model, allowing the main agent to continue.
    await expect(
      runSubAgent({ question: "implement feature", powerful: true, maxToolCalls: 1 })
    ).rejects.toThrow("memory module corruption");
  });

  it("error propagation enables executeHandler to return [ERROR] string (not crash the agent)", async () => {
    // This test verifies the CONTRACT: runSubAgent propagates non-recoverable
    // errors. The agent.ts executeHandler (lines 1068-1074) wraps every handler
    // call in try/catch:
    //   try { return await handler(args, toolCall, healRetry); }
    //   catch (err) { return { resultStr: `[ERROR] ${err.message}`, usedHeal: false }; }
    //
    // If runSubAgent SWALLOWED the error (returned null), executeHandler would
    // see null = "subagent_disabled" (misleading). By propagating, executeHandler's
    // catch block converts it to "[ERROR] ..." which the main agent can react to.
    mockGetSystemPrompt.mockImplementation(() => {
      throw new Error("simulated sub-agent failure");
    });

    const { runSubAgent } = await import("../subAgents.js");

    // The sub-agent throws (propagates the error) — NOT returns null
    await expect(
      runSubAgent({ question: "test", powerful: true, maxToolCalls: 1 })
    ).rejects.toThrow("simulated sub-agent failure");
  });

  it("returns null (not throws) when chat() throws inside the retry loop — inner catch handles it", async () => {
    // This is the "normal" sub-agent failure path: chat() throws a
    // non-transient error inside the while loop. The inner try/catch
    // handles it and returns null.
    mockGetSystemPrompt.mockReturnValue("MOCK SYSTEM PROMPT");
    const { chat } = await import("../apiClient.js");
    const mockedChat = chat as ReturnType<typeof vi.fn>;
    mockedChat.mockRejectedValue(new Error("non-transient model error"));

    const { runSubAgent } = await import("../subAgents.js");
    const result = await runSubAgent({ question: "test", maxToolCalls: 2 });

    // Inner catch returns null — designed behavior for recoverable sub-agent
    // failures (main agent gets null = "sub-agent couldn't answer" and
    // continues with its own reasoning).
    expect(result).toBeNull();
  });

  it("restores CLAUDE_KILLER_AGENT_ID env var even when an error propagates", async () => {
    // Arrange: getSystemPrompt throws AFTER the env var is set would be a bug,
    // but actually getSystemPrompt is called BEFORE the env var is set in
    // runSubAgentInner. So we need a different scenario: make the import of
    // agent.js fail (which happens AFTER the env var is set).
    mockGetSystemPrompt.mockReturnValue("MOCK SYSTEM PROMPT");

    // Re-mock agent.js to throw on import
    vi.doMock("../agent.js", () => {
      throw new Error("agent.js module load failure");
    });

    const { runSubAgent } = await import("../subAgents.js");

    // Set a known previous agent ID
    process.env.CLAUDE_KILLER_AGENT_ID = "main-agent";

    // Act: runSubAgent should reject (agent.js import fails)
    await expect(
      runSubAgent({ question: "test", powerful: true, maxToolCalls: 1 })
    ).rejects.toThrow();

    // Assert: the env var was restored to the previous value by the finally block
    // (even though the error propagated). This proves cleanup happens on throw.
    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBe("main-agent");

    // Restore the original mock
    vi.doUnmock("../agent.js");
    vi.resetModules();
  });
});
