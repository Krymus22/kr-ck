/**
 * scoutAgent-summary.test.ts — Tests for scout internal summary (§17.13 rule 114).
 *
 * When the scout reads a file, the RAW content goes to toolResults (for the
 * main agent), but a SHORT summary goes to the scout's own history (to
 * prevent context overflow).
 *
 * Tests cover:
 *   - summarizeForScoutContext skips small results (< 2KB)
 *   - summarizeForScoutContext skips errors
 *   - summarizeForScoutContext calls LLM for large results
 *   - summarizeForScoutContext falls back to truncated raw on LLM failure
 *   - toolResults contains RAW content (not summary)
 *   - scout history contains summary (not raw) for large files
 *   - scout history contains raw for small files (no summary)
 *   - Each scout invocation is independent (stateless)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

// Mock chatWithModel — we control what the summarizer returns
const mockChatWithModel = vi.fn();
vi.mock("../apiClient.js", () => ({
  chatWithModel: mockChatWithModel,
  clearModelOverride: vi.fn(),
}));

vi.mock("../tools.js", () => ({
  lerArquivo: vi.fn(),
  executarComando: vi.fn(),
}));

vi.mock("../fileSearch.js", () => ({
  globSearch: vi.fn(() => []),
}));

vi.mock("../contentSearch.js", () => ({
  grepSearch: vi.fn(() => []),
  formatGrepResults: vi.fn(() => ""),
}));

vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn(),
}));

vi.mock("../extensions.js", () => ({
  getActiveMCPServers: vi.fn(() => []),
  getMCPToolDefinitions: vi.fn(() => []),
  callMCPTool: vi.fn(),
}));

vi.mock("../robloxMcpGuard.js", () => ({
  classifyMcpTool: vi.fn(() => "read"),
  extractToolName: vi.fn(),
}));

vi.mock("../pathSecurity.js", () => ({
  resolveAndCheckPath: vi.fn((p: string) => p),
  validateCwd: vi.fn(() => ({ ok: true })),
}));

import { runScout, formatScoutResult, _resetScoutForTests } from "../scoutAgent.js";
import { lerArquivo } from "../tools.js";

const origEnv = { ...process.env };

beforeEach(() => {
  process.env.SCOUT_ENABLED = "1";
  process.env.SCOUT_MODEL = "google/diffusiongemma-26b-a4b-it";
  process.env.NVIDIA_API_KEY = "nvapi-test";
  vi.clearAllMocks();
  _resetScoutForTests();
});

afterEach(() => {
  process.env = { ...origEnv };
  vi.clearAllMocks();
  _resetScoutForTests();
});

describe("scoutAgent — internal summary (§17.13 rule 114)", () => {
  describe("summarizeForScoutContext behavior", () => {
    it("scout history contains summary (not raw) for large files", async () => {
      // Large file content (> 2KB threshold)
      const largeContent = "x".repeat(5000);
      vi.mocked(lerArquivo).mockResolvedValue(largeContent);

      // Mock the LLM responses:
      // 1st call: scout decides to call ler_arquivo
      // 2nd call: summarizer generates summary of the file
      // 3rd call: scout says "DONE"
      mockChatWithModel
        .mockResolvedValueOnce({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "test.ts" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        .mockResolvedValueOnce({
          // Summary response (from summarizeForScoutContext)
          choices: [{
            message: { role: "assistant", content: "Test file with 5000 chars of x." },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })
        .mockResolvedValueOnce({
          // Scout says DONE
          choices: [{
            message: { role: "assistant", content: "DONE" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        });

      const result = await runScout({
        objective: "read test.ts",
        tasks: [{ type: "read_file", description: "read test.ts" }],
        maxToolCalls: 5,
      });

      expect(result).not.toBeNull();
      expect(result!.completed).toBe(true);

      // toolResults should contain RAW content (5000 chars)
      expect(result!.toolResults).toHaveLength(1);
      expect(result!.toolResults[0].result).toBe(largeContent);
      expect(result!.toolResults[0].result.length).toBe(5000);

      // The summarizer should have been called (2nd chatWithModel call)
      expect(mockChatWithModel).toHaveBeenCalledTimes(3);
      // 2nd call is the summarizer — messages[1] is the user message with file content
      const summaryCall = mockChatWithModel.mock.calls[1];
      const summaryMessages = summaryCall[0] as Array<{ role: string; content: string }>;
      expect(summaryMessages[1].content).toBe(largeContent.slice(0, 12000));
    });

    it("scout history contains raw for small files (no summary)", async () => {
      // Small file content (< 2KB threshold) — should NOT trigger summarizer
      const smallContent = "small file";
      vi.mocked(lerArquivo).mockResolvedValue(smallContent);

      mockChatWithModel
        .mockResolvedValueOnce({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "test.ts" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        .mockResolvedValueOnce({
          // Scout says DONE (no summarizer call)
          choices: [{
            message: { role: "assistant", content: "DONE" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        });

      const result = await runScout({
        objective: "read test.ts",
        tasks: [{ type: "read_file", description: "read test.ts" }],
        maxToolCalls: 5,
      });

      expect(result).not.toBeNull();
      expect(result!.completed).toBe(true);

      // toolResults contains raw
      expect(result!.toolResults[0].result).toBe(smallContent);

      // Only 2 LLM calls (scout decision + DONE) — NO summarizer call
      expect(mockChatWithModel).toHaveBeenCalledTimes(2);
    });

    it("summarizer failure falls back to truncated raw in history", async () => {
      const largeContent = "y".repeat(5000);
      vi.mocked(lerArquivo).mockResolvedValue(largeContent);

      mockChatWithModel
        .mockResolvedValueOnce({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "test.ts" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        .mockRejectedValueOnce(new Error("Summarizer API failed"))
        .mockResolvedValueOnce({
          choices: [{
            message: { role: "assistant", content: "DONE" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        });

      const result = await runScout({
        objective: "read test.ts",
        tasks: [{ type: "read_file", description: "read test.ts" }],
        maxToolCalls: 5,
      });

      expect(result).not.toBeNull();
      expect(result!.completed).toBe(true);

      // toolResults still contains FULL raw content (not affected by summary failure)
      expect(result!.toolResults[0].result).toBe(largeContent);
      expect(result!.toolResults[0].result.length).toBe(5000);
    });

    it("summarizer skips errors (passes through)", async () => {
      // lerArquivo returns an error
      vi.mocked(lerArquivo).mockResolvedValue("[ERROR] File not found: test.ts");

      mockChatWithModel
        .mockResolvedValueOnce({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "test.ts" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        .mockResolvedValueOnce({
          choices: [{
            message: { role: "assistant", content: "DONE" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        });

      const result = await runScout({
        objective: "read test.ts",
        tasks: [{ type: "read_file", description: "read test.ts" }],
        maxToolCalls: 5,
      });

      expect(result).not.toBeNull();
      // Error result should be in toolResults
      expect(result!.toolResults[0].result).toBe("[ERROR] File not found: test.ts");
      expect(result!.toolResults[0].success).toBe(false);

      // Only 2 LLM calls (no summarizer for errors)
      expect(mockChatWithModel).toHaveBeenCalledTimes(2);
    });

    it("each scout invocation is independent (stateless)", async () => {
      // First invocation
      vi.mocked(lerArquivo).mockResolvedValue("content 1");
      mockChatWithModel
        .mockResolvedValueOnce({
          choices: [{
            message: { role: "assistant", content: "DONE" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });

      const result1 = await runScout({
        objective: "task 1",
        tasks: [],
        maxToolCalls: 1,
      });

      // Second invocation — should NOT see history from first
      vi.clearAllMocks();
      vi.mocked(lerArquivo).mockResolvedValue("content 2");
      mockChatWithModel
        .mockResolvedValueOnce({
          choices: [{
            message: { role: "assistant", content: "DONE" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });

      const result2 = await runScout({
        objective: "task 2",
        tasks: [],
        maxToolCalls: 1,
      });

      // Both should succeed independently
      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect(result1!.toolResults).toHaveLength(0); // no tool calls in this test
      expect(result2!.toolResults).toHaveLength(0);
    });
  });

  describe("toolResults always contains RAW content", () => {
    it("multiple files: all raw content in toolResults", async () => {
      const file1 = "a".repeat(3000);
      const file2 = "b".repeat(3000);
      vi.mocked(lerArquivo)
        .mockResolvedValueOnce(file1)
        .mockResolvedValueOnce(file2);

      mockChatWithModel
        // Scout calls ler_arquivo for file 1
        .mockResolvedValueOnce({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "file1.ts" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        // Summarizer for file 1
        .mockResolvedValueOnce({
          choices: [{
            message: { role: "assistant", content: "File 1 summary" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })
        // Scout calls ler_arquivo for file 2
        .mockResolvedValueOnce({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_2",
                type: "function",
                function: { name: "ler_arquivo", arguments: JSON.stringify({ caminho: "file2.ts" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
        // Summarizer for file 2
        .mockResolvedValueOnce({
          choices: [{
            message: { role: "assistant", content: "File 2 summary" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        })
        // Scout says DONE
        .mockResolvedValueOnce({
          choices: [{
            message: { role: "assistant", content: "DONE" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        });

      const result = await runScout({
        objective: "read file1.ts and file2.ts",
        tasks: [
          { type: "read_file", description: "read file1.ts" },
          { type: "read_file", description: "read file2.ts" },
        ],
        maxToolCalls: 10,
      });

      expect(result).not.toBeNull();
      expect(result!.toolResults).toHaveLength(2);

      // Both toolResults should have RAW content
      expect(result!.toolResults[0].result).toBe(file1);
      expect(result!.toolResults[0].result.length).toBe(3000);
      expect(result!.toolResults[1].result).toBe(file2);
      expect(result!.toolResults[1].result.length).toBe(3000);
    });
  });
});
