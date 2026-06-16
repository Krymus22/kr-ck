/**
 * streaming.test.ts — Tests for streaming improvements module.
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

describe("TokenCounter", () => {
  it("should track prompt tokens", () => {
    const counter = new TokenCounter();
    counter.addPrompt(100);
    counter.addPrompt(50);
    expect(counter.getPromptTokens()).toBe(150);
  });

  it("should track completion tokens", () => {
    const counter = new TokenCounter();
    counter.addCompletion(200);
    expect(counter.getCompletionTokens()).toBe(200);
  });

  it("should calculate total", () => {
    const counter = new TokenCounter();
    counter.addPrompt(100);
    counter.addCompletion(200);
    expect(counter.getTotalTokens()).toBe(300);
  });

  it("should reset", () => {
    const counter = new TokenCounter();
    counter.addPrompt(100);
    counter.reset();
    expect(counter.getTotalTokens()).toBe(0);
  });

  it("should return stats object", () => {
    const counter = new TokenCounter();
    counter.addPrompt(100);
    counter.addCompletion(50);
    const stats = counter.getStats();
    expect(stats.prompt).toBe(100);
    expect(stats.completion).toBe(50);
    expect(stats.total).toBe(150);
  });
});

describe("BufferedStreamProcessor", () => {
  it("should buffer and flush on threshold", () => {
    const flushed: string[] = [];
    const processor = new BufferedStreamProcessor((chunk) => flushed.push(chunk), 5);

    processor.push("ab");
    processor.push("cd");
    processor.push("e"); // triggers flush at 5 chars
    processor.flush();

    expect(flushed.join("")).toBe("abcde");
  });

  it("should force flush remaining buffer", () => {
    const flushed: string[] = [];
    const processor = new BufferedStreamProcessor((chunk) => flushed.push(chunk), 100);

    processor.push("hello");
    const remaining = processor.forceFlush();

    expect(remaining).toBe("hello");
    expect(flushed.length).toBe(0);
  });

  it("should handle empty buffer", () => {
    const processor = new BufferedStreamProcessor(() => {}, 10);
    const remaining = processor.forceFlush();
    expect(remaining).toBe("");
  });

  it("isFlushed should return false before and after flush", () => {
    const processor = new BufferedStreamProcessor(() => {}, 10);
    expect(processor.isFlushed()).toBe(false);
    processor.push("abc");
    processor.flush();
    expect(processor.isFlushed()).toBe(false);
  });
});

describe("StreamThrottle", () => {
  it("should allow emission after interval", async () => {
    const throttle = new StreamThrottle(50);
    expect(throttle.shouldEmit()).toBe(true);
    expect(throttle.shouldEmit()).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(throttle.shouldEmit()).toBe(true);
  });

  it("should reset", () => {
    const throttle = new StreamThrottle(100000);
    expect(throttle.shouldEmit()).toBe(true);
    expect(throttle.shouldEmit()).toBe(false);
    throttle.reset();
    expect(throttle.shouldEmit()).toBe(true);
  });
});

describe("estimateTokenCount", () => {
  it("should estimate tokens for English text", () => {
    const tokens = estimateTokenCount("hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("should handle empty string", () => {
    const tokens = estimateTokenCount("");
    expect(tokens).toBe(0);
  });

  it("should handle longer text", () => {
    const text = "a".repeat(1000);
    const tokens = estimateTokenCount(text);
    expect(tokens).toBeGreaterThan(200);
  });
});

describe("truncateToTokenLimit", () => {
  it("should not truncate if under limit", () => {
    const text = "short";
    const result = truncateToTokenLimit(text, 1000);
    expect(result).toBe(text);
  });

  it("should truncate if over limit", () => {
    const text = "a".repeat(10000);
    const result = truncateToTokenLimit(text, 10);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain("TRUNCATED");
  });
});

describe("StreamingMetrics", () => {
  it("should track TTFT", () => {
    const metrics = new StreamingMetrics();
    metrics.start();
    metrics.onFirstToken();
    expect(metrics.getTTFT()).toBeGreaterThanOrEqual(0);
  });

  it("should calculate TPS", () => {
    const metrics = new StreamingMetrics();
    metrics.start();
    metrics.onFirstToken();
    for (let i = 0; i < 10; i++) metrics.onToken();
    const tps = metrics.getTokensPerSecond();
    expect(typeof tps).toBe("number");
  });

  it("should return metrics object", () => {
    const metrics = new StreamingMetrics();
    metrics.start();
    metrics.onFirstToken();
    metrics.onToken();
    const m = metrics.getMetrics();
    expect(m.ttft).toBeGreaterThanOrEqual(0);
    expect(m.totalTokens).toBe(1);
  });

  it("should return 0 for TTFT when onFirstToken not called", () => {
    const metrics = new StreamingMetrics();
    metrics.start();
    expect(metrics.getTTFT()).toBe(0);
  });

  it("should handle TPS with tokens recorded in same millisecond", () => {
    const metrics = new StreamingMetrics();
    metrics.start();
    metrics.onFirstToken();
    for (let i = 0; i < 5; i++) metrics.onToken();
    const tps = metrics.getTokensPerSecond();
    expect(typeof tps).toBe("number");
  });

  it("should return 0 TPS when only one token recorded", () => {
    const metrics = new StreamingMetrics();
    metrics.start();
    metrics.onFirstToken();
    metrics.onToken();
    expect(metrics.getTokensPerSecond()).toBe(0);
  });

  it("should return 0 TPS when no tokens recorded", () => {
    const metrics = new StreamingMetrics();
    metrics.start();
    metrics.onFirstToken();
    expect(metrics.getTokensPerSecond()).toBe(0);
  });
});
