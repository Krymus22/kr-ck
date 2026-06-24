/**
 * agentCoverage.test.ts — Tests for agent.ts internal functions.
 *
 * Tests the tool dispatch pipeline, tool handler registration, and
 * helper functions that are testable without a full API integration.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  TOOL_DEFINITIONS: [],
  isTransientNetworkErrorPublic: vi.fn(() => false),
  is429ErrorPublic: vi.fn(() => false),
  SUB_AGENT_MAX_CHAT_RETRIES: 2,
}));

vi.mock("../extensions.js", () => ({
  loadAllExtensions: vi.fn(),
  getActiveSkills: vi.fn(() => []),
  getMCPToolDefinitions: vi.fn(() => []),
  callMCPTool: vi.fn(),
  shutdownMCPServers: vi.fn(),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: () => [], getByCategory: () => [], isInstalled: () => false, addTool: () => ({ success: false, message: "" }) })),
  getDetector: vi.fn(() => ({ detect: () => ({ intent: null, context: [] }), detectFromContext: () => [] })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: () => [] })),
  initializeTools: vi.fn(),
}));

vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({ globalDir: "/tmp", projectDir: "/tmp", historyDir: "/tmp", skillsDir: "/tmp" })),
  ensureMemoryDirs: vi.fn(),
  injectMemory: vi.fn(() => ({ projectMemory: "", checkpoint: null, globalMemory: "", relevantSkills: [], recentHistory: [], totalTokensEstimate: 0 })),
  formatInjectedMemory: vi.fn(() => ""),
  createCheckpoint: vi.fn(),
  saveSessionTrace: vi.fn(),
  shouldWriteCheckpoint: vi.fn(() => false),
  writeCheckpoint: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  startSession: vi.fn(), endSession: vi.fn(),
  recordToolCall: vi.fn(), recordMessage: vi.fn(),
  recordError: vi.fn(), recordApiCall: vi.fn(),
}));

vi.mock("../retry.js", () => ({
  withRetry: vi.fn(async (fn: any) => fn()),
  isRetryableError: vi.fn(() => false),
}));

vi.mock("../contextCompaction.js", () => ({
  smartCompact: vi.fn(() => ({ compacted: false, savedTokens: 0 })),
}));

vi.mock("../extensionCenter.js", () => ({
  executeTrigger: vi.fn(),
}));

vi.mock("../apiKeyPool.js", () => ({
  initApiKeyPool: vi.fn(() => false),
  getPoolSize: vi.fn(() => 0),
  acquireKeyForStreaming: vi.fn(),
  formatPoolStats: vi.fn(() => ""),
  getPoolStats: vi.fn(() => []),
}));

vi.mock("../tools.js", () => ({
  lerFile: vi.fn(),
  aplicarDiff: vi.fn(),
  executarComando: vi.fn(),
  desfazerEdicao: vi.fn(),
  listarBackups: vi.fn(),
}));

vi.mock("../diffPreview.js", () => ({
  previewAndApprove: vi.fn(() => true),
}));

vi.mock("../guardrail.js", () => ({
  validateSyntax: vi.fn(() => ({ valid: true })),
}));

vi.mock("../hooks.js", () => ({
  executePreToolCallHooks: vi.fn(() => ({ skip: false })),
  executePostToolCallHooks: vi.fn(() => ({})),
  executePreFileWriteHooks: vi.fn(() => ({ block: false })),
  executePostFileWriteHooks: vi.fn(),
}));

vi.mock("../fileRead.js", () => ({ readFileAdvanced: vi.fn() }));
vi.mock("../fileEdit.js", () => ({ editFile: vi.fn() }));
vi.mock("../fileSearch.js", () => ({ globSearch: vi.fn(() => []) }));
vi.mock("../contentSearch.js", () => ({ grepSearch: vi.fn(() => []), formatGrepResults: vi.fn(() => "") }));
vi.mock("../gitTool.js", () => ({
  gitStatus: vi.fn(), gitDiff: vi.fn(), gitLog: vi.fn(),
  gitCommit: vi.fn(), gitBlame: vi.fn(), gitShow: vi.fn(),
  gitBranch: vi.fn(), gitCheckout: vi.fn(),
}));
vi.mock("../multiFileEdit.js", () => ({ multiFileEdit: vi.fn() }));
vi.mock("../session.js", () => ({ saveSession: vi.fn(), loadSession: vi.fn(), listSessions: vi.fn() }));
vi.mock("../lspAst.js", () => ({ parseFile: vi.fn() }));
vi.mock("../toolCache.js", () => ({ readOnlyCache: { get: vi.fn(() => null), set: vi.fn(), invalidate: vi.fn() }, shouldCacheResult: vi.fn(() => false) }));
vi.mock("../parallelTools.js", () => ({ executeParallelTools: vi.fn(() => []) }));
vi.mock("../testRunner.js", () => ({ runTests: vi.fn(), formatTestResult: vi.fn(), suggestFixes: vi.fn(), formatFixSuggestions: vi.fn() }));

// Now we can import agent module — it will use all our mocks
import * as history from "../history.js";

describe("agent.ts — tool handler coverage", () => {
  describe("getSystemPrompt (via history)", () => {
    it.skip("contains Think Tool instructions", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("pensar");
      expect(prompt).toContain("REAFFIRM");
      expect(prompt).toContain("VERIFY");
    });

    it.skip("contains Poka-Yoke instructions", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("ABSOLUTE paths");
      expect(prompt).toContain("SEARCH");
      expect(prompt).toContain("REPLACE");
    });

    it.skip("contains Parallel Tool Calls instructions", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("parallel_tool_calls");
      expect(prompt).toContain("explorar_subagente");
    });

    it.skip("contains Multi-Key Pool instructions", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("NVIDIA_API_KEYS");
      expect(prompt).toContain("status_pool");
    });

    it.skip("contains Strict Quality Gate instructions", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("STRICT_MODE");
    });

    it("contains Task State instructions", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("TASK_STATE");
      expect(prompt).toContain("atualizar_estado");
    });

    it("contains Effort Level instructions", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("EFFORT LEVEL");
    });

    it("contains rollback instructions", () => {
      const prompt = history.getSystemPrompt();
      expect(prompt).toContain("desfazer_edicao");
    });
  });

  describe("history management", () => {
    beforeEach(() => {
      history.resetHistory();
    });

    it("initializes with system prompt as first message", () => {
      const h = history.getHistory();
      expect(h.length).toBeGreaterThan(0);
      expect(h[0].role).toBe("system");
    });

    it("adds user message", () => {
      history.addUserMessage("test message");
      const h = history.getHistory();
      const last = h[h.length - 1];
      expect(last.role).toBe("user");
      expect(last.content).toBe("test message");
    });

    it("adds tool result", () => {
      history.addToolResult("tc_1", "tool result content");
      const h = history.getHistory();
      const last = h[h.length - 1] as any;
      expect(last.role).toBe("tool");
      expect(last.content).toBe("tool result content");
      expect(last.tool_call_id).toBe("tc_1");
    });

    it("adds system message", () => {
      history.addSystemMessage("system note");
      const h = history.getHistory();
      const last = h[h.length - 1];
      expect(last.role).toBe("system");
      expect(last.content).toBe("system note");
    });

    it("estimateTokens returns positive number", () => {
      history.addUserMessage("some content to estimate");
      const tokens = history.estimateTokens();
      expect(tokens).toBeGreaterThan(0);
    });

    it("replaceHistory replaces the entire history", () => {
      history.addUserMessage("original");
      const newHistory = [
        { role: "system" as const, content: "new system" },
        { role: "user" as const, content: "new user" },
      ];
      history.replaceHistory(newHistory);
      const h = history.getHistory();
      expect(h.length).toBe(2);
      expect(h[0].content).toBe("new system");
      expect(h[1].content).toBe("new user");
    });

    it("resetHistory clears to just system prompt", () => {
      history.addUserMessage("to be cleared");
      history.resetHistory();
      const h = history.getHistory();
      expect(h.length).toBe(1);
      expect(h[0].role).toBe("system");
    });
  });

  describe("history optimization", () => {
    beforeEach(() => {
      history.resetHistory();
    });

    it("historySummary returns role counts", () => {
      history.addUserMessage("hello");
      history.addSystemMessage("note");
      const summary = history.historySummary();
      expect(summary).toContain("system:");
      expect(summary).toContain("user:");
    });

    it("compactHistory returns null when not enough messages", () => {
      history.addUserMessage("only one");
      const result = history.compactHistory();
      expect(result).toBeNull();
    });
  });
});
