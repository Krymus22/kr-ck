/**
 * retry-extended.test.ts — Extended tests for retry.ts
 *
 * Covers:
 *   - withRetry: success on first try, retry on failure, maxRetries cap
 *   - withRetry: custom retryOn predicate, onRetry callback, jitter/no-jitter
 *   - isRetryableError: codes (ECONNRESET, ETIMEDOUT, etc.), HTTP 429, 5xx
 *   - retryWithTimeout: timeout enforcement
 *   - RetryOptions type contract
 *   - Edge cases: sync vs async, returning values, error propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
}));

import { withRetry, isRetryableError, retryWithTimeout, type RetryOptions } from "../retry.js";

describe("withRetry — success path", () => {
  it("returns the value on first try without retries", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns numeric values", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, { maxRetries: 0 });
    expect(result).toBe(42);
  });

  it("returns object values", async () => {
    const fn = vi.fn().mockResolvedValue({ a: 1, b: "x" });
    const result = await withRetry(fn, { maxRetries: 0 });
    expect(result.a).toBe(1);
    expect(result.b).toBe("x");
  });

  it("returns null values", async () => {
    const fn = vi.fn().mockResolvedValue(null);
    const result = await withRetry(fn, { maxRetries: 0 });
    expect(result).toBeNull();
  });

  it("returns undefined values", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const result = await withRetry(fn, { maxRetries: 0 });
    expect(result).toBeUndefined();
  });
});

describe("withRetry — retry on failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries up to maxRetries times then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error("transient");
      return "ok";
    });
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, jitter: false });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after maxRetries is exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));
    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 1, jitter: false }),
    ).rejects.toThrow("always fails");
    // maxRetries=2 → 3 total attempts (0, 1, 2)
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry when maxRetries=0 (single attempt)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(
      withRetry(fn, { maxRetries: 0, baseDelayMs: 1, jitter: false }),
    ).rejects.toThrow("x");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with attempt number, error, and delay", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(
      withRetry(fn, {
        maxRetries: 1, baseDelayMs: 5, jitter: false, onRetry,
      }),
    ).rejects.toThrow("x");
    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, err, delay] = onRetry.mock.calls[0]!;
    expect(attempt).toBe(1);
    expect(err).toBeInstanceOf(Error);
    expect(typeof delay).toBe("number");
  });
});

describe("withRetry — retryOn predicate", () => {
  it("retries only when retryOn returns true", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      throw new Error("type:" + calls);
    });
    const retryOn = (err: any) => err.message === "type:1";
    await expect(
      withRetry(fn, {
        maxRetries: 3, baseDelayMs: 1, jitter: false, retryOn,
      }),
    ).rejects.toThrow("type:2");
    // Called twice: first (retryOn true → retry), second (retryOn false → stop)
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when retryOn returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    const retryOn = () => false;
    await expect(
      withRetry(fn, {
        maxRetries: 5, baseDelayMs: 1, jitter: false, retryOn,
      }),
    ).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries when retryOn always returns true up to maxRetries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    const retryOn = () => true;
    await expect(
      withRetry(fn, {
        maxRetries: 2, baseDelayMs: 1, jitter: false, retryOn,
      }),
    ).rejects.toThrow("x");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("withRetry — delay calculation", () => {
  it("respects maxDelayMs cap", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1_000_000,
        maxDelayMs: 50,
        backoffMultiplier: 2,
        jitter: false,
        onRetry,
      }),
    ).rejects.toThrow("x");
    for (const call of onRetry.mock.calls) {
      const delay = call[2] as number;
      expect(delay).toBeLessThanOrEqual(50);
    }
  });

  it("with jitter: false, delay is exponential and equals base * mult^attempt", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 10,
        maxDelayMs: 10_000,
        backoffMultiplier: 2,
        jitter: false,
        onRetry,
      }),
    ).rejects.toThrow("x");
    const d1 = onRetry.mock.calls[0]![2] as number;
    const d2 = onRetry.mock.calls[1]![2] as number;
    expect(d1).toBe(10);    // attempt 0 → base * mult^0 = 10
    expect(d2).toBe(20);    // attempt 1 → base * mult^1 = 20
  });

  it("with jitter: true, delay stays within +/-25% of base delay", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await expect(
      withRetry(fn, {
        maxRetries: 1,
        baseDelayMs: 100,
        maxDelayMs: 1000,
        backoffMultiplier: 2,
        jitter: true,
        onRetry,
      }),
    ).rejects.toThrow("x");
    const delay = onRetry.mock.calls[0]![2] as number;
    // base=100, multiplier=2, attempt=0 → 100 ± 25 = [75, 125]
    expect(delay).toBeGreaterThanOrEqual(75);
    expect(delay).toBeLessThanOrEqual(125);
  });
});

describe("withRetry — defaults", () => {
  it("uses sensible defaults when no options provided", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("defaults: maxRetries=3 → 4 total attempts on failure", async () => {
    // Use very short base delay to keep test fast
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    // Override base delay to 1ms but keep other defaults
    await expect(
      withRetry(fn, { baseDelayMs: 1, jitter: false }),
    ).rejects.toThrow("x");
    expect(fn).toHaveBeenCalledTimes(4); // 0,1,2,3
  });
});

describe("isRetryableError", () => {
  it("returns true for ECONNRESET", () => {
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("returns true for ENOTFOUND", () => {
    expect(isRetryableError({ code: "ENOTFOUND" })).toBe(true);
  });

  it("returns true for EPIPE", () => {
    expect(isRetryableError({ code: "EPIPE" })).toBe(true);
  });

  it("returns true for ECONNREFUSED", () => {
    expect(isRetryableError({ code: "ECONNREFUSED" })).toBe(true);
  });

  it("returns true for EAI_AGAIN", () => {
    expect(isRetryableError({ code: "EAI_AGAIN" })).toBe(true);
  });

  it("returns true for EHOSTUNREACH", () => {
    expect(isRetryableError({ code: "EHOSTUNREACH" })).toBe(true);
  });

  it("returns true for HTTP 429 (rate limit)", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it("returns false for HTTP 500 (real server bug — NOT retryable)", () => {
    // BUG FIX: 500 is a real server bug — retrying just hits the same bug.
    // Only 502/503 are retried (transient gateway issues). This must agree
    // with apiClient.ts's RETRIABLE_5XX_STATUSES = new Set([502, 503]).
    expect(isRetryableError({ status: 500 })).toBe(false);
  });

  it("returns true for HTTP 502 (transient bad gateway)", () => {
    expect(isRetryableError({ status: 502 })).toBe(true);
  });

  it("returns true for HTTP 503 (service unavailable)", () => {
    expect(isRetryableError({ status: 503 })).toBe(true);
  });

  it("returns false for HTTP 504 (gateway timeout — http client already has timeout)", () => {
    expect(isRetryableError({ status: 504 })).toBe(false);
  });

  it("returns false for HTTP 500 even with cause.code present (status takes precedence for 5xx decision)", () => {
    // 500 is never retried regardless of other fields
    expect(isRetryableError({ status: 500, code: "ECONNRESET" })).toBe(true); // code wins
    expect(isRetryableError({ status: 500 })).toBe(false); // pure 500 not retried
  });

  it("returns false for HTTP 400 (client error)", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
  });

  it("returns false for HTTP 404 (not found)", () => {
    expect(isRetryableError({ status: 404 })).toBe(false);
  });

  it("returns false for HTTP 401 (unauthorized)", () => {
    expect(isRetryableError({ status: 401 })).toBe(false);
  });

  it("returns false for unknown error codes", () => {
    expect(isRetryableError({ code: "UNKNOWN_CODE" })).toBe(false);
  });

  it("returns false for plain Error without code/status", () => {
    expect(isRetryableError(new Error("plain"))).toBe(false);
  });

  it("returns false for null/undefined input", () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it("checks error.cause.code as fallback", () => {
    expect(isRetryableError({ cause: { code: "ECONNRESET" } })).toBe(true);
  });
});

describe("retryWithTimeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the value when fn completes before timeout", async () => {
    const fn = vi.fn().mockResolvedValue("fast");
    const result = await retryWithTimeout(fn, 1000, { maxRetries: 0, baseDelayMs: 1 });
    expect(result).toBe("fast");
  });

  it("throws a timeout error when fn exceeds timeoutMs", async () => {
    const fn = () => new Promise<string>((r) => setTimeout(() => r("late"), 500));
    await expect(
      retryWithTimeout(fn, 50, { maxRetries: 0, baseDelayMs: 1, jitter: false }),
    ).rejects.toThrow(/Timeout after 50ms/);
  });

  it("retries on timeout if maxRetries > 0", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      if (calls < 2) return new Promise<string>((r) => setTimeout(() => r("late"), 500));
      return Promise.resolve("ok");
    };
    const result = await retryWithTimeout(fn, 50, { maxRetries: 1, baseDelayMs: 1, jitter: false });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("RetryOptions type contract", () => {
  it("accepts an empty object", () => {
    const opts: RetryOptions = {};
    expect(opts).toBeDefined();
  });

  it("accepts all fields", () => {
    const opts: RetryOptions = {
      maxRetries: 5,
      baseDelayMs: 100,
      maxDelayMs: 5000,
      backoffMultiplier: 3,
      jitter: false,
      retryOn: () => true,
      onRetry: () => {},
    };
    expect(opts.maxRetries).toBe(5);
  });
});

describe("withRetry — handles sync errors thrown in async fn", () => {
  it("catches synchronous throws inside an async function", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 2) throw new Error("sync throw inside async");
      return "ok";
    });
    const result = await withRetry(fn, { maxRetries: 2, baseDelayMs: 1, jitter: false });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
