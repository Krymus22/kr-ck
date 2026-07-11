/**
 * orchestratorAgent.test.ts — Regression tests for orchestrator mode (FEAT-ORCH-TESTS).
 *
 * Covers:
 *   1. Config getters (isOrchestratorMode, getOrchestratorModel, getHeavyModel)
 *   2. runOrchestratorLoop: simple conversation, tool delegation
 *      (chamar_planejador, chamar_programador, executar_comando_readonly,
 *       usar_scout), plan never compacted, coder >500 chars compacted,
 *      anti-recursion, callbacks, API errors, timeout
 *   3. runPlanner: success, heavy model, anti-recursion, clearModelOverride
 *   4. runCoder: success, heavy model, anti-recursion, scout usage,
 *      clearModelOverride
 *   5. Scout MCP tools (source checks)
 *
 * Pattern: mock chatWithModel from ../apiClient.js (same as
 * smallTaskAgent.test.ts). runPlanner and runCoder are NOT mocked — we test
 * the real implementation by mocking the chatWithModel they call internally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Hoisted mocks (referenced in vi.mock factories) ───────────────────────

const mockChatWithModel = vi.hoisted(() => vi.fn());
const mockClearModelOverride = vi.hoisted(() => vi.fn());
const mockRunScout = vi.hoisted(() => vi.fn());
const mockIsScoutEnabled = vi.hoisted(() => vi.fn(() => true));
const mockFormatScoutResult = vi.hoisted(
  () => vi.fn(() => "[SCOUT] formatted result"),
);

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock("../apiClient.js", () => ({
  chatWithModel: mockChatWithModel,
  clearModelOverride: mockClearModelOverride,
}));

// History mock: tracks messages in a shared array so getHistory() reflects
// what was added via addUserMessage/addSystemMessage/addRawAssistantMessage/
// addToolResult. This lets tests inspect the tool results passed to
// chatWithModel on subsequent loop iterations.
const historyState = vi.hoisted(() => ({ messages: [] as Array<Record<string, unknown>> }));
vi.mock("../history.js", () => ({
  getHistory: vi.fn(() => [...historyState.messages]),
  addUserMessage: vi.fn((content: string) => {
    historyState.messages.push({ role: "user", content });
  }),
  addSystemMessage: vi.fn((content: string) => {
    historyState.messages.push({ role: "system", content });
  }),
  addRawAssistantMessage: vi.fn((msg: Record<string, unknown>) => {
    historyState.messages.push({ ...msg });
  }),
  addToolResult: vi.fn((toolCallId: string, content: string) => {
    historyState.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }),
}));

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

vi.mock("../scoutAgent.js", () => ({
  isScoutEnabled: mockIsScoutEnabled,
  runScout: mockRunScout,
  formatScoutResult: mockFormatScoutResult,
}));

vi.mock("../tools.js", () => ({
  executarComando: vi.fn(async (args: { comando: string }) => {
    if (args.comando === "ls") return "file1.ts\nfile2.ts";
    if (args.comando === "pwd") return "/home/user/project";
    if (args.comando === "fail") return "[ERROR] Command failed with code 1";
    return `output of: ${args.comando}`;
  }),
  desfazerEdicao: vi.fn(),
  aplicarDiff: vi.fn(),
}));

vi.mock("../apiResearcher.js", () => ({
  webSearch: vi.fn(async (query: string) => [
    {
      url: `https://example.com/${query}`,
      title: `Result for ${query}`,
      snippet: "snippet text",
    },
  ]),
  webRead: vi.fn(async (url: string) => `content of ${url}`),
}));

vi.mock("../thinkTool.js", () => ({
  think: vi.fn(async () => ({ message: "[THOUGHT] ok" })),
  THINK_TOOL_DEFINITION: {
    type: "function" as const,
    function: {
      name: "pensar",
      description: "Structured thinking tool.",
      parameters: {
        type: "object",
        properties: {
          pensamento: { type: "string" },
          categoria: { type: "string" },
        },
      },
    },
  },
}));

vi.mock("../readBeforeWrite.js", () => ({
  recordRead: vi.fn(),
}));

vi.mock("../fileEdit.js", () => ({
  editFile: vi.fn(async () => "[OK] edited"),
}));

vi.mock("../multiFileEdit.js", () => ({
  multiFileEditWithLocks: vi.fn(async () => ({
    success: true,
    filesEdited: ["test.ts"],
    errors: [],
    rolledBack: false,
  })),
}));

vi.mock("../pathSecurity.js", () => ({
  resolveAndCheckPath: vi.fn(),
  validateCwd: vi.fn(() => ({ ok: true, cwd: process.cwd() })),
}));

// ─── Imports (after mocks are registered) ──────────────────────────────────

import {
  isOrchestratorMode,
  getOrchestratorModel,
  getHeavyModel,
  runOrchestratorLoop,
} from "../orchestratorAgent.js";
import { runPlanner } from "../plannerAgent.js";
import { runCoder } from "../coderAgent.js";

// ─── Response helpers ───────────────────────────────────────────────────────

/** Build a simple text-only model response (finish_reason: stop). */
function textResponse(content: string) {
  return {
    choices: [
      {
        message: { content, tool_calls: undefined },
        finish_reason: "stop" as const,
      },
    ],
  };
}

