/**
 * error-paths-part2-1-compaction.test.ts — Error Path 1
 *
 * Scenario: Compaction LLM call fails → should fall back to mechanical/heuristic.
 *
 * Verifies that modelBasedCompactionAsync catches chat() failures (throw or
 * empty summary) and that smartCompact falls through to heuristic compaction
 * without crashing the agent.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
}));

// Enable intelligent compaction so the model-based path is attempted
vi.mock("../effortLevels.js", () => ({
  shouldUseIntelligentCompaction: vi.fn(() => true),
}));

const mockChat = vi.hoisted(() => vi.fn());
vi.mock("../apiClient.js", () => ({
  chat: mockChat,
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

const mockHistoryState: {
  messages: any[];
  tokens: number;
  compactResult: any;
} = {
  messages: [],
  tokens: 0,
  compactResult: null,
};

vi.mock("../history.js", () => ({
  estimateTokens: vi.fn(() => mockHistoryState.tokens),
  getHistory: vi.fn(() => mockHistoryState.messages),
  replaceHistory: vi.fn((m: any[]) => {
    mockHistoryState.messages = m;
    mockHistoryState.tokens = m.length * 100;
  }),
  compactHistory: vi.fn(() => mockHistoryState.compactResult),
  resetHistory: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockHistoryState.messages = [];
  mockHistoryState.tokens = 0;
  mockHistoryState.compactResult = null;
  mockChat.mockReset();
});

describe("Error path 1: Compaction LLM call fails → falls back to mechanical", () => {
  it("falls back to heuristic compaction when chat() throws", async () => {
    // Arrange: 12 messages, tokens above threshold AND above 1.2× threshold
    // (model-based compaction triggers only when before > maxTokens * 1.2)
    const msgs: any[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 11; i++) {
      msgs.push({ role: "assistant", content: `msg${i}` });
    }
    mockHistoryState.messages = msgs;
    // 12 messages × 100 = 1200 tokens. maxTokens=500 → 1200 > 500*1.2=600 ✓
    mockHistoryState.tokens = 1200;
    // chat() throws — simulates network failure, 5xx, etc.
    mockChat.mockRejectedValue(new Error("LLM service unavailable (503)"));

    const { smartCompact } = await import("../contextCompaction.js");
    // Act: should NOT throw — must fall back to heuristic compaction
    const result = await smartCompact(500);

    // Assert: function returned (didn't throw)
    expect(result).toBeDefined();
    expect(typeof result.compacted).toBe("boolean");
    expect(typeof result.savedTokens).toBe("number");

    // Assert: chat() was called (model-based path was attempted)
    expect(mockChat).toHaveBeenCalledTimes(1);

    // Assert: fallback to heuristic compaction occurred — replaceHistory was
    // called by the heuristic path (model-based did NOT replace on failure).
    const historyMod = await import("../history.js");
    expect((historyMod.replaceHistory as any).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to heuristic compaction when chat() returns empty/too-short summary", async () => {
    const msgs: any[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 11; i++) {
      msgs.push({ role: "assistant", content: `msg${i}` });
    }
    mockHistoryState.messages = msgs;
    mockHistoryState.tokens = 1200;
    // chat returns a summary that's too short (<50 chars) → treated as failure
    mockChat.mockResolvedValue({
      choices: [{ message: { content: "short" }, finish_reason: "stop" }],
    });

    const { smartCompact } = await import("../contextCompaction.js");
    const result = await smartCompact(500);

    expect(result).toBeDefined();
    expect(typeof result.compacted).toBe("boolean");
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it("does NOT crash the agent when model-based compaction fails repeatedly", async () => {
    mockChat.mockRejectedValue(new Error("persistent LLM failure"));
    const msgs: any[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 11; i++) {
      msgs.push({ role: "assistant", content: `msg${i}` });
    }
    mockHistoryState.messages = msgs;
    mockHistoryState.tokens = 1200;

    const { smartCompact } = await import("../contextCompaction.js");

    // Call smartCompact multiple times — each should fall back gracefully
    for (let i = 0; i < 3; i++) {
      const result = await smartCompact(500);
      expect(result).toBeDefined();
      expect(typeof result.compacted).toBe("boolean");
    }
  });

  it("logs a warning when model-based compaction fails (for debugging)", async () => {
    const msgs: any[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 11; i++) {
      msgs.push({ role: "assistant", content: `msg${i}` });
    }
    mockHistoryState.messages = msgs;
    mockHistoryState.tokens = 1200;
    mockChat.mockRejectedValue(new Error("connection reset"));

    const { smartCompact } = await import("../contextCompaction.js");
    await smartCompact(500);

    // The warn log should mention the model-based failure
    const logMod = await import("../logger.js");
    const warnFn = (logMod as any).warn as ReturnType<typeof vi.fn>;
    const warnCalls = warnFn.mock.calls.map((c: any[]) => String(c[0] ?? ""));
    expect(warnCalls.some((s: string) => s.includes("Model-based call failed"))).toBe(true);
  });
});
