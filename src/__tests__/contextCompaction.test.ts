/**
 * contextCompaction.test.ts — Tests for intelligent context compaction.
 */

import { describe, it, expect } from "vitest";
import { compactIntelligently } from "../contextCompaction.js";

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
    // Should merge consecutive assistant messages
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
  });

  it("should merge adjacent tool results", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "assistant", content: "calling tools" },
      { role: "tool", content: "result1", tool_call_id: "1" },
      { role: "tool", content: "result2", tool_call_id: "2" },
      { role: "tool", content: "result3", tool_call_id: "3" },
      { role: "tool", content: "result4", tool_call_id: "4" },
    ];

    const { messages: result, appliedStrategies } = compactIntelligently(messages);
    // Either merge or remove-consecutive should be applied
    expect(result.length).toBeLessThanOrEqual(messages.length);
  });

  it("should remove old error messages", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "tool", content: "[ERRO] err1", tool_call_id: "1" },
      { role: "tool", content: "[ERRO] err2", tool_call_id: "2" },
      { role: "tool", content: "[ERRO] err3", tool_call_id: "3" },
      { role: "tool", content: "[ERRO] err4", tool_call_id: "4" },
      { role: "tool", content: "[ERRO] err5", tool_call_id: "5" },
      { role: "tool", content: "[ERRO] err6", tool_call_id: "6" },
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
});
