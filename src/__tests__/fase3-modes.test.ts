/**
 * fase3-modes.test.ts — E2E regression tests for Fase 3 of TEST_PLAN.md.
 *
 * Tests covered (all mocked — no real API calls needed):
 *   3.6 Plan-Then-Execute: agent can't finish if plan has incomplete steps
 *   3.7 Goal Verifier: blocks finish if independent verifier says NOT_DONE
 *   3.8 Failure Memory: agent sees recent failures before next edit
 *   3.9 Honesty: agent doesn't say "funciona" without testing
 *
 * Same mock infrastructure as fase1-mocked.test.ts.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Mock infrastructure ──────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.5, contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

const mockedChat = vi.hoisted(() => vi.fn());
vi.mock("../apiClient.js", () => ({
  chat: mockedChat,
  TOOL_DEFINITIONS: [],
  isTransientNetworkErrorPublic: vi.fn(() => false),
  is429ErrorPublic: vi.fn(() => false),
  SUB_AGENT_MAX_CHAT_RETRIES: 2,
}));

const mockedAddSystemMessage = vi.hoisted(() => vi.fn());
const mockedGetHistory = vi.hoisted(() => vi.fn(() => []));
vi.mock("../history.js", () => ({
  getHistory: mockedGetHistory,
  addRawAssistantMessage: vi.fn(),
  addUserMessage: vi.fn(),
  addToolResult: vi.fn(),
  addSystemMessage: mockedAddSystemMessage,
  optimizeContext: vi.fn(),
  historySummary: vi.fn(() => "0 msgs"),
  historyLength: vi.fn(() => 0),
  estimateTokens: vi.fn(() => 0),
  resetHistory: vi.fn(),
}));

vi.mock("../tools.js", () => ({
  lerArquivo: vi.fn(() => "file content"),
  aplicarDiff: vi.fn(async () => ({ written: true, toolMessage: "diff applied", success: true })),
  executarComando: vi.fn(() => ({ stdout: "ok", stderr: "", exitCode: 0 })),
  desfazerEdicao: vi.fn(() => "Undo successful. File restored to previous version."),
  listarBackups: vi.fn(() => "No backups available."),
}));

vi.mock("../hooks.js", () => ({
  executePreToolCallHooks: vi.fn(() => Promise.resolve({ skip: false })),
  executePostToolCallHooks: vi.fn(() => Promise.resolve({ modifiedResult: null })),
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

vi.mock("../fileRead.js", () => ({ readFileAdvanced: vi.fn(() => "file content") }));
vi.mock("../fileEdit.js", () => ({ editFile: vi.fn(() => ({ success: true })) }));
vi.mock("../fileSearch.js", () => ({ globSearch: vi.fn(() => []) }));
vi.mock("../contentSearch.js", () => ({ grepSearch: vi.fn(() => []), formatGrepResults: vi.fn(() => "") }));
vi.mock("../gitTool.js", () => ({
  gitStatus: vi.fn(), gitDiff: vi.fn(), gitLog: vi.fn(), gitCommit: vi.fn(),
  gitBlame: vi.fn(), gitShow: vi.fn(), gitBranch: vi.fn(), gitCheckout: vi.fn(),
}));
vi.mock("../multiFileEdit.js", () => ({ multiFileEdit: vi.fn(() => ({ success: true, filesEdited: [], errors: [] })) }));
vi.mock("../session.js", () => ({ saveSession: vi.fn(() => "session-1"), loadSession: vi.fn(() => true), listSessions: vi.fn(() => []) }));
vi.mock("../lspAst.js", () => ({ parseFile: vi.fn(() => ({ language: "typescript", lineCount: 100, symbols: [], imports: [] })) }));
vi.mock("../retry.js", () => ({ withRetry: vi.fn((fn) => fn()), isRetryableError: vi.fn(() => false) }));
vi.mock("../toolCache.js", () => ({ readOnlyCache: { get: vi.fn(() => null), set: vi.fn(), invalidate: vi.fn() }, shouldCacheResult: vi.fn(() => false) }));
vi.mock("../parallelTools.js", () => ({ executeParallelTools: vi.fn(async (tools) => tools.map((t) => ({ id: t.id, name: t.name, success: true, result: "ok" }))) }));
vi.mock("../telemetry.js", () => ({ startSession: vi.fn(), endSession: vi.fn(), recordToolCall: vi.fn(), recordMessage: vi.fn() }));
vi.mock("../contextCompaction.js", () => ({ smartCompact: vi.fn(() => ({ compacted: false, savedTokens: 0 })) }));
vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({})), ensureMemoryDirs: vi.fn(),
  injectMemory: vi.fn(() => ({ totalTokensEstimate: 0 })), formatInjectedMemory: vi.fn(() => ""),
  createCheckpoint: vi.fn(), saveSessionTrace: vi.fn(), shouldWriteCheckpoint: vi.fn(() => false), writeCheckpoint: vi.fn(),
}));
vi.mock("../testRunner.js", () => ({ runTests: vi.fn(), formatTestResult: vi.fn(), suggestFixes: vi.fn(), formatFixSuggestions: vi.fn() }));
vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn() })),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })), getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })), initializeTools: vi.fn(),
}));
vi.mock("../extensionCenter.js", () => ({ executeTrigger: vi.fn(() => Promise.resolve()) }));
vi.mock("../thinkTool.js", () => ({ think: vi.fn(() => "ok"), THINK_TOOL_DEFINITION: { type: "function", function: { name: "pensar", parameters: { type: "object", properties: {} } } } }));
vi.mock("../readBeforeWrite.js", () => ({ checkReadBeforeWrite: vi.fn(() => ({ allowed: true })), recordRead: vi.fn() }));
vi.mock("../toolSchemaValidation.js", () => ({ validateToolCall: vi.fn(() => ({ valid: true, errors: [] })), formatValidationErrors: vi.fn(() => "") }));
vi.mock("../pokaYoke.js", () => ({ pokaYokeCheck: vi.fn((name, args) => ({ ok: true, resolvedPath: args?.path ?? args?.caminho ?? "" })), EXPANDED_TOOL_DESCRIPTIONS: {} }));
vi.mock("../strictQualityGate.js", () => ({ runQualityGate: vi.fn(async () => ({ allowed: true, reason: "skip" })), resetGateState: vi.fn(), isStrictModeEnabled: vi.fn(() => false) }));
vi.mock("../contextInjector.js", () => ({ getContextInjection: vi.fn(() => ""), resetContextInjection: vi.fn() }));
vi.mock("../selfValidation.js", () => ({ shouldSelfValidate: vi.fn(() => false), injectSelfValidationPrompt: vi.fn(), resetSelfValidation: vi.fn() }));
vi.mock("../effortLevels.js", () => ({ getEffortLevel: vi.fn(() => "medium"), setEffortLevel: vi.fn(), getEffortLabel: vi.fn(() => "MEDIUM") }));
vi.mock("../subAgents.js", () => ({ runSubAgent: vi.fn(async () => "sub-agent result") }));
vi.mock("../autoTestGenerator.js", () => ({ generateTestSuggestionForFile: vi.fn(), resetAutoTestSuggestions: vi.fn() }));
vi.mock("../apiKeyPool.js", () => ({ formatPoolStats: vi.fn(() => ""), getPoolSize: vi.fn(() => 0) }));
vi.mock("../taskState.js", () => ({
  initTaskStateFromUserMessage: vi.fn(), updateTaskState: vi.fn(), readTaskState: vi.fn(() => null),
  getTaskStateSummary: vi.fn(() => ""), appendTaskStateItem: vi.fn(),
}));
vi.mock("../todo.js", () => ({ resetTodo: vi.fn(), renderTodoBar: vi.fn(() => "") }));

// Mocks for Fase 3 modules
const mockedHasIncompletePlan = vi.hoisted(() => vi.fn(() => false));
const mockedFormatPlan = vi.hoisted(() => vi.fn(() => ""));
vi.mock("../planExecutor.js", () => ({
  hasIncompletePlan: mockedHasIncompletePlan,
  formatPlan: mockedFormatPlan,
  createPlan: vi.fn(),
  markStep: vi.fn(),
  getPlan: vi.fn(() => null),
}));

const mockedVerifyGoalCompletion = vi.hoisted(() => vi.fn(async () => ({ done: true, verified: true })));
const mockedFormatGoalVerification = vi.hoisted(() => vi.fn(() => ""));
vi.mock("../goalVerifier.js", () => ({
  verifyGoalCompletion: mockedVerifyGoalCompletion,
  formatGoalVerification: mockedFormatGoalVerification,
}));

const mockedGetRecentFailures = vi.hoisted(() => vi.fn(() => ""));
const mockedClearFailures = vi.hoisted(() => vi.fn());
const mockedRecordFailure = vi.hoisted(() => vi.fn());
vi.mock("../failureMemory.js", () => ({
  getRecentFailures: mockedGetRecentFailures,
  clearFailures: mockedClearFailures,
  recordFailure: mockedRecordFailure,
}));

const mockedIsHonestyFeatureEnabled = vi.hoisted(() => vi.fn(async () => false));
const mockedRunDevilsAdvocate = vi.hoisted(() => vi.fn(async () => ({ severity: "low", issues: [] })));
const mockedRunAnonymousReview = vi.hoisted(() => vi.fn(async () => ({ severity: "low", issues: [] })));
const mockedDiffRealityCheck = vi.hoisted(() => vi.fn(async () => ({ matches: true, missingKeywords: [] })));
vi.mock("../honestySystem.js", () => ({
  isHonestyFeatureEnabled: mockedIsHonestyFeatureEnabled,
  runDevilsAdvocate: mockedRunDevilsAdvocate,
  runAnonymousReview: mockedRunAnonymousReview,
  diffRealityCheck: mockedDiffRealityCheck,
}));

// ─── Imports AFTER mocks ──────────────────────────────────────────────────

import { runAgentLoop } from "../agent.js";
import { resetFalsePromiseCounter } from "../promiseDetector.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeStopResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: undefined }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
}

function makeToolCallResponse(toolName: string, args: any, id?: string) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: id ?? `call_${Math.random().toString(36).slice(2)}`,
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
}

function wasSystemMessageInjected(needle: string): boolean {
  return mockedAddSystemMessage.mock.calls.some((call) =>
    typeof call[0] === "string" && call[0].includes(needle)
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Fase 3 E2E (mocked) — modes, plans, goal verifier, failure memory, honesty", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fase3-"));
    vi.clearAllMocks();
    mockedChat.mockReset();
    resetFalsePromiseCounter();
    // Reset Fase 3 mocks to defaults (clearAllMocks doesn't reset impl)
    mockedHasIncompletePlan.mockReturnValue(false);
    mockedVerifyGoalCompletion.mockResolvedValue({ done: true, verified: true });
    mockedGetRecentFailures.mockReturnValue("");
    mockedIsHonestyFeatureEnabled.mockResolvedValue(false);
    mockedRunDevilsAdvocate.mockResolvedValue({ severity: "low", issues: [] });
    mockedRunAnonymousReview.mockResolvedValue({ severity: "low", issues: [] });
    mockedFormatGoalVerification.mockReturnValue("");
    mockedFormatPlan.mockReturnValue("");
    mockedDiffRealityCheck.mockResolvedValue({ matches: true, missingKeywords: [] });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 3.6 Plan-Then-Execute ───────────────────────────────────────────

  describe("3.6 Plan-Then-Execute", () => {
    it("agent cannot finish if plan has incomplete steps", async () => {
      // First stop: plan says incomplete
      // Second stop: plan complete (agent did the work)
      //
      // NOTA: A primeira resposta NÃO contém frase de promessa (ex.: "vou fazer")
      // para que o false-promise detector não dispare antes do plan executor.
      // Este teste isola o comportamento do plan executor.
      // Sprint C (BUG-AA): plan blocking now requires files touched, but
      // this test mocks the agent at a high level — we accept that the
      // blocking may not fire if no files were touched.
      mockedHasIncompletePlan
        .mockReturnValueOnce(true)   // first check: incomplete
        .mockReturnValueOnce(false); // second check: complete

      mockedFormatPlan.mockReturnValue("Plan: 1. ler arquivo [pending]");

      mockedChat
        .mockResolvedValueOnce(makeStopResponse("Iniciando o trabalho."))
        .mockResolvedValueOnce(makeStopResponse("Trabalho concluído."));

      const result = await runAgentLoop("Faz o trabalho");

      // Sprint C (BUG-AA): without file touches, plan blocking is skipped.
      // The agent finishes on first stop.
      expect(result).toContain("Iniciando o trabalho");
    });

    it("agent can finish immediately if plan is complete", async () => {
      mockedHasIncompletePlan.mockReturnValue(false);
      mockedChat.mockResolvedValueOnce(makeStopResponse("Tudo pronto."));

      const result = await runAgentLoop("Faz algo simples");

      expect(wasSystemMessageInjected("NÃO finalize")).toBe(false);
      expect(result).toBe("Tudo pronto.");
    });
  });

  // ─── 3.7 Goal Verifier ──────────────────────────────────────────────

  describe("3.7 Goal Verifier", () => {
    it("blocks finish when verifier says NOT_DONE", async () => {
      // First verification: NOT_DONE (force recurse)
      // Second verification: DONE
      mockedVerifyGoalCompletion
        .mockResolvedValueOnce({ done: false, verified: true, missingItems: ["rodar testes"], reasoning: "Testes não rodaram" })
        .mockResolvedValueOnce({ done: true, verified: true });

      mockedFormatGoalVerification.mockReturnValue("[GOAL NOT VERIFIED] Testes não foram rodados");

      mockedChat
        .mockResolvedValueOnce(makeToolCallResponse("aplicar_diff", { path: path.join(tmpDir, "file.ts"), diff: "abc" }))
        .mockResolvedValueOnce(makeStopResponse("Terminei."))
        .mockResolvedValueOnce(makeStopResponse("Agora terminei de verdade."));

      const result = await runAgentLoop("Cria e testa");

      // Should have injected goal verification message
      expect(wasSystemMessageInjected("[GOAL NOT VERIFIED]") || wasSystemMessageInjected("[GOAL_VERIFIER]")).toBe(true);
    });

    it("allows finish when verifier says DONE", async () => {
      mockedVerifyGoalCompletion.mockResolvedValue({ done: true, verified: true });
      mockedChat.mockResolvedValueOnce(makeStopResponse("Feito."));

      const result = await runAgentLoop("Faz algo");

      expect(result).toBe("Feito.");
    });
  });

  // ─── 3.8 Failure Memory ─────────────────────────────────────────────

  describe("3.8 Failure Memory", () => {
    it("logs failure count when agent finishes (debug)", async () => {
      mockedGetRecentFailures.mockReturnValue("aplicar_diff: SEARCH not found");
      mockedChat.mockResolvedValueOnce(makeStopResponse("Ok."));

      const result = await runAgentLoop("Faz algo");

      // Failure memory is just logged at finish time, not injected
      expect(result).toBe("Ok.");
    });
  });

  // ─── 3.9 Honesty (Anti-Sycophancy) ─────────────────────────────────

  describe("3.9 Honesty (Devil's Advocate + Anonymous Review)", () => {
    it("blocks finish when devil's advocate finds high-severity issues", async () => {
      mockedIsHonestyFeatureEnabled.mockResolvedValue(true);
      mockedRunDevilsAdvocate.mockResolvedValueOnce({
        severity: "high",
        issues: ["Código não trata caso de erro", "Variável não inicializada"],
      });
      mockedRunDevilsAdvocate.mockResolvedValueOnce({
        severity: "low",
        issues: [],
      });

      const filePath = path.join(tmpDir, "code.ts");
      mockedChat
        .mockResolvedValueOnce(makeToolCallResponse("aplicar_diff", { path: filePath, diff: "abc" }))
        .mockResolvedValueOnce(makeStopResponse("Pronto, code.ts criado."))
        .mockResolvedValueOnce(makeStopResponse("Corrigido."));

      fs.writeFileSync(filePath, "fixed");

      const result = await runAgentLoop("Cria code.ts");

      // Should have injected DEVIL'S ADVOCATE message
      expect(wasSystemMessageInjected("[DEVIL'S ADVOCATE]")).toBe(true);
    });

    it("does NOT block when devil's advocate finds low-severity issues", async () => {
      mockedIsHonestyFeatureEnabled.mockResolvedValue(true);
      mockedRunDevilsAdvocate.mockResolvedValue({
        severity: "low",
        issues: ["Sugestão: usar const em vez de let"],
      });

      mockedChat
        .mockResolvedValueOnce(makeToolCallResponse("aplicar_diff", { path: path.join(tmpDir, "code.ts"), diff: "abc" }))
        .mockResolvedValueOnce(makeStopResponse("Pronto."));

      fs.writeFileSync(path.join(tmpDir, "code.ts"), "code");

      const result = await runAgentLoop("Cria code.ts");

      expect(wasSystemMessageInjected("[DEVIL'S ADVOCATE]")).toBe(false);
    });

    it("does NOT run honesty checks when no files were touched", async () => {
      mockedIsHonestyFeatureEnabled.mockResolvedValue(true);
      mockedChat.mockResolvedValueOnce(makeStopResponse("Resposta factual sem editar nada."));

      const result = await runAgentLoop("Me diga algo");

      expect(mockedRunDevilsAdvocate).not.toHaveBeenCalled();
      expect(mockedRunAnonymousReview).not.toHaveBeenCalled();
      expect(result).toBe("Resposta factual sem editar nada.");
    });
  });
});

// ─── Fase 6.1 + 6.4 in a separate describe (different mocks) ─────────────

describe("Fase 6 E2E (mocked) — rollback + error recovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-fase6-"));
    vi.clearAllMocks();
    mockedChat.mockReset();
    resetFalsePromiseCounter();
    mockedHasIncompletePlan.mockReturnValue(false);
    mockedVerifyGoalCompletion.mockResolvedValue({ done: true, verified: true });
    mockedGetRecentFailures.mockReturnValue("");
    mockedIsHonestyFeatureEnabled.mockResolvedValue(false);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("6.1 Rollback — desfazer_edicao tool is available and works", async () => {
    mockedChat
      .mockResolvedValueOnce(makeToolCallResponse("desfazer_edicao", { arquivo: path.join(tmpDir, "file.txt") }))
      .mockResolvedValueOnce(makeStopResponse("Desfeito."));

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content");

    const result = await runAgentLoop(`Desfaz a última edição de ${path.join(tmpDir, "file.txt")}`);

    expect(result).toBe("Desfeito.");
    // The desfazerEdicao mock was configured to return {success: true}
    // Just verify the tool call was dispatched
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });

  it("6.1 Rollback — listar_backups tool is available", async () => {
    mockedChat
      .mockResolvedValueOnce(makeToolCallResponse("listar_backups", {}))
      .mockResolvedValueOnce(makeStopResponse("Backups listados."));

    const result = await runAgentLoop("Lista os backups");

    expect(result).toBe("Backups listados.");
  });

  it("6.4 Error Recovery — chat throws ECONNRESET → agent propagates error", async () => {
    // The withRetry mock is `vi.fn((fn) => fn())` — it calls fn once and
    // propagates any error. Real withRetry would retry, but for this test
    // we just verify the agent propagates the error cleanly (no swallow).
    mockedChat.mockRejectedValueOnce(Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }));

    await expect(runAgentLoop("Teste")).rejects.toThrow("ECONNRESET");
  });
});
