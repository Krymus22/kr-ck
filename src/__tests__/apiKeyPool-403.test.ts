/**
 * apiKeyPool-403.test.ts — Tests for 403 cooldown behavior (§17.13 rule 113).
 *
 * When a key returns 403 (Forbidden), it should be cooled down for 60s
 * (same as 429) so the pool tries another key on the next request.
 *
 * Without this, NVIDIA's occasional 403-on-rate-limit (instead of 429)
 * would persistently fail the same key while other keys sit idle.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import {
  acquireKeyForStreaming,
  getPoolStats,
  getAvailableKeyCount,
  initApiKeyPool,
  resetPool,
  getPoolSize,
} from "../apiKeyPool.js";

const origEnv = { ...process.env };

beforeEach(() => {
  process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2,nvapi-k3";
  resetPool();
  initApiKeyPool();
});

afterEach(() => {
  process.env = { ...origEnv };
  resetPool();
});

describe("apiKeyPool — 403 cooldown (§17.13 rule 113)", () => {
  it("cools down key for 60s after 403", async () => {
    const h = await acquireKeyForStreaming();
    const keyIndex = h.entry.index;

    // Release with 403
    h.release(false, 403, 100);

    // Check cooldown is set
    const stats = getPoolStats();
    const cooledKey = stats[keyIndex];
    expect(cooledKey.cooldownUntil).toBeGreaterThan(Date.now());
    // Should be ~60s from now
    const cooldownMs = cooledKey.cooldownUntil - Date.now();
    expect(cooldownMs).toBeGreaterThan(55_000);
    expect(cooldownMs).toBeLessThan(65_000);
  });

  it("skips 403'd key on next acquire (uses another key)", async () => {
    // Acquire key 0, release with 403
    const h1 = await acquireKeyForStreaming();
    const k1Index = h1.entry.index;
    h1.release(false, 403, 100);

    // Next acquire should NOT be the same key
    const h2 = await acquireKeyForStreaming();
    expect(h2.entry.index).not.toBe(k1Index);
    h2.release(true, 200, 50);
  });

  it("all keys 403'd → available count is 0", async () => {
    // Acquire and 403 all 3 keys
    const h1 = await acquireKeyForStreaming();
    h1.release(false, 403, 100);
    const h2 = await acquireKeyForStreaming();
    h2.release(false, 403, 100);
    const h3 = await acquireKeyForStreaming();
    h3.release(false, 403, 100);

    // All keys in cooldown
    expect(getAvailableKeyCount()).toBe(0);
  });

  it("403 increments errorCount (not successCount)", async () => {
    const h = await acquireKeyForStreaming();
    const keyIndex = h.entry.index;
    h.release(false, 403, 100);

    const stats = getPoolStats();
    expect(stats[keyIndex].errorCount).toBe(1);
    expect(stats[keyIndex].successCount).toBe(0);
  });

  it("429 and 403 both cool down key (independent)", async () => {
    // Key 0 gets 403
    const h1 = await acquireKeyForStreaming();
    h1.release(false, 403, 100);

    // Key 1 gets 429
    const h2 = await acquireKeyForStreaming();
    h2.release(false, 429, 100);

    // Both should be in cooldown
    expect(getAvailableKeyCount()).toBe(1); // only key 2 available

    const stats = getPoolStats();
    expect(stats[h1.entry.index].cooldownUntil).toBeGreaterThan(Date.now());
    expect(stats[h2.entry.index].cooldownUntil).toBeGreaterThan(Date.now());
    // The third key (never acquired) should not be in cooldown
    const unusedKey = stats.find(s => s.index !== h1.entry.index && s.index !== h2.entry.index);
    expect(unusedKey!.cooldownUntil).toBe(0);
  });

  it("successful release after 403 cooldown clears cooldown", async () => {
    // Key gets 403
    const h1 = await acquireKeyForStreaming();
    h1.release(false, 403, 100);

    // Acquire a different key and release it OK
    const h2 = await acquireKeyForStreaming();
    h2.release(true, 200, 50);

    // h2's key should NOT be in cooldown
    const stats = getPoolStats();
    expect(stats[h2.entry.index].cooldownUntil).toBe(0);
    expect(stats[h2.entry.index].successCount).toBe(1);
  });

  it("403 does NOT set rateLimitedCount (only 429 does)", async () => {
    const h = await acquireKeyForStreaming();
    h.release(false, 403, 100);

    const stats = getPoolStats();
    // 403 should cool down but NOT increment rateLimitedCount
    // (rateLimitedCount is 429-specific)
    expect(stats[h.entry.index].rateLimitedCount).toBe(0);
    expect(stats[h.entry.index].cooldownUntil).toBeGreaterThan(Date.now());
  });
});
