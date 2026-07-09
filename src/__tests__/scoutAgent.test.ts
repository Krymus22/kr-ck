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

  it("getScoutModel returns default mistral-medium-3.5", () => {
    delete process.env.SCOUT_MODEL;
    expect(getScoutModel()).toBe("mistralai/mistral-medium-3.5-128b");
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

  it("produces summary when scout completes", async () => {
    process.env.SCOUT_ENABLED = "1";
    vi.mocked(chatWithModel).mockResolvedValue({
      choices: [{
        message: { content: "## Summary\nFound the file.", tool_calls: undefined },
        finish_reason: "stop",
      }],
    } as any);

    const result = await runScout({
      objective: "read foo.ts",
      tasks: [{ type: "read_file", description: "read foo.ts" }],
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
    expect(result!.summary).toContain("Found the file");
    expect(result!.modelUsed).toBe("mistralai/mistral-medium-3.5-128b");
  });

  it("executes tool calls and returns summary", async () => {
    process.env.SCOUT_ENABLED = "1";
    const { lerArquivo } = await import("../tools.js");
    vi.mocked(lerArquivo).mockResolvedValue("file content here");

    // First call: model requests tool call (relative path within cwd)
    // Second call: model returns summary
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
          message: { content: "## Summary\nFile has 100 lines.", tool_calls: undefined },
          finish_reason: "stop",
        }],
      } as any);

    const result = await runScout({
      objective: "read test.ts",
      tasks: [{ type: "read_file", description: "read test.ts" }],
    });

    expect(result).not.toBeNull();
    expect(result!.completed).toBe(true);
    expect(result!.summary).toContain("100 lines");
    expect(result!.toolCallCount).toBe(2);
    // The path is resolved relative to cwd, so it should be an absolute path
    // ending with test.ts
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
  it("formats completed result with model and summary", () => {
    const result = {
      summary: "Found 3 files.",
      filesInspected: ["a.ts", "b.ts"],
      completed: true,
      modelUsed: "mistralai/mistral-medium-3.5-128b",
      toolCallCount: 5,
    };
    const formatted = formatScoutResult(result);
    expect(formatted).toContain("[SCOUT CONTEXT");
    expect(formatted).toContain("mistralai/mistral-medium-3.5-128b");
    expect(formatted).toContain("5 tool calls");
    expect(formatted).toContain("Found 3 files.");
    expect(formatted).toContain("[End of scout context");
  });

  it("formats failed result with error", () => {
    const result = {
      summary: "",
      filesInspected: [],
      completed: false,
      modelUsed: "mistralai/mistral-medium-3.5-128b",
      toolCallCount: 0,
      error: "API_TIMEOUT",
    };
    const formatted = formatScoutResult(result);
    expect(formatted).toContain("[SCOUT FAILED]");
    expect(formatted).toContain("API_TIMEOUT");
  });
});
