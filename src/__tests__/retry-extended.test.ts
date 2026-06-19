/**
 * retry-extended.test.ts — Casos edge / error / integração p/ retry.ts.
 * Foco: withRetry em 4 cenários, backoff determinístico, edge cases.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
}));

import { withRetry, isRetryableError, retryWithTimeout } from "../retry.js";

describe("withRetry (extended) — 4 cenários principais", () => {
  it("sucesso na primeira tentativa — fn chamada exatamente 1x", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retry com sucesso após 2 falhas — fn chamada 3x", async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error("fail");
      return "ok";
    });
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, jitter: false });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retry esgota maxRetries=2 — fn chamada 3x (1 + 2 retries) e lança", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fail"));
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, jitter: false }))
      .rejects.toThrow("always fail");
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });

  it("error não-retornável (retryOn=false) para imediatamente após 1ª chamada", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fatal"));
    await expect(withRetry(fn, {
      maxRetries: 5,
      baseDelayMs: 1,
      retryOn: () => false,
    })).rejects.toThrow("fatal");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("withRetry (extended) — backoff", () => {
  it("backoff cresce exponencialmente sem jitter (delay previsível)", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      backoffMultiplier: 2,
      jitter: false,
      onRetry: (_a, _e, d) => delays.push(d),
    }).catch(() => {});
    // Sem jitter: delay = base * mult^attempt
    // attempt 0: 10 * 2^0 = 10
    // attempt 1: 10 * 2^1 = 20
    // attempt 2: 10 * 2^2 = 40
    expect(delays).toEqual([10, 20, 40]);
  });

  it("maxDelayMs limita o delay máximo mesmo com backoff alto", async () => {
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 100,
      backoffMultiplier: 10,
      maxDelayMs: 250,
      jitter: false,
      onRetry: (_a, _e, d) => delays.push(d),
    }).catch(() => {});
    // Todos os delays devem ser <= 250
    for (const d of delays) expect(d).toBeLessThanOrEqual(250);
    expect(delays.length).toBe(3);
  });
});

describe("withRetry (extended) — edge cases", () => {
  it("maxRetries=0 significa 1 tentativa só, sem retry", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("nope"));
    await expect(withRetry(fn, { maxRetries: 0, baseDelayMs: 1 }))
      .rejects.toThrow("nope");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("onRetry recebe attempt começando em 1 (não 0)", async () => {
    const attempts: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error("x"));
    await withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 1,
      jitter: false,
      onRetry: (a) => attempts.push(a),
    }).catch(() => {});
    expect(attempts).toEqual([1, 2]);
  });
});

describe("isRetryableError (extended)", () => {
  it("EAI_AGAIN e EHOSTUNREACH são retryable", () => {
    expect(isRetryableError({ code: "EAI_AGAIN" })).toBe(true);
    expect(isRetryableError({ code: "EHOSTUNREACH" })).toBe(true);
  });

  it("error.cause.code também é verificado (nested)", () => {
    expect(isRetryableError({ cause: { code: "ECONNRESET" } })).toBe(true);
  });

  it("status 599 (5xx) é retryable; 404 não é", () => {
    expect(isRetryableError({ status: 599 })).toBe(true);
    expect(isRetryableError({ status: 404 })).toBe(false);
  });
});

describe("retryWithTimeout (extended)", () => {
  it("timeout error também é retryable quando usa retryOn default", async () => {
    // Sem retryOn, todo erro é retryable; timeout lança e faz retry até esgotar
    let calls = 0;
    await expect(retryWithTimeout(
      async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 500));
        return "ok";
      },
      50,
      { maxRetries: 1, baseDelayMs: 1, jitter: false }
    )).rejects.toThrow("Timeout");
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
