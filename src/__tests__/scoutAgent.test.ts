/**
 * scoutAgent.test.ts — Tests for the scout sub-agent feature.
 *
 * Covers:
 *   - Feature toggle (isScoutEnabled)
 *   - Model validation (validateScoutModel)
 *   - Config getters (getScoutModel)
 *   - runScout: disabled returns null
 *   - runScout: enabled produces summary
 *   - runScout: tool execution (read, search)
 *   - runScout: max tool calls limit
 *   - runScout: error handling (API failure)
 *   - formatScoutResult: completed
 *   - formatScoutResult: failed
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

vi.mock("../apiClient.js", () => ({
  chatWithModel: vi.fn(),
  // BH9 MEDIUM 1 FIX: scout's finally block now calls clearModelOverride as
  // a safety net (mirrors smallTaskAgent). Mock it so the import resolves.
  clearModelOverride: vi.fn(),
}));

vi.mock("../tools.js", () => ({
  lerArquivo: vi.fn(),
}));

vi.mock("../fileSearch.js", () => ({
  globSearch: vi.fn(),
}));

vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(),
  formatGrepResults: vi.fn(),
}));

vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn(),
}));

vi.mock("../modelRegistry.js", () => ({
  getModelInfo: vi.fn((id: string) => {
    if (id === "google/diffusiongemma-26b-a4b-it") {
      return {
        id, name: "DiffusionGemma 26B",
        contextWindow: 256000, maxOutputTokens: 4096,
        costPer1MPrompt: 0, costPer1MCompletion: 0,
        supportsTools: true, supportsParallelTools: true,
        hasThinking: true, provider: "nvidia",
      };
    }
    if (id === "mistralai/mistral-medium-3.5-128b") {
      return {
        id, name: "Mistral Medium 3.5",
        contextWindow: 128000, maxOutputTokens: 8192,
        costPer1MPrompt: 0, costPer1MCompletion: 0,
        supportsTools: true, supportsParallelTools: true,
        hasThinking: false, provider: "nvidia",
      };
    }
    if (id === "deepseek-ai/deepseek-r1") {
      return {
        id, name: "DeepSeek R1",
        contextWindow: 128000, maxOutputTokens: 32768,
        costPer1MPrompt: 0, costPer1MCompletion: 0,
        supportsTools: false, supportsParallelTools: false,
        hasThinking: true, provider: "nvidia",
      };
    }
    return { id: "unknown", name: "Unknown", contextWindow: 128000, maxOutputTokens: 8192, supportsTools: true };
  }),
  getModelMaxOutputTokens: vi.fn(() => 8192),
  modelSupportsTools: vi.fn((id: string) => id !== "deepseek-ai/deepseek-r1"),
  modelSupportsParallelTools: vi.fn(() => true),
}));

import { isScoutEnabled, getScoutModel, validateScoutModel, runScout, formatScoutResult, _resetScoutForTests } from "../scoutAgent.js";
import { chatWithModel } from "../apiClient.js";

describe("scoutAgent — feature toggle", () => {
  afterEach(() => {
    delete process.env.SCOUT_ENABLED;
    delete process.env.SCOUT_MODEL;
  });

  it("isScoutEnabled returns false by default", () => {
    delete process.env.SCOUT_ENABLED;
    expect(isScoutEnabled()).toBe(false);
  });

  it("isScoutEnabled returns true when SCOUT_ENABLED=1", () => {
    process.env.SCOUT_ENABLED = "1";
    expect(isScoutEnabled()).toBe(true);
  });

  it("isScoutEnabled returns true when SCOUT_ENABLED=true", () => {
    process.env.SCOUT_ENABLED = "true";
    expect(isScoutEnabled()).toBe(true);
  });

  it("isScoutEnabled returns false when SCOUT_ENABLED=0", () => {
    process.env.SCOUT_ENABLED = "0";
    expect(isScoutEnabled()).toBe(false);
  });

  it("isScoutEnabled returns false when SCOUT_ENABLED=off", () => {
    process.env.SCOUT_ENABLED = "off";
    expect(isScoutEnabled()).toBe(false);
  });
});

describe("scoutAgent — model config", () => {
  afterEach(() => {
    delete process.env.SCOUT_MODEL;
  });

  it("getScoutModel returns default diffusiongemma-26b", () => {
    delete process.env.SCOUT_MODEL;
    expect(getScoutModel()).toBe("google/diffusiongemma-26b-a4b-it");
  });

  it("getScoutModel returns custom model from env", () => {
    process.env.SCOUT_MODEL = "moonshotai/kimi-k2.6";
    expect(getScoutModel()).toBe("moonshotai/kimi-k2.6");
  });

  it("validateScoutModel returns null for valid model", () => {
    delete process.env.SCOUT_MODEL;
    expect(validateScoutModel()).toBeNull();
  });

  it("validateScoutModel returns error for model without tools", () => {
    process.env.SCOUT_MODEL = "deepseek-ai/deepseek-r1";
    const err = validateScoutModel();
    expect(err).toContain("does not support tools");
  });
});

describe("scoutAgent — runScout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetScoutForTests();
    delete process.env.SCOUT_ENABLED;
    delete process.env.SCOUT_MODEL;
  });

  afterEach(() => {
    delete process.env.SCOUT_ENABLED;
    delete process.env.SCOUT_MODEL;
  });

  it("returns null when feature is disabled", async () => {
    delete process.env.SCOUT_ENABLED;
    const result = await runScout({
      objective: "test",
      tasks: [{ type: "read_file", description: "read foo" }],
    });
    expect(result).toBeNull();
  });

  it("returns error result when model is invalid", async () => {
    process.env.SCOUT_ENABLED = "1";
    process.env.SCOUT_MODEL = "deepseek-ai/deepseek-r1";
    const result = await runScout({
      objective: "test",
      tasks: [{ type: "read_file", description: "read foo" }],
    });
    expect(result).not.toBeNull();
    expect(result!.completed).toBe(false);
    expect(result!.error).toContain("does not support tools");
  });

  it("completes with no tool calls when model says DONE", async () => {
    process.env.SCOUT_ENABLED = "1";
    vi.mocked(chatWithModel).mockResolvedValue({
      choices: [{
        message: { content: "DONE", tool_calls: undefined },
        finish_reason: "stop",
      }],
    } as any);

    const result = await runScout({
      objective: "read foo.ts",
      tasks: [{ type: "read_file", description: "read foo.ts" }],
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
    expect(result!.toolResults).toHaveLength(0);
    expect(result!.modelUsed).toBe("google/diffusiongemma-26b-a4b-it");
  });

  it("executes tool calls and returns raw results (not summary)", async () => {
    process.env.SCOUT_ENABLED = "1";
    const { lerArquivo } = await import("../tools.js");
    vi.mocked(lerArquivo).mockResolvedValue("file content here");

    // First call: model requests tool call (relative path within cwd)
    // Second call: model says DONE
    vi.mocked(chatWithModel)
      .mockResolvedValueOnce({
        choices: [{
          message: {
            content: "",
            tool_calls: [{
              id: "tc-1",
              type: "function",
              function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "test.ts" }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
      } as any)
      .mockResolvedValueOnce({
        choices: [{
          message: { content: "DONE", tool_calls: undefined },
          finish_reason: "stop",
        }],
      } as any);

    const result = await runScout({
      objective: "read test.ts",
      tasks: [{ type: "read_file", description: "read test.ts" }],
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
    // The scout should return the RAW tool result, not a summary
    expect(result!.toolResults).toHaveLength(1);
    expect(result!.toolResults[0]!.tool).toBe("ler_arquivo");
    expect(result!.toolResults[0]!.result).toBe("file content here");
    expect(result!.toolResults[0]!.success).toBe(true);
    expect(result!.toolCallCount).toBe(1);
    // The path is resolved relative to cwd, so it should be an absolute path
    expect(lerArquivo).toHaveBeenCalled();
    const calledArg = vi.mocked(lerArquivo).mock.calls[0]?.[0];
    expect(calledArg?.caminho).toContain("test.ts");
  });

  it("respects maxToolCalls limit", async () => {
    process.env.SCOUT_ENABLED = "1";
    // Every call returns a tool call — never produces summary
    vi.mocked(chatWithModel).mockResolvedValue({
      choices: [{
        message: {
          content: "",
          tool_calls: [{
            id: "tc-1",
            type: "function",
            function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "test.ts" }) },
          }],
        },
        finish_reason: "tool_calls",
      }],
    } as any);

    const { lerArquivo } = await import("../tools.js");
    vi.mocked(lerArquivo).mockResolvedValue("content");

    const result = await runScout({
      objective: "test",
      tasks: [{ type: "read_file", description: "read foo" }],
      maxToolCalls: 3,
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
    // Should stop after 3 calls
    expect(result!.toolCallCount).toBeLessThanOrEqual(3);
  });

  it("handles API errors gracefully", async () => {
    process.env.SCOUT_ENABLED = "1";
    vi.mocked(chatWithModel).mockRejectedValue(new Error("API_TIMEOUT"));

    const result = await runScout({
      objective: "test",
      tasks: [{ type: "read_file", description: "read foo" }],
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(false);
    expect(result!.error).toContain("API_TIMEOUT");
  });
});

describe("scoutAgent — formatScoutResult", () => {
  it("formats completed result with raw tool results", () => {
    const result = {
      toolResults: [
        { tool: "ler_arquivo", args: { caminho: "a.ts" }, result: "content of a.ts", success: true },
        { tool: "buscar_texto", args: { padrao: "foo" }, result: "found 3 matches", success: true },
      ],
      filesInspected: ["/project/a.ts"],
      completed: true,
      modelUsed: "google/diffusiongemma-26b-a4b-it",
      toolCallCount: 2,
    };
    const formatted = formatScoutResult(result as any);
    expect(formatted).toContain("[SCOUT RESULTS");
    expect(formatted).toContain("google/diffusiongemma-26b-a4b-it");
    expect(formatted).toContain("2 successful calls");
    // Raw results should be present, not a summary
    expect(formatted).toContain("content of a.ts");
    expect(formatted).toContain("found 3 matches");
    expect(formatted).toContain("ler_arquivo");
    expect(formatted).toContain("buscar_texto");
    expect(formatted).toContain("Files Inspected by Scout");
    expect(formatted).toContain("[End of scout results");
  });

  it("formats failed result with error", () => {
    const result = {
      toolResults: [],
      filesInspected: [],
      completed: false,
      modelUsed: "google/diffusiongemma-26b-a4b-it",
      toolCallCount: 0,
      error: "API_TIMEOUT",
    };
    const formatted = formatScoutResult(result as any);
    expect(formatted).toContain("[SCOUT FAILED]");
    expect(formatted).toContain("API_TIMEOUT");
  });
});
