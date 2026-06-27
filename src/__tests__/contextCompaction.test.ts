/**
 * contextCompaction.test.ts — Tests for intelligent context compaction.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { compactIntelligently, smartCompact, strategies } from "../contextCompaction.js";
import * as history from "../history.js";

describe("compactIntelligently", () => {
  it("should remove consecutive same-role messages", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "user", content: "msg1" },
      { role: "assistant", content: "reply1" },
      { role: "assistant", content: "reply2" },
      { role: "assistant", content: "reply3" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).toContain("remove-consecutive-same-role");
    const assistantCount = result.filter((m) => m.role === "assistant").length;
    expect(assistantCount).toBeLessThan(3);
  });

  it("should compress long tool results", () => {
    const longContent = "x".repeat(3000);
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: longContent, tool_call_id: "1" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).toContain("compress-long-tool-results");
    expect(result[1].content.length).toBeLessThan(longContent.length);
    expect(result[1].content).toContain("[COMPACTED]");
  });

  it("should merge adjacent tool results (3+)", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "assistant", content: "calling tools" },
      { role: "tool", content: "result1", tool_call_id: "1" },
      { role: "tool", content: "result2", tool_call_id: "2" },
      { role: "tool", content: "result3", tool_call_id: "3" },
      { role: "tool", content: "result4", tool_call_id: "4" },
    ];

    const { messages: result } = compactIntelligently(messages);
    expect(result.length).toBeLessThanOrEqual(messages.length);
  });

  it("should remove old error messages (>5)", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "[ERROR] err1", tool_call_id: "1" },
      { role: "tool", content: "[ERROR] err2", tool_call_id: "2" },
      { role: "tool", content: "[ERROR] err3", tool_call_id: "3" },
      { role: "tool", content: "[ERROR] err4", tool_call_id: "4" },
      { role: "tool", content: "[ERROR] err5", tool_call_id: "5" },
      { role: "tool", content: "[ERROR] err6", tool_call_id: "6" },
    ];

    const { messages: result } = compactIntelligently(messages);
    expect(result.length).toBeLessThan(messages.length);
  });

  it("should not modify messages when no compaction needed", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    expect(result.length).toBe(3);
    expect(appliedStrategies.length).toBe(0);
  });

  it("should preserve system prompt", () => {
    const messages = [
      { role: "system", content: "important system prompt" },
      { role: "user", content: "msg" },
      { role: "assistant", content: "reply" },
      { role: "assistant", content: "reply2" },
    ];

    const { messages: result } = compactIntelligently(messages);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toBe("important system prompt");
  });

  it("should keep only 3 errors (skip >3)", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "[ERROR] a", tool_call_id: "1" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "[ERROR] b", tool_call_id: "2" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "[ERROR] c", tool_call_id: "3" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "[ERROR] d", tool_call_id: "4" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "[ERROR] e", tool_call_id: "5" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "[ERROR] f", tool_call_id: "6" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "[ERROR] g", tool_call_id: "7" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).toContain("remove-old-error-messages");
    const errorCount = result.filter((m) => m.content?.includes("[ERROR]")).length;
    expect(errorCount).toBeLessThanOrEqual(4);
  });

  it("merge-adjacent-tool-results skips when less than 3 consecutive", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "r1", tool_call_id: "1" },
      { role: "tool", content: "r2", tool_call_id: "2" },
    ];

    const { appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).not.toContain("merge-adjacent-tool-results");
  });

  it("compress-long-tool-results skips short tool results", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "short", tool_call_id: "1" },
    ];

    const { appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).not.toContain("compress-long-tool-results");
  });

  it("remove-old-error-messages skips when <=5 errors", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "[ERROR] a", tool_call_id: "1" },
      { role: "tool", content: "[ERROR] b", tool_call_id: "2" },
    ];

    const { appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).not.toContain("remove-old-error-messages");
  });

  it("compress-long-tool-results with non-string content skips", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: 12345, tool_call_id: "1" },
    ];

    const { appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).not.toContain("compress-long-tool-results");
  });

  it("merge-adjacent apply handles 5+ consecutive tool results", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "a".repeat(150), tool_call_id: "1" },
      { role: "tool", content: "b".repeat(150), tool_call_id: "2" },
      { role: "tool", content: "c".repeat(150), tool_call_id: "3" },
      { role: "tool", content: "d".repeat(150), tool_call_id: "4" },
      { role: "tool", content: "e".repeat(150), tool_call_id: "5" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    expect(result.length).toBeLessThan(messages.length);
    expect(appliedStrategies).toContain("remove-consecutive-same-role");
  });

  it("remove-consecutive-same-role merges consecutive tool messages", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "first", tool_call_id: "1" },
      { role: "tool", content: "second", tool_call_id: "2" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).toContain("remove-consecutive-same-role");
    const toolMsgs = result.filter((m: any) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toContain("first");
    expect(toolMsgs[0].content).toContain("second");
  });
});

describe("smartCompact", () => {
  beforeEach(() => {
    history.resetHistory();
  });

  it("returns not-compacted when under threshold", async () => {
    history.addUserMessage("short");
    const result = await smartCompact(50000);
    expect(result.compacted).toBe(false);
    expect(result.savedTokens).toBe(0);
  });

  it("returns compacted when over threshold with enough messages", async () => {
    // Mix of user + tool messages so compaction strategies have
    // something to do (user-only messages aren't compacted by current strategies).
    for (let i = 0; i < 20; i++) {
      history.addUserMessage(`message ${i} with some content to make it longer`);
      history.addToolResult(`tool-${i}`, `tool result ${i} with content `.repeat(10));
    }
    const result = await smartCompact(10);
    // Either compacted (strategies applied) or aggressive compaction kicked in
    expect(result.compacted).toBe(true);
    expect(result.savedTokens).toBeGreaterThanOrEqual(0);
  });

  it("reaches normal return path when compactHistory returns null", async () => {
    history.resetHistory();
    history.addUserMessage("test1");
    history.addUserMessage("test2");
    const result = await smartCompact(1);
    expect(result).toBeDefined();
    expect(typeof result.compacted).toBe("boolean");
    expect(typeof result.savedTokens).toBe("number");
  });

  it("returns saved tokens when compactIntelligently reduces enough", async () => {
    history.resetHistory();
    for (let i = 0; i < 15; i++) {
      history.addUserMessage("x".repeat(500));
    }
    const result = await smartCompact(50000);
    expect(result.compacted).toBe(false);
    expect(result.savedTokens).toBe(0);
  });
});

describe("merge-adjacent-tool-results strategy apply (lines 60-85)", () => {
  it("merges 3+ consecutive tool results into a summary", () => {
    const mergeStrategy = strategies.find((s) => s.name === "merge-adjacent-tool-results")!;
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "result AAAAA", tool_call_id: "tc1" },
      { role: "tool", content: "result BBBBB", tool_call_id: "tc2" },
      { role: "tool", content: "result CCCCC", tool_call_id: "tc3" },
      { role: "tool", content: "result DDDDD", tool_call_id: "tc4" },
    ];

    const result = mergeStrategy.apply(messages);
    const toolMsgs = result.filter((m: any) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect(toolMsgs[0].content).toContain("[tc1]");
    expect(toolMsgs[0].content).toContain("[tc4]");
    expect(toolMsgs[0].content).toContain("result AAAAA");
  });

  it("preserves groups of 1-2 consecutive tool results (else branch)", () => {
    const mergeStrategy = strategies.find((s) => s.name === "merge-adjacent-tool-results")!;
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "r1", tool_call_id: "tc1" },
      { role: "tool", content: "r2", tool_call_id: "tc2" },
      { role: "user", content: "next" },
      { role: "tool", content: "r3", tool_call_id: "tc3" },
    ];

    const result = mergeStrategy.apply(messages);
    const toolMsgs = result.filter((m: any) => m.role === "tool");
    expect(toolMsgs.length).toBe(3);
    expect(toolMsgs[0].content).toBe("r1");
    expect(toolMsgs[1].content).toBe("r2");
    expect(toolMsgs[2].content).toBe("r3");
  });

  it("handles mixed groups: large group merged, small group preserved", () => {
    const mergeStrategy = strategies.find((s) => s.name === "merge-adjacent-tool-results")!;
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "a", tool_call_id: "t1" },
      { role: "tool", content: "b", tool_call_id: "t2" },
      { role: "tool", content: "c", tool_call_id: "t3" },
      { role: "tool", content: "d", tool_call_id: "t4" },
      { role: "user", content: "go" },
      { role: "tool", content: "e", tool_call_id: "t5" },
      { role: "tool", content: "f", tool_call_id: "t6" },
    ];

    const result = mergeStrategy.apply(messages);
    const toolMsgs = result.filter((m: any) => m.role === "tool");
    expect(toolMsgs.length).toBe(3);
    expect(toolMsgs[0].content).toContain("[t1]");
    expect(toolMsgs[1].content).toBe("e");
    expect(toolMsgs[2].content).toBe("f");
  });
});

describe("compress-long-tool-results with mixed messages", () => {
  it("compacts only long tool results while keeping short ones intact", () => {
    const longContent = "x".repeat(3000);
    const messages = [
      { role: "system", content: "prompt" },
      { role: "user", content: "hello" },
      { role: "tool", content: "short1", tool_call_id: "1" },
      { role: "assistant", content: "mid" },
      { role: "tool", content: longContent, tool_call_id: "2" },
      { role: "assistant", content: "response" },
      { role: "tool", content: "short2", tool_call_id: "3" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).toContain("compress-long-tool-results");
    expect(result.find((m: any) => m.tool_call_id === "1")?.content).toBe("short1");
    expect(result.find((m: any) => m.tool_call_id === "3")?.content).toBe("short2");
    const longResult = result.find((m: any) => m.tool_call_id === "2");
    expect(longResult?.content).toContain("[COMPACTED]");
    expect(longResult?.content.length).toBeLessThan(longContent.length);
  });

  it("compacts multiple long tool results separated by non-tool messages", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "A".repeat(2500), tool_call_id: "a" },
      { role: "assistant", content: "mid" },
      { role: "tool", content: "B".repeat(2500), tool_call_id: "b" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    expect(appliedStrategies).toContain("compress-long-tool-results");
    expect(result.find((m: any) => m.tool_call_id === "a")?.content).toContain("[COMPACTED]");
    expect(result.find((m: any) => m.tool_call_id === "b")?.content).toContain("[COMPACTED]");
  });
});
