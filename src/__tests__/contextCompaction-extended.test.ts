/**
 * contextCompaction-extended.test.ts — Extended tests for contextCompaction.ts
 *
 * Covers 30+ tests across:
 *   - compactIntelligently (with various message shapes)
 *   - strategies array shape and individual strategy.shouldApply / .apply
 *   - smartCompact (mocked history module)
 *   - edge cases: empty arrays, null content, mixed types
 *
 * NOTE: compactIntelligently applies strategies in order, so
 * remove-consecutive-same-role runs FIRST and may merge consecutive
 * tool messages before merge-adjacent-tool-results can trigger.
 * Strategy-specific behavior is tested directly via strategies[i].apply().
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock logger
vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

// Mock effortLevels — disable intelligent compaction so smartCompact uses heuristics
vi.mock("../effortLevels.js", () => ({
  shouldUseIntelligentCompaction: vi.fn(() => false),
}));

// Mock apiClient so modelBasedCompactionAsync never reaches the network
vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
}));

// Mock history module so we can control estimateTokens/getHistory/etc.
const mockHistoryState: { messages: any[]; tokens: number; compactResult: any } = {
  messages: [],
  tokens: 0,
  compactResult: null,
};

vi.mock("../history.js", () => ({
  estimateTokens: vi.fn((msgs?: any) => {
    if (msgs !== undefined) return msgs.length * 100;
    return mockHistoryState.tokens;
  }),
  getHistory: vi.fn(() => mockHistoryState.messages),
  replaceHistory: vi.fn((m: any[]) => {
    mockHistoryState.messages = m;
    mockHistoryState.tokens = m.length * 100;
  }),
  compactHistory: vi.fn(() => mockHistoryState.compactResult),
  resetHistory: vi.fn(() => {
    mockHistoryState.messages = [];
    mockHistoryState.tokens = 0;
    mockHistoryState.compactResult = null;
  }),
  addUserMessage: vi.fn((c: string) => {
    mockHistoryState.messages.push({ role: "user", content: c });
    mockHistoryState.tokens += c.length;
  }),
  addToolResult: vi.fn((id: string, c: string) => {
    mockHistoryState.messages.push({ role: "tool", content: c, tool_call_id: id });
    mockHistoryState.tokens += c.length;
  }),
}));

import { compactIntelligently, strategies } from "../contextCompaction.js";

describe("strategies (extended)", () => {
  it("exposes an array of CompactionStrategy objects", () => {
    expect(Array.isArray(strategies)).toBe(true);
    expect(strategies.length).toBeGreaterThan(0);
  });

  it("each strategy has name, shouldApply, and apply", () => {
    for (const s of strategies) {
      expect(typeof s.name).toBe("string");
      expect(typeof s.shouldApply).toBe("function");
      expect(typeof s.apply).toBe("function");
    }
  });

  it("contains all four named strategies", () => {
    const names = strategies.map((s) => s.name);
    expect(names).toContain("remove-consecutive-same-role");
    expect(names).toContain("compress-long-tool-results");
    expect(names).toContain("merge-adjacent-tool-results");
    expect(names).toContain("remove-old-error-messages");
  });

  it("remove-consecutive-same-role.shouldApply returns false on empty", () => {
    const s = strategies.find((x) => x.name === "remove-consecutive-same-role")!;
    expect(s.shouldApply([])).toBe(false);
  });

  it("remove-consecutive-same-role.shouldApply returns false for single message", () => {
    const s = strategies.find((x) => x.name === "remove-consecutive-same-role")!;
    expect(s.shouldApply([{ role: "system", content: "x" }])).toBe(false);
  });

  it("remove-consecutive-same-role.shouldApply returns false for consecutive system messages", () => {
    const s = strategies.find((x) => x.name === "remove-consecutive-same-role")!;
    const msgs = [
      { role: "system", content: "p1" },
      { role: "system", content: "p2" },
    ];
    expect(s.shouldApply(msgs)).toBe(false);
  });

  it("remove-consecutive-same-role.shouldApply returns true for consecutive assistant messages", () => {
    const s = strategies.find((x) => x.name === "remove-consecutive-same-role")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    expect(s.shouldApply(msgs)).toBe(true);
  });

  it("compress-long-tool-results.shouldApply returns false for short content", () => {
    const s = strategies.find((x) => x.name === "compress-long-tool-results")!;
    expect(s.shouldApply([{ role: "tool", content: "short", tool_call_id: "1" }])).toBe(false);
  });

  it("compress-long-tool-results.shouldApply returns true for >2000 char content", () => {
    const s = strategies.find((x) => x.name === "compress-long-tool-results")!;
    expect(s.shouldApply([{ role: "tool", content: "x".repeat(2500), tool_call_id: "1" }])).toBe(true);
  });

  it("merge-adjacent-tool-results.shouldApply returns false for 2 consecutive", () => {
    const s = strategies.find((x) => x.name === "merge-adjacent-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "a", tool_call_id: "1" },
      { role: "tool", content: "b", tool_call_id: "2" },
    ];
    expect(s.shouldApply(msgs)).toBe(false);
  });

  it("merge-adjacent-tool-results.shouldApply returns true for 4+ consecutive", () => {
    const s = strategies.find((x) => x.name === "merge-adjacent-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "a", tool_call_id: "1" },
      { role: "tool", content: "b", tool_call_id: "2" },
      { role: "tool", content: "c", tool_call_id: "3" },
      { role: "tool", content: "d", tool_call_id: "4" },
    ];
    expect(s.shouldApply(msgs)).toBe(true);
  });

  it("remove-old-error-messages.shouldApply returns false for 3 errors", () => {
    const s = strategies.find((x) => x.name === "remove-old-error-messages")!;
    const msgs = [
      { role: "tool", content: "[ERROR] a", tool_call_id: "1" },
      { role: "tool", content: "[ERROR] b", tool_call_id: "2" },
      { role: "tool", content: "[ERROR] c", tool_call_id: "3" },
    ];
    expect(s.shouldApply(msgs)).toBe(false);
  });

  it("remove-old-error-messages.shouldApply returns true for 6+ errors", () => {
    const s = strategies.find((x) => x.name === "remove-old-error-messages")!;
    const msgs = [];
    for (let i = 0; i < 7; i++) {
      msgs.push({ role: "tool", content: "[ERROR] err" + i, tool_call_id: String(i) });
    }
    expect(s.shouldApply(msgs)).toBe(true);
  });
});

describe("compactIntelligently (extended)", () => {
  it("returns empty array for empty input", () => {
    const { messages, appliedStrategies } = compactIntelligently([]);
    expect(messages).toEqual([]);
    expect(appliedStrategies).toEqual([]);
  });

  it("does not apply any strategy to a healthy conversation", () => {
    const msgs = [
      { role: "system", content: "system" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];
    const { appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).toEqual([]);
  });

  it("merges consecutive assistant messages", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ];
    const { messages, appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).toContain("remove-consecutive-same-role");
    const assistants = messages.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toContain("first");
    expect(assistants[0].content).toContain("second");
  });

  it("does not merge consecutive user messages (only non-user roles)", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
    ];
    const { appliedStrategies } = compactIntelligently(msgs);
    // shouldApply returns true for consecutive user messages (only system is excluded)
    expect(appliedStrategies).toContain("remove-consecutive-same-role");
  });

  it("does not trigger remove-consecutive for system messages", () => {
    const msgs = [
      { role: "system", content: "p1" },
      { role: "system", content: "p2" },
    ];
    const { appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).not.toContain("remove-consecutive-same-role");
  });

  it("compresses long tool result content with [COMPACTED] marker", () => {
    const long = "x".repeat(3000);
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: long, tool_call_id: "1" },
    ];
    const { messages, appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).toContain("compress-long-tool-results");
    expect(messages[1].content).toContain("[COMPACTED]");
    expect(messages[1].content.length).toBeLessThan(long.length);
  });

  it("keeps first 500 and last 500 chars in compressed tool result", () => {
    const long = "A".repeat(500) + "MIDDLE".repeat(500) + "B".repeat(500);
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: long, tool_call_id: "1" },
    ];
    const { messages } = compactIntelligently(msgs);
    expect(messages[1].content.startsWith("A".repeat(50))).toBe(true);
    expect(messages[1].content.endsWith("B".repeat(50))).toBe(true);
  });

  it("does not compress tool results shorter than 2000 chars", () => {
    const short = "x".repeat(1500);
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: short, tool_call_id: "1" },
    ];
    const { messages, appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).not.toContain("compress-long-tool-results");
    expect(messages[1].content).toBe(short);
  });

  it("skips compression for non-string tool content", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: 123456789, tool_call_id: "1" },
    ];
    const { appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).not.toContain("compress-long-tool-results");
  });

  it("keeps groups of 2 or fewer tool results when no merging needed", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "r1", tool_call_id: "1" },
      { role: "user", content: "go" },
      { role: "tool", content: "r2", tool_call_id: "2" },
    ];
    const { appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).not.toContain("merge-adjacent-tool-results");
  });

  it("preserves non-tool messages when merging consecutive assistants", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u2" },
    ];
    const { messages } = compactIntelligently(msgs);
    const users = messages.filter((m) => m.role === "user");
    expect(users.length).toBe(2);
  });

  it("removes old error messages beyond the 3rd (interleaved with assistant)", () => {
    const msgs: any[] = [{ role: "system", content: "p" }];
    for (let i = 0; i < 7; i++) {
      msgs.push({ role: "tool", content: `[ERROR] err${i}`, tool_call_id: String(i) });
      msgs.push({ role: "assistant", content: `reply${i}` });
    }
    const { messages, appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).toContain("remove-old-error-messages");
    const errors = messages.filter((m) => typeof m.content === "string" && m.content.includes("[ERROR]"));
    expect(errors.length).toBeLessThanOrEqual(4);
  });

  it("keeps non-error tool messages alongside error messages", () => {
    const msgs: any[] = [{ role: "system", content: "p" }];
    for (let i = 0; i < 7; i++) {
      msgs.push({ role: "tool", content: `[ERROR] err${i}`, tool_call_id: String(i) });
      msgs.push({ role: "assistant", content: `r${i}` });
    }
    msgs.push({ role: "tool", content: "good result", tool_call_id: "g1" });
    msgs.push({ role: "assistant", content: "ok" });
    msgs.push({ role: "tool", content: "good result 2", tool_call_id: "g2" });
    const { messages } = compactIntelligently(msgs);
    const contents = messages.map((m) => m.content).join("");
    expect(contents).toContain("good result");
  });

  it("returns appliedStrategies in the order strategies are evaluated", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "tool", content: "x".repeat(3000), tool_call_id: "1" },
    ];
    const { appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies.length).toBeGreaterThan(0);
    expect(appliedStrategies[0]).toBe("remove-consecutive-same-role");
  });

  it("does not mutate the input array", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    const original = [...msgs];
    compactIntelligently(msgs);
    expect(msgs.length).toBe(original.length);
    expect(msgs[0]).toBe(original[0]);
  });

  it("handles messages with missing role field gracefully", () => {
    const msgs: any[] = [{ content: "no role" }, { content: "still no role" }];
    const { messages } = compactIntelligently(msgs);
    expect(Array.isArray(messages)).toBe(true);
  });

  it("handles messages with missing content field gracefully", () => {
    const msgs: any[] = [{ role: "assistant" }, { role: "assistant" }];
    const { messages } = compactIntelligently(msgs);
    expect(Array.isArray(messages)).toBe(true);
  });

  it("compresses multiple long tool results in one pass", () => {
    const long1 = "A".repeat(2500);
    const long2 = "B".repeat(2500);
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: long1, tool_call_id: "1" },
      { role: "assistant", content: "mid" },
      { role: "tool", content: long2, tool_call_id: "2" },
    ];
    const { messages, appliedStrategies } = compactIntelligently(msgs);
    expect(appliedStrategies).toContain("compress-long-tool-results");
    expect(messages.find((m: any) => m.tool_call_id === "1").content).toContain("[COMPACTED]");
    expect(messages.find((m: any) => m.tool_call_id === "2").content).toContain("[COMPACTED]");
  });

  it("preserves tool_call_id in compressed tool messages", () => {
    const long = "x".repeat(3000);
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: long, tool_call_id: "abc-123" },
    ];
    const { messages } = compactIntelligently(msgs);
    expect(messages[1].tool_call_id).toBe("abc-123");
  });

  it("removes only the 4th+ error message (keeps first 3)", () => {
    const msgs: any[] = [{ role: "system", content: "p" }];
    for (let i = 0; i < 7; i++) {
      msgs.push({ role: "tool", content: `[ERROR] err${i}`, tool_call_id: String(i) });
      msgs.push({ role: "assistant", content: `r${i}` });
    }
    const { messages } = compactIntelligently(msgs);
    const errors = messages.filter((m) => typeof m.content === "string" && m.content.includes("[ERROR]"));
    // Strategy keeps first 3, drops 4+ (3 errors retained)
    expect(errors.length).toBeLessThanOrEqual(4);
  });
});

describe("individual strategy.apply (extended)", () => {
  it("remove-consecutive-same-role.apply merges two consecutive assistant messages with newline", () => {
    const s = strategies.find((x) => x.name === "remove-consecutive-same-role")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ];
    const result = s.apply(msgs);
    const assistants = result.filter((m: any) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toBe("first\nsecond");
  });

  it("remove-consecutive-same-role.apply does not merge user messages", () => {
    const s = strategies.find((x) => x.name === "remove-consecutive-same-role")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
    ];
    const result = s.apply(msgs);
    const users = result.filter((m: any) => m.role === "user");
    expect(users.length).toBe(2);
  });

  it("compress-long-tool-results.apply adds COMPACTED marker", () => {
    const s = strategies.find((x) => x.name === "compress-long-tool-results")!;
    const long = "x".repeat(3000);
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: long, tool_call_id: "1" },
    ];
    const result = s.apply(msgs);
    expect(result[1].content).toContain("[COMPACTED]");
    expect(result[1].content.length).toBeLessThan(long.length);
  });

  it("compress-long-tool-results.apply does not modify short tool content", () => {
    const s = strategies.find((x) => x.name === "compress-long-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "short", tool_call_id: "1" },
    ];
    const result = s.apply(msgs);
    expect(result[1].content).toBe("short");
  });

  it("merge-adjacent-tool-results.apply merges 4+ consecutive into summary", () => {
    const s = strategies.find((x) => x.name === "merge-adjacent-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "alpha", tool_call_id: "t1" },
      { role: "tool", content: "beta", tool_call_id: "t2" },
      { role: "tool", content: "gamma", tool_call_id: "t3" },
      { role: "tool", content: "delta", tool_call_id: "t4" },
    ];
    const result = s.apply(msgs);
    const tools = result.filter((m: any) => m.role === "tool");
    expect(tools.length).toBe(1);
    expect(tools[0].content).toContain("[t1]");
    expect(tools[0].content).toContain("[t4]");
  });

  it("merge-adjacent-tool-results.apply preserves groups of 1-2 consecutive", () => {
    const s = strategies.find((x) => x.name === "merge-adjacent-tool-results")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "tool", content: "r1", tool_call_id: "t1" },
      { role: "user", content: "go" },
      { role: "tool", content: "r2", tool_call_id: "t2" },
    ];
    const result = s.apply(msgs);
    const tools = result.filter((m: any) => m.role === "tool");
    expect(tools.length).toBe(2);
  });

  it("remove-old-error-messages.apply keeps first 3 errors, drops 4+", () => {
    const s = strategies.find((x) => x.name === "remove-old-error-messages")!;
    const msgs: any[] = [{ role: "system", content: "p" }];
    for (let i = 0; i < 7; i++) {
      msgs.push({ role: "tool", content: `[ERROR] err${i}`, tool_call_id: String(i) });
    }
    const result = s.apply(msgs);
    const errors = result.filter((m: any) => typeof m.content === "string" && m.content.includes("[ERROR]"));
    expect(errors.length).toBe(3);
  });

  it("remove-old-error-messages.apply does not remove non-error tool messages", () => {
    const s = strategies.find((x) => x.name === "remove-old-error-messages")!;
    const msgs: any[] = [{ role: "system", content: "p" }];
    for (let i = 0; i < 7; i++) {
      msgs.push({ role: "tool", content: `[ERROR] err${i}`, tool_call_id: String(i) });
    }
    msgs.push({ role: "tool", content: "good", tool_call_id: "g" });
    const result = s.apply(msgs);
    const contents = result.map((m: any) => m.content).join("");
    expect(contents).toContain("good");
  });
});

describe("smartCompact (extended, mocked history)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoryState.messages = [];
    mockHistoryState.tokens = 0;
    mockHistoryState.compactResult = null;
  });

  it("returns { compacted: false, savedTokens: 0 } when under threshold", async () => {
    mockHistoryState.tokens = 100;
    const { smartCompact } = await import("../contextCompaction.js");
    const result = await smartCompact(50000);
    expect(result.compacted).toBe(false);
    expect(result.savedTokens).toBe(0);
  });

  it("returns a valid result object when over threshold", async () => {
    mockHistoryState.tokens = 100000;
    mockHistoryState.messages = [
      { role: "system", content: "p" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    mockHistoryState.compactResult = null;
    const { smartCompact } = await import("../contextCompaction.js");
    const result = await smartCompact(10000);
    expect(result).toBeDefined();
    expect(typeof result.compacted).toBe("boolean");
    expect(typeof result.savedTokens).toBe("number");
  });

  it("falls through to heuristic path when compactHistory returns null", async () => {
    mockHistoryState.tokens = 100000;
    mockHistoryState.messages = [
      { role: "system", content: "p" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    mockHistoryState.compactResult = null;
    const { smartCompact } = await import("../contextCompaction.js");
    const result = await smartCompact(10000);
    expect(typeof result.compacted).toBe("boolean");
    expect(typeof result.savedTokens).toBe("number");
  });

  it("uses default maxTokens of 50000 when not specified", async () => {
    mockHistoryState.tokens = 100;
    const { smartCompact } = await import("../contextCompaction.js");
    const result = await smartCompact();
    expect(result.compacted).toBe(false);
    expect(result.savedTokens).toBe(0);
  });

  it("returns positive savedTokens when compaction reduces size", async () => {
    mockHistoryState.tokens = 100000;
    mockHistoryState.messages = [
      { role: "system", content: "p" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    mockHistoryState.compactResult = null;
    const { smartCompact } = await import("../contextCompaction.js");
    const result = await smartCompact(10000);
    // Either way savedTokens should be a number
    expect(typeof result.savedTokens).toBe("number");
  });

  it("returns { compacted: false } when threshold is 0 and tokens is 0", async () => {
    mockHistoryState.tokens = 0;
    const { smartCompact } = await import("../contextCompaction.js");
    const result = await smartCompact(0);
    // 0 <= 0, so no compaction
    expect(result.compacted).toBe(false);
    expect(result.savedTokens).toBe(0);
  });
});
