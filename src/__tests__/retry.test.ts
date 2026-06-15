/**
 * retry.test.ts — Tests for retry/backoff module.
 */

import { describe, it, expect } from "vitest";
import { withRetry, isRetryableError, retryWithTimeout } from "../retry.js";

describe("withRetry", () => {
  it("should succeed on first try", async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return "ok";
    }, { maxRetries: 3 });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("should retry on failure and eventually succeed", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return "ok";
      },
      { maxRetries: 3, baseDelayMs: 10, jitter: false }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("should throw after max retries", async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error("always fail");
        },
        { maxRetries: 2, baseDelayMs: 10 }
      )
    ).rejects.toThrow("always fail");
  });

  it("should stop retrying if retryOn returns false", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error("stop");
        },
        {
          maxRetries: 5,
          baseDelayMs: 10,
          retryOn: () => false,
        }
      )
    ).rejects.toThrow("stop");
    expect(calls).toBe(1);
  });

  it("should call onRetry callback", async () => {
    const retryCalls: number[] = [];
    await withRetry(
      async () => {
        throw new Error("fail");
      },
      {
        maxRetries: 3,
        baseDelayMs: 10,
        onRetry: (attempt) => retryCalls.push(attempt),
      }
    ).catch(() => {});
    expect(retryCalls.length).toBe(3);
    expect(retryCalls).toEqual([1, 2, 3]);
  });
});

describe("isRetryableError", () => {
  it("should detect ECONNRESET as retryable", () => {
    expect(isRetryableError({ code: "ECONNRESET" })).toBe(true);
  });

  it("should detect ETIMEDOUT as retryable", () => {
    expect(isRetryableError({ code: "ETIMEDOUT" })).toBe(true);
  });

  it("should detect 429 as retryable", () => {
    expect(isRetryableError({ status: 429 })).toBe(true);
  });

  it("should detect 500 as retryable", () => {
    expect(isRetryableError({ status: 500 })).toBe(true);
  });

  it("should not detect 400 as retryable", () => {
    expect(isRetryableError({ status: 400 })).toBe(false);
  });

  it("should handle null/undefined gracefully", () => {
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe("retryWithTimeout", () => {
  it("should succeed within timeout", async () => {
    const result = await retryWithTimeout(async () => "ok", 1000);
    expect(result).toBe("ok");
  });

  it("should timeout if too slow", async () => {
    await expect(
      retryWithTimeout(
        async () => {
          await new Promise((r) => setTimeout(r, 2000));
          return "ok";
        },
        100,
        { maxRetries: 0 }
      )
    ).rejects.toThrow("Timeout");
  }, 500);
});
