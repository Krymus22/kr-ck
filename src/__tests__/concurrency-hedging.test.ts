/**
 * concurrency-hedging.test.ts — Race condition tests for apiClient.ts hedging.
 *
 * CONCURRENCY HAZARD UNDER TEST:
 *   Primary and hedge streams race via Promise.race. When primary wins
 *   BEFORE the hedge's createStreamRequest has resolved, hedgeRawStream is
 *   null and abortStreamSafe(null) is a no-op. Without the hedgeCancelled
 *   flag (added in this fix), the hedge's HTTP request continues in the
 *   background after the hedge key's mutex was released — violating the
 *   1-concurrent-per-key invariant.
 *
 * Strategy: mirror apiClient-extended.test.ts mock setup. Use fake timers
 * to control when primary/hedge createStreamRequest resolve, exercising the
 * specific race where primary wins while hedge is still pending.
 *
 * NOTE: `import` is used everywhere (no require()) per project convention.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── vi.hoisted: mocks compartilhados entre factory e testes ────────────────
const hoisted = vi.hoisted(() => {
  class MockAPIError extends Error {
    status?: number;
    headers?: Record<string, string>;
    constructor(message: string, status?: number, headers?: Record<string, string>) {
      super(message);
      this.name = "APIError";
      this.status = status;
      this.headers = headers;
    }
  }
  return {
    createMock: vi.fn(),
    MockAPIError,
    configMock: {
      nvidiaApiKey: "test-key",
      nvidiaApiKeys: "",
      nvidiaApiKeysFile: "",
      nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
      model: "moonshotai/kimi-k2.6",
      rateLimitRpm: 1000,
      maxConcurrency: 1,
      maxHealRetries: 3,
      debug: false,
      contextWindowTokens: 128000,
      contextCompactThreshold: 0.75,
      contextWarnThreshold: 0.6,
      costPerKPrompt: 0,
      costPerKCompletion: 0,
      diffPreview: false,
      maxTokens: 4096,
      temperature: 0.6,
      topP: 0.9,
    },
    poolMock: {
      initApiKeyPool: vi.fn(() => true),
      getPoolSize: vi.fn(() => 2),
      acquireKeyForStreaming: vi.fn(),
      tryAcquireKeyImmediate: vi.fn(() => null),
      getAvailableKeyCount: vi.fn(() => 1),
      getTotalKeyCount: vi.fn(() => 2),
      getPoolStats: vi.fn(() => []),
      formatPoolStats: vi.fn(() => "[POOL] mock"),
    },
    providerMock: {
      providerSendsThinkingMode: vi.fn(() => false),
      getProviderReasoningField: vi.fn(() => "reasoning_content" as const),
      providerNeedsHedging: vi.fn(() => true),
      detectProvider: vi.fn(() => "nvidia" as const),
      getProviderConfig: vi.fn(() => ({
        name: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "test-key",
        sendThinkingMode: false,
        reasoningField: "reasoning_content" as const,
        needsHeartbeat: true,
        needsHedging: true,
        needsMultiKeyPool: true,
        maxConcurrentSubAgents: 2,
        heartbeatMaxTokens: 1,
      })),
      providerNeedsHeartbeat: vi.fn(() => true),
      getProviderMaxSubAgents: vi.fn(() => 2),
      providerUsesMultiKeyPool: vi.fn(() => true),
    },
    modelRegistryMock: {
      getModelInfo: vi.fn(() => ({
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        costPer1MPrompt: 0,
        costPer1MCompletion: 0,
        supportsTools: true,
        supportsParallelTools: true,
        hasThinking: false,
        provider: "nvidia",
      })),
      getModelMaxOutputTokens: vi.fn(() => 8192),
      getModelContextWindow: vi.fn(() => 128000),
    },
  };
});

vi.mock("openai", () => {
  class MockOpenAI {
    static APIError = hoisted.MockAPIError;
    chat = { completions: { create: hoisted.createMock } };
  }
  return { default: MockOpenAI, APIError: hoisted.MockAPIError };
});
vi.mock("../config.js", () => ({ config: hoisted.configMock }));
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(),
}));
vi.mock("../apiKeyPool.js", () => hoisted.poolMock);
vi.mock("../apiProvider.js", () => hoisted.providerMock);
vi.mock("../modelRegistry.js", () => hoisted.modelRegistryMock);

import { chat, type Message } from "../apiClient.js";

// ─── Stream helpers (mirror apiClient-extended.test.ts) ─────────────────────

function mockStream(chunks: any[]): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function contentChunk(text: string): any {
  return {
    id: "chatcmpl-test", model: "moonshotai/kimi-k2.6", created: 1700000000,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function finishChunk(finishReason: string, usage?: any): any {
  return {
    id: "chatcmpl-test", model: "moonshotai/kimi-k2.6", created: 1700000000,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function simpleStream(text = "hello world"): AsyncIterable<any> {
  const parts = text.split(" ");
  const chunks = parts.map((p) => contentChunk(p + " "));
  chunks.push(finishChunk("stop"));
  return mockStream(chunks);
}

/** A stream that records whether it was iterated (consumed). */
function trackedStream(text: string, consumeMarker: { value: boolean }): AsyncIterable<any> {
  const chunks = [contentChunk(text), finishChunk("stop")];
  return {
    [Symbol.asyncIterator]() {
      consumeMarker.value = true;
      let i = 0;
      return {
        next: async () => {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const sampleMessages: Message[] = [{ role: "user", content: "test" }];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("CONCURRENCY 3 — apiClient hedging winner determination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.createMock.mockReset();
    hoisted.createMock.mockImplementation(() => Promise.resolve(simpleStream()));

    hoisted.poolMock.getPoolSize.mockReturnValue(2);
    hoisted.poolMock.initApiKeyPool.mockReturnValue(true);
    hoisted.poolMock.acquireKeyForStreaming.mockReset();
    hoisted.poolMock.tryAcquireKeyImmediate.mockReset();
    hoisted.poolMock.tryAcquireKeyImmediate.mockReturnValue(null);
    hoisted.poolMock.getAvailableKeyCount.mockReturnValue(1);
    hoisted.poolMock.getTotalKeyCount.mockReturnValue(2);

    hoisted.providerMock.providerNeedsHedging.mockReturnValue(true);
    hoisted.providerMock.providerSendsThinkingMode.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("primary wins before hedge createStreamRequest resolves — hedge is cancelled, consumeStream NOT called on hedge", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const primaryRelease = vi.fn();
    const hedgeRelease = vi.fn();

    // Primary's createStreamRequest resolves SLOWLY (after the 5s hedge
    // threshold fires). This is what causes the racing block to be entered.
    // The resolved stream completes quickly (fast consumeStream).
    const primaryStream = simpleStream("primary-wins");
    let primaryResolve!: (v: any) => void;
    const primaryCreate = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => { primaryResolve = resolve; });
    });
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: primaryRelease,
    });

    // Hedge's createStreamRequest resolves EVEN LATER (after primary wins).
    // We track whether the hedge stream is iterated — if the bug is present,
    // consumeStream would be called on it.
    const hedgeConsumeMarker = { value: false };
    const hedgeStream = trackedStream("hedge-data", hedgeConsumeMarker);
    let hedgeResolve!: (v: any) => void;
    const hedgeCreate = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => { hedgeResolve = resolve; });
    });
    hoisted.poolMock.tryAcquireKeyImmediate.mockReturnValue({
      client: { chat: { completions: { create: hedgeCreate } } },
      entry: { index: 1 },
      release: hedgeRelease,
    });

    const p = chat(sampleMessages);

    // Advance to 5s — hedge timer fires, tryAcquireKeyImmediate is called.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).toHaveBeenCalledTimes(1);
    expect(hedgeCreate).not.toHaveBeenCalled(); // hedge stream NOT created yet

    // Now resolve primary's createStreamRequest — enters the racing block.
    primaryResolve(primaryStream);

    // Advance a bit so primary consumeStream completes and wins the race.
    await vi.advanceTimersByTimeAsync(300);

    // Hedge's createStreamRequest should now have been called (inside the
    // racing block, createStreamRequest is invoked for the hedge).
    expect(hedgeCreate).toHaveBeenCalledTimes(1);

    const response = await p;

    // Primary won — response must be primary's content.
    expect(response.choices?.[0]?.message?.content).toContain("primary-wins");

    // ─── The race-condition assertions ───────────────────────────────────
    // 1. The hedge's createStreamRequest has NOT resolved yet (hedgeResolve
    //    is still pending). Resolve it now to simulate the late-resolve case.
    expect(hedgeConsumeMarker.value).toBe(false); // not consumed yet
    hedgeResolve(hedgeStream);

    // Advance time so the hedge's .then callback runs (and checks the flag).
    await vi.advanceTimersByTimeAsync(500);

    // 2. CRITICAL: even though hedge's createStreamRequest resolved AFTER
    //    primary won, its stream must NOT be consumed — the hedgeCancelled
    //    flag should have aborted it. (If the bug is present,
    //    hedgeConsumeMarker.value would be true here, leaking resources.)
    expect(hedgeConsumeMarker.value).toBe(false);

    // 3. Both keys must be released exactly once.
    expect(primaryRelease).toHaveBeenCalledTimes(1);
    expect(hedgeRelease).toHaveBeenCalledTimes(1);
  });

  it("hedge wins — primary is aborted, hedge content is returned", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const primaryRelease = vi.fn();
    const hedgeRelease = vi.fn();

    // Primary's createStreamRequest resolves, but consumeStream is SLOW
    // (the stream never finishes — simulates a hung primary).
    const primaryConsumeMarker = { value: false };
    const primaryStream = {
      [Symbol.asyncIterator]() {
        primaryConsumeMarker.value = true;
        return {
          next: async () => {
            // Never resolves — simulates a slow/hung primary stream.
            await new Promise(() => {}); // hangs forever
          },
        };
      },
    };
    let primaryResolve!: (v: any) => void;
    const primaryCreate = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => { primaryResolve = resolve; });
    });
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: primaryRelease,
    });

    // Hedge's createStreamRequest resolves with a fast stream.
    const hedgeStream = simpleStream("hedge-wins");
    let hedgeResolve!: (v: any) => void;
    const hedgeCreate = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => { hedgeResolve = resolve; });
    });
    hoisted.poolMock.tryAcquireKeyImmediate.mockReturnValue({
      client: { chat: { completions: { create: hedgeCreate } } },
      entry: { index: 1 },
      release: hedgeRelease,
    });

    const p = chat(sampleMessages);

    // Advance to 5s — hedge timer fires.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).toHaveBeenCalledTimes(1);

    // Resolve primary — enters the racing block.
    primaryResolve(primaryStream);
    await vi.advanceTimersByTimeAsync(100);

    // Now resolve hedge — its consumeStream completes quickly.
    hedgeResolve(hedgeStream);
    await vi.advanceTimersByTimeAsync(500);

    const response = await p;

    // Hedge won — response must be hedge's content.
    expect(response.choices?.[0]?.message?.content).toContain("hedge-wins");

    // Primary was started (its stream was iterated) but aborted because
    // hedge won. Both keys released exactly once.
    expect(primaryConsumeMarker.value).toBe(true);
    expect(primaryRelease).toHaveBeenCalledTimes(1);
    expect(hedgeRelease).toHaveBeenCalledTimes(1);
  });

  it("no hedge when pool has only 1 key — primary path used, tryAcquireKeyImmediate never called", async () => {
    hoisted.poolMock.getTotalKeyCount.mockReturnValue(1);
    hoisted.poolMock.getAvailableKeyCount.mockReturnValue(0);

    const primaryRelease = vi.fn();
    const primaryCreate = vi.fn().mockResolvedValue(simpleStream("solo"));
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: primaryRelease,
    });

    const response = await chat(sampleMessages);

    expect(response.choices?.[0]?.message?.content).toContain("solo");
    expect(hoisted.poolMock.tryAcquireKeyImmediate).not.toHaveBeenCalled();
    expect(primaryRelease).toHaveBeenCalledTimes(1);
  });

  it("hedge timer is cleared when primary wins quickly (no late hedge fire)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const primaryRelease = vi.fn();
    const primaryCreate = vi.fn().mockResolvedValue(simpleStream("fast-primary"));
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: primaryRelease,
    });

    const p = chat(sampleMessages);

    // Primary resolves almost immediately (< 5s hedge threshold).
    await vi.advanceTimersByTimeAsync(200);
    const response = await p;

    expect(response.choices?.[0]?.message?.content).toContain("fast-primary");

    // Advance well past the 5s hedge threshold — hedge must NOT fire
    // because primaryStreamStarted was set before the timer fired, and the
    // timer was cleared in the finally block.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).not.toHaveBeenCalled();
  });

  it("error during race — both streams are cleaned up (no resource leak)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const primaryRelease = vi.fn();
    const hedgeRelease = vi.fn();

    // Primary's createStreamRequest resolves, but consumeStream REJECTS.
    const primaryStream = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            throw new Error("primary stream error");
          },
        };
      },
    };
    let primaryResolve!: (v: any) => void;
    const primaryCreate = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => { primaryResolve = resolve; });
    });
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: primaryRelease,
    });

    // Hedge's createStreamRequest is pending (slow).
    const hedgeConsumeMarker = { value: false };
    const hedgeStream = trackedStream("hedge-data", hedgeConsumeMarker);
    let hedgeResolve!: (v: any) => void;
    const hedgeCreate = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => { hedgeResolve = resolve; });
    });
    hoisted.poolMock.tryAcquireKeyImmediate.mockReturnValue({
      client: { chat: { completions: { create: hedgeCreate } } },
      entry: { index: 1 },
      release: hedgeRelease,
    });

    const p = chat(sampleMessages);

    // Advance to 5s — hedge timer fires.
    await vi.advanceTimersByTimeAsync(5_100);

    // Resolve primary — enters the racing block. consumeStream rejects.
    primaryResolve(primaryStream);
    await vi.advanceTimersByTimeAsync(200);

    // The chat() top-level catches chatWithPool's error and falls back to
    // chatSingleKey (which uses the default mock and succeeds). So p
    // resolves (not rejects). We don't care about the final response — we
    // only care that the hedge was cleaned up. Wait for settlement.
    await Promise.allSettled([p]);

    // ─── The race-condition assertions ───────────────────────────────────
    // 1. The hedge's createStreamRequest may still be pending. Resolve it
    //    to simulate the late-resolve case.
    hedgeResolve(hedgeStream);
    await vi.advanceTimersByTimeAsync(500);

    // 2. CRITICAL: the hedge stream must NOT be consumed — the
    //    hedgeCancelled flag (set in the finally block on the error path)
    //    should have aborted it.
    expect(hedgeConsumeMarker.value).toBe(false);

    // 3. Both keys must be released (primary in the catch/finally, hedge in
    //    the inner finally).
    expect(primaryRelease).toHaveBeenCalledTimes(1);
    expect(hedgeRelease).toHaveBeenCalledTimes(1);
  });
});