/** Build a tool-call model response (finish_reason: tool_calls). */
function toolCallResponse(
  toolName: string,
  args: Record<string, unknown>,
  id = "tc-1",
) {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id,
              type: "function" as const,
              function: {
                name: toolName,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
        finish_reason: "tool_calls" as const,
      },
    ],
  };
}

/** Build a text response with usage stats. */
function textResponseWithUsage(
  content: string,
  usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
) {
  return {
    choices: [
      {
        message: { content, tool_calls: undefined },
        finish_reason: "stop" as const,
      },
    ],
    usage,
  };
}

// ─── Config tests ──────────────────────────────────────────────────────────

describe("orchestratorAgent — config", () => {
  beforeEach(() => {
    delete process.env.ORCHESTRATOR_MODE;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.HEAVY_MODEL;
  });

  afterEach(() => {
    delete process.env.ORCHESTRATOR_MODE;
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.HEAVY_MODEL;
  });

  it("isOrchestratorMode() returns false by default", () => {
    expect(isOrchestratorMode()).toBe(false);
  });

  it("isOrchestratorMode() returns true when ORCHESTRATOR_MODE=1", () => {
    process.env.ORCHESTRATOR_MODE = "1";
    expect(isOrchestratorMode()).toBe(true);
  });

  it("isOrchestratorMode() returns true when ORCHESTRATOR_MODE=true", () => {
    process.env.ORCHESTRATOR_MODE = "true";
    expect(isOrchestratorMode()).toBe(true);
  });

  it("getOrchestratorModel() returns default google/gemma-4-31b-it", () => {
    expect(getOrchestratorModel()).toBe("google/gemma-4-31b-it");
  });

  it("getOrchestratorModel() returns custom when ORCHESTRATOR_MODEL set", () => {
    process.env.ORCHESTRATOR_MODEL = "meta/llama-3.1-8b-instruct";
    expect(getOrchestratorModel()).toBe("meta/llama-3.1-8b-instruct");
  });

  it("getHeavyModel() returns default z-ai/glm-5.2", () => {
    expect(getHeavyModel()).toBe("z-ai/glm-5.2");
  });

  it("getHeavyModel() returns custom when HEAVY_MODEL set", () => {
    process.env.HEAVY_MODEL = "qwen/qwen-3-coder-480b";
    expect(getHeavyModel()).toBe("qwen/qwen-3-coder-480b");
  });
});

// ─── runOrchestratorLoop tests ─────────────────────────────────────────────

