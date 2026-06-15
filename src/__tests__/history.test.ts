import { describe, it, expect, beforeEach } from "vitest";
import {
  isPlanMode,
  setPlanMode,
  getCavemanLevel,
  setCavemanLevel,
  addUserMessage,
  getHistory,
  historyLength,
  resetHistory,
  compactHistory,
  historySummary,
  estimateTokens,
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
    // Add enough messages to trigger compaction
    for (let i = 0; i < 15; i++) {
      addUserMessage(`message ${i}`);
    }
    const beforeCount = historyLength();
    const result = compactHistory();
    expect(result).not.toBeNull();
    expect(result!.removed).toBeGreaterThan(0);
    // After compaction, history should have fewer messages
    expect(historyLength()).toBeLessThan(beforeCount);
  });
});
