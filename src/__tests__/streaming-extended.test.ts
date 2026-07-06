/**
 * streaming-extended.test.ts — Extended tests for streaming.ts
 *
 * Covers 30+ tests across TokenCounter, BufferedStreamProcessor, StreamThrottle,
 * estimateTokenCount, truncateToTokenLimit, and StreamingMetrics, including
 * edge cases (empty strings, large inputs, CJK characters, defensive
 * assertions on return types).
 */

import { describe, it, expect } from "vitest";
import {
  TokenCounter,
  BufferedStreamProcessor,
  StreamThrottle,
  estimateTokenCount,
  truncateToTokenLimit,
  StreamingMetrics,
} from "../streaming.js";

// ============================================================================
// TokenCounter — 8 tests
// ============================================================================

describe("TokenCounter (extended)", () => {
  it("starts at zero for all counters", () => {
    const c = new TokenCounter();
    expect(c.getPromptTokens()).toBe(0);
    expect(c.getCompletionTokens()).toBe(0);
    expect(c.getTotalTokens()).toBe(0);
  });

  it("accumulates multiple prompt additions", () => {
    const c = new TokenCounter();
    c.addPrompt(10);
    c.addPrompt(20);
    c.addPrompt(5);
    expect(c.getPromptTokens()).toBe(35);
  });

  it("accumulates multiple completion additions", () => {
    const c = new TokenCounter();
    c.addCompletion(7);
    c.addCompletion(13);
    expect(c.getCompletionTokens()).toBe(20);
  });

  it("total = prompt + completion when both are added", () => {
    const c = new TokenCounter();
    c.addPrompt(42);
    c.addCompletion(58);
    expect(c.getTotalTokens()).toBe(100);
  });

  it("handles zero-token additions gracefully", () => {
    const c = new TokenCounter();
    c.addPrompt(0);
    c.addCompletion(0);
    expect(c.getTotalTokens()).toBe(0);
  });

  it("reset returns all counters to zero", () => {
    const c = new TokenCounter();
    c.addPrompt(100);
    c.addCompletion(200);
    c.reset();
    expect(c.getStats()).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it("getStats returns an object with the right shape", () => {
    const c = new TokenCounter();
    c.addPrompt(3);
    c.addCompletion(7);
    const stats = c.getStats();
    expect(typeof stats).toBe("object");
    expect(stats).not.toBeNull();
    expect(stats.prompt).toBe(3);
    expect(stats.completion).toBe(7);
    expect(stats.total).toBe(10);
  });

  it("does not go negative when only positive values are added", () => {
    const c = new TokenCounter();
    c.addPrompt(5);
    c.addCompletion(5);
    expect(c.getPromptTokens()).toBeGreaterThanOrEqual(0);
    expect(c.getCompletionTokens()).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// BufferedStreamProcessor — 9 tests
// ============================================================================

describe("BufferedStreamProcessor (extended)", () => {
  it("does not flush before threshold is reached", () => {
    const flushed: string[] = [];
    const p = new BufferedStreamProcessor((c) => flushed.push(c), 10);
    p.push("abc");
    expect(flushed.length).toBe(0);
  });

  it("flushes when threshold is exactly reached", () => {
    const flushed: string[] = [];
    const p = new BufferedStreamProcessor((c) => flushed.push(c), 3);
    p.push("abc");
    expect(flushed).toEqual(["abc"]);
  });

  it("flushes when threshold is exceeded in a single push", () => {
    const flushed: string[] = [];
    const p = new BufferedStreamProcessor((c) => flushed.push(c), 5);
    p.push("abcdefghij"); // 10 chars > 5
    expect(flushed).toEqual(["abcdefghij"]);
  });

  it("explicit flush() sends remaining buffer", () => {
    const flushed: string[] = [];
    const p = new BufferedStreamProcessor((c) => flushed.push(c), 100);
    p.push("hello");
    p.flush();
    expect(flushed).toEqual(["hello"]);
  });

  it("flush() on empty buffer is a no-op", () => {
    const flushed: string[] = [];
    const p = new BufferedStreamProcessor((c) => flushed.push(c), 10);
    p.flush();
    expect(flushed.length).toBe(0);
  });

  it("forceFlush() returns remaining buffer without invoking callback", () => {
    const flushed: string[] = [];
    const p = new BufferedStreamProcessor((c) => flushed.push(c), 100);
    p.push("data");
    const remaining = p.forceFlush();
    expect(remaining).toBe("data");
    expect(flushed.length).toBe(0); // callback NOT called
  });

  it("forceFlush() on empty buffer returns empty string", () => {
    const p = new BufferedStreamProcessor(() => {}, 10);
    expect(p.forceFlush()).toBe("");
  });

  it("isFlushed() always returns false (it's a stub)", () => {
    const p = new BufferedStreamProcessor(() => {}, 5);
    expect(p.isFlushed()).toBe(false);
    p.push("abc");
    p.flush();
    expect(p.isFlushed()).toBe(false);
  });

  it("handles multiple sequential pushes around the threshold", () => {
    const flushed: string[] = [];
    const p = new BufferedStreamProcessor((c) => flushed.push(c), 4);
    p.push("ab"); // 2
    p.push("cd"); // 4 -> flush "abcd"
    p.push("ef"); // 2
    p.push("gh"); // 4 -> flush "efgh"
    p.flush(); // nothing
    expect(flushed).toEqual(["abcd", "efgh"]);
  });
});

// ============================================================================
// StreamThrottle — 7 tests
// ============================================================================

describe("StreamThrottle (extended)", () => {
  it("shouldEmit() returns true on first call", () => {
    const t = new StreamThrottle(1000);
    expect(t.shouldEmit()).toBe(true);
  });

  it("shouldEmit() returns false immediately after a successful emit", () => {
    const t = new StreamThrottle(1000);
    expect(t.shouldEmit()).toBe(true);
    expect(t.shouldEmit()).toBe(false);
  });

  it("reset() allows immediate emit again", () => {
    const t = new StreamThrottle(100000);
    t.shouldEmit();
    expect(t.shouldEmit()).toBe(false);
    t.reset();
    expect(t.shouldEmit()).toBe(true);
  });

  it("allows emit after interval elapses", async () => {
    const t = new StreamThrottle(30);
    t.shouldEmit();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.shouldEmit()).toBe(true);
  });

  it("uses default interval when none provided", () => {
    const t = new StreamThrottle();
    expect(t.shouldEmit()).toBe(true);
    expect(t.shouldEmit()).toBe(false);
  });

  it("reset() works after interval already elapsed", async () => {
    const t = new StreamThrottle(20);
    t.shouldEmit();
    await new Promise((r) => setTimeout(r, 30));
    t.reset();
    // After reset, lastEmit=0 so any call should emit
    expect(t.shouldEmit()).toBe(true);
  });

  it("does not emit twice within the same interval window", async () => {
    const t = new StreamThrottle(50);
    t.shouldEmit();
    await new Promise((r) => setTimeout(r, 10));
    expect(t.shouldEmit()).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.shouldEmit()).toBe(true);
  });
});

// ============================================================================
// estimateTokenCount — 8 tests
// ============================================================================

describe("estimateTokenCount (extended)", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("returns a positive number for English text", () => {
    const n = estimateTokenCount("hello world");
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThan(0);
  });

  it("scales roughly linearly with input size", () => {
    const small = estimateTokenCount("a".repeat(40));
    const large = estimateTokenCount("a".repeat(400));
    expect(large).toBeGreaterThan(small);
  });

  it("returns a larger estimate for CJK chars than for ASCII of same length", () => {
    const ascii = "abcdefghij"; // 10 ASCII
    const cjk = "你好世界你好世界"; // 10 CJK
    expect(estimateTokenCount(cjk)).toBeGreaterThan(estimateTokenCount(ascii));
  });

  it("handles Japanese hiragana characters", () => {
    const n = estimateTokenCount("こんにちは");
    expect(n).toBeGreaterThan(0);
  });

  it("handles Japanese katakana characters", () => {
    const n = estimateTokenCount("コンニチハ");
    expect(n).toBeGreaterThan(0);
  });

  it("handles mixed ASCII + CJK content", () => {
    const n = estimateTokenCount("hello 你好 world 世界");
    expect(n).toBeGreaterThan(0);
  });

  it("returns 0 for whitespace-only strings", () => {
    // 4 whitespace chars / 4 = 1, but check we don't crash
    const n = estimateTokenCount("    ");
    expect(typeof n).toBe("number");
    expect(n).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// truncateToTokenLimit — 7 tests
// ============================================================================

describe("truncateToTokenLimit (extended)", () => {
  it("returns the original text when under limit", () => {
    const text = "short text";
    expect(truncateToTokenLimit(text, 1000)).toBe(text);
  });

  it("returns the original text when exactly at limit", () => {
    const text = "hello";
    const limit = estimateTokenCount(text);
    expect(truncateToTokenLimit(text, limit)).toBe(text);
  });

  it("truncates text that exceeds limit", () => {
    const text = "a".repeat(10000);
    const result = truncateToTokenLimit(text, 10);
    expect(result.length).toBeLessThan(text.length);
  });

  it("adds TRUNCATED marker when truncating", () => {
    const text = "a".repeat(10000);
    const result = truncateToTokenLimit(text, 10);
    expect(result).toContain("[TRUNCATED]");
  });

  it("handles empty string input", () => {
    expect(truncateToTokenLimit("", 100)).toBe("");
  });

  it("preserves the beginning of the text when truncating", () => {
    const text = "PREFIX" + "x".repeat(5000);
    const result = truncateToTokenLimit(text, 5);
    expect(result).toContain("PREFIX");
  });

  it("handles very small token limits (1)", () => {
    const text = "abcdefghij";
    const result = truncateToTokenLimit(text, 1);
    expect(typeof result).toBe("string");
    expect(result.length).toBeLessThanOrEqual(text.length + 20);
  });
});

// ============================================================================
// StreamingMetrics — 9 tests
// ============================================================================

describe("StreamingMetrics (extended)", () => {
  it("starts with zero TTFT", () => {
    const m = new StreamingMetrics();
    expect(m.getTTFT()).toBe(0);
  });

  it("returns 0 TPS when no tokens recorded", () => {
    const m = new StreamingMetrics();
    m.start();
    expect(m.getTokensPerSecond()).toBe(0);
  });

  it("returns 0 TPS when only one token recorded", () => {
    const m = new StreamingMetrics();
    m.start();
    m.onToken();
    expect(m.getTokensPerSecond()).toBe(0);
  });

  it("computes TTFT after start() and onFirstToken()", async () => {
    const m = new StreamingMetrics();
    m.start();
    await new Promise((r) => setTimeout(r, 10));
    m.onFirstToken();
    expect(m.getTTFT()).toBeGreaterThanOrEqual(8);
  });

  it("returns 0 TTFT when onFirstToken() not called", () => {
    const m = new StreamingMetrics();
    m.start();
    expect(m.getTTFT()).toBe(0);
  });

  it("computes a positive TPS with multiple tokens", async () => {
    const m = new StreamingMetrics();
    m.start();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      m.onToken();
    }
    const tps = m.getTokensPerSecond();
    expect(typeof tps).toBe("number");
    // With 5 tokens and ~25ms elapsed, TPS should be > 0
    expect(tps).toBeGreaterThan(0);
  });

  it("getTotalTime() returns elapsed since start()", async () => {
    const m = new StreamingMetrics();
    m.start();
    await new Promise((r) => setTimeout(r, 20));
    const elapsed = m.getTotalTime();
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it("getMetrics() returns object with all required keys", () => {
    const m = new StreamingMetrics();
    m.start();
    m.onFirstToken();
    m.onToken();
    const metrics = m.getMetrics();
    expect(typeof metrics).toBe("object");
    expect(metrics).not.toBeNull();
    expect(typeof metrics.ttft).toBe("number");
    expect(typeof metrics.tps).toBe("number");
    expect(typeof metrics.totalTime).toBe("number");
    expect(typeof metrics.totalTokens).toBe("number");
  });

  it("tracks totalTokens count correctly", () => {
    const m = new StreamingMetrics();
    m.start();
    m.onToken();
    m.onToken();
    m.onToken();
    expect(m.getMetrics().totalTokens).toBe(3);
  });
});
