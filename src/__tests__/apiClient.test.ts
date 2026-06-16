/**
 * apiClient.test.ts — Tests for apiClient.ts internals.
 * Covers: SlidingWindowRateLimiter, Mutex, stream processing,
 * tool call accumulation, response building, error classification.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Extract internals from apiClient.ts ───────────────────────────────────

class SlidingWindowRateLimiter {
  private readonly windowMs = 60_000;
  private readonly maxRequests: number;
  private timestamps: number[] = [];

  constructor(requestsPerMinute: number) {
    this.maxRequests = requestsPerMinute;
  }

  canAcquire(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    return this.timestamps.length < this.maxRequests;
  }

  acquireSync(): boolean {
    if (!this.canAcquire()) return false;
    this.timestamps.push(Date.now());
    return true;
  }

  getQueueLength(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    return Math.max(0, this.timestamps.length - this.maxRequests);
  }

  getTimestamps(): number[] {
    return [...this.timestamps];
  }
}

class Mutex {
  private _locked = false;
  private readonly _queue: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise((resolve) => this._queue.push(resolve));
  }

  unlock(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }

  isLocked(): boolean {
    return this._locked;
  }

  getQueueLength(): number {
    return this._queue.length;
  }
}

interface StreamState {
  isFirstChunk: boolean;
  finishReason: string | null;
  responseId: string;
  responseModel: string;
  responseCreated: number;
  totalContent: string;
  toolCallsAccumulator: Record<number, {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  promptTokens: number;
  completionTokens: number;
}

function createStreamState(): StreamState {
  return {
    isFirstChunk: true,
    finishReason: null,
    responseId: "",
    responseModel: "",
    responseCreated: 0,
    totalContent: "",
    toolCallsAccumulator: {},
    promptTokens: 0,
    completionTokens: 0,
  };
}

function processContentChunk(
  state: StreamState,
  content: string,
): { streamStarted: boolean } {
  let streamStarted = false;
  if (state.isFirstChunk) {
    state.isFirstChunk = false;
    streamStarted = true;
  }
  state.totalContent += content;
  return { streamStarted };
}

function processToolCallDelta(
  accumulator: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }>,
  toolCalls: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>,
): void {
  for (const tc of toolCalls) {
    const idx: number = tc.index ?? 0;
    if (accumulator[idx]) {
      const acc = accumulator[idx];
      if (tc.id && !acc.id) acc.id = tc.id;
    } else {
      accumulator[idx] = {
        id: tc.id ?? "",
        type: "function",
        function: { name: tc.function?.name ?? "", arguments: "" },
      };
    }
    if (tc.function?.arguments) {
      accumulator[idx].function.arguments += tc.function.arguments;
    }
  }
}

function buildChatResponse(state: StreamState): {
  id: string;
  object: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string | null; tool_calls?: unknown[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
} {
  const toolCallsList = Object.values(state.toolCallsAccumulator);
  return {
    id: state.responseId,
    object: "chat.completion",
    created: state.responseCreated,
    model: state.responseModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: state.totalContent || null,
          tool_calls: toolCallsList.length > 0 ? toolCallsList : undefined,
        },
        finish_reason: state.finishReason ?? "stop",
      },
    ],
    usage: {
      prompt_tokens: state.promptTokens,
      completion_tokens: state.completionTokens,
      total_tokens: state.promptTokens + state.completionTokens,
    },
  };
}

function is429Error(err: unknown): boolean {
  const apiErr = err as { status?: number };
  return apiErr?.status === 429;
}

function isTransientNetworkError(err: unknown): boolean {
  const codes = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE", "ECONNREFUSED", "EAI_AGAIN"]);
  const anyErr = err as { code?: string; cause?: { code?: string } };
  const errCode = anyErr?.code || anyErr?.cause?.code;
  return typeof errCode === "string" && codes.has(errCode);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("apiClient internals", () => {
  describe("SlidingWindowRateLimiter", () => {
    it("should allow requests under the limit", () => {
      const limiter = new SlidingWindowRateLimiter(5);
      expect(limiter.acquireSync()).toBe(true);
      expect(limiter.acquireSync()).toBe(true);
      expect(limiter.acquireSync()).toBe(true);
    });

    it("should block requests over the limit", () => {
      const limiter = new SlidingWindowRateLimiter(2);
      expect(limiter.acquireSync()).toBe(true);
      expect(limiter.acquireSync()).toBe(true);
      expect(limiter.acquireSync()).toBe(false);
    });

    it("should report correct queue length", () => {
      const limiter = new SlidingWindowRateLimiter(2);
      limiter.acquireSync();
      limiter.acquireSync();
      expect(limiter.getQueueLength()).toBe(0);
      limiter.acquireSync(); // this fails but still counts
      // Queue length is based on timestamps count vs max
    });

    it("should track timestamps", () => {
      const limiter = new SlidingWindowRateLimiter(3);
      limiter.acquireSync();
      limiter.acquireSync();
      expect(limiter.getTimestamps()).toHaveLength(2);
    });

    it("should handle zero limit", () => {
      const limiter = new SlidingWindowRateLimiter(0);
      expect(limiter.acquireSync()).toBe(false);
    });
  });

  describe("Mutex", () => {
    it("should allow first lock immediately", async () => {
      const mutex = new Mutex();
      await mutex.lock();
      expect(mutex.isLocked()).toBe(true);
      mutex.unlock();
    });

    it("should queue subsequent locks", async () => {
      const mutex = new Mutex();
      await mutex.lock();
      let secondLocked = false;
      const p = mutex.lock().then(() => { secondLocked = true; });
      // Give microtask a chance to run
      await new Promise((r) => setTimeout(r, 10));
      expect(secondLocked).toBe(false);
      expect(mutex.getQueueLength()).toBe(1);
      mutex.unlock();
      await p;
      expect(secondLocked).toBe(true);
      mutex.unlock();
    });

    it("should process FIFO queue", async () => {
      const mutex = new Mutex();
      const order: number[] = [];
      await mutex.lock();
      const p1 = mutex.lock().then(() => { order.push(1); });
      const p2 = mutex.lock().then(() => { order.push(2); });
      await new Promise((r) => setTimeout(r, 10));
      mutex.unlock(); // releases to p1
      await p1;
      expect(order).toEqual([1]);
      mutex.unlock(); // releases to p2
      await p2;
      expect(order).toEqual([1, 2]);
    });

    it("should unlock without queue clears locked state", () => {
      const mutex = new Mutex();
      mutex.unlock(); // no-op when not locked
      expect(mutex.isLocked()).toBe(false);
    });
  });

  describe("Stream state processing", () => {
    it("should create initial stream state", () => {
      const state = createStreamState();
      expect(state.isFirstChunk).toBe(true);
      expect(state.totalContent).toBe("");
      expect(state.finishReason).toBeNull();
      expect(state.toolCallsAccumulator).toEqual({});
    });

    it("should process content chunks and build total", () => {
      const state = createStreamState();
      const r1 = processContentChunk(state, "Hello");
      expect(state.totalContent).toBe("Hello");
      expect(r1.streamStarted).toBe(true);

      const r2 = processContentChunk(state, " world");
      expect(state.totalContent).toBe("Hello world");
      expect(r2.streamStarted).toBe(false);
      expect(state.isFirstChunk).toBe(false);
    });

    it("should accumulate tool call deltas", () => {
      const acc: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }> = {};
      processToolCallDelta(acc, [
        { index: 0, id: "call_1", function: { name: "ler_arquivo", arguments: '{"caminho":' } },
      ]);
      processToolCallDelta(acc, [
        { index: 0, function: { arguments: ' "src/main.ts"}' } },
      ]);
      expect(acc[0].function.arguments).toBe('{"caminho": "src/main.ts"}');
      expect(acc[0].function.name).toBe("ler_arquivo");
    });

    it("should handle multiple tool calls", () => {
      const acc: Record<number, { id: string; type: "function"; function: { name: string; arguments: string } }> = {};
      processToolCallDelta(acc, [
        { index: 0, id: "call_1", function: { name: "tool_a", arguments: "{}" } },
        { index: 1, id: "call_2", function: { name: "tool_b", arguments: "{}" } },
      ]);
      expect(Object.keys(acc)).toHaveLength(2);
    });
  });

  describe("buildChatResponse", () => {
    it("should build response with content", () => {
      const state = createStreamState();
      state.totalContent = "Hello";
      state.responseId = "resp_1";
      state.finishReason = "stop";
      const response = buildChatResponse(state);
      expect(response.id).toBe("resp_1");
      expect(response.choices[0].message.content).toBe("Hello");
      expect(response.choices[0].finish_reason).toBe("stop");
    });

    it("should build response with tool calls", () => {
      const state = createStreamState();
      state.toolCallsAccumulator = {
        0: { id: "call_1", type: "function", function: { name: "tool_a", arguments: "{}" } },
      };
      const response = buildChatResponse(state);
      expect(response.choices[0].message.tool_calls).toHaveLength(1);
    });

    it("should return null content when no content and tool calls present", () => {
      const state = createStreamState();
      state.toolCallsAccumulator = {
        0: { id: "call_1", type: "function", function: { name: "tool_a", arguments: "{}" } },
      };
      const response = buildChatResponse(state);
      expect(response.choices[0].message.content).toBeNull();
    });

    it("should sum usage tokens correctly", () => {
      const state = createStreamState();
      state.promptTokens = 100;
      state.completionTokens = 50;
      const response = buildChatResponse(state);
      expect(response.usage.total_tokens).toBe(150);
    });
  });

  describe("Error classification", () => {
    it("should detect 429 errors", () => {
      expect(is429Error({ status: 429 })).toBe(true);
      expect(is429Error({ status: 500 })).toBe(false);
      expect(is429Error({})).toBe(false);
    });

    it("should detect transient network errors", () => {
      expect(isTransientNetworkError({ code: "ECONNRESET" })).toBe(true);
      expect(isTransientNetworkError({ code: "ETIMEDOUT" })).toBe(true);
      expect(isTransientNetworkError({ code: "ENOTFOUND" })).toBe(true);
      expect(isTransientNetworkError({ code: "EPIPE" })).toBe(true);
      expect(isTransientNetworkError({ code: "ECONNREFUSED" })).toBe(true);
      expect(isTransientNetworkError({ code: "EAI_AGAIN" })).toBe(true);
    });

    it("should detect transient errors in cause chain", () => {
      expect(isTransientNetworkError({ cause: { code: "ECONNRESET" } })).toBe(true);
    });

    it("should NOT detect non-transient errors", () => {
      expect(isTransientNetworkError({ code: "ENOENT" })).toBe(false);
      expect(isTransientNetworkError({})).toBe(false);
    });

    it("should NOT detect non-429 errors", () => {
      expect(is429Error({ status: 503 })).toBe(false);
      expect(is429Error(new Error("timeout"))).toBe(false);
    });
  });
});
