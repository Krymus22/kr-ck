/**
 * streaming.ts - Streaming improvements: token counting, backpressure, buffered streaming.
 */

export class TokenCounter {
  private promptTokens = 0;
  private completionTokens = 0;
  private totalTokens = 0;

  addPrompt(tokens: number): void {
    this.promptTokens += tokens;
    this.totalTokens += tokens;
  }

  addCompletion(tokens: number): void {
    this.completionTokens += tokens;
    this.totalTokens += tokens;
  }

  getPromptTokens(): number { return this.promptTokens; }
  getCompletionTokens(): number { return this.completionTokens; }
  getTotalTokens(): number { return this.totalTokens; }

  reset(): void {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalTokens = 0;
  }

  getStats(): { prompt: number; completion: number; total: number } {
    return {
      prompt: this.promptTokens,
      completion: this.completionTokens,
      total: this.totalTokens,
    };
  }
}

export class BufferedStreamProcessor {
  private buffer = "";
  private readonly flushed = false;
  private readonly flushThreshold: number;
  private readonly onFlush: (chunk: string) => void;

  constructor(onFlush: (chunk: string) => void, flushThreshold: number = 10) {
    this.onFlush = onFlush;
    this.flushThreshold = flushThreshold;
  }

  push(token: string): void {
    this.buffer += token;
    if (this.buffer.length >= this.flushThreshold) {
      this.flush();
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.onFlush(this.buffer);
      this.buffer = "";
    }
  }

  forceFlush(): string {
    const remaining = this.buffer;
    this.buffer = "";
    return remaining;
  }

  isFlushed(): boolean { return this.flushed; }
}

export class StreamThrottle {
  private lastEmit = 0;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs: number = 50) {
    this.minIntervalMs = minIntervalMs;
  }

  shouldEmit(): boolean {
    const now = Date.now();
    if (now - this.lastEmit >= this.minIntervalMs) {
      this.lastEmit = now;
      return true;
    }
    return false;
  }

  reset(): void {
    this.lastEmit = 0;
  }
}

export function estimateTokenCount(text: string): number {
  // Rough estimate: ~4 chars per token for English, ~2 for CJK
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(otherChars / 4) + Math.ceil(cjkChars / 1.5);
}

export function truncateToTokenLimit(text: string, maxTokens: number): string {
  const estimatedTokens = estimateTokenCount(text);
  if (estimatedTokens <= maxTokens) return text;

  // Truncate by character ratio
  const ratio = maxTokens / estimatedTokens;
  const truncated = text.slice(0, Math.floor(text.length * ratio));
  return truncated + "\n...[TRUNCATED]";
}

export class StreamingMetrics {
  private startTime = 0;
  private firstTokenTime = 0;
  /**
   * Bounded sample of token arrival timestamps.
   *
   * MEMORY FIX (Round 4 — memory + perf): previously this was an unbounded
   * `number[]` that grew by one entry per token. A long streaming response
   * (thousands of tokens) held thousands of numbers in memory for the
   * lifetime of the metrics object — pure waste, since `getTokensPerSecond`
   * only needs the FIRST and LAST timestamps to compute throughput. We now
   * keep the first timestamp (for TTFT-relative TPS) and overwrite the last
   * on every token. O(1) memory instead of O(tokens).
   */
  private firstTokenTs = 0;
  private lastTokenTs = 0;
  private totalTokens = 0;

  start(): void { this.startTime = Date.now(); }
  onFirstToken(): void { this.firstTokenTime = Date.now(); }
  
  onToken(): void {
    const now = Date.now();
    if (this.firstTokenTs === 0) this.firstTokenTs = now;
    this.lastTokenTs = now;
    this.totalTokens++;
  }

  getTTFT(): number {
    return this.firstTokenTime > 0 ? this.firstTokenTime - this.startTime : 0;
  }

  getTokensPerSecond(): number {
    if (this.totalTokens < 2) return 0;
    if (this.lastTokenTs === 0 || this.firstTokenTs === 0) return 0;
    const elapsed = (this.lastTokenTs - this.firstTokenTs) / 1000;
    return elapsed > 0 ? this.totalTokens / elapsed : 0;
  }

  getTotalTime(): number {
    return Date.now() - this.startTime;
  }

  getMetrics(): { ttft: number; tps: number; totalTime: number; totalTokens: number } {
    return {
      ttft: this.getTTFT(),
      tps: this.getTokensPerSecond(),
      totalTime: this.getTotalTime(),
      totalTokens: this.totalTokens,
    };
  }
}
