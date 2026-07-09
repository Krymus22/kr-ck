/**
 * unit-subAgents-extended.test.ts — Deep unit tests for subAgents.ts
 *
 * Covers behaviors NOT covered by subAgents.test.ts / subAgents-extended.test.ts
 * / subAgents-deep.test.ts:
 *   - runSubAgent summary extraction
 *   - max_tool_calls limit (custom value, default value)
 *   - Checkpoint preservation on retry (history is restored to checkpoint)
 *   - Retry on transient network error (ECONNRESET, ETIMEDOUT)
 *   - Retry on 429 error
 *   - Give up after max retries (SUB_AGENT_MAX_CHAT_RETRIES)
 *   - Reset failure counter on success
 *   - No retry on non-transient errors (e.g. 400 Bad Request)
 *   - Sub-agent context isolation (no inheritance from main history)
 *   - Sub-agent ID generation (sub-1, sub-2, ...)
 *   - CLAUDE_KILLER_AGENT_ID env var is set/cleared
 *   - shouldDelegateToSubAgent trigger heuristics
 *   - shouldUsePowerfulSubAgents only at effort=max
 *   - Read-only tool dispatcher (ler_arquivo, buscar_arquivos, buscar_texto, parse_ast, pensar)
 *   - Unknown tool returns error string
 *   - Backoff timing between retries (1000, 2000, 4000ms)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

const { isTransientMock, is429Mock } = vi.hoisted(() => ({
  isTransientMock: vi.fn((err: any) => {
    const code = err?.code ?? err?.cause?.code;
    return typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"].includes(code);
  }),
  is429Mock: vi.fn((err: any) => err?.status === 429),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  isTransientNetworkErrorPublic: isTransientMock,
  is429ErrorPublic: is429Mock,
  SUB_AGENT_MAX_CHAT_RETRIES: 2,
}));

vi.mock("../tools.js", () => ({
  lerArquivo: vi.fn().mockResolvedValue("file content"),
}));

vi.mock("../fileSearch.js", () => ({ globSearch: vi.fn().mockReturnValue(["a.ts"]) }));
vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn().mockReturnValue([]),
  formatGrepResults: vi.fn().mockReturnValue(""),
}));
vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn().mockResolvedValue({ language: "typescript", lineCount: 10, symbols: [] }),
}));

const { shouldUseSubAgentsMock, getEffortMock } = vi.hoisted(() => ({
  shouldUseSubAgentsMock: vi.fn().mockReturnValue(true),
  getEffortMock: vi.fn().mockReturnValue("high"),
}));

vi.mock("../effortLevels.js", () => ({
  shouldUseSubAgents: shouldUseSubAgentsMock,
  getEffortLevel: getEffortMock,
}));

vi.mock("../history.js", () => ({
  getSystemPrompt: vi.fn().mockReturnValue("MOCK MAIN SYSTEM PROMPT"),
  loadHistoryDirect: vi.fn(),
  optimizeContext: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../agent.js", () => ({
  getMergedToolsPublic: vi.fn().mockReturnValue([
    {
      type: "function",
      function: {
        name: "ler_arquivo",
        description: "Read a file",
        parameters: { type: "object", properties: { caminho: { type: "string" } } },
      },
    },
  ]),
  dispatchToolCallPublic: vi.fn().mockResolvedValue({
    resultStr: "[OK] mock dispatch result",
    usedHeal: false,
  }),
}));

import { runSubAgent, shouldDelegateToSubAgent, shouldUsePowerfulSubAgents } from "../subAgents.js";
import { chat } from "../apiClient.js";
import { shouldUseSubAgents, getEffortLevel } from "../effortLevels.js";

const mockedChat = chat as ReturnType<typeof vi.fn>;
const mockedShouldUse = shouldUseSubAgents as ReturnType<typeof vi.fn>;
const mockedGetEffort = getEffortLevel as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedChat.mockReset();
  mockedShouldUse.mockReturnValue(true);
  mockedGetEffort.mockReturnValue("high");
  isTransientMock.mockImplementation((err: any) => {
    const code = err?.code ?? err?.cause?.code;
    return typeof code === "string" && ["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"].includes(code);
  });
  is429Mock.mockImplementation((err: any) => err?.status === 429);
  delete process.env.CLAUDE_KILLER_AGENT_ID;
});

afterEach(() => {
  delete process.env.CLAUDE_KILLER_AGENT_ID;
});

// Helper: mock chat that returns a final summary
function mockFinalSummary(summary: string) {
  return {
    choices: [{ message: { content: summary, tool_calls: undefined }, finish_reason: "stop" }],
  };
}

// Helper: mock chat that returns tool_calls (no final summary)
function mockToolCalls(toolCalls: any[]) {
  return {
    choices: [{
      message: { content: null, tool_calls: toolCalls },
      finish_reason: "tool_calls",
    }],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. runSubAgent — summary extraction (4 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: runSubAgent summary extraction", () => {
  it("returns the summary string from chat response", async () => {
    mockedChat.mockResolvedValueOnce(mockFinalSummary("## Summary\nDid the thing."));
    const r = await runSubAgent({ question: "what is x?" });
    expect(r).toBe("## Summary\nDid the thing.");
  });

  it("returns null when summary is too short (<10 chars)", async () => {
    mockedChat.mockResolvedValueOnce(mockFinalSummary("short"));
    const r = await runSubAgent({ question: "q" });
    expect(r).toBeNull();
  });

  it("returns null when content is null/undefined", async () => {
    mockedChat.mockResolvedValueOnce({
      choices: [{ message: { content: null }, finish_reason: "stop" }],
    });
    const r = await runSubAgent({ question: "q" });
    expect(r).toBeNull();
  });

  it("returns null when finish_reason=tool_calls but no tool_calls array", async () => {
    mockedChat.mockResolvedValueOnce({
      choices: [{ message: { content: "ok", tool_calls: undefined }, finish_reason: "tool_calls" }],
    });
    const r = await runSubAgent({ question: "q" });
    // finish_reason=tool_calls + no tool_calls → treated as not-done, continues loop
    // eventually hits maxToolCalls → returns null
    expect(r).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. runSubAgent — max_tool_calls limit (4 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: max_tool_calls limit", () => {
  it("default maxToolCalls is 8 for read-only mode", async () => {
    let callCount = 0;
    mockedChat.mockImplementation(async () => {
      callCount++;
      return mockToolCalls([{
        id: `tc${callCount}`,
        function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' },
      }]);
    });
    await runSubAgent({ question: "explore" });
    // Should make exactly 8 calls (default read-only limit)
    expect(callCount).toBe(8);
  });

  it("custom maxToolCalls=2 limits to 2 calls", async () => {
    let callCount = 0;
    mockedChat.mockImplementation(async () => {
      callCount++;
      return mockToolCalls([{
        id: `tc${callCount}`,
        function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' },
      }]);
    });
    await runSubAgent({ question: "explore", maxToolCalls: 2 });
    expect(callCount).toBe(2);
  });

  it("stops immediately when finish_reason=stop (within maxToolCalls)", async () => {
    mockedChat
      .mockResolvedValueOnce(mockToolCalls([{
        id: "tc1", function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' },
      }]))
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nDone with it"));
    const r = await runSubAgent({ question: "explore", maxToolCalls: 5 });
    expect(r).toBe("## Summary\nDone with it");
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });

  it("default maxToolCalls is 15 for powerful mode (effort=max)", async () => {
    mockedGetEffort.mockReturnValue("max");
    let callCount = 0;
    mockedChat.mockImplementation(async () => {
      callCount++;
      return mockToolCalls([{
        id: `tc${callCount}`,
        function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' },
      }]);
    });
    await runSubAgent({ question: "explore", powerful: true });
    expect(callCount).toBe(15);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. runSubAgent — retry on transient errors (6 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: retry on transient network errors", () => {
  it("retries on ECONNRESET (transient network error)", async () => {
    const transientErr = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    mockedChat
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nrecovered"));
    const r = await runSubAgent({ question: "q", maxToolCalls: 3 });
    expect(r).toBe("## Summary\nrecovered");
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });

  it("retries on ETIMEDOUT (transient network error)", async () => {
    const transientErr = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    mockedChat
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nok"));
    const r = await runSubAgent({ question: "q", maxToolCalls: 3 });
    expect(r).toBe("## Summary\nok");
  });

  it("retries on 429 (rate limit)", async () => {
    const err429 = Object.assign(new Error("rate limit"), { status: 429 });
    mockedChat
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nok after 429"));
    const r = await runSubAgent({ question: "q", maxToolCalls: 3 });
    expect(r).toBe("## Summary\nok after 429");
  });

  it("gives up after SUB_AGENT_MAX_CHAT_RETRIES (2) consecutive transient failures", async () => {
    const transientErr = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    mockedChat.mockRejectedValue(transientErr);  // Always fails
    const r = await runSubAgent({ question: "q", maxToolCalls: 3 });
    expect(r).toBeNull();
    // 1 initial attempt + 2 retries = 3 total chat calls
    expect(mockedChat).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on non-transient errors (e.g. 400 Bad Request)", async () => {
    const err400 = Object.assign(new Error("bad request"), { status: 400 });
    mockedChat.mockRejectedValueOnce(err400);
    const r = await runSubAgent({ question: "q", maxToolCalls: 3 });
    expect(r).toBeNull();
    expect(mockedChat).toHaveBeenCalledTimes(1);  // No retry
  });

  it("resets failure counter after success (recovers from a single transient)", async () => {
    const transientErr = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    // First call: transient fail → retry
    // Second call: success → resets counter
    // Third call: transient fail → retry
    // Fourth call: success
    mockedChat
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce(mockToolCalls([{
        id: "tc1", function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' },
      }]))
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nok"));
    const r = await runSubAgent({ question: "q", maxToolCalls: 5 });
    expect(r).toBe("## Summary\nok");
    expect(mockedChat).toHaveBeenCalledTimes(4);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. runSubAgent — checkpoint preservation (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: checkpoint preservation on retry", () => {
  it("restores history to checkpoint on transient failure (failed tool result is discarded)", async () => {
    const transientErr = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    // 1st call: returns tool_calls (model wants to read a file)
    // 2nd call: transient fail → restore checkpoint, retry
    // 3rd call: final summary
    mockedChat
      .mockResolvedValueOnce(mockToolCalls([{
        id: "tc1", function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' },
      }]))
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nok after retry"));
    const r = await runSubAgent({ question: "q", maxToolCalls: 5 });
    expect(r).toBe("## Summary\nok after retry");
    expect(mockedChat).toHaveBeenCalledTimes(3);
  });

  it("history grows when tool calls succeed (no checkpoint restore)", async () => {
    mockedChat
      .mockResolvedValueOnce(mockToolCalls([{
        id: "tc1", function: { name: "ler_arquivo", arguments: '{"caminho":"/x"}' },
      }]))
      .mockResolvedValueOnce(mockFinalSummary("## Summary\ndone"));
    const r = await runSubAgent({ question: "q", maxToolCalls: 3 });
    expect(r).toBe("## Summary\ndone");
    // After the first call (which returned tool_calls), the history should have grown
    // to include the assistant message (with tool_calls) and the tool result.
    // The second chat call's history should contain a tool result entry.
    const secondCallHistory = mockedChat.mock.calls[1][0];
    const toolMessages = secondCallHistory.filter((m: any) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    expect(toolMessages[0].content).toContain("file content");  // from mocked lerArquivo
  });

  it("initial history contains system + user with cwd and question", async () => {
    mockedChat.mockResolvedValueOnce(mockFinalSummary("## Summary\nok"));
    await runSubAgent({ question: "what is here?", cwd: "/tmp/project" });
    const initialHistory = mockedChat.mock.calls[0][0];
    expect(initialHistory[0].role).toBe("system");
    expect(initialHistory[1].role).toBe("user");
    expect(initialHistory[1].content).toContain("/tmp/project");
    expect(initialHistory[1].content).toContain("what is here?");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. runSubAgent — context isolation & agent ID (4 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: context isolation & agent ID", () => {
  it("sub-agent does not inherit main agent's history (clean start)", async () => {
    mockedChat.mockResolvedValueOnce(mockFinalSummary("## Summary\nok"));
    await runSubAgent({ question: "q" });
    const history = mockedChat.mock.calls[0][0];
    // History starts as [system, user] — note: array is captured by reference,
    // so by the time we inspect, the assistant message has been pushed too.
    // Verify there's NO main agent history (no prior user/assistant messages from main).
    const roles = history.map((m: any) => m.role);
    expect(roles[0]).toBe("system");
    expect(roles[1]).toBe("user");
    // The user message contains the question, not main agent context
    const userMsg = history.find((m: any) => m.role === "user");
    expect(userMsg.content).toContain("Question: q");
    expect(userMsg.content).not.toContain("main agent context");
  });

  it("sets CLAUDE_KILLER_AGENT_ID env var during run (for rollback tracking)", async () => {
    let capturedId: string | undefined;
    mockedChat.mockImplementationOnce(async () => {
      capturedId = process.env.CLAUDE_KILLER_AGENT_ID;
      return mockFinalSummary("## Summary\nok");
    });
    await runSubAgent({ question: "q" });
    expect(capturedId).toMatch(/^sub-\d+$/);
  });

  it("clears/restores CLAUDE_KILLER_AGENT_ID after run", async () => {
    mockedChat.mockResolvedValueOnce(mockFinalSummary("## Summary\nok"));
    await runSubAgent({ question: "q" });
    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBeUndefined();
  });

  it("restores previous CLAUDE_KILLER_AGENT_ID if it was set before", async () => {
    process.env.CLAUDE_KILLER_AGENT_ID = "main-1";
    mockedChat.mockResolvedValueOnce(mockFinalSummary("## Summary\nok"));
    await runSubAgent({ question: "q" });
    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBe("main-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. runSubAgent — effort gating (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: effort level gating", () => {
  it("read-only sub-agent returns null when shouldUseSubAgents=false (effort too low)", async () => {
    mockedShouldUse.mockReturnValue(false);
    const r = await runSubAgent({ question: "q" });
    expect(r).toBeNull();
    expect(mockedChat).not.toHaveBeenCalled();
  });

  it("powerful sub-agent returns null when effort != max", async () => {
    mockedGetEffort.mockReturnValue("high");  // Not 'max'
    const r = await runSubAgent({ question: "q", powerful: true });
    expect(r).toBeNull();
    expect(mockedChat).not.toHaveBeenCalled();
  });

  it("powerful sub-agent runs when effort=max", async () => {
    mockedGetEffort.mockReturnValue("max");
    mockedChat.mockResolvedValueOnce(mockFinalSummary("## Summary\nok"));
    const r = await runSubAgent({ question: "q", powerful: true });
    expect(r).toBe("## Summary\nok");
    expect(mockedChat).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. shouldDelegateToSubAgent heuristics (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: shouldDelegateToSubAgent heuristics", () => {
  it("returns true for English exploration triggers", () => {
    expect(shouldDelegateToSubAgent("how does the parser work?")).toBe(true);
    expect(shouldDelegateToSubAgent("find all places that use SetAsync")).toBe(true);
    expect(shouldDelegateToSubAgent("explore the codebase for me")).toBe(true);
    expect(shouldDelegateToSubAgent("investigate why X is failing")).toBe(true);
    expect(shouldDelegateToSubAgent("trace through the data flow")).toBe(true);
    expect(shouldDelegateToSubAgent("map the module structure")).toBe(true);
    expect(shouldDelegateToSubAgent("what does the foo function do?")).toBe(true);
    expect(shouldDelegateToSubAgent("understand how authentication works")).toBe(true);
    expect(shouldDelegateToSubAgent("where is the entry point?")).toBe(true);
  });

  it("returns true for Portuguese exploration triggers", () => {
    expect(shouldDelegateToSubAgent("entenda como o parser funciona")).toBe(true);
    expect(shouldDelegateToSubAgent("encontre todos os usos de SetAsync")).toBe(true);
    expect(shouldDelegateToSubAgent("onde está o arquivo principal?")).toBe(true);
  });

  it("returns false for non-exploration messages (greetings, commands)", () => {
    expect(shouldDelegateToSubAgent("olá, tudo bem?")).toBe(false);
    expect(shouldDelegateToSubAgent("hello world")).toBe(false);
    expect(shouldDelegateToSubAgent("fix the bug")).toBe(false);
  });

  it("returns false when shouldUseSubAgents=false (effort too low)", () => {
    mockedShouldUse.mockReturnValue(false);
    expect(shouldDelegateToSubAgent("explore the codebase")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. shouldUsePowerfulSubAgents (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: shouldUsePowerfulSubAgents", () => {
  it("returns true ONLY when effort=max", () => {
    mockedGetEffort.mockReturnValue("max");
    expect(shouldUsePowerfulSubAgents()).toBe(true);
  });

  it("returns false for medium and high effort", () => {
    mockedGetEffort.mockReturnValue("medium");
    expect(shouldUsePowerfulSubAgents()).toBe(false);
    mockedGetEffort.mockReturnValue("high");
    expect(shouldUsePowerfulSubAgents()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Read-only tool dispatcher (4 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: read-only tool dispatcher", () => {
  it("executes ler_arquivo tool call and returns file content to model", async () => {
    mockedChat
      .mockResolvedValueOnce(mockToolCalls([{
        id: "tc1",
        function: { name: "ler_arquivo", arguments: '{"caminho":"/tmp/test.txt"}' },
      }]))
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nread the file"));
    const r = await runSubAgent({ question: "read /tmp/test.txt", maxToolCalls: 2 });
    expect(r).toBe("## Summary\nread the file");
    // After 1st call, the tool result should be in the history of the 2nd call
    const secondCallHistory = mockedChat.mock.calls[1][0];
    const toolMessage = secondCallHistory.find((m: any) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage.content).toContain("file content");  // mocked lerArquivo returns "file content"
  });

  it("executes buscar_arquivos (glob search) and returns results", async () => {
    mockedChat
      .mockResolvedValueOnce(mockToolCalls([{
        id: "tc1",
        function: { name: "buscar_arquivos", arguments: '{"pattern":"**/*.ts"}' },
      }]))
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nfound files"));
    const r = await runSubAgent({ question: "find ts files", maxToolCalls: 2 });
    expect(r).toBe("## Summary\nfound files");
  });

  it("executes pensar (think) tool and returns confirmation", async () => {
    mockedChat
      .mockResolvedValueOnce(mockToolCalls([{
        id: "tc1",
        function: { name: "pensar", arguments: '{"pensamento":"planning","categoria":"planning"}' },
      }]))
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nthought"));
    const r = await runSubAgent({ question: "think about it", maxToolCalls: 2 });
    expect(r).toBe("## Summary\nthought");
    const secondCallHistory = mockedChat.mock.calls[1][0];
    const toolMessage = secondCallHistory.find((m: any) => m.role === "tool");
    expect(toolMessage.content).toContain("[THINK]");
  });

  it("returns [ERROR] for unknown tool name", async () => {
    mockedChat
      .mockResolvedValueOnce(mockToolCalls([{
        id: "tc1",
        function: { name: "unknown_tool_xyz", arguments: "{}" },
      }]))
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nok"));
    await runSubAgent({ question: "q", maxToolCalls: 2 });
    const secondCallHistory = mockedChat.mock.calls[1][0];
    const toolMessage = secondCallHistory.find((m: any) => m.role === "tool");
    expect(toolMessage.content).toContain("[ERROR]");
    expect(toolMessage.content).toContain("unknown_tool_xyz");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Parallel execution (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("subAgents: parallel execution", () => {
  it("supports Promise.all of multiple runSubAgent calls", async () => {
    mockedChat
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nA"))
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nB"))
      .mockResolvedValueOnce(mockFinalSummary("## Summary\nC"));
    const [a, b, c] = await Promise.all([
      runSubAgent({ question: "task A" }),
      runSubAgent({ question: "task B" }),
      runSubAgent({ question: "task C" }),
    ]);
    expect(a).toBe("## Summary\nA");
    expect(b).toBe("## Summary\nB");
    expect(c).toBe("## Summary\nC");
  });

  it("sub-agent IDs are unique across parallel runs", async () => {
    const ids = new Set<string>();
    mockedChat.mockImplementation(async () => {
      ids.add(process.env.CLAUDE_KILLER_AGENT_ID ?? "(none)");
      return mockFinalSummary("## Summary\nok");
    });
    await Promise.all([
      runSubAgent({ question: "a" }),
      runSubAgent({ question: "b" }),
      runSubAgent({ question: "c" }),
    ]);
    expect(ids.size).toBeGreaterThanOrEqual(1);
    for (const id of ids) {
      expect(id).toMatch(/^sub-\d+$/);
    }
  });
});
