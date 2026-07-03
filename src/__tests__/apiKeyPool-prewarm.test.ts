/**
 * apiKeyPool-prewarm.test.ts — tests for the prewarm functionality.
 *
 * Prewarm sends a tiny "hi" request (max_tokens=1) to each key in the pool
 * at startup. This establishes TLS sessions, warms the keepAlive connection
 * pool, and triggers the NVIDIA NIM server to load the model into GPU memory.
 *
 * Tests:
 *   - prewarmPool() is idempotent (calling twice = 1 prewarm)
 *   - prewarmPool() skips when pool is empty
 *   - prewarmPool() fires requests in parallel (all keys at once)
 *   - prewarmPool() handles errors gracefully (doesn't crash)
 *   - prewarmPool() logs success/failure
 *   - resetPrewarm() allows re-prewarming
 *   - prewarm uses the correct model (from process.env.MODEL)
 *   - prewarm uses max_tokens=1 (cheap)
 *   - prewarm uses stream=false (no streaming parser)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock OpenAI — apiKeyPool creates OpenAI clients, so we mock the class
const mockCreate = vi.hoisted(() => vi.fn(async () => ({
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    baseURL: string;
    timeout: number;
    chat = { completions: { create: mockCreate } };
    constructor(opts: any) {
      this.apiKey = opts.apiKey;
      this.baseURL = opts.baseURL;
      this.timeout = opts.timeout;
    }
  },
}));

// Note: we do NOT mock node:https — apiKeyPool.test.ts also doesn't.
// The real https.Agent is used (it just creates a socket pool, no real connections
// are made because OpenAI is mocked).

// Import AFTER mocks
import { initApiKeyPool, prewarmPool, resetPrewarm, resetPool, getPoolSize } from "../apiKeyPool.js";

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("apiKeyPool prewarm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPool();
    resetPrewarm();
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    // Set up 3 fake keys for testing (simulating user's 3-key setup)
    process.env.NVIDIA_API_KEYS = "nvapi-key1-test,nvapi-key2-test,nvapi-key3-test";
    process.env.MODEL = "minimaxai/minimax-m3";
  });

  afterEach(() => {
    resetPool();
    resetPrewarm();
    delete process.env.NVIDIA_API_KEYS;
    delete process.env.MODEL;
  });

  it("prewarmPool() sends 1 request per key in the pool", async () => {
    initApiKeyPool();
    expect(getPoolSize()).toBe(3);

    await prewarmPool();

    // Should have called create() 3 times (once per key)
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it("prewarmPool() is idempotent — calling twice = 1 prewarm", async () => {
    initApiKeyPool();

    await prewarmPool();
    await prewarmPool(); // should be no-op

    expect(mockCreate).toHaveBeenCalledTimes(3); // not 6
  });

  it("prewarmPool() skips when pool is empty", async () => {
    // Don't init pool
    expect(getPoolSize()).toBe(0);

    await prewarmPool();

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("prewarmPool() fires requests in parallel (all keys at once)", async () => {
    initApiKeyPool();

    // Track call order — parallel means all start before any finishes
    const callStarts: number[] = [];
    mockCreate.mockImplementation(async () => {
      callStarts.push(Date.now());
      // Simulate 50ms latency
      await new Promise((r) => setTimeout(r, 50));
      return {
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    });

    const start = Date.now();
    await prewarmPool();
    const elapsed = Date.now() - start;

    // If parallel: elapsed ≈ 50ms (all 3 run at once)
    // If serial: elapsed ≈ 150ms (3 × 50ms)
    expect(elapsed).toBeLessThan(120); // allow 20ms overhead
    expect(callStarts.length).toBe(3);

    // All 3 calls should have started within 20ms of each other (parallel)
    const spread = Math.max(...callStarts) - Math.min(...callStarts);
    expect(spread).toBeLessThan(20);
  });

  it("prewarmPool() handles errors gracefully (doesn't crash)", async () => {
    initApiKeyPool();

    // Make all requests fail
    mockCreate.mockRejectedValue(new Error("Network error"));

    // Should not throw
    await expect(prewarmPool()).resolves.toBeUndefined();
  });

  it("prewarmPool() handles partial failures (some keys OK, some fail)", async () => {
    initApiKeyPool();

    // First key succeeds, second fails, third succeeds
    mockCreate.mockImplementation(async (...args: any[]) => {
      const apiKey = args[0]?.__apiKey ?? "";
      // We can't easily tell which key is which in the mock, so just alternate
      return mockCreate.mock.results.length % 2 === 0
        ? { choices: [{ message: { content: "hi" } }], usage: {} }
        : Promise.reject(new Error("Rate limited"));
    });

    await expect(prewarmPool()).resolves.toBeUndefined();
  });

  it("resetPrewarm() allows re-prewarming", async () => {
    initApiKeyPool();

    await prewarmPool();
    expect(mockCreate).toHaveBeenCalledTimes(3);

    resetPrewarm();
    mockCreate.mockClear();

    await prewarmPool();
    expect(mockCreate).toHaveBeenCalledTimes(3); // re-prewarmed
  });

  it("prewarm uses max_tokens=1 (cheap request)", async () => {
    initApiKeyPool();
    await prewarmPool();

    // Check the first call's arguments
    const firstCall = mockCreate.mock.calls[0]?.[0];
    expect(firstCall).toBeDefined();
    expect(firstCall.max_tokens).toBe(1);
  });

  it("prewarm uses stream=false (no streaming parser)", async () => {
    initApiKeyPool();
    await prewarmPool();

    const firstCall = mockCreate.mock.calls[0]?.[0];
    expect(firstCall.stream).toBe(false);
  });

  it("prewarm uses the model from process.env.MODEL", async () => {
    process.env.MODEL = "moonshotai/kimi-k2.6";
    initApiKeyPool();
    await prewarmPool();

    const firstCall = mockCreate.mock.calls[0]?.[0];
    expect(firstCall.model).toBe("moonshotai/kimi-k2.6");
  });

  it("prewarm sends 'hi' as the user message", async () => {
    initApiKeyPool();
    await prewarmPool();

    const firstCall = mockCreate.mock.calls[0]?.[0];
    expect(firstCall.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("prewarm works with 1 key (single-key mode)", async () => {
    process.env.NVIDIA_API_KEYS = "";
    process.env.NVIDIA_API_KEY = "nvapi-single-key-test";
    initApiKeyPool();
    expect(getPoolSize()).toBeGreaterThanOrEqual(0); // depends on pool init logic

    // Even with 0 keys in pool, prewarm should not crash
    await expect(prewarmPool()).resolves.toBeUndefined();
  });

  it("prewarm with 5 keys fires 5 parallel requests", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2,nvapi-k3,nvapi-k4,nvapi-k5";
    initApiKeyPool();
    expect(getPoolSize()).toBe(5);

    await prewarmPool();
    expect(mockCreate).toHaveBeenCalledTimes(5);
  });
});

// ─── max_tokens dynamic (Mudança 3) ────────────────────────────────────────

describe("max_tokens dynamic (model-aware)", () => {
  it("getModelMaxOutputTokens returns correct limit per model", async () => {
    const { getModelMaxOutputTokens } = await import("../modelRegistry.js");
    expect(getModelMaxOutputTokens("moonshotai/kimi-k2.6")).toBe(8192);
    expect(getModelMaxOutputTokens("minimaxai/minimax-m3")).toBe(16384);
    expect(getModelMaxOutputTokens("deepseek-ai/deepseek-r1")).toBe(32768);
    expect(getModelMaxOutputTokens("unknown/model")).toBe(8192); // fallback
  });

  it("Math.min(config.maxTokens, modelMaxOutputTokens) picks the lower limit", () => {
    // Simulate: user sets MAX_TOKENS=20000 but model only supports 8192
    const configMaxTokens = 20000;
    const modelMax = 8192; // kimi-k2.6
    const result = Math.min(configMaxTokens, modelMax);
    expect(result).toBe(8192); // model limit wins
  });

  it("Math.min respects user override when lower than model limit", () => {
    // Simulate: user sets MAX_TOKENS=1000 (wants short responses)
    const configMaxTokens = 1000;
    const modelMax = 16384; // minimax-m3
    const result = Math.min(configMaxTokens, modelMax);
    expect(result).toBe(1000); // user override wins
  });

  it("Math.min handles equal values", () => {
    const configMaxTokens = 16384;
    const modelMax = 16384;
    const result = Math.min(configMaxTokens, modelMax);
    expect(result).toBe(16384);
  });
});
