import { describe, it, expect, beforeEach } from "vitest";
import {
  isPlanMode,
  setPlanMode,
  getCavemanLevel,
  setCavemanLevel,
  addUserMessage,
  addRawAssistantMessage,
  addToolResult,
  addSystemMessage,
  getHistory,
  historyLength,
  resetHistory,
  compactHistory,
  historySummary,
  estimateTokens,
  getSystemPrompt,
} from "../history.js";

describe("Plan Mode", () => {
  beforeEach(() => {
    setPlanMode(false);
    resetHistory();
  });

  it("defaults to false", () => {
    expect(isPlanMode()).toBe(false);
  });

  it("toggles on and off", () => {
    setPlanMode(true);
    expect(isPlanMode()).toBe(true);
    setPlanMode(false);
    expect(isPlanMode()).toBe(false);
  });
});

describe("Caveman Level", () => {
  beforeEach(() => {
    setCavemanLevel(null);
    resetHistory();
  });

  it("defaults to null", () => {
    expect(getCavemanLevel()).toBeNull();
  });

  it("sets and gets level", () => {
    setCavemanLevel("ultra");
    expect(getCavemanLevel()).toBe("ultra");
  });

  it("clears level", () => {
    setCavemanLevel("lite");
    setCavemanLevel(null);
    expect(getCavemanLevel()).toBeNull();
  });
});

describe("History", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("starts with system prompt", () => {
    expect(historyLength()).toBe(1);
    expect(getHistory()[0].role).toBe("system");
  });

  it("adds user messages", () => {
    addUserMessage("hello");
    expect(historyLength()).toBe(2);
    expect(getHistory()[1].role).toBe("user");
  });

  it("resets properly", () => {
    addUserMessage("msg1");
    addUserMessage("msg2");
    resetHistory();
    expect(historyLength()).toBe(1);
  });

  it("summary shows role counts", () => {
    addUserMessage("hello");
    const summary = historySummary();
    expect(summary).toContain("system:1");
    expect(summary).toContain("user:1");
  });
});

describe("Token estimation", () => {
  it("returns positive number", () => {
    const tokens = estimateTokens([{ role: "user", content: "hello world" }]);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates proportional to content length", () => {
    const short = estimateTokens([{ role: "user", content: "hi" }]);
    const longContent = "a".repeat(1000);
    const long = estimateTokens([{ role: "user", content: longContent }]);
    expect(long).toBeGreaterThan(short);
  });
});

describe("compactHistory", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns null when history is short", () => {
    addUserMessage("msg");
    const result = compactHistory();
    expect(result).toBeNull();
  });

  it("compacts when history is long", () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`message ${i}`);
    }
    const beforeCount = historyLength();
    const result = compactHistory();
    expect(result).not.toBeNull();
    expect(result!.removed).toBeGreaterThan(0);
    expect(historyLength()).toBeLessThan(beforeCount);
  });
});

describe("History - Extended", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("addRawAssistantMessage stores raw message", () => {
    const msg = { role: "assistant", content: "hi", tool_calls: [] };
    addRawAssistantMessage(msg as any);
    expect(historyLength()).toBe(2);
    expect(getHistory()[1].role).toBe("assistant");
  });

  it("addToolResult stores tool result with call id", () => {
    addUserMessage("test");
    addToolResult("call_123", "result content");
    const h = getHistory();
    expect(h.length).toBe(3);
    expect(h[2].role).toBe("tool");
    expect((h[2] as any).tool_call_id).toBe("call_123");
  });

  it("addSystemMessage adds system message", () => {
    addSystemMessage("injected system msg");
    const h = getHistory();
    expect(h.length).toBe(2);
    expect(h[1].role).toBe("system");
    expect(h[1].content).toBe("injected system msg");
  });

  it("getSystemPrompt includes base prompt", () => {
    const prompt = getHistory()[0].content as string;
    expect(prompt.length).toBeGreaterThan(0);
    expect(typeof prompt).toBe("string");
  });

  it("setCavemanLevel updates existing system prompt", () => {
    addUserMessage("msg"); // triggers ensureHistoryInitialized
    setCavemanLevel("ultra");
    const sysContent = getHistory()[0].content as string;
    expect(sysContent).toContain("CAVEMAN MODE");
    expect(sysContent).toContain("ultra");
  });

  it("estimateTokens counts tool_calls JSON", () => {
    const messages = [
      { role: "assistant", content: "text", tool_calls: [{ id: "1", type: "function", function: { name: "fn", arguments: "{}" } }] }
    ];
    const tokens = estimateTokens(messages as any);
    expect(tokens).toBeGreaterThan(0);
  });

  it("compactHistory drops orphan tool messages", () => {
    addUserMessage("msg0");
    addUserMessage("msg1");
    addUserMessage("msg2");
    addToolResult("orphan_call", "orphan result");
    // Now we have 5 messages: system + user + user + user + tool
    for (let i = 5; i < 15; i++) {
      addUserMessage(`msg${i}`);
    }
    const result = compactHistory();
    expect(result).not.toBeNull();
    // Orphan tool message should be removed
    const h = getHistory();
    const toolMsgs = h.filter(m => m.role === "tool");
    // All orphan tool messages should be cleaned up after compaction
    expect(toolMsgs.length).toBe(0);
  });

  it("historySummary includes all role counts", () => {
    addUserMessage("u1");
    addUserMessage("u2");
    addSystemMessage("sys1");
    const summary = historySummary();
    expect(summary).toContain("system:");
    expect(summary).toContain("user:");
  });

  it("resetHistory clears custom messages", () => {
    addUserMessage("before reset");
    resetHistory();
    expect(historyLength()).toBe(1);
  });
});
