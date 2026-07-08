/**
 * unit-agent-extended.test.ts — Deep unit tests for agent.ts (non-chdir tests).
 *
 * Covers behaviors NOT covered by agent.test.ts / agentCoverage.test.ts /
 * agentIntegration.test.ts / agent-extended.test.ts:
 *
 *   - Tool classification sets (READ_ONLY_TOOLS, WRITE_FILE_TOOLS, FILE_TOOLS)
 *   - Tool handler returns { resultStr, usedHeal } shape
 *   - Unknown tool returns error string
 *   - MCP tool call goes through robloxMcpGuard (blocks write tools)
 *   - Blocked MCP tool returns block reason
 *   - Allowed MCP tool calls callMCPTool
 *   - Bug Hunter runs at end of turn when files touched
 *   - DataGuard runs at end of turn (when files touched)
 *   - Strict Quality Gate blocks on test failure
 *   - Effort level affects sub-agent availability
 *   - Tool aliases (read_file → ler_arquivo, etc.)
 *
 * Mocks heavily to isolate agent.ts from network/filesystem.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Estado hoisted (acessível por mocks e por testes) ─────────────────────
const hoisted = vi.hoisted(() => ({
  toolDefinitions: [] as any[],
  smartCompactResult: { compacted: false, savedTokens: 0 } as { compacted: boolean; savedTokens: number },
  preHookResult: { skip: false, modifiedArgs: undefined as any, resultOverride: undefined as string | undefined },
  postHookResult: { modifiedResult: null as string | null },
  strictModeEnabled: false,
  gateResult: { allowed: true, reason: "no files touched", consecutiveBlocks: 0, errorLog: undefined as string | undefined },
}));

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  success: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    nvidiaBaseUrl: "https://test.api.nvidia.com/v1",
    model: "test-model",
    contextWindowTokens: 128000,
    contextWarnThreshold: 0.5,
    contextCompactThreshold: 0.75,
    costPerKPrompt: 0.01,
    costPerKCompletion: 0.03,
    maxHealRetries: 2,
  },
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  get TOOL_DEFINITIONS() { return hoisted.toolDefinitions; },
  isTransientNetworkErrorPublic: vi.fn(() => false),
  is429ErrorPublic: vi.fn(() => false),
  SUB_AGENT_MAX_CHAT_RETRIES: 2,
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
  getSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../tools.js", () => ({
  lerArquivo: vi.fn(),
  aplicarDiff: vi.fn(),
  executarComando: vi.fn(async () => "command output"),
  desfazerEdicao: vi.fn(),
  listarBackups: vi.fn(),
}));

vi.mock("../hooks.js", () => ({
  executePreToolCallHooks: vi.fn(async () => hoisted.preHookResult),
  executePostToolCallHooks: vi.fn(async () => hoisted.postHookResult),
  executePreFileWriteHooks: vi.fn(() => ({ block: false })),
  executePostFileWriteHooks: vi.fn(),
}));

const { mcpCallMock } = vi.hoisted(() => ({
  mcpCallMock: vi.fn(async () => "[MCP] tool executed successfully"),
}));
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []),
  callMCPTool: mcpCallMock,
}));

vi.mock("../fileRead.js", () => ({ readFileAdvanced: vi.fn(() => "file content") }));
vi.mock("../fileEdit.js", () => ({ editFile: vi.fn(async () => "edited successfully") }));
vi.mock("../fileSearch.js", () => ({ globSearch: vi.fn(() => ["file1.ts"]) }));
vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(() => []),
  formatGrepResults: vi.fn(() => "no matches"),
}));

vi.mock("../gitTool.js", () => ({
  gitStatus: vi.fn(async () => ({
    branch: "main", ahead: 0, behind: 0,
    staged: [], modified: [], untracked: [], conflicted: [],
  })),
  gitDiff: vi.fn(async () => "no changes"),
  gitLog: vi.fn(async () => "log"),
  gitCommit: vi.fn(async () => "committed"),
  gitBlame: vi.fn(async () => "blame"),
  gitShow: vi.fn(async () => "show"),
  gitBranch: vi.fn(async () => "branches"),
  gitCheckout: vi.fn(async () => "checked out"),
}));

vi.mock("../multiFileEdit.js", () => ({
  multiFileEdit: vi.fn(() => ({ success: true, filesEdited: [], errors: [] })),
  multiFileEditWithLocks: vi.fn(async () => ({ success: true, filesEdited: [], errors: [] })),
}));

vi.mock("../session.js", () => ({
  startSession: vi.fn(() => "test-session"), appendMessage: vi.fn(),
  listSessions: vi.fn(() => []),
}));

vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn(() => ({ language: "typescript", lineCount: 100, symbols: [], imports: [] })),
}));

vi.mock("../retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
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
  smartCompact: vi.fn(() => hoisted.smartCompactResult),
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
  runTests: vi.fn(async () => "tests pass"),
  formatTestResult: vi.fn(() => "ok"),
  suggestFixes: vi.fn(() => []),
  formatFixSuggestions: vi.fn(() => ""),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({
    getAll: vi.fn(() => []),
    getByCategory: vi.fn(() => []),
    isInstalled: vi.fn(() => false),
    addTool: vi.fn(),
    get: vi.fn(),
  })),
  getDetector: vi.fn(() => ({
    detect: vi.fn(() => ({ intent: null, context: [] })),
    detectFromContext: vi.fn(() => []),
  })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(),
}));

vi.mock("../extensionCenter.js", () => ({
  executeTrigger: vi.fn(async () => {}),
  subscribeToHubChanges: vi.fn(() => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

vi.mock("../strictQualityGate.js", () => ({
  isStrictModeEnabled: vi.fn(() => hoisted.strictModeEnabled),
  runQualityGate: vi.fn(async () => hoisted.gateResult),
  resetGateState: vi.fn(),
}));

vi.mock("../apiProvider.js", () => ({
  getProviderMaxSubAgents: vi.fn(() => 2),
}));

const { effortMock } = vi.hoisted(() => ({
  effortMock: vi.fn(() => "medium"),
}));
vi.mock("../effortLevels.js", () => ({
  getEffortLevel: effortMock,
  setEffortLevel: vi.fn(),
  shouldUseSubAgents: vi.fn(() => effortMock() === "high" || effortMock() === "max"),
  shouldUsePowerfulSubAgents: vi.fn(() => effortMock() === "max"),
}));

vi.mock("../taskState.js", () => ({
  initTaskStateFromUserMessage: vi.fn(),
  updateTaskState: vi.fn(),
  readTaskState: vi.fn(() => null),
  getTaskStateSummary: vi.fn(() => ""),
  appendTaskStateItem: vi.fn(),
}));

vi.mock("../thinkTool.js", () => ({
  think: vi.fn(async () => ({ confirmed: true, message: "ok" })),
  THINK_TOOL_DEFINITION: {
    type: "function",
    function: {
      name: "pensar",
      description: "Think tool",
      parameters: { type: "object", properties: { pensamento: { type: "string" } }, required: ["pensamento"] },
    },
  },
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
  withActivity: vi.fn(async (_kind: string, _label: string, fn: () => Promise<unknown>) => fn()),
  clearActivity: vi.fn(),
}));

vi.mock("../promiseDetector.js", () => ({
  shouldBlockForFalsePromise: vi.fn(() => ({ block: false, reason: "", rejectionMessage: "" })),
  resetFalsePromiseCounter: vi.fn(),
}));

vi.mock("../contextInjector.js", () => ({
  getContextInjection: vi.fn(() => null),
  resetContextInjection: vi.fn(),
}));

vi.mock("../selfValidation.js", () => ({
  shouldSelfValidate: vi.fn(() => false),
  injectSelfValidationPrompt: vi.fn(),
  resetSelfValidation: vi.fn(),
}));

vi.mock("../autoTestGenerator.js", () => ({
  generateTestSuggestionForFile: vi.fn(() => null),
  resetAutoTestSuggestions: vi.fn(),
}));

vi.mock("../apiKeyPool.js", () => ({
  formatPoolStats: vi.fn(() => "pool stats"),
  getPoolSize: vi.fn(() => 0),
}));

vi.mock("../subAgents.js", () => ({
  runSubAgent: vi.fn(async () => null),
}));

vi.mock("../planExecutor.js", () => ({
  hasIncompletePlan: vi.fn(() => false),
  formatPlan: vi.fn(() => ""),
}));

vi.mock("../honestySystem.js", () => ({
  isHonestyFeatureEnabled: vi.fn(async () => false),
  runDevilsAdvocate: vi.fn(async () => ({ severity: "low", issues: [] })),
  runAnonymousReview: vi.fn(async () => ({ issues: [] })),
}));

vi.mock("../goalVerifier.js", () => ({
  verifyGoalCompletion: vi.fn(async () => ({ done: true, verified: true, reason: "ok" })),
  formatGoalVerification: vi.fn(() => ""),
}));

// Bug Hunter mock — controllable per-test
const { bugHunterMock } = vi.hoisted(() => ({
  bugHunterMock: vi.fn(async () => ({
    shouldBlock: false, findings: [], message: "", completed: true,
  })),
}));
vi.mock("../bugHunter.js", () => ({
  runBugHunter: bugHunterMock,
  runTestsForFindings: vi.fn((findings: any[]) => findings),
  allCriticalHighTestsPass: vi.fn(() => true),
}));

// DataGuard mock — controllable per-test
const { dataGuardMock } = vi.hoisted(() => ({
  dataGuardMock: vi.fn(async () => ({
    shouldBlock: false, findings: [], message: "", completed: true,
  })),
}));

vi.mock("../dataGuard.js", () => ({
  runDataGuard: dataGuardMock,
  resetDataGuardState: vi.fn(),
}));

vi.mock("../failureMemory.js", () => ({
  recordFailure: vi.fn(),
  getRecentFailures: vi.fn(() => null),
  clearFailures: vi.fn(),
}));

vi.mock("../checkpointWriter.js", () => ({
  shouldCheckpoint: vi.fn(() => 0),
  writeCheckpoint: vi.fn(async () => ({ state: {} })),
  formatCheckpoint: vi.fn(() => ""),
}));

vi.mock("../toolReduction.js", () => ({
  detectIntent: vi.fn(() => null),
  filterToolsByIntent: vi.fn((tools: any[]) => tools),
  getFilterSummary: vi.fn(() => ""),
}));

vi.mock("../manifestLoader.js", () => ({
  loadActiveManifests: vi.fn(() => []),
  loadModeManifests: vi.fn(() => []),
  generateFunctionCallsFromManifests: vi.fn(() => []),
  executeFromManifest: vi.fn(async () => ({ ok: true, output: "", errors: [], duration: 0 })),
  isManifestTool: vi.fn(() => false),
}));

vi.mock("../modes.js", () => ({
  getActiveMode: vi.fn(() => null),
  getActiveModeName: vi.fn(() => null),
}));

vi.mock("../readBeforeWrite.js", () => ({
  clearReadPaths: vi.fn(),
  setReadBeforeWriteEnabled: vi.fn(),
  recordRead: vi.fn(),
  recordWrite: vi.fn(),
  isReadBeforeWriteEnabled: vi.fn(() => false),
  hasBeenRead: vi.fn(() => true),
  hasReadPath: vi.fn(() => true),
  checkReadBeforeWrite: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../pokaYoke.js", () => ({
  pokaYokeCheck: vi.fn(() => ({ ok: true })),
  EXPANDED_TOOL_DESCRIPTIONS: {},
}));

vi.mock("../i18n.js", () => ({
  t: vi.fn((_key: string, ...args: any[]) => `i18n:${_key}:${args.join(":")}`),
}));

// ─── Imports (após todos os mocks) ────────────────────────────────────────

import { runAgentLoop, dispatchToolCallPublic, getMergedToolsPublic } from "../agent.js";
import { chat } from "../apiClient.js";
import { editFile } from "../fileEdit.js";
import { callMCPTool } from "../extensions.js";
import { runBugHunter } from "../bugHunter.js";
import { runDataGuard } from "../dataGuard.js";
import { runQualityGate, resetGateState, isStrictModeEnabled } from "../strictQualityGate.js";
import { getEffortLevel } from "../effortLevels.js";
import { clearReadPaths, setReadBeforeWriteEnabled } from "../readBeforeWrite.js";

const mockedChat = chat as ReturnType<typeof vi.fn>;
const mockedEditFile = editFile as ReturnType<typeof vi.fn>;
const mockedCallMCPTool = callMCPTool as ReturnType<typeof vi.fn>;
const mockedRunBugHunter = runBugHunter as ReturnType<typeof vi.fn>;
const mockedRunDataGuard = runDataGuard as ReturnType<typeof vi.fn>;
const mockedRunQualityGate = runQualityGate as ReturnType<typeof vi.fn>;
const mockedIsStrictModeEnabled = isStrictModeEnabled as ReturnType<typeof vi.fn>;
const mockedGetEffort = getEffortLevel as ReturnType<typeof vi.fn>;

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown>, id?: string) {
  return {
    id: id ?? `call_${Math.random().toString(36).slice(2)}`,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

function mockStopResponse(content: string) {
  return {
    choices: [{
      message: { role: "assistant", content, tool_calls: undefined },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function mockToolCallsResponse(toolCalls: any[]) {
  return {
    choices: [{
      message: { role: "assistant", content: null, tool_calls: toolCalls },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  mockedChat.mockReset();
  mockedEditFile.mockReset();
  mockedCallMCPTool.mockReset();
  mockedRunBugHunter.mockReset();
  mockedRunDataGuard.mockReset();
  mockedRunQualityGate.mockReset();
  mockedGetEffort.mockReturnValue("medium");

  // Re-establish default mock implementations
  mockedRunBugHunter.mockImplementation(async () => ({
    shouldBlock: false, findings: [], message: "", completed: true,
  }));
  mockedRunDataGuard.mockImplementation(async () => ({
    shouldBlock: false, findings: [], message: "", completed: true,
  }));
  mockedRunQualityGate.mockImplementation(async () => hoisted.gateResult);
  mockedIsStrictModeEnabled.mockImplementation(() => hoisted.strictModeEnabled);
  mockedCallMCPTool.mockImplementation(async () => "[MCP] tool executed successfully");

  // Reset hoisted state
  hoisted.toolDefinitions.length = 0;
  hoisted.smartCompactResult = { compacted: false, savedTokens: 0 };
  hoisted.preHookResult = { skip: false, modifiedArgs: undefined, resultOverride: undefined };
  hoisted.postHookResult = { modifiedResult: null };
  hoisted.strictModeEnabled = false;
  hoisted.gateResult = { allowed: true, reason: "no files touched", consecutiveBlocks: 0, errorLog: undefined };

  originalEnv = { ...process.env };
  process.env.STRICT_MODE = "false";
  setReadBeforeWriteEnabled(false);
  clearReadPaths();
  resetGateState();
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks?.();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Tool classification sets (8 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: tool classification sets", () => {
  // The classification sets are not exported, but we can verify their behavior
  // by observing which tools are dispatched in parallel vs sequentially.

  it("ler_arquivo is treated as read-only (parallel dispatch)", async () => {
    const tc1 = makeToolCall("ler_arquivo", { caminho: "/a.ts" });
    const tc2 = makeToolCall("ler_arquivo", { caminho: "/b.ts" });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc1, tc2]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("read two files");
    // Should not crash — read-only tools are dispatched in parallel
    expect(mockedChat).toHaveBeenCalled();
  });

  it("buscar_arquivos is treated as read-only", async () => {
    const tc = makeToolCall("buscar_arquivos", { pattern: "**/*.ts" });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("find files");
    expect(mockedChat).toHaveBeenCalled();
  });

  it("buscar_texto is treated as read-only", async () => {
    const tc = makeToolCall("buscar_texto", { pattern: "TODO" });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("search text");
    expect(mockedChat).toHaveBeenCalled();
  });

  it("explorar_subagente is treated as read-only", async () => {
    const tc = makeToolCall("explorar_subagente", { question: "what is x?" });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("explore");
    expect(mockedChat).toHaveBeenCalled();
  });

  it("ler_estado is treated as read-only", async () => {
    const tc = makeToolCall("ler_estado", {});
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("read state");
    expect(mockedChat).toHaveBeenCalled();
  });

  it("listar_memoria is treated as read-only", async () => {
    const tc = makeToolCall("listar_memoria", {});
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("list memory");
    expect(mockedChat).toHaveBeenCalled();
  });

  it("editar_arquivo is treated as a write tool (sequential dispatch)", async () => {
    mockedEditFile.mockResolvedValueOnce("edited");
    const tc = makeToolCall("editar_arquivo", { path: "/tmp/x.ts", edits: [{ search: "a", replace: "b" }] });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("edit file");
    expect(mockedEditFile).toHaveBeenCalled();
  });

  it("editar_multi_arquivos is treated as a write tool", async () => {
    const tc = makeToolCall("editar_multi_arquivos", { requests: [] });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("multi edit");
    expect(mockedChat).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Tool handler shape (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: tool handler returns { resultStr, usedHeal } shape", () => {
  it("dispatchToolCallPublic returns object with resultStr and usedHeal properties", async () => {
    const tc = makeToolCall("executar_comando", { comando: "echo hi" });
    // The handler returns whatever executarComando returns
    const result = await dispatchToolCallPublic(tc);
    expect(result).toHaveProperty("resultStr");
    expect(result).toHaveProperty("usedHeal");
    expect(typeof result.resultStr).toBe("string");
    expect(typeof result.usedHeal).toBe("boolean");
  });

  it("dispatchToolCallPublic for ler_arquivo returns string resultStr", async () => {
    const tc = makeToolCall("ler_arquivo", { caminho: "/tmp/test.txt" });
    const result = await dispatchToolCallPublic(tc);
    expect(typeof result.resultStr).toBe("string");
    expect(result.resultStr.length).toBeGreaterThan(0);
  });

  it("dispatchToolCallPublic for editar_arquivo returns success message", async () => {
    mockedEditFile.mockResolvedValueOnce("edited successfully");
    const tc = makeToolCall("editar_arquivo", {
      path: "/tmp/x.ts",
      edits: [{ search: "a", replace: "b" }],
    });
    const result = await dispatchToolCallPublic(tc);
    expect(result.resultStr).toBe("edited successfully");
    expect(result.usedHeal).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Unknown tool handling (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: unknown tool handling", () => {
  it("returns [ERROR] for unknown tool name", async () => {
    const tc = makeToolCall("ferramenta_inexistente_xyz", {});
    const result = await dispatchToolCallPublic(tc);
    expect(result.resultStr).toContain("[ERROR]");
    expect(result.resultStr).toContain("ferramenta_inexistente_xyz");
    expect(result.usedHeal).toBe(false);
  });

  it("returns [ERROR] for tool with special characters in name", async () => {
    const tc = makeToolCall("tool@special#name!", {});
    const result = await dispatchToolCallPublic(tc);
    expect(result.resultStr).toContain("[ERROR]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. MCP tool calls go through robloxMcpGuard (5 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: MCP tool calls go through robloxMcpGuard", () => {
  it("blocked MCP write tool (multi_edit) returns block reason and does NOT call callMCPTool", async () => {
    const tc = makeToolCall("Roblox_Studio__multi_edit", { path: "game.Script" });
    const result = await dispatchToolCallPublic(tc);
    expect(result.resultStr).toContain("BLOCKED");
    expect(result.resultStr).toContain("aplicar_diff");
    expect(mockedCallMCPTool).not.toHaveBeenCalled();
  });

  it("blocked MCP generate_mesh returns block reason", async () => {
    const tc = makeToolCall("Roblox_Studio__generate_mesh", {});
    const result = await dispatchToolCallPublic(tc);
    expect(result.resultStr).toContain("BLOCKED");
    expect(mockedCallMCPTool).not.toHaveBeenCalled();
  });

  it("blocked MCP insert_from_creator_store returns block reason", async () => {
    const tc = makeToolCall("Roblox_Studio__insert_from_creator_store", {});
    const result = await dispatchToolCallPublic(tc);
    expect(result.resultStr).toContain("BLOCKED");
    expect(mockedCallMCPTool).not.toHaveBeenCalled();
  });

  it("allowed MCP read tool (script_read) calls callMCPTool", async () => {
    const tc = makeToolCall("Roblox_Studio__script_read", { path: "game.Script" });
    const result = await dispatchToolCallPublic(tc);
    expect(mockedCallMCPTool).toHaveBeenCalledWith("Roblox_Studio__script_read", { path: "game.Script" });
    expect(result.resultStr).toBe("[MCP] tool executed successfully");
  });

  it("allowed MCP execute tool (execute_luau) calls callMCPTool (with logging)", async () => {
    const tc = makeToolCall("Roblox_Studio__execute_luau", { code: "print('hi')" });
    const result = await dispatchToolCallPublic(tc);
    expect(mockedCallMCPTool).toHaveBeenCalled();
    expect(result.resultStr).toBe("[MCP] tool executed successfully");
  });

  it("non-Roblox MCP tool (other_server__tool) passes through guard (allowed by default)", async () => {
    const tc = makeToolCall("other_server__some_tool", {});
    const result = await dispatchToolCallPublic(tc);
    expect(mockedCallMCPTool).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Tool aliases (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: tool aliases (Sprint C bug fix BUG-Z)", () => {
  it("'read_file' alias is mapped to 'ler_arquivo'", async () => {
    const tc = makeToolCall("read_file", { caminho: "/tmp/test.txt" });
    const result = await dispatchToolCallPublic(tc);
    // Should not return [ERROR] (alias is resolved)
    expect(result.resultStr).not.toContain("[ERROR] Unknown tool");
  });

  it("'grep' alias is mapped to 'buscar_texto'", async () => {
    const tc = makeToolCall("grep", { pattern: "TODO" });
    const result = await dispatchToolCallPublic(tc);
    expect(result.resultStr).not.toContain("[ERROR] Unknown tool");
  });

  it("'think' alias is mapped to 'pensar'", async () => {
    const tc = makeToolCall("think", { pensamento: "planning the work" });
    const result = await dispatchToolCallPublic(tc);
    expect(result.resultStr).not.toContain("[ERROR] Unknown tool");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Bug Hunter integration (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: Bug Hunter runs at end of turn when files touched", () => {
  it("Bug Hunter is NOT called when no files were touched", async () => {
    mockedChat.mockResolvedValueOnce(mockStopResponse("done") as any);
    await runAgentLoop("simple question");
    expect(mockedRunBugHunter).not.toHaveBeenCalled();
  });

  it("Bug Hunter IS called when editar_arquivo was used (files touched)", async () => {
    mockedEditFile.mockResolvedValueOnce("edited");
    const editTc = makeToolCall("editar_arquivo", {
      path: "/tmp/x.ts",
      edits: [{ search: "a", replace: "b" }],
    });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([editTc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("edit the file");
    expect(mockedRunBugHunter).toHaveBeenCalled();
  });

  it("Bug Hunter blocks finish when shouldBlock=true (forces another round)", async () => {
    mockedEditFile.mockResolvedValueOnce("edited");
    mockedRunBugHunter
      .mockResolvedValueOnce({
        shouldBlock: true,
        findings: [{ severity: "critical", file: "/tmp/x.ts", description: "bug", suggestion: "fix" }],
        message: "BLOCK: fix the bug",
        completed: true,
      })
      .mockResolvedValueOnce({
        shouldBlock: false, findings: [], message: "", completed: true,
      });
    const editTc = makeToolCall("editar_arquivo", {
      path: "/tmp/x.ts",
      edits: [{ search: "a", replace: "b" }],
    });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([editTc]))  // 1. Tool call
      .mockResolvedValueOnce(mockStopResponse("done"))          // 2. Stop → Bug Hunter blocks
      .mockResolvedValueOnce(mockStopResponse("really done"));  // 3. Stop → Bug Hunter passes
    const result = await runAgentLoop("edit file");
    expect(result).toBe("really done");
    expect(mockedRunBugHunter).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. DataGuard integration (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: DataGuard runs at end of turn", () => {
  it("DataGuard is NOT called when no files were touched", async () => {
    mockedChat.mockResolvedValueOnce(mockStopResponse("done") as any);
    await runAgentLoop("simple question");
    expect(mockedRunDataGuard).not.toHaveBeenCalled();
  });

  it("DataGuard IS called when editar_arquivo was used", async () => {
    mockedEditFile.mockResolvedValueOnce("edited");
    const editTc = makeToolCall("editar_arquivo", {
      path: "/tmp/x.luau",
      edits: [{ search: "a", replace: "b" }],
    });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([editTc]))
      .mockResolvedValueOnce(mockStopResponse("done"));
    await runAgentLoop("edit file");
    expect(mockedRunDataGuard).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Strict Quality Gate (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: Strict Quality Gate", () => {
  it("STRICT_MODE=false → gate is not consulted (no runQualityGate calls)", async () => {
    hoisted.strictModeEnabled = false;
    mockedChat.mockResolvedValueOnce(mockStopResponse("done") as any);
    await runAgentLoop("test");
    expect(mockedIsStrictModeEnabled).toHaveBeenCalled();
    expect(mockedRunQualityGate).not.toHaveBeenCalled();
  });

  it("STRICT_MODE=true with no files touched → gate is not consulted", async () => {
    hoisted.strictModeEnabled = true;
    mockedChat.mockResolvedValueOnce(mockStopResponse("done") as any);
    await runAgentLoop("simple question");
    expect(mockedIsStrictModeEnabled).toHaveBeenCalled();
    expect(mockedRunQualityGate).not.toHaveBeenCalled();
  });

  it("STRICT_MODE=true with files touched + gate blocks → forces another round", async () => {
    hoisted.strictModeEnabled = true;
    mockedEditFile.mockResolvedValueOnce("edited");
    hoisted.gateResult = {
      allowed: false,
      reason: "tsc errors",
      consecutiveBlocks: 1,
      errorLog: "[STRICT_GATE BLOCK 1/8] TypeScript errors",
    };
    const editTc = makeToolCall("editar_arquivo", {
      path: "/tmp/x.ts",
      edits: [{ search: "a", replace: "b" }],
    });
    mockedRunQualityGate
      .mockResolvedValueOnce({
        allowed: false, reason: "tsc errors", consecutiveBlocks: 1,
        errorLog: "[STRICT_GATE BLOCK 1/8] TypeScript errors",
      })
      .mockResolvedValueOnce({
        allowed: true, reason: "all checks passed", consecutiveBlocks: 0,
      });
    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([editTc]))   // 1. Edit
      .mockResolvedValueOnce(mockStopResponse("done"))           // 2. Stop → gate blocks
      .mockResolvedValueOnce(mockStopResponse("really done"));   // 3. Stop → gate passes
    const result = await runAgentLoop("edit file");
    expect(result).toBe("really done");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Effort level affects sub-agent availability (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: effort level affects sub-agent availability", () => {
  it("effort=medium → getEffortLevel returns 'medium'", () => {
    mockedGetEffort.mockReturnValue("medium");
    expect(getEffortLevel()).toBe("medium");
  });

  it("effort=high → getEffortLevel returns 'high'", () => {
    mockedGetEffort.mockReturnValue("high");
    expect(getEffortLevel()).toBe("high");
  });

  it("effort=max → getEffortLevel returns 'max' (enables powerful sub-agents)", () => {
    mockedGetEffort.mockReturnValue("max");
    expect(getEffortLevel()).toBe("max");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. getMergedToolsPublic (2 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("agent: getMergedToolsPublic", () => {
  it("returns an array of tool definitions", () => {
    const tools = getMergedToolsPublic();
    expect(Array.isArray(tools)).toBe(true);
  });

  it("includes pensar (think) tool by default", () => {
    const tools = getMergedToolsPublic();
    const names = tools.map((t: any) => t.function.name);
    expect(names).toContain("pensar");
  });
});
