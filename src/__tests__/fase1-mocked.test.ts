/**
 * fase1-mocked.test.ts — E2E regression tests for the 3 bugs from yesterday.
 *
 * Uses vitest's vi.mock to replace chat() with scripted responses that
 * simulate the EXACT problematic outputs the user reported:
 *   - "Achei algo concreto. Vou investigar mais." + finish_reason=stop
 *
 * Strategy: re-use the same mock infrastructure as agent.test.ts, but
 * add SPECIFIC assertions for the false-promise detector behavior.
 *
 * Tests covered (from TEST_PLAN.md):
 *   1.4d REGRESSION: false-promise detector fires on "vou investigar" + stop
 *   1.4 EDGE: agent that calls a tool is NOT flagged
 *   1.4 EDGE: agent that uses pensar + gives answer is NOT flagged
 *   1.5 EDGE: explicit refusal ("não posso") is NOT flagged
 *   1.4 EN: English false promises ("I'll check") are also detected
 *   1.4d: agent terminates after MAX_FALSE_PROMISE_RETRIES (no infinite loop)
 *   1.4d: EXACT message from yesterday's bug report is detected
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Mock infrastructure (same pattern as agent.test.ts) ──────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    nvidiaBaseUrl: "https://test.api.com",
    model: "test-model",
    contextWindowTokens: 128000,
    contextWarnThreshold: 0.5,
    contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01,
    costPerKCompletion: 0.03,
    maxHealRetries: 2,
    temperature: 0.6,
    topP: 0.9,
    maxTokens: 4096,
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

// Capture addSystemMessage calls so we can assert on them
const mockedAddSystemMessage = vi.hoisted(() => vi.fn());
const mockedGetHistory = vi.hoisted(() => vi.fn(() => []));
const mockedAddRawAssistantMessage = vi.hoisted(() => vi.fn());
const mockedAddUserMessage = vi.hoisted(() => vi.fn());
const mockedAddToolResult = vi.hoisted(() => vi.fn());

vi.mock("../history.js", () => ({
  getHistory: mockedGetHistory,
  addRawAssistantMessage: mockedAddRawAssistantMessage,
  addUserMessage: mockedAddUserMessage,
  addToolResult: mockedAddToolResult,
  addSystemMessage: mockedAddSystemMessage,
  optimizeContext: vi.fn(),
  historySummary: vi.fn(() => "0 msgs"),
  historyLength: vi.fn(() => 0),
  estimateTokens: vi.fn(() => 0),
  resetHistory: vi.fn(),
}));

vi.mock("../tools.js", () => ({
  lerFile: vi.fn(() => "file content"),
  aplicarDiff: vi.fn(() => ({ success: true, message: "ok" })),
  executarComando: vi.fn(() => ({ stdout: "ok", stderr: "", exitCode: 0 })),
  desfazerEdicao: vi.fn(() => ({ success: true, message: "restored" })),
  listarBackups: vi.fn(() => []),
}));

vi.mock("../hooks.js", () => ({
  executePreToolCallHooks: vi.fn(() => Promise.resolve({ skip: false })),
  executePostToolCallHooks: vi.fn(() => Promise.resolve({ modifiedResult: null })),
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []),
  callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(),
  shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []),
  getActiveMCPServers: vi.fn(() => []),
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
vi.mock("../session.js", () => ({ startSession: vi.fn(() => "test-session"), appendMessage: vi.fn(), getLastSession: vi.fn(() => null), loadSessionMessages: vi.fn(() => []), setActiveSession: vi.fn(), getActiveSessionId: vi.fn(() => null), listSessions: vi.fn(() => []), deleteSession: vi.fn(() => true), renameSession: vi.fn(() => true) }));
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
vi.mock("../readBeforeWrite.js", () => ({ checkReadBeforeWrite: vi.fn(() => ({ ok: true })), recordRead: vi.fn(), setAgentLoopRunningChecker: vi.fn() }));
vi.mock("../toolSchemaValidation.js", () => ({ validateToolCall: vi.fn(() => ({ valid: true, errors: [] })), formatValidationErrors: vi.fn(() => "") }));
vi.mock("../pokaYoke.js", () => ({ pokaYokeCheck: vi.fn(() => ({ ok: true })), EXPANDED_TOOL_DESCRIPTIONS: {} }));
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

// ─── Now import the agent AFTER all mocks are set up ──────────────────────

import { runAgentLoop } from "../agent.js";
import { resetFalsePromiseCounter } from "../promiseDetector.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeStopResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: undefined }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
}

function makeToolCallResponse(toolName: string, args: any) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `call_${Math.random().toString(36).slice(2)}`,
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  };
}

function wasFalsePromiseInjected(): boolean {
  return mockedAddSystemMessage.mock.calls.some((call) =>
    typeof call[0] === "string" && call[0].includes("FALSE_PROMISE_DETECTED")
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("Fase 1 E2E (mocked) — false-promise detector regression", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-ck-"));
    vi.clearAllMocks();
    // Reset the false-promise counter (module-level state) between tests
    resetFalsePromiseCounter();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1.4d — agent says 'Vou investigar mais.' + stop → FALSE_PROMISE_DETECTED injected", async () => {
    // EXACT bug from yesterday
    mockedChat
      .mockResolvedValueOnce(makeStopResponse("Achei algo concreto. Vou investigar mais."))
      .mockResolvedValueOnce(makeToolCallResponse("ler_arquivo", { path: path.join(tmpDir, "mystery.txt") }))
      .mockResolvedValueOnce(makeStopResponse("O arquivo contém 'secret content'."));

    fs.writeFileSync(path.join(tmpDir, "mystery.txt"), "secret content");

    const result = await runAgentLoop(`Investigue o arquivo ${path.join(tmpDir, "mystery.txt")}.`);

    expect(wasFalsePromiseInjected()).toBe(true);
    expect(mockedChat).toHaveBeenCalledTimes(3);
    expect(result).toContain("secret content");
  });

  it("1.4d — agent terminates after MAX_FALSE_PROMISE_RETRIES=2 (no infinite loop)", async () => {
    // 5 consecutive false promises — should stop after 2 retries
    mockedChat.mockResolvedValue(makeStopResponse("Vou investigar mais."));

    const result = await runAgentLoop("Investiga algo.");

    // Should have injected exactly 2 FALSE_PROMISE_DETECTED messages
    const falsePromiseCalls = mockedAddSystemMessage.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes("FALSE_PROMISE_DETECTED")
    );
    expect(falsePromiseCalls.length).toBe(2);
    // Should NOT have called chat() 5 times — only 3 (initial + 2 retries)
    expect(mockedChat).toHaveBeenCalledTimes(3);
    expect(result).toContain("Vou investigar");
  });

  it("1.4 POSITIVE — agent that calls a tool is NOT flagged", async () => {
    mockedChat
      .mockResolvedValueOnce(makeToolCallResponse("ler_arquivo", { path: path.join(tmpDir, "data.txt") }))
      .mockResolvedValueOnce(makeStopResponse("O arquivo contém 42."));

    fs.writeFileSync(path.join(tmpDir, "data.txt"), "42");

    const result = await runAgentLoop(`Leia ${path.join(tmpDir, "data.txt")}.`);

    expect(wasFalsePromiseInjected()).toBe(false);
    expect(result).toContain("42");
  });

  it("1.4 EDGE — agent says 'vou investigar' AND calls a tool → NOT flagged", async () => {
    // Agent both calls a tool AND says "vou investigar" — should NOT be flagged
    mockedChat
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: "Vou investigar os arquivos.",
            tool_calls: [{
              id: "call_1",
              function: { name: "ler_arquivo", arguments: JSON.stringify({ path: path.join(tmpDir, "a.txt") }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      })
      .mockResolvedValueOnce(makeStopResponse("Investiguei. Arquivo tem 1."));

    fs.writeFileSync(path.join(tmpDir, "a.txt"), "1");

    const result = await runAgentLoop(`Investigue ${tmpDir}.`);

    expect(wasFalsePromiseInjected()).toBe(false);
    expect(result).toContain("1");
  });

  it("1.5 EDGE — explicit refusal ('não posso') → NOT flagged as false promise", async () => {
    mockedChat.mockResolvedValueOnce(
      makeStopResponse("Infelizmente não posso acessar esse arquivo porque ele não existe. Você pode confirmar o caminho?")
    );

    const result = await runAgentLoop("Leia /arquivo/inexistente.txt");

    expect(wasFalsePromiseInjected()).toBe(false);
    expect(result).toContain("não posso");
  });

  it("1.5 EDGE — English refusal ('I can't') → NOT flagged as false promise", async () => {
    mockedChat.mockResolvedValueOnce(
      makeStopResponse("I can't run that command because the binary is not installed.")
    );

    const result = await runAgentLoop("Run /nonexistent/binary");

    expect(wasFalsePromiseInjected()).toBe(false);
    expect(result).toContain("can't");
  });

  it("1.4 EDGE — agent uses pensar (think tool) + complete answer → NOT flagged", async () => {
    mockedChat
      .mockResolvedValueOnce(makeToolCallResponse("pensar", { pensamento: "Vou pensar..." }))
      .mockResolvedValueOnce(makeStopResponse("Refleti sobre o problema. A resposta é 42."));

    const result = await runAgentLoop("Qual a resposta?");

    expect(wasFalsePromiseInjected()).toBe(false);
    expect(result).toContain("42");
  });

  it("1.4 EN — English false promise ('I'll check') → detected", async () => {
    mockedChat
      .mockResolvedValueOnce(makeStopResponse("I'll check that for you."))
      .mockResolvedValueOnce(makeToolCallResponse("ler_arquivo", { path: path.join(tmpDir, "x.txt") }))
      .mockResolvedValueOnce(makeStopResponse("Read it. Content: hello."));

    fs.writeFileSync(path.join(tmpDir, "x.txt"), "hello");

    const result = await runAgentLoop(`Check ${path.join(tmpDir, "x.txt")}.`);

    expect(wasFalsePromiseInjected()).toBe(true);
    expect(result).toContain("hello");
  });

  it("1.4d REGRESSION — EXACT message from yesterday's bug report is detected", async () => {
    // Reproduces EXACTLY what the user reported:
    //   "Achei algo concreto. O aftman está instalado, e o shim de rojo.exe
    //    existe mas exige declaração em aftman.toml. Vou investigar mais."
    const exactBugMessage = "Achei algo concreto. O aftman está instalado, e o shim de rojo.exe existe mas exige declaração em aftman.toml. Vou investigar mais.";

    mockedChat
      .mockResolvedValueOnce(makeStopResponse(exactBugMessage))
      .mockResolvedValueOnce(makeToolCallResponse("executar_comando", { comando: "aftman list" }))
      .mockResolvedValueOnce(makeStopResponse("Investiguei com aftman list. Encontrei os tools instalados."));

    const result = await runAgentLoop("Vê o que tem na máquina");

    expect(wasFalsePromiseInjected()).toBe(true);
    expect(result).toContain("Investiguei");
  });

  it("1.4 EDGE — 'aguarde enquanto verifico' → detected (waiting phrase)", async () => {
    mockedChat
      .mockResolvedValueOnce(makeStopResponse("Aguarde enquanto verifico isso."))
      .mockResolvedValueOnce(makeToolCallResponse("executar_comando", { comando: "ls" }))
      .mockResolvedValueOnce(makeStopResponse("Verifiquei. Tudo ok."));

    const result = await runAgentLoop("Verifica");

    expect(wasFalsePromiseInjected()).toBe(true);
    expect(result).toContain("Verifiquei");
  });

  it("1.4 EDGE — 'let me look' → detected (English)", async () => {
    mockedChat
      .mockResolvedValueOnce(makeStopResponse("Let me look into this."))
      .mockResolvedValueOnce(makeToolCallResponse("executar_comando", { comando: "ls" }))
      .mockResolvedValueOnce(makeStopResponse("Looked. Done."));

    const result = await runAgentLoop("Look into this");

    expect(wasFalsePromiseInjected()).toBe(true);
  });
});
