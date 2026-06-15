/**
 * retry.ts — Retry with exponential backoff and jitter.
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
    // Add ±25% jitter
    const jitterRange = delay * 0.25;
    delay += (Math.random() * 2 - 1) * jitterRange;
  }

  return Math.max(0, Math.floor(delay));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function isRetryableError(error: any): boolean {
  const code = error?.code ?? error?.cause?.code;
  const retryableCodes = [
    "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE",
    "ECONNREFUSED", "EAI_AGAIN", "EHOSTUNREACH",
  ];

  if (typeof code === "string" && retryableCodes.includes(code)) return true;
  if (error?.status === 429) return true;
  if (error?.status >= 500 && error?.status < 600) return true;

  return false;
}

export async function retryWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  opts?: RetryOptions
): Promise<T> {
  return withRetry(
    async () => {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      return result;
    },
    opts
  );
}
