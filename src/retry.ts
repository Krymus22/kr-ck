/**
 * retry.ts - Retry with exponential backoff and jitter.
 */

import * as log from "./logger.js";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitter?: boolean;
  retryOn?: (error: any) => boolean;
  onRetry?: (attempt: number, error: any, delayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "retryOn" | "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  let lastError: any;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= options.maxRetries) break;
      if (opts?.retryOn && !opts.retryOn(err)) break;

      const delay = calculateDelay(attempt, options);
      opts?.onRetry?.(attempt + 1, err, delay);
      log.warn(`Retry ${attempt + 1}/${options.maxRetries} after ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastError;
}

function calculateDelay(attempt: number, options: Required<Omit<RetryOptions, "retryOn" | "onRetry">>): number {
  let delay = options.baseDelayMs * Math.pow(options.backoffMultiplier, attempt);
  delay = Math.min(delay, options.maxDelayMs);

  if (options.jitter) {
    // Add +/-25% jitter
    const jitterRange = delay * 0.25;
    delay += (Math.random() * 2 - 1) * jitterRange;
  }

  return Math.max(0, Math.floor(delay));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Only 502 and 503 are retryable among 5xx errors.
// 500 is NOT retried (usually a real server bug — retrying would just hit the
// same bug again, wasting the user's token quota and time). 504 is also NOT
// retried (gateway timeout — the HTTP client already has its own timeout, so
// retrying would likely fail the same way).
// This mirrors apiClient.ts's RETRIABLE_5XX_STATUSES = new Set([502, 503])
// so the outer withRetry wrapper in agent.ts and the inner retry logic in
// apiClient.ts agree on what's retryable.
const RETRIABLE_5XX_STATUSES = new Set([502, 503]);

export function isRetryableError(error: any): boolean {
  const code = error?.code ?? error?.cause?.code;
  const retryableCodes = [
    "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE",
    "ECONNREFUSED", "EAI_AGAIN", "EHOSTUNREACH",
  ];

  if (typeof code === "string" && retryableCodes.includes(code)) return true;
  if (error?.status === 429) return true;
  // BUG FIX: previously, ALL 5xx were retried. This contradicted apiClient.ts
  // which only retries 502/503 (transient) and treats 500 as a real server
  // bug. The outer withRetry in agent.ts was retrying 500 errors that the
  // inner apiClient had already decided not to retry, wasting tokens and
  // time on a bug that wouldn't fix itself.
  if (typeof error?.status === "number" && RETRIABLE_5XX_STATUSES.has(error.status)) return true;

  return false;
}

export async function retryWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  opts?: RetryOptions
): Promise<T> {
  return withRetry(
    async () => {
      // BUG FIX: the setTimeout used for the per-attempt timeout was never
      // cleared when fn() settled first. Each call leaked a pending timer
      // that would fire later and reject an already-settled promise (causing
      // unhandled-rejection warnings in some runtimes and keeping the event
      // loop alive longer than necessary). Capture the handle and clear it
      // as soon as fn() settles.
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const result = await Promise.race([
          fn(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Timeout after ${timeoutMs}ms`)),
              timeoutMs
            );
          }),
        ]);
        return result;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
    opts
  );
}
