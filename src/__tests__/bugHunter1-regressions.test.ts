/**
 * bugHunter1-regressions.test.ts — Regression tests for Bug Hunter #1 fixes.
 *
 * Each test verifies a specific bug fix in the agent loop + tools area:
 *
 *   1. agent.trackFileAccess — require() in ESM broke skillTracker + fileRehydration
 *      (the calls were silently swallowed by try/catch). Verify the static
 *      imports are actually invoked when the agent dispatches a tool call.
 *
 *   2. processToolCalls — single read-only call mixed with write call was
 *      silently dropped (the parallel path was a no-op for length<=1 AND the
 *      `else if` branch was skipped because writeCalls.length > 0). Verify
 *      BOTH tool results reach history.addToolResult.
 *
 *   3. toolConfigurator.configureTool — JSON.parse on malformed tool_call
 *      arguments threw synchronously and aborted the entire configuration
 *      session. Verify the malformed args now produce a tool result the IA
 *      can recover from (instead of killing the loop).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks for agent.ts dependencies ────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
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
    contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01,
    costPerKCompletion: 0.03,
    maxHealRetries: 2,
  },
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  TOOL_DEFINITIONS: [],
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
  getLoadedMemoryFiles: vi.fn(() => []),
}));

vi.mock("../tools.js", () => ({
  lerArquivo: vi.fn(async () => "file content"),
  aplicarDiff: vi.fn(async () => ({ written: true, toolMessage: "ok" })),
  executarComando: vi.fn(async () => "command output"),
  desfazerEdicao: vi.fn(() => "restored"),
  listarBackups: vi.fn(() => "no backups"),
}));

vi.mock("../hooks.js", () => ({
  executePreToolCallHooks: vi.fn(async () => ({ skip: false })),
  executePostToolCallHooks: vi.fn(async () => ({ modifiedResult: null })),
  executePreFileWriteHooks: vi.fn(async () => ({ block: false })),
  executePostFileWriteHooks: vi.fn(async () => {}),
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []),
  callMCPTool: vi.fn(async () => "[MOCK] MCP not available"),
  getActiveSkills: vi.fn(() => []),
}));

vi.mock("../fileRead.js", () => ({ readFileAdvanced: vi.fn(() => "file content") }));
vi.mock("../fileEdit.js", () => ({ editFile: vi.fn(async () => "edited") }));
vi.mock("../fileSearch.js", () => ({ globSearch: vi.fn(() => ["file1.ts"]) }));
vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(() => []),
  formatGrepResults: vi.fn(() => "no matches"),
}));

vi.mock("../gitTool.js", () => ({
  gitStatus: vi.fn(async () => "ok"),
  gitDiff: vi.fn(async () => "diff"),
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
  startSession: vi.fn(() => "test-session"),
  appendMessage: vi.fn(),
  listSessions: vi.fn(() => []),
}));

vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn(async () => ({ language: "typescript", lineCount: 100, symbols: [], imports: [] })),
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
    tools.map((t: any) => ({ id: t.id, name: t.name, success: true, result: "ok", durationMs: 1 }))
  ),
}));

vi.mock("../telemetry.js", () => ({
  startSession: vi.fn(),
  endSession: vi.fn(),
  recordToolCall: vi.fn(),
  recordMessage: vi.fn(),
}));

vi.mock("../contextCompaction.js", () => ({
  smartCompact: vi.fn(async () => ({ compacted: false, savedTokens: 0 })),
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
  isStrictModeEnabled: vi.fn(() => false),
  runQualityGate: vi.fn(async () => ({ allowed: true, reason: "ok", consecutiveBlocks: 0 })),
  resetGateState: vi.fn(),
}));

vi.mock("../apiProvider.js", () => ({ getProviderMaxSubAgents: vi.fn(() => 2) }));
vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
}));

vi.mock("../taskState.js", () => ({
  initTaskStateFromUserMessage: vi.fn(),
  updateTaskState: vi.fn(),
  readTaskState: vi.fn(() => null),
  getTaskStateSummary: vi.fn(() => ""),
  appendTaskStateItem: vi.fn(),
  markTaskItemDone: vi.fn(() => ({ done: [], todo: [] })),
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

vi.mock("../askUser.js", () => ({
  ASK_USER_TOOL_DEFINITION: {
    type: "function",
    function: {
      name: "perguntar_usuario",
      description: "Ask user",
      parameters: { type: "object", properties: {} },
    },
  },
  handleAskUser: vi.fn(async () => ({ resultStr: "ok", usedHeal: false })),
  setAskUserCallback: vi.fn(),
  clearAskUserCallback: vi.fn(),
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

vi.mock("../subAgents.js", () => ({ runSubAgent: vi.fn(async () => null) }));

vi.mock("../manifestLoader.js", () => ({
  loadActiveManifests: vi.fn(() => []),
  generateFunctionCallsFromManifests: vi.fn(() => []),
  executeFromManifest: vi.fn(),
  isManifestTool: vi.fn(() => false),
}));

vi.mock("../readBeforeWrite.js", () => ({
  checkReadBeforeWrite: vi.fn(() => ({ allowed: true })),
  recordRead: vi.fn(),
  clearReadPaths: vi.fn(),
  setReadBeforeWriteEnabled: vi.fn(),
}));

vi.mock("../pokaYoke.js", () => ({
  pokaYokeCheck: vi.fn(() => ({ ok: true, resolvedPath: "/resolved/path" })),
  EXPANDED_TOOL_DESCRIPTIONS: {},
}));

vi.mock("../argsNormalizer.js", () => ({ normalizeArgs: vi.fn() }));

vi.mock("../i18n.js", () => ({
  t: vi.fn((key: string, ...args: unknown[]) => `${key}:${args.join(":")}`),
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

vi.mock("../bugHunter.js", () => ({
  runBugHunter: vi.fn(async () => ({ shouldBlock: false, findings: [], message: "", completed: true })),
  resetBugHunterState: vi.fn(),
  runTestsForFindings: vi.fn(),
  allCriticalHighTestsPass: vi.fn(() => true),
  snapshotFileBeforeEdit: vi.fn(),
  generateDiffAfterEdit: vi.fn(() => null),
}));

vi.mock("../dataGuard.js", () => ({
  runDataGuard: vi.fn(async () => ({ shouldBlock: false, findings: [], message: "", completed: true })),
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

vi.mock("../modes.js", () => ({ getActiveMode: vi.fn(() => null) }));

vi.mock("../hookRunner.js", () => ({ runHooks: vi.fn(async () => {}) }));

vi.mock("../autoMemory.js", () => ({
  readAutoMemory: vi.fn(() => ""),
  maybeSuggestMemoryWrite: vi.fn(() => null),
}));

vi.mock("../researchHint.js", () => ({
  detectResearchTrigger: vi.fn(() => null),
  generateResearchHint: vi.fn(() => null),
}));

vi.mock("../fileRehydration.js", () => ({
  recordSessionFileEdit: vi.fn(),
}));

vi.mock("../skillTracker.js", () => ({
  recordSkillInvocation: vi.fn(),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { runAgentLoop } from "../agent.js";
import { chat } from "../apiClient.js";
import * as history from "../history.js";
import { recordSessionFileEdit } from "../fileRehydration.js";
import { recordSkillInvocation } from "../skillTracker.js";
import { getActiveSkills } from "../extensions.js";

const mockedChat = vi.mocked(chat);
const mockedAddToolResult = vi.mocked(history.addToolResult);
const mockedRecordSessionFileEdit = vi.mocked(recordSessionFileEdit);
const mockedRecordSkillInvocation = vi.mocked(recordSkillInvocation);
const mockedGetActiveSkills = vi.mocked(getActiveSkills);

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── Test setup ─────────────────────────────────────────────────────────────

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
  mockedChat.mockReset();
  mockedChat.mockImplementation(async () => mockStopResponse("default") as any);
  originalEnv = { ...process.env };
  process.env.STRICT_MODE = "false";
});

afterEach(() => {
  process.env = originalEnv;
});

// ═════════════════════════════════════════════════════════════════════════════════
// Bug 1: agent.trackFileAccess — require() in ESM broke skillTracker + fileRehydration
// ═════════════════════════════════════════════════════════════════════════════════

describe("Bug 1: trackFileAccess uses static imports (not require())", () => {
  it("calls recordSessionFileEdit when IA edits a file (write tool)", async () => {
    // editar_arquivo is a WRITE_FILE_TOOL — should trigger recordSessionFileEdit.
    const tc = makeToolCall("editar_arquivo", { path: "/some/file.ts", search: "a", replace: "b" }, "call_edit_1");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]) as any)
      .mockResolvedValueOnce(mockStopResponse("done") as any);

    await runAgentLoop("edit the file");

    // The fix: recordSessionFileEdit IS called now (before, require() threw
    // ReferenceError silently caught by try/catch, so it was NEVER called).
    expect(mockedRecordSessionFileEdit).toHaveBeenCalled();
    // Resolved path comes from the pokaYokeCheck mock which returns "/resolved/path".
    expect(mockedRecordSessionFileEdit).toHaveBeenCalledWith("/resolved/path");
  });

  it("calls recordSkillInvocation when IA reads a file that is an active skill", async () => {
    // ler_arquivo is a READ_ONLY_TOOL — should trigger recordSkillInvocation
    // IF the file path matches one of getActiveSkills().
    const skillPath = "/skills/rojo-cli.md";
    mockedGetActiveSkills.mockReturnValue([{ path: skillPath } as any]);

    const tc = makeToolCall("ler_arquivo", { caminho: skillPath }, "call_read_skill");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]) as any)
      .mockResolvedValueOnce(mockStopResponse("done") as any);

    await runAgentLoop("read the skill");

    // The fix: recordSkillInvocation IS called now (before, require() threw
    // ReferenceError silently caught by try/catch, so it was NEVER called).
    expect(mockedRecordSkillInvocation).toHaveBeenCalledWith(skillPath);
  });

  it("does NOT call recordSkillInvocation when IA reads a non-skill file", async () => {
    mockedGetActiveSkills.mockReturnValue([{ path: "/skills/rojo-cli.md" } as any]);

    const tc = makeToolCall("ler_arquivo", { caminho: "/some/other/file.ts" }, "call_read_other");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([tc]) as any)
      .mockResolvedValueOnce(mockStopResponse("done") as any);

    await runAgentLoop("read the file");

    expect(mockedRecordSkillInvocation).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// Bug 2: processToolCalls — single read-only call mixed with write calls was dropped
// ═════════════════════════════════════════════════════════════════════════════════

describe("Bug 2: processToolCalls executes single read-only call mixed with write call", () => {
  it("executes BOTH the single read-only call AND the write call (regression)", async () => {
    // Before the fix: exactly 1 read-only + 1+ write calls caused the read-only
    // call to be SILENTLY DROPPED (parallel path was a no-op for length<=1,
    // and the else-if branch was skipped because writeCalls.length > 0).
    // The model would then see an orphan tool_call_id and the API would 400.
    const readCall = makeToolCall("ler_arquivo", { caminho: "/file.ts" }, "call_read_mixed");
    const writeCall = makeToolCall("editar_arquivo", { path: "/file.ts", search: "a", replace: "b" }, "call_write_mixed");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([readCall, writeCall]) as any)
      .mockResolvedValueOnce(mockStopResponse("done") as any);

    await runAgentLoop("read and edit");

    // BOTH tool results must reach history — neither should be dropped.
    expect(mockedAddToolResult).toHaveBeenCalledWith("call_read_mixed", expect.any(String));
    expect(mockedAddToolResult).toHaveBeenCalledWith("call_write_mixed", expect.any(String));
  });

  it("executes a single read-only call alone (sanity, no write calls)", async () => {
    const readCall = makeToolCall("ler_arquivo", { caminho: "/only-read.ts" }, "call_read_only");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([readCall]) as any)
      .mockResolvedValueOnce(mockStopResponse("done") as any);

    await runAgentLoop("read the file");

    expect(mockedAddToolResult).toHaveBeenCalledWith("call_read_only", expect.any(String));
  });

  it("executes multiple read-only calls in parallel (no regression)", async () => {
    const r1 = makeToolCall("ler_arquivo", { caminho: "/a.ts" }, "call_a");
    const r2 = makeToolCall("ler_arquivo", { caminho: "/b.ts" }, "call_b");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([r1, r2]) as any)
      .mockResolvedValueOnce(mockStopResponse("done") as any);

    await runAgentLoop("read both files");

    expect(mockedAddToolResult).toHaveBeenCalledWith("call_a", expect.any(String));
    expect(mockedAddToolResult).toHaveBeenCalledWith("call_b", expect.any(String));
  });

  it("executes multiple write calls sequentially (no regression)", async () => {
    const w1 = makeToolCall("editar_arquivo", { path: "/a.ts", search: "x", replace: "y" }, "call_w1");
    const w2 = makeToolCall("editar_arquivo", { path: "/b.ts", search: "x", replace: "y" }, "call_w2");

    mockedChat
      .mockResolvedValueOnce(mockToolCallsResponse([w1, w2]) as any)
      .mockResolvedValueOnce(mockStopResponse("done") as any);

    await runAgentLoop("edit both files");

    expect(mockedAddToolResult).toHaveBeenCalledWith("call_w1", expect.any(String));
    expect(mockedAddToolResult).toHaveBeenCalledWith("call_w2", expect.any(String));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════
// Bug 5: toolConfigurator.configureTool — JSON.parse on malformed args aborts loop
// ═════════════════════════════════════════════════════════════════════════════════

// NOTE: Bug 5 is tested in a separate file (bugHunter1-configurator-regression.test.ts)
// because toolConfigurator.ts has a different set of dependencies to mock than
// agent.ts. See that file for the actual test.
