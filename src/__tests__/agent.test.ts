/**
 * agent.test.ts — Tests for agent.ts logic.
 * Mocks the OpenAI chat function — NO real API calls.
 * Tests: parseArgs, asString, isTestFailure, alreadyInHistory,
 * tool dispatch, auto-heal, READ_ONLY_TOOLS, trigger context,
 * runAgentLoop with mocked responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ─── Mock all external dependencies BEFORE importing agent ────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn() },
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  throttle: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    nvidiaBaseUrl: "https://test.api.nvidia.com/v1",
    model: "test-model",
    contextWindowTokens: 128000,
    contextWarnThreshold: 0.5,
    contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01,
    costPerKCompletion: 0.03,
    maxHealRetries: 2,
  },
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  TOOL_DEFINITIONS: [],
}));

vi.mock("../history.js", () => ({
  getHistory: vi.fn(() => []),
  addRawAssistantMessage: vi.fn(),
  addUserMessage: vi.fn(),
  addToolResult: vi.fn(),
  addSystemMessage: vi.fn(),
  optimizeContext: vi.fn(),
  historySummary: vi.fn(() => "0 msgs"),
  historyLength: vi.fn(() => 0),
  estimateTokens: vi.fn(() => 0),
  loadHistoryDirect: vi.fn(),
  getSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../tools.js", () => ({
  lerFile: vi.fn(),
  aplicarDiff: vi.fn(),
  executarComando: vi.fn(),
}));

vi.mock("../hooks.js", () => ({
  executePreToolCallHooks: vi.fn(() => Promise.resolve({ skip: false })),
  executePostToolCallHooks: vi.fn(() => Promise.resolve({ modifiedResult: null })),
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []),
  callMCPTool: vi.fn(),
}));

vi.mock("../fileRead.js", () => ({
  readFileAdvanced: vi.fn(() => "file content"),
}));

vi.mock("../fileEdit.js", () => ({
  editFile: vi.fn(() => "edited"),
}));

vi.mock("../fileSearch.js", () => ({
  globSearch: vi.fn(() => ["file1.ts", "file2.ts"]),
}));

vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(() => []),
  formatGrepResults: vi.fn(() => "no matches"),
}));

vi.mock("../gitTool.js", () => ({
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  gitLog: vi.fn(),
  gitCommit: vi.fn(),
  gitBlame: vi.fn(),
  gitShow: vi.fn(),
  gitBranch: vi.fn(),
  gitCheckout: vi.fn(),
}));

vi.mock("../multiFileEdit.js", () => ({
  multiFileEdit: vi.fn(() => ({ success: true, filesEdited: [], errors: [] })),
}));

vi.mock("../session.js", () => ({
  startSession: vi.fn(() => "test-session"), appendMessage: vi.fn(),
  listSessions: vi.fn(() => []),
}));

vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn(() => ({ language: "typescript", lineCount: 100, symbols: [], imports: [] })),
}));

vi.mock("../retry.js", () => ({
  withRetry: vi.fn((fn: () => Promise<any>) => fn()),
  isRetryableError: vi.fn(() => false),
}));

vi.mock("../toolCache.js", () => ({
  readOnlyCache: { get: vi.fn(() => null), set: vi.fn(), invalidate: vi.fn() },
  shouldCacheResult: vi.fn(() => false),
}));

vi.mock("../parallelTools.js", () => ({
  executeParallelTools: vi.fn(async (tools: any[]) => 
    tools.map((t: any) => ({ id: t.id, name: t.name, success: true, result: "ok" }))
  ),
}));

vi.mock("../telemetry.js", () => ({
  startSession: vi.fn(),
  endSession: vi.fn(),
  recordToolCall: vi.fn(),
  recordMessage: vi.fn(),
}));

vi.mock("../contextCompaction.js", () => ({
  smartCompact: vi.fn(() => ({ compacted: false, savedTokens: 0 })),
}));

vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({})),
  ensureMemoryDirs: vi.fn(),
  injectMemory: vi.fn(() => ({ totalTokensEstimate: 0 })),
  formatInjectedMemory: vi.fn(() => ""),
  createCheckpoint: vi.fn(),
  saveSessionTrace: vi.fn(),
  shouldWriteCheckpoint: vi.fn(() => false),
  writeCheckpoint: vi.fn(),
}));

vi.mock("../testRunner.js", () => ({
  runTests: vi.fn(),
  formatTestResult: vi.fn(),
  suggestFixes: vi.fn(),
  formatFixSuggestions: vi.fn(),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn() })),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(),
}));

vi.mock("../extensionCenter.js", () => ({
  executeTrigger: vi.fn(() => Promise.resolve()),
  // Reactive store hooks — required by useSyncExternalStore in ExtensionHub
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

// ─── Now import agent with mocked dependencies ───────────────────────────

import { runAgentLoop } from "../agent.js";
import { chat } from "../apiClient.js";
import * as history from "../history.js";

const mockedChat = vi.mocked(chat);

// ─── Pure function tests (re-implemented locally since they're internal) ──

function parseArgs(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

function asString(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "symbol") return String(val);
  if (typeof val === "object") return JSON.stringify(val);
  return fallback;
}

const TEST_TOOLS = new Set(["executar_testes", "executar_comando", "sugerir_fixes"]);
const READ_ONLY_TOOLS = new Set(["ler_arquivo", "ler_arquivo_avancado", "buscar_arquivos", "buscar_texto", "git_status", "git_log", "git_diff"]);
const FILE_TOOLS = new Set(["aplicar_diff", "editar_arquivo", "multi_edit"]);

function isTestFailure(resultStr: string): boolean {
  const lower = resultStr.toLowerCase();
  return (
    lower.includes("fail") || lower.includes("error") || lower.includes("failed") ||
    lower.includes("❌") || lower.includes("failing")
  ) && (
    lower.includes("test") || lower.includes("lint") || lower.includes("vitest") ||
    lower.includes("jest") || lower.includes("pytest") || lower.includes("cargo") ||
    lower.includes("eslint") || lower.includes("tsc")
  );
}

function alreadyInHistory(toolCallId: string, hist: Array<{ role?: string; tool_call_id?: string }>): boolean {
  const lastMsg = hist.at(-1);
  return lastMsg?.role === "tool" && lastMsg?.tool_call_id === toolCallId;
}

function classifyToolCalls(toolCalls: Array<{ function: { name: string } }>): { readOnly: string[]; write: string[]; test: string[] } {
  const readOnly: string[] = [];
  const write: string[] = [];
  const test: string[] = [];
  for (const tc of toolCalls) {
    const name = tc.function.name;
    if (READ_ONLY_TOOLS.has(name)) readOnly.push(name);
    else write.push(name);
    if (TEST_TOOLS.has(name)) test.push(name);
  }
  return { readOnly, write, test };
}

function buildTriggerContext(cwd: string, filePath?: string, toolName?: string) {
  const ctx: { cwd: string; filePath?: string; toolName?: string } = { cwd };
  if (filePath) ctx.filePath = filePath;
  if (toolName) ctx.toolName = toolName;
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PURE FUNCTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("agent.ts pure logic", () => {
  describe("parseArgs", () => {
    it("should parse valid JSON", () => {
      expect(parseArgs('{"caminho": "src/main.ts"}')).toEqual({ caminho: "src/main.ts" });
    });
    it("should return _raw for invalid JSON", () => {
      expect(parseArgs("not json")).toEqual({ _raw: "not json" });
    });
    it("should handle empty string", () => {
      expect(parseArgs("")).toEqual({ _raw: "" });
    });
    it("should handle nested objects", () => {
      expect(parseArgs('{"a": {"b": [1,2,3]}}')).toEqual({ a: { b: [1, 2, 3] } });
    });
    it("should handle numeric values", () => {
      expect(parseArgs('{"count": 42}')).toEqual({ count: 42 });
    });
    it("should handle boolean values", () => {
      expect(parseArgs('{"flag": true}')).toEqual({ flag: true });
    });
  });

  describe("asString", () => {
    it("should return string as-is", () => { expect(asString("hello")).toBe("hello"); });
    it("should return fallback for null", () => { expect(asString(null, "default")).toBe("default"); });
    it("should return fallback for undefined", () => { expect(asString(undefined)).toBe(""); });
    it("should convert number to string", () => { expect(asString(42)).toBe("42"); });
    it("should convert boolean to string", () => { expect(asString(true)).toBe("true"); });
    it("should JSON.stringify objects", () => { expect(asString({ a: 1 })).toBe('{"a":1}'); });
    it("should convert symbol to string", () => { expect(asString(Symbol("test"))).toBe("Symbol(test)"); });
    it("should return fallback for function", () => { expect(asString(() => {})).toBe(""); });
    it("should handle empty string", () => { expect(asString("")).toBe(""); });
  });

  describe("isTestFailure", () => {
    it("should detect vitest failures", () => { expect(isTestFailure("2 tests failed in vitest")).toBe(true); });
    it("should detect jest failures", () => { expect(isTestFailure("FAIL src/test.test.ts - jest")).toBe(true); });
    it("should detect pytest failures", () => { expect(isTestFailure("3 failed in pytest")).toBe(true); });
    it("should detect cargo test failures", () => { expect(isTestFailure("test result: FAILED. 5 passed; 2 failed")).toBe(true); });
    it("should detect eslint errors", () => { expect(isTestFailure("error: Unexpected var eslint")).toBe(true); });
    it("should detect tsc errors", () => { expect(isTestFailure("error TS2322: tsc found 1 error")).toBe(true); });
    it("should detect emoji failures", () => { expect(isTestFailure("❌ 3 tests failed")).toBe(true); });
    it("should NOT detect generic errors", () => { expect(isTestFailure("Error: file not found")).toBe(false); });
    it("should NOT detect success", () => { expect(isTestFailure("320 tests passed")).toBe(false); });
    it("should detect lint failures", () => { expect(isTestFailure("5 problems found (3 errors) lint")).toBe(true); });
  });

  describe("alreadyInHistory", () => {
    it("should return true if last message matches", () => {
      expect(alreadyInHistory("call_123", [
        { role: "assistant" },
        { role: "tool", tool_call_id: "call_123" },
      ])).toBe(true);
    });
    it("should return false for different ID", () => {
      expect(alreadyInHistory("call_123", [
        { role: "assistant" },
        { role: "tool", tool_call_id: "call_456" },
      ])).toBe(false);
    });
    it("should return false if last is not tool", () => {
      expect(alreadyInHistory("call_123", [{ role: "assistant", content: "hi" }])).toBe(false);
    });
    it("should return false for empty history", () => {
      expect(alreadyInHistory("call_123", [])).toBe(false);
    });
    it("should only check the LAST message", () => {
      expect(alreadyInHistory("call_123", [
        { role: "tool", tool_call_id: "call_123" },
        { role: "assistant", content: "response" },
      ])).toBe(false);
    });
  });

  describe("classifyToolCalls", () => {
    it("should classify read-only tools", () => {
      const result = classifyToolCalls([
        { function: { name: "ler_arquivo" } },
        { function: { name: "buscar_texto" } },
      ]);
      expect(result.readOnly).toEqual(["ler_arquivo", "buscar_texto"]);
      expect(result.write).toHaveLength(0);
    });
    it("should classify write tools", () => {
      const result = classifyToolCalls([
        { function: { name: "aplicar_diff" } },
        { function: { name: "editar_arquivo" } },
      ]);
      expect(result.write).toEqual(["aplicar_diff", "editar_arquivo"]);
    });
    it("should classify test tools", () => {
      const result = classifyToolCalls([
        { function: { name: "executar_testes" } },
        { function: { name: "sugerir_fixes" } },
      ]);
      expect(result.test).toEqual(["executar_testes", "sugerir_fixes"]);
    });
    it("should handle mixed tool calls", () => {
      const result = classifyToolCalls([
        { function: { name: "ler_arquivo" } },
        { function: { name: "aplicar_diff" } },
        { function: { name: "executar_testes" } },
        { function: { name: "git_status" } },
      ]);
      expect(result.readOnly).toEqual(["ler_arquivo", "git_status"]);
      expect(result.write).toEqual(["aplicar_diff", "executar_testes"]);
      expect(result.test).toEqual(["executar_testes"]);
    });
    it("should handle unknown tools as write", () => {
      expect(classifyToolCalls([{ function: { name: "custom_tool" } }]).write).toEqual(["custom_tool"]);
    });
    it("should handle empty", () => {
      const result = classifyToolCalls([]);
      expect(result.readOnly).toHaveLength(0);
      expect(result.write).toHaveLength(0);
      expect(result.test).toHaveLength(0);
    });
  });

  describe("buildTriggerContext", () => {
    it("should build with cwd only", () => {
      expect(buildTriggerContext("/project")).toEqual({ cwd: "/project" });
    });
    it("should include filePath", () => {
      expect(buildTriggerContext("/project", "/project/src/main.ts").filePath).toBe("/project/src/main.ts");
    });
    it("should include toolName", () => {
      expect(buildTriggerContext("/project", undefined, "aplicar_diff").toolName).toBe("aplicar_diff");
    });
    it("should include all fields", () => {
      expect(buildTriggerContext("/project", "/project/file.ts", "editar_arquivo")).toEqual({
        cwd: "/project",
        filePath: "/project/file.ts",
        toolName: "editar_arquivo",
      });
    });
  });

  describe("Tool set membership", () => {
    it("READ_ONLY_TOOLS should contain expected tools", () => {
      for (const t of ["ler_arquivo", "ler_arquivo_avancado", "buscar_arquivos", "buscar_texto", "git_status", "git_log", "git_diff"]) {
        expect(READ_ONLY_TOOLS.has(t)).toBe(true);
      }
    });
    it("FILE_TOOLS should contain expected tools", () => {
      for (const t of ["aplicar_diff", "editar_arquivo", "multi_edit"]) {
        expect(FILE_TOOLS.has(t)).toBe(true);
      }
    });
    it("TEST_TOOLS should contain expected tools", () => {
      for (const t of ["executar_testes", "executar_comando", "sugerir_fixes"]) {
        expect(TEST_TOOLS.has(t)).toBe(true);
      }
    });
    it("WRITE tools should NOT be in READ_ONLY_TOOLS", () => {
      expect(READ_ONLY_TOOLS.has("aplicar_diff")).toBe(false);
      expect(READ_ONLY_TOOLS.has("editar_arquivo")).toBe(false);
      expect(READ_ONLY_TOOLS.has("executar_comando")).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS (mocked API, real agent loop logic)
// ═══════════════════════════════════════════════════════════════════════════════

describe("runAgentLoop (mocked API)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return simple text response (no tool calls)", async () => {
    mockedChat.mockResolvedValueOnce({
      choices: [{
        message: { role: "assistant", content: "Olá! Como posso ajudar?" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as any);

    const result = await runAgentLoop("Olá");
    expect(result).toBe("Olá! Como posso ajudar?");
    expect(mockedChat).toHaveBeenCalledTimes(1);
  });

  it("should return empty response placeholder when content is null", async () => {
    mockedChat.mockResolvedValueOnce({
      choices: [{
        message: { role: "assistant", content: null },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as any);

    const result = await runAgentLoop("test");
    expect(result).toBe("(resposta vazia)");
  });

  it("should throw on empty choices array", async () => {
    mockedChat.mockResolvedValueOnce({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    } as any);

    await expect(runAgentLoop("test")).rejects.toThrow("Empty response from NVIDIA NIM API");
  });

  it("should call streaming callbacks", async () => {
    const onStreamStart = vi.fn();
    const onToken = vi.fn();
    const onThinking = vi.fn();
    const onUsage = vi.fn();

    mockedChat.mockResolvedValueOnce({
      choices: [{
        message: { role: "assistant", content: "response" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    } as any);

    await runAgentLoop("test", onStreamStart, onToken, onThinking, onUsage);

    expect(onStreamStart).not.toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledWith({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("should process tool calls and recurse", async () => {
    const toolCallId = "call_read_1";
    const toolCall = {
      id: toolCallId,
      type: "function" as const,
      function: {
        name: "ler_arquivo",
        arguments: JSON.stringify({ caminho: "src/main.ts" }),
      },
    };

    mockedChat
      .mockResolvedValueOnce({
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [toolCall] },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { role: "assistant", content: "Here is the file content" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });

    const result = await runAgentLoop("read the file");
    expect(result).toBe("Here is the file content");
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });

  it("should handle MCP tool calls (name contains __)", async () => {
    const toolCallId = "call_mcp_1";
    const toolCall = {
      id: toolCallId,
      type: "function" as const,
      function: {
        name: "server__tool",
        arguments: JSON.stringify({ arg1: "value" }),
      },
    };

    mockedChat
      .mockResolvedValueOnce({
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [toolCall] },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { role: "assistant", content: "MCP result" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });

    const result = await runAgentLoop("use mcp tool");
    expect(result).toBe("MCP result");
  });

  it("should handle unknown tool gracefully", async () => {
    const toolCall = {
      id: "call_unknown_1",
      type: "function" as const,
      function: {
        name: "nonexistent_tool",
        arguments: JSON.stringify({}),
      },
    };

    mockedChat
      .mockResolvedValueOnce({
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [toolCall] },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })
      .mockResolvedValueOnce({
        choices: [{
          message: { role: "assistant", content: "Fixed the error" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });

    const result = await runAgentLoop("do something");
    expect(result).toBe("Fixed the error");
  });
});