describe("orchestratorAgent — runOrchestratorLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatWithModel.mockReset();
    mockClearModelOverride.mockReset();
    mockRunScout.mockReset();
    mockIsScoutEnabled.mockReset();
    mockFormatScoutResult.mockReset();
    historyState.messages = [];

    // Defaults
    mockIsScoutEnabled.mockReturnValue(true);
    mockFormatScoutResult.mockReturnValue("[SCOUT] formatted result");

    process.env.ORCHESTRATOR_MODE = "1";
    delete process.env.ORCHESTRATOR_MODEL;
    delete process.env.HEAVY_MODEL;
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.ORCHESTRATOR_MODE;
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  it("runs simple conversation (no tool calls — model responds directly)", async () => {
    mockChatWithModel.mockResolvedValueOnce(textResponse("Olá! Como posso ajudar?"));

    const result = await runOrchestratorLoop("oi");

    expect(result).toBe("Olá! Como posso ajudar?");
    expect(mockChatWithModel).toHaveBeenCalledTimes(1);
    // Orchestrator model was used (3rd arg of chatWithModel).
    expect(mockChatWithModel.mock.calls[0]?.[2]).toBe("google/gemma-4-31b-it");
  });

  it("calls chamar_planejador when model requests it", async () => {
    // 1. Orchestrator → tool_call(chamar_planejador)
    // 2. runPlanner → plan text (heavy model, no tool calls)
    // 3. Orchestrator → final answer
    mockChatWithModel
      .mockResolvedValueOnce(
        toolCallResponse("chamar_planejador", { tarefa: "planejar feature X" }),
      )
      .mockResolvedValueOnce(
        textResponse("[PLAN - 2 steps]\n1. Step 1\n2. Step 2"),
      )
      .mockResolvedValueOnce(textResponse("Plano criado com sucesso!"));

    const result = await runOrchestratorLoop("planeje feature X");

    expect(result).toBe("Plano criado com sucesso!");
    // 3 chatWithModel calls: orchestrator → planner → orchestrator.
    expect(mockChatWithModel).toHaveBeenCalledTimes(3);
    // Planner call used the heavy model.
    expect(mockChatWithModel.mock.calls[1]?.[2]).toBe("z-ai/glm-5.2");
    // The plan (raw) must be in the tool result fed back to the orchestrator.
    const thirdCallMessages = mockChatWithModel.mock.calls[2]?.[0] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = thirdCallMessages?.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("[PLAN");
    expect(toolMsg!.content).toContain("Step 1");
  });

  it("calls chamar_programador when model requests it", async () => {
    // 1. Orchestrator → tool_call(chamar_programador)
    // 2. runCoder → short summary (< 1000 chars → no compaction)
    // 3. Orchestrator → final answer
    mockChatWithModel
      .mockResolvedValueOnce(
        toolCallResponse("chamar_programador", { tarefa: "criar arquivo X" }),
      )
      .mockResolvedValueOnce(textResponse("Criei o arquivo X com sucesso."))
      .mockResolvedValueOnce(textResponse("Pronto! Arquivo criado."));

    const result = await runOrchestratorLoop("crie arquivo X");

    expect(result).toBe("Pronto! Arquivo criado.");
    expect(mockChatWithModel).toHaveBeenCalledTimes(3);
    // Coder used the heavy model.
    expect(mockChatWithModel.mock.calls[1]?.[2]).toBe("z-ai/glm-5.2");
  });

  it("calls executar_comando_readonly when model requests it", async () => {
    mockChatWithModel
      .mockResolvedValueOnce(
        toolCallResponse("executar_comando_readonly", { comando: "pwd" }),
      )
      .mockResolvedValueOnce(textResponse("Você está em /home/user/project"));

    const result = await runOrchestratorLoop("onde estou?");

    expect(result).toBe("Você está em /home/user/project");
    // The underlying executarComando should have been called.
    const { executarComando } = await import("../tools.js");
    expect(vi.mocked(executarComando)).toHaveBeenCalled();
  });

  it("rejects non-readonly commands in executar_comando_readonly", async () => {
    mockChatWithModel
      .mockResolvedValueOnce(
        toolCallResponse("executar_comando_readonly", { comando: "rm -rf /" }),
      )
      .mockResolvedValueOnce(textResponse("Comando bloqueado."));

    await runOrchestratorLoop("delete tudo");

    // The destructive command must NOT have been executed.
    const { executarComando } = await import("../tools.js");
    expect(vi.mocked(executarComando)).not.toHaveBeenCalled();
    // The tool result fed back to the model should mention the allowlist.
    const secondCallMessages = mockChatWithModel.mock.calls[1]?.[0] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = secondCallMessages?.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("allowlist");
  });

  it("calls usar_scout when model requests it", async () => {
    mockIsScoutEnabled.mockReturnValue(true);
    mockRunScout.mockResolvedValue({
      toolResults: [
        {
          tool: "ler_arquivo",
          args: { caminho: "foo.ts" },
          result: "content",
          success: true,
        },
      ],
      filesInspected: ["foo.ts"],
      completed: true,
      modelUsed: "google/diffusiongemma-26b-a4b-it",
      toolCallCount: 1,
    });
    mockFormatScoutResult.mockReturnValue("[SCOUT RESULTS] content of foo.ts");

    mockChatWithModel
      .mockResolvedValueOnce(
        toolCallResponse("usar_scout", {
          objetivo: "ler foo.ts",
          tarefas: [{ tipo: "read_file", descricao: "ler foo.ts" }],
        }),
      )
      .mockResolvedValueOnce(textResponse("Li o arquivo foo.ts via scout."));

    const result = await runOrchestratorLoop("leia foo.ts");

    expect(result).toBe("Li o arquivo foo.ts via scout.");
    expect(mockRunScout).toHaveBeenCalledTimes(1);
  });

  it("plan is never compacted (stays raw in context)", async () => {
    // Planner returns a LONG plan (>500 chars) — it must NOT be compacted.
    const longPlan = "[PLAN]\n" + "Passo específico do plano. ".repeat(40);

    mockChatWithModel
      .mockResolvedValueOnce(
        toolCallResponse("chamar_planejador", { tarefa: "planejar" }),
      )
      .mockResolvedValueOnce(textResponse(longPlan))
      .mockResolvedValueOnce(textResponse("Plano recebido."));

    await runOrchestratorLoop("planeje");

    // The plan (tool result) passed back to the orchestrator must contain the
    // FULL raw plan — not a [COMPACTED] marker.
    const thirdCallMessages = mockChatWithModel.mock.calls[2]?.[0] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = thirdCallMessages?.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("[PLAN");
    expect(toolMsg!.content).toContain("Passo específico do plano.");
    expect(toolMsg!.content).not.toContain("[COMPACTED");
  });

  it("coder results >1000 chars are compacted", async () => {
    // Coder returns a long summary (>1000 chars — raised from 500 per
    // FIX-MED-ORCH S3-3 MED 13 to avoid the perverse case where compaction
    // markers made the output LARGER than the original) → orchestrator
    // compacts it via a separate chatWithModel call before adding to context.
    const longCoderResult = "Editei vários arquivos. " + "Detalhe. ".repeat(150);

    mockChatWithModel
      // 1. Orchestrator → tool_call(chamar_programador)
      .mockResolvedValueOnce(
        toolCallResponse("chamar_programador", { tarefa: "implementar" }),
      )
      // 2. Coder → long result
      .mockResolvedValueOnce(textResponse(longCoderResult))
      // 3. Compaction call (orchestrator model summarizes the coder result)
      .mockResolvedValueOnce(textResponse("Resumo conciso do que foi feito."))
      // 4. Orchestrator → final answer
      .mockResolvedValueOnce(textResponse("Pronto."));

    await runOrchestratorLoop("implemente");

    // 4 calls total: orchestrator → coder → compaction → orchestrator.
    expect(mockChatWithModel).toHaveBeenCalledTimes(4);
    // The tool result fed back to the orchestrator (4th call) must be compacted.
    const fourthCallMessages = mockChatWithModel.mock.calls[3]?.[0] as Array<{
      role: string;
      content: string;
    }>;
    const toolMsg = fourthCallMessages?.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("[COMPACTED");
  });

  it("anti-recursion: sets CLAUDE_KILLER_AGENT_ID = 'orchestrator' during loop", async () => {
    // Capture agent ID at the time chatWithModel is called.
    const capturedIds: (string | undefined)[] = [];
    mockChatWithModel.mockImplementation(() => {
      capturedIds.push(process.env.CLAUDE_KILLER_AGENT_ID);
      return Promise.resolve(textResponse("ok"));
    });

    await runOrchestratorLoop("oi");

    expect(capturedIds[0]).toBe("orchestrator");
  });

  it("clears CLAUDE_KILLER_AGENT_ID in finally", async () => {
    mockChatWithModel.mockResolvedValueOnce(textResponse("ok"));

    await runOrchestratorLoop("oi");

    // After the loop, agent ID must be cleared (deleted, not set to a string).
    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBeUndefined();
  });

  it("clears CLAUDE_KILLER_AGENT_ID in finally even on error", async () => {
    mockChatWithModel.mockRejectedValueOnce(new Error("API down"));

    await expect(runOrchestratorLoop("oi")).rejects.toThrow("API down");

    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBeUndefined();
    expect(mockClearModelOverride).toHaveBeenCalled();
  });

  it("callbacks fire correctly (onStreamStart, onToolCall, onToolResult, onUsage)", async () => {
    const onStreamStart = vi.fn();
    const onToolCall = vi.fn();
    const onToolResult = vi.fn();
    const onUsage = vi.fn();

    // Mock that invokes onStreamStart (5th arg) to simulate the real
    // chatWithModel behavior of calling the streaming callback.
    mockChatWithModel
      .mockImplementationOnce((...args: unknown[]) => {
        const cb = args[4];
        if (typeof cb === "function") (cb as () => void)();
        return Promise.resolve({
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    id: "tc-1",
                    type: "function" as const,
                    function: {
                      name: "executar_comando_readonly",
                      arguments: JSON.stringify({ comando: "pwd" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls" as const,
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      })
      .mockImplementationOnce((...args: unknown[]) => {
        const cb = args[4];
        if (typeof cb === "function") (cb as () => void)();
        return Promise.resolve(
          textResponseWithUsage("Done", {
            prompt_tokens: 20,
            completion_tokens: 10,
            total_tokens: 30,
          }),
        );
      });

    await runOrchestratorLoop("pwd", {
      onStreamStart,
      onToolCall,
      onToolResult,
      onUsage,
    });

    expect(onStreamStart).toHaveBeenCalled();
    expect(onToolCall).toHaveBeenCalledWith("executar_comando_readonly", {
      comando: "pwd",
    });
    expect(onToolResult).toHaveBeenCalled();
    expect(onUsage).toHaveBeenCalledWith({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  it("handles API errors gracefully (throws, cleans state)", async () => {
    mockChatWithModel.mockRejectedValueOnce(new Error("API timeout"));

    await expect(runOrchestratorLoop("oi")).rejects.toThrow("API timeout");

    // State is cleaned up in finally.
    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBeUndefined();
    expect(mockClearModelOverride).toHaveBeenCalled();
  });

  it("handles timeout (rethrows, cleans state)", async () => {
    mockChatWithModel.mockRejectedValueOnce(
      new Error("Request timed out after 60000ms"),
    );

    await expect(runOrchestratorLoop("oi")).rejects.toThrow("timed out");

    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBeUndefined();
    expect(mockClearModelOverride).toHaveBeenCalled();
  });

  it("throws if ORCHESTRATOR_MODE is not enabled", async () => {
    delete process.env.ORCHESTRATOR_MODE;
    await expect(runOrchestratorLoop("oi")).rejects.toThrow(
      "Orchestrator mode is disabled",
    );
    expect(mockChatWithModel).not.toHaveBeenCalled();
  });

  it("throws on empty user input", async () => {
    await expect(runOrchestratorLoop("")).rejects.toThrow("non-empty");
  });
});

// ─── runPlanner tests ──────────────────────────────────────────────────────

describe("plannerAgent — runPlanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatWithModel.mockReset();
    mockClearModelOverride.mockReset();
    mockRunScout.mockReset();
    mockIsScoutEnabled.mockReset();
    mockFormatScoutResult.mockReset();

    mockIsScoutEnabled.mockReturnValue(true);
    mockFormatScoutResult.mockReturnValue("[SCOUT] formatted result");

    delete process.env.HEAVY_MODEL;
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.HEAVY_MODEL;
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  it("returns plan string on success", async () => {
    const plan = "[PLAN - 2 steps]\n1. Read foo\n2. Write bar";
    mockChatWithModel.mockResolvedValueOnce(textResponse(plan));

    const result = await runPlanner("planejar feature X");

    expect(result.success).toBe(true);
    expect(result.plan).toBe(plan);
    expect(result.toolCallsMade).toBe(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("uses HEAVY_MODEL", async () => {
    process.env.HEAVY_MODEL = "qwen/qwen-3-coder-480b";
    mockChatWithModel.mockResolvedValueOnce(textResponse("[PLAN]\n1. Step"));

    await runPlanner("test");

    expect(mockChatWithModel.mock.calls[0]?.[2]).toBe("qwen/qwen-3-coder-480b");
  });

  it("sets CLAUDE_KILLER_AGENT_ID = 'planner' during execution", async () => {
    const capturedIds: (string | undefined)[] = [];
    mockChatWithModel.mockImplementation(() => {
      capturedIds.push(process.env.CLAUDE_KILLER_AGENT_ID);
      return Promise.resolve(textResponse("[PLAN]\n1. Step"));
    });

    await runPlanner("test");

    expect(capturedIds[0]).toBe("planner");
  });

  it("clears agent ID in finally", async () => {
    mockChatWithModel.mockResolvedValueOnce(textResponse("[PLAN]\n1. Step"));

    await runPlanner("test");

    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBeUndefined();
  });

  it("calls clearModelOverride in finally", async () => {
    mockChatWithModel.mockResolvedValueOnce(textResponse("[PLAN]\n1. Step"));

    await runPlanner("test");

    expect(mockClearModelOverride).toHaveBeenCalled();
  });

  it("clears agent ID in finally even on error", async () => {
    mockChatWithModel.mockRejectedValueOnce(new Error("API down"));

    const result = await runPlanner("test");

    expect(result.success).toBe(false);
    expect(result.error).toContain("API down");
    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBeUndefined();
    expect(mockClearModelOverride).toHaveBeenCalled();
  });

  it("handles API errors (returns error result, doesn't throw)", async () => {
    mockChatWithModel.mockRejectedValueOnce(new Error("Network error"));

    const result = await runPlanner("test");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Network error");
    expect(result.plan).toBe("");
  });

  it("rejects recursive call (CLAUDE_KILLER_AGENT_ID already = planner)", async () => {
    process.env.CLAUDE_KILLER_AGENT_ID = "planner";

    const result = await runPlanner("test");

    expect(result.success).toBe(false);
    expect(result.error).toContain("recursão");
    expect(mockChatWithModel).not.toHaveBeenCalled();
  });

  it("rejects empty task", async () => {
    const result = await runPlanner("");

    expect(result.success).toBe(false);
    expect(result.error).toContain("non-empty");
  });
});

// ─── runCoder tests ────────────────────────────────────────────────────────

describe("coderAgent — runCoder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChatWithModel.mockReset();
    mockClearModelOverride.mockReset();
    mockRunScout.mockReset();
    mockIsScoutEnabled.mockReset();
    mockFormatScoutResult.mockReset();

    mockIsScoutEnabled.mockReturnValue(true);
    mockFormatScoutResult.mockReturnValue("[SCOUT] formatted result");

    delete process.env.HEAVY_MODEL;
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(() => {
    delete process.env.HEAVY_MODEL;
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  it("returns result string on success", async () => {
    const summary = "Editei src/foo.ts: adicionei função bar().";
    mockChatWithModel.mockResolvedValueOnce(textResponse(summary));

    const result = await runCoder("implementar função bar", null);

    expect(result.success).toBe(true);
    expect(result.result).toBe(summary);
  });

  it("uses HEAVY_MODEL", async () => {
    process.env.HEAVY_MODEL = "qwen/qwen-3-coder-480b";
    mockChatWithModel.mockResolvedValueOnce(textResponse("done"));

    await runCoder("test", null);

    expect(mockChatWithModel.mock.calls[0]?.[2]).toBe("qwen/qwen-3-coder-480b");
  });

  it("sets CLAUDE_KILLER_AGENT_ID = 'coder' during execution", async () => {
    const capturedIds: (string | undefined)[] = [];
    mockChatWithModel.mockImplementation(() => {
      capturedIds.push(process.env.CLAUDE_KILLER_AGENT_ID);
      return Promise.resolve(textResponse("done"));
    });

    await runCoder("test", null);

    expect(capturedIds[0]).toBe("coder");
  });

  it("clears agent ID in finally", async () => {
    mockChatWithModel.mockResolvedValueOnce(textResponse("done"));

    await runCoder("test", null);

    expect(process.env.CLAUDE_KILLER_AGENT_ID).toBeUndefined();
  });

  it("calls clearModelOverride in finally", async () => {
    mockChatWithModel.mockResolvedValueOnce(textResponse("done"));

    await runCoder("test", null);

    expect(mockClearModelOverride).toHaveBeenCalled();
  });

  it("can use usar_scout (not blocked by anti-recursion)", async () => {
    // Coder calls usar_scout internally — the anti-recursion check in
    // agent.ts only blocks scout/sub-agent/small-task-agent, NOT coder.
    // The coder also clears CLAUDE_KILLER_AGENT_ID before calling runScout
    // as defense-in-depth.
    mockIsScoutEnabled.mockReturnValue(true);
    mockRunScout.mockResolvedValue({
      toolResults: [
        {
          tool: "ler_arquivo",
          args: { caminho: "foo.ts" },
          result: "content",
          success: true,
        },
      ],
      filesInspected: ["foo.ts"],
      completed: true,
      modelUsed: "google/diffusiongemma-26b-a4b-it",
      toolCallCount: 1,
    });
    mockFormatScoutResult.mockReturnValue("[SCOUT RESULTS] content of foo.ts");

    mockChatWithModel
      .mockResolvedValueOnce(
        toolCallResponse("usar_scout", {
          objetivo: "ler foo.ts antes de editar",
          tarefas: [{ tipo: "read_file", descricao: "ler foo.ts" }],
        }),
      )
      .mockResolvedValueOnce(
        textResponse("Li foo.ts via scout e estou pronto."),
      );

    const result = await runCoder("editar foo.ts", null);

    expect(result.success).toBe(true);
    expect(mockRunScout).toHaveBeenCalledTimes(1);
    // The coder must call recordRead for each file the scout inspected
    // (read-before-write gate).
    const { recordRead } = await import("../readBeforeWrite.js");
    expect(vi.mocked(recordRead)).toHaveBeenCalledWith(
      "ler_arquivo",
      expect.any(String),
    );
  });

  it("handles API errors (returns error result, doesn't throw)", async () => {
    mockChatWithModel.mockRejectedValueOnce(new Error("API error"));

    const result = await runCoder("test", null);

    expect(result.success).toBe(false);
    expect(result.error).toContain("API error");
    expect(result.result).toBe("");
  });

  it("rejects recursive call (CLAUDE_KILLER_AGENT_ID already = coder)", async () => {
    process.env.CLAUDE_KILLER_AGENT_ID = "coder";

    const result = await runCoder("test", null);

    expect(result.success).toBe(false);
    expect(result.error).toContain("recursão");
    expect(mockChatWithModel).not.toHaveBeenCalled();
  });

  it("rejects empty task", async () => {
    const result = await runCoder("", null);

    expect(result.success).toBe(false);
    expect(result.error).toContain("non-empty");
  });
});

// ─── Scout MCP tools (source checks) ───────────────────────────────────────
//
// These tests verify invariants in the source code itself — that the scout
// has MCP read tools and that the anti-recursion guard in agent.ts allows
// planner/coder while blocking scout/sub-agent. We read the source files
// directly and assert specific patterns are present.

describe("scout MCP tools", () => {
  const projectRoot = process.cwd();
  const scoutAgentSource = fs.readFileSync(
    path.resolve(projectRoot, "src", "scoutAgent.ts"),
    "utf8",
  );
  const agentSource = fs.readFileSync(
    path.resolve(projectRoot, "src", "agent.ts"),
    "utf8",
  );

  it("scout has MCP read tools when MCP servers active (source check)", () => {
    // The scout source must import MCP utilities from extensions.js.
    expect(scoutAgentSource).toContain("getActiveMCPServers");
    expect(scoutAgentSource).toContain("getMCPToolDefinitions");
    expect(scoutAgentSource).toContain("callMCPTool");
    // The scout must have a function that filters MCP tools to read-only.
    expect(scoutAgentSource).toContain("getMCPReadTools");
    // The filtered MCP read tools must be combined with the built-in tools.
    expect(scoutAgentSource).toMatch(/getMCPReadTools\(\)/);
    // The system prompt must mention MCP Roblox Studio tools.
    expect(scoutAgentSource).toContain("MCP Roblox Studio tools");
  });

  it("scout anti-recursion allows 'planner' and 'coder' (source check)", () => {
    // The anti-recursion block in agent.ts must NOT include planner or coder
    // in the block list — they are heavy models that CAN use the scout.
    expect(agentSource).not.toMatch(/agentId\s*===\s*["']planner["']/);
    expect(agentSource).not.toMatch(/agentId\s*===\s*["']coder["']/);
    // The source must mention that planner/coder/orchestrator are allowed.
    expect(agentSource).toMatch(/planner|"coder"|orchestrator/i);
  });

  it("scout anti-recursion blocks 'scout' and 'sub-agent' (source check)", () => {
    // The block list must include scout, sub-agent, and small-task-agent.
    expect(agentSource).toMatch(/agentId\s*===\s*["']scout["']/);
    expect(agentSource).toMatch(/agentId\s*===\s*["']sub-agent["']/);
    expect(agentSource).toMatch(/agentId\s*===\s*["']small-task-agent["']/);
    // The error message must mention usar_scout and deadlock.
    expect(agentSource).toContain(
      "usar_scout cannot be called from inside a sub-agent",
    );
    expect(agentSource).toContain("deadlock");
  });
});
