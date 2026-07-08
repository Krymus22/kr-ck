/**
 * error-paths-part2-5-keypool.test.ts — Error Path 5
 *
 * Scenario: Key pool: all keys in cooldown → should wait, not crash.
 *
 * BUG FIXED: when all keys were in 429 cooldown (60s) and the default
 * maxWaitMs was also 60s, the polling loop's deadline expired at almost
 * exactly the moment the cooldowns released. The function threw "All keys
 * busy or rate-limited" instead of returning the now-available key. The fix
 * adds a "last-chance check" after the loop: pickNextKey() is called one
 * final time before throwing, so a key that became available during the
 * last 100ms sleep is still returned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
}));

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class MockOpenAI {
    apiKey: string;
    baseURL: string;
    chat = { completions: { create: mockCreate } };
    constructor(opts: any) {
      this.apiKey = opts.apiKey;
      this.baseURL = opts.baseURL;
    }
  },
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEYS;
  delete process.env.NVIDIA_API_KEYS_FILE;
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: "hi" } }],
    usage: {},
  });
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
});

describe("Error path 5: Key pool all keys in cooldown → waits and recovers", () => {
  it("waits and recovers when all keys are in 429 cooldown (does NOT crash)", async () => {
    const { initApiKeyPool, acquireKeyForStreaming, resetPool, getPoolStats } = await import("../apiKeyPool.js");
    resetPool();
    process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2";
    initApiKeyPool();

    // Put BOTH keys in 429 cooldown (60s each)
    const h1 = await acquireKeyForStreaming();
    h1.release(false, 429, 10);
    const h2 = await acquireKeyForStreaming();
    h2.release(false, 429, 10);

    // Verify both are in cooldown
    const statsAfter429 = getPoolStats();
    expect(statsAfter429.every((s) => s.cooldownUntil > Date.now())).toBe(true);
    expect(statsAfter429.every((s) => s.rateLimitedCount === 1)).toBe(true);

    // Now try to acquire a key — all are in cooldown for 60s.
    // With the BUG FIX (last-chance check), acquireKey should WAIT and then
    // return a key once the cooldown expires (at t=60s), rather than throwing
    // "All keys busy or rate-limited after 60000ms".
    vi.useFakeTimers({ now: Date.now() });

    const acquirePromise = acquireKeyForStreaming();

    // Advance time past the 60s cooldown + polling buffer
    await vi.advanceTimersByTimeAsync(60_500);

    // The promise should resolve (not reject) with a key
    const handle = await acquirePromise;
    expect(handle).toBeDefined();
    expect(handle.client).toBeDefined();
    expect(typeof handle.release).toBe("function");

    // Cleanup
    handle.release(true, 200, 10);
  });

  it("throws a clear error (not crash) when all keys remain unavailable past maxWaitMs", async () => {
    const { initApiKeyPool, acquireKeyForStreaming, resetPool } = await import("../apiKeyPool.js");
    resetPool();
    process.env.NVIDIA_API_KEYS = "nvapi-k1";
    initApiKeyPool();

    // Acquire the single key and HOLD it (mutex locked) — never release.
    // This means the key can never be picked, even after cooldown.
    const h1 = await acquireKeyForStreaming();

    // Try to acquire again — will wait for the mutex forever (60s maxWait).
    vi.useFakeTimers({ now: Date.now() });
    const acquirePromise = acquireKeyForStreaming();

    // Attach the rejection handler BEFORE advancing timers so Node doesn't
    // emit an "unhandled rejection" warning during the fake-timer advancement.
    const assertionPromise = expect(acquirePromise).rejects.toThrow(/All keys busy or rate-limited/);

    // Advance past 60s wait
    await vi.advanceTimersByTimeAsync(61_000);

    // Await the assertion (now the rejection is already being handled)
    await assertionPromise;

    // Cleanup
    h1.release(true, 200, 10);
  });

  it("skips cooled-down keys and uses available ones (round-robin with cooldown)", async () => {
    const { initApiKeyPool, acquireKeyForStreaming, tryAcquireKeyImmediate, resetPool, getPoolStats } = await import("../apiKeyPool.js");
    resetPool();
    process.env.NVIDIA_API_KEYS = "nvapi-a,nvapi-b,nvapi-c";
    initApiKeyPool();

    // Put key #0 in cooldown
    const h0 = await acquireKeyForStreaming();
    h0.release(false, 429, 10);

    // Verify key #0 is in cooldown
    const stats = getPoolStats();
    const cooledKey = stats.find((s) => s.cooldownUntil > 0);
    expect(cooledKey).toBeDefined();
    expect(cooledKey!.index).toBe(0);

    // tryAcquireKeyImmediate should skip key #0 and return key #1 or #2
    const immediate = tryAcquireKeyImmediate();
    expect(immediate).not.toBeNull();
    const acquiredIdx = (immediate as any).entry.index;
    expect(acquiredIdx).not.toBe(0); // NOT the cooled-down key
    expect(acquiredIdx).toBeGreaterThanOrEqual(1);

    // Cleanup
    immediate!.release(true, 200, 10);
  });

  it("last-chance check recovers a key that becomes available during the final 100ms sleep", async () => {
    // This test specifically verifies the BUG FIX: the last-chance pickNextKey()
    // call after the polling loop exits. Without it, a key that becomes available
    // in the final 100ms sleep (right at the deadline) would be missed.
    const { initApiKeyPool, acquireKeyForStreaming, resetPool, getPoolStats } = await import("../apiKeyPool.js");
    resetPool();
    process.env.NVIDIA_API_KEYS = "nvapi-x";
    initApiKeyPool();

    // Put the single key in cooldown for 60s
    const h1 = await acquireKeyForStreaming();
    h1.release(false, 429, 10);

    // Verify it's in cooldown
    expect(getPoolStats()[0].cooldownUntil).toBeGreaterThan(Date.now());

    // The default maxWaitMs is 60_000, and the cooldown is also 60_000.
    // Without the last-chance check, this would throw "All keys busy" because
    // the deadline expires at exactly the moment the cooldown releases.
    // With the fix, the last-chance check finds the now-available key.
    vi.useFakeTimers({ now: Date.now() });

    const acquirePromise = acquireKeyForStreaming();

    // Advance exactly 60s + a tiny buffer for the final poll
    await vi.advanceTimersByTimeAsync(60_200);

    // Should resolve with the recovered key (NOT reject)
    const handle = await acquirePromise;
    expect(handle).toBeDefined();
    expect(handle.client).toBeDefined();

    handle.release(true, 200, 10);
  });
});
