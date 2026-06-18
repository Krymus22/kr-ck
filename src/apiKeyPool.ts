/**
 * apiKeyPool.ts - Multi-key pool for NVIDIA NIM API.
 *
 * Allows the agent to use multiple NVIDIA API keys in parallel, each with its
 * own 40 RPM / 1 concurrent request quota. Sub-agents can pick a free key
 * and run truly in parallel without contending with the main agent.
 *
 * Design:
 *   - Pool of N keys, each with its own OpenAI client instance
 *   - Round-robin selection when a key is requested
 *   - Per-key mutex: only 1 in-flight request per key (NVIDIA free-tier limit)
 *   - Per-key rate limiter: 40 RPM sliding window
 *   - 429-aware: a key that returns 429 is cooled down for 60s before reuse
 *   - Metrics: per-key call count, 429 count, last latency
 *
 * Configuration:
 *   - NVIDIA_API_KEY (existing, single key) - kept for backwards compat
 *   - NVIDIA_API_KEYS (new, comma-separated) - preferred for multi-key
 *   - NVIDIA_API_KEYS_FILE (new, file path with one key per line) - for many keys
 *
 * If only NVIDIA_API_KEY is set, the pool has 1 entry and behavior is identical
 * to before (no regression for existing users).
 */

import OpenAI from "openai";
import https from "node:https";
import * as log from "./logger.js";

// Prewarm config — model name comes from process.env.MODEL at module load.
// We don't import config.js to avoid circular dependency (config imports apiKeyPool).
const PREWARM_MODEL = process.env.MODEL ?? "moonshotai/kimi-k2.6";

// --- Types -------------------------------------------------------------------

export interface ApiKeyStats {
  index: number;
  keyPrefix: string;       // first 12 chars only - never log full key
  totalCalls: number;
  successCount: number;
  errorCount: number;
  rateLimitedCount: number;
  cooldownUntil: number;   // epoch ms; 0 if not cooling down
  lastLatencyMs: number;
  avgLatencyMs: number;
  inFlight: number;
}

interface PoolEntry {
  index: number;
  apiKey: string;
  client: OpenAI;
  mutex: { locked: boolean; queue: Array<() => void> };
  windowStart: number;     // start of current 60s window
  callCount: number;       // calls in current window
  stats: ApiKeyStats;
  latencies: number[];     // last 50 latencies for avg
}

// --- Config ------------------------------------------------------------------

const RATE_LIMIT_RPM = 40;
const RATE_LIMIT_WINDOW_MS = 60_000;
const COOLDOWN_AFTER_429_MS = 60_000;
const MAX_LATENCY_SAMPLES = 50;
const BASE_URL = "https://integrate.api.nvidia.com/v1";

// --- Keepalive agent (reuse the same config as apiClient.ts) -----------------

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  timeout: 0,
  maxSockets: 10,
  scheduling: "lifo",
});

// --- Pool State --------------------------------------------------------------

let pool: PoolEntry[] = [];
let nextIndex = 0; // round-robin pointer

// --- Initialization ----------------------------------------------------------

/**
 * Load API keys from env vars. Priority:
 *   1. NVIDIA_API_KEYS (comma-separated)
 *   2. NVIDIA_API_KEYS_FILE (one per line)
 *   3. NVIDIA_API_KEY (single, backwards compat)
 *
 * Returns empty array if no keys configured.
 */
export function loadApiKeys(): string[] {
  // 1. Try comma-separated list
  const keys = parseCommaSeparatedKeys(process.env.NVIDIA_API_KEYS);
  if (keys.length > 0) return keys;

  // 2. Try file with one key per line
  const fileKeys = loadKeysFromFile(process.env.NVIDIA_API_KEYS_FILE);
  if (fileKeys.length > 0) return fileKeys;

  // 3. Fall back to single key
  const single = process.env.NVIDIA_API_KEY?.trim();
  if (single?.startsWith("nvapi-")) return [single];

  return [];
}

function parseCommaSeparatedKeys(raw: string | undefined): string[] {
  const list = raw?.trim();
  if (!list) return [];
  const keys: string[] = [];
  for (const k of list.split(",")) {
    const trimmed = k.trim();
    if (trimmed.startsWith("nvapi-")) keys.push(trimmed);
  }
  return keys;
}

function loadKeysFromFile(filePath: string | undefined): string[] {
  const path = filePath?.trim();
  if (!path) return [];
  try {
    const fs = require("node:fs");
    const content = fs.readFileSync(path, "utf8");
    const keys: string[] = [];
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("nvapi-")) keys.push(trimmed);
    }
    log.info(`[API_POOL] Loaded ${keys.length} key(s) from ${path}`);
    return keys;
  } catch (err) {
    log.warn(`[API_POOL] Failed to read keys file ${path}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Initialize the pool. Must be called once at startup.
 * If no keys are configured, returns false (caller should fall back to single-key mode).
 */
export function initApiKeyPool(): boolean {
  if (pool.length > 0) return true; // already initialized

  const keys = loadApiKeys();
  if (keys.length === 0) {
    log.warn("[API_POOL] No API keys configured - falling back to single-key mode");
    return false;
  }

  pool = keys.map((apiKey, index) => {
    const client = new OpenAI({
      apiKey,
      baseURL: BASE_URL,
      timeout: 5 * 60 * 1000,
      httpAgent: keepAliveAgent,
    });
    return {
      index,
      apiKey,
      client,
      mutex: { locked: false, queue: [] },
      windowStart: Date.now(),
      callCount: 0,
      stats: {
        index,
        keyPrefix: apiKey.slice(0, 10) + "...",  // nvapi-XXXX... (never log full key)
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        rateLimitedCount: 0,
        cooldownUntil: 0,
        lastLatencyMs: 0,
        avgLatencyMs: 0,
        inFlight: 0,
      },
      latencies: [],
    };
  });

  log.success(`[API_POOL] Initialized with ${pool.length} key(s) - effective throughput ~${pool.length * RATE_LIMIT_RPM} RPM, ${pool.length} concurrent`);
  return true;
}

/**
 * Get the number of keys in the pool.
 */
export function getPoolSize(): number {
  return pool.length;
}

// --- Mutex (1 concurrent per key) --------------------------------------------

async function acquireMutex(entry: PoolEntry): Promise<void> {
  if (!entry.mutex.locked) {
    entry.mutex.locked = true;
    return;
  }
  await new Promise<void>((resolve) => {
    entry.mutex.queue.push(resolve);
  });
  entry.mutex.locked = true;
}

function releaseMutex(entry: PoolEntry): void {
  const next = entry.mutex.queue.shift();
  if (next) {
    next();
  } else {
    entry.mutex.locked = false;
  }
}

// --- Rate limiter (40 RPM sliding window per key) ----------------------------

function checkRateLimit(entry: PoolEntry): { allowed: boolean; waitMs: number } {
  const now = Date.now();
  // Reset window if expired
  if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry.windowStart = now;
    entry.callCount = 0;
  }
  if (entry.callCount < RATE_LIMIT_RPM) {
    return { allowed: true, waitMs: 0 };
  }
  // Window full - must wait until oldest call falls out
  const waitMs = RATE_LIMIT_WINDOW_MS - (now - entry.windowStart) + 100;
  return { allowed: false, waitMs };
}

// --- Key selection -----------------------------------------------------------

/**
 * Pick the next available key (round-robin, skipping cooled-down or rate-limited).
 * Returns null if ALL keys are unavailable.
 */
function pickNextKey(): PoolEntry | null {
  if (pool.length === 0) return null;
  const now = Date.now();

  // Try up to pool.length entries starting from nextIndex
  for (let i = 0; i < pool.length; i++) {
    const idx = (nextIndex + i) % pool.length;
    const entry = pool[idx];
    // Skip if cooling down after 429
    if (entry.stats.cooldownUntil > now) continue;
    // Skip if rate-limited in current window
    const rl = checkRateLimit(entry);
    if (!rl.allowed) continue;
    // Skip if currently in use (mutex locked)
    if (entry.mutex.locked) continue;
    // Found a free key
    nextIndex = (idx + 1) % pool.length;
    return entry;
  }
  return null;
}

/**
 * Pick a key, waiting if necessary until one becomes available.
 * Throws if pool is empty or all keys are in long cooldown.
 */
async function acquireKey(maxWaitMs: number = 60_000): Promise<PoolEntry> {
  if (pool.length === 0) {
    throw new Error("API key pool is empty - initialize with initApiKeyPool() first");
  }
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const entry = pickNextKey();
    if (entry) {
      await acquireMutex(entry);
      entry.callCount++;
      entry.stats.inFlight++;
      return entry;
    }
    // No key available - wait 100ms and retry
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`[API_POOL] All keys busy or rate-limited after ${maxWaitMs}ms - pool size: ${pool.length}`);
}

function releaseKey(entry: PoolEntry, success: boolean, httpStatus: number | null, latencyMs: number): void {
  entry.stats.inFlight--;
  entry.stats.totalCalls++;
  entry.stats.lastLatencyMs = latencyMs;
  entry.latencies.push(latencyMs);
  if (entry.latencies.length > MAX_LATENCY_SAMPLES) entry.latencies.shift();
  entry.stats.avgLatencyMs = entry.latencies.reduce((a, b) => a + b, 0) / entry.latencies.length;

  if (success) {
    entry.stats.successCount++;
  } else {
    entry.stats.errorCount++;
    // 429 -> cooldown this key for 60s
    if (httpStatus === 429) {
      entry.stats.rateLimitedCount++;
      entry.stats.cooldownUntil = Date.now() + COOLDOWN_AFTER_429_MS;
      log.warn(`[API_POOL] Key #${entry.index} (${entry.stats.keyPrefix}) hit 429 - cooling down for ${COOLDOWN_AFTER_429_MS / 1000}s`);
    }
  }

  releaseMutex(entry);
}

// --- Public API: run a chat completion on the pool ---------------------------

/**
 * Execute a chat completion using an available key from the pool.
 * This is the main entry point - replaces direct calls to client.chat.completions.create.
 *
 * Automatically handles:
 *   - Key selection (round-robin, skipping cooled-down)
 *   - Per-key mutex (1 concurrent per key)
 *   - Per-key rate limit (40 RPM)
 *   - 429 cooldown (60s)
 *   - Latency tracking
 *
 * Returns the OpenAI response.
 */
export async function poolChatCompletion(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  if (pool.length === 0) {
    if (!initApiKeyPool()) {
      throw new Error("No API keys configured - set NVIDIA_API_KEY or NVIDIA_API_KEYS env var");
    }
  }

  const entry = await acquireKey();
  const start = Date.now();
  let httpStatus: number | null = null;
  let success = false;

  try {
    // Convert streaming params to non-streaming for simplicity in pool mode
    // (the apiClient.ts streaming layer wraps this; here we just need the response)
    const response = await entry.client.chat.completions.create({
      ...params,
      stream: false,
    } as any);
    success = true;
    return response as OpenAI.Chat.Completions.ChatCompletion;
  } catch (err: any) {
    httpStatus = err?.status ?? err?.response?.status ?? null;
    throw err;
  } finally {
    releaseKey(entry, success, httpStatus, Date.now() - start);
  }
}

/**
 * Get a client instance from the pool for direct streaming use.
 * Use this when you need streaming (the main agent's streaming loop).
 *
 * The caller is responsible for releasing the key via releaseKeyForStreaming
 * when the stream completes or errors.
 */
export async function acquireKeyForStreaming(): Promise<{
  client: OpenAI;
  entry: PoolEntry;
  release: (success: boolean, httpStatus: number | null, latencyMs: number) => void;
}> {
  if (pool.length === 0) {
    if (!initApiKeyPool()) {
      throw new Error("No API keys configured - set NVIDIA_API_KEY or NVIDIA_API_KEYS env var");
    }
  }
  const entry = await acquireKey();
  return {
    client: entry.client,
    entry,
    release: (success, httpStatus, latencyMs) => releaseKey(entry, success, httpStatus, latencyMs),
  };
}

/**
 * Try to acquire a key WITHOUT blocking. Returns null immediately if no key is free.
 * Used by delayed hedging to grab a 2nd key for backup without waiting.
 *
 * This is the key insight: if the main agent is using key A, and a sub-agent
 * is using key B, only key C is free. Hedging will try to acquire C as backup.
 * If C is also busy, hedging is skipped (1-key mode).
 */
export function tryAcquireKeyImmediate(): {
  client: OpenAI;
  entry: PoolEntry;
  release: (success: boolean, httpStatus: number | null, latencyMs: number) => void;
} | null {
  if (pool.length === 0) return null;
  const entry = pickNextKey();
  if (!entry) return null;
  // acquireMutex is synchronous — if locked, pickNextKey already skipped it
  // But we need to double-check since pickNextKey checks mutex.locked
  // and acquireMutex sets it. Since JS is single-threaded, no race.
  acquireMutex(entry);
  entry.callCount++;
  entry.stats.inFlight++;
  return {
    client: entry.client,
    entry,
    release: (success, httpStatus, latencyMs) => releaseKey(entry, success, httpStatus, latencyMs),
  };
}

/**
 * Count how many keys in the pool are currently free (not in use, not cooling down).
 * Used to decide whether hedging is possible.
 */
export function getAvailableKeyCount(): number {
  if (pool.length === 0) return 0;
  const now = Date.now();
  let count = 0;
  for (const entry of pool) {
    if (entry.stats.cooldownUntil > now) continue;
    if (entry.mutex.locked) continue;
    const rl = checkRateLimit(entry);
    if (!rl.allowed) continue;
    count++;
  }
  return count;
}

/**
 * Get total pool size (all keys, including busy ones).
 */
export function getTotalKeyCount(): number {
  return pool.length;
}

// --- Metrics -----------------------------------------------------------------

export function getPoolStats(): ApiKeyStats[] {
  return pool.map((e) => ({ ...e.stats }));
}

export function formatPoolStats(): string {
  if (pool.length === 0) return "[API_POOL] Pool empty";
  const lines = pool.map((e) => {
    const s = e.stats;
    const cd = s.cooldownUntil > Date.now() ? ` COOLDOWN ${Math.ceil((s.cooldownUntil - Date.now()) / 1000)}s` : "";
    const inflight = s.inFlight > 0 ? ` ...${s.inFlight}` : "";
    return `  #${s.index} ${s.keyPrefix} | calls=${s.totalCalls} ok=${s.successCount} err=${s.errorCount} 429=${s.rateLimitedCount} | avg=${Math.round(s.avgLatencyMs)}ms last=${s.lastLatencyMs}ms${inflight}${cd}`;
  });
  return `[API_POOL] ${pool.length} key(s):\n${lines.join("\n")}`;
}

/**
 * Reset all stats - useful for testing.
 */
export function resetPoolStats(): void {
  for (const entry of pool) {
    entry.stats.totalCalls = 0;
    entry.stats.successCount = 0;
    entry.stats.errorCount = 0;
    entry.stats.rateLimitedCount = 0;
    entry.stats.cooldownUntil = 0;
    entry.stats.lastLatencyMs = 0;
    entry.stats.avgLatencyMs = 0;
    entry.stats.inFlight = 0;
    entry.latencies = [];
    entry.windowStart = Date.now();
    entry.callCount = 0;
  }
}

/**
 * Reset the entire pool - for tests that need to reinitialize with different keys.
 */
export function resetPool(): void {
  pool = [];
  nextIndex = 0;
}

// --- Prewarm -----------------------------------------------------------------

/**
 * Whether prewarm has been requested (idempotent — only runs once).
 * Subsequent calls to prewarmPool() are no-ops.
 */
let prewarmed = false;

/**
 * Prewarm all keys in the pool by sending a tiny "hi" request to each.
 *
 * Why this matters:
 *   1. **TLS handshake**: the first HTTPS request to integrate.api.nvidia.com
 *      takes 200-500ms for the TLS handshake. Prewarm does it once at startup
 *      so the first real user request skips it.
 *   2. **Connection pool**: the keepAlive agent reuses sockets. Prewarm
 *      establishes the first socket so subsequent requests reuse it.
 *   3. **Model warmup on NVIDIA side**: NVIDIA NIM keeps models "warm" in
 *      GPU memory after the first request. Without prewarm, the first real
 *      user request hits a cold model (load from disk = 5-30s). With prewarm,
 *      the model is already loaded when the user sends their first message.
 *
 * This runs in the background (fire-and-forget) — the app doesn't wait for
 * it. If prewarm fails (network error, invalid key), it's logged but doesn't
 * crash the app. The first real request will do the warmup naturally.
 *
 * Idempotent: calling prewarmPool() multiple times only prewarms once.
 *
 * @returns a Promise that resolves when all prewarm requests complete (or fail).
 *          Callers can await this if they want to block startup until warm,
 *          but typically it's fire-and-forget.
 */
export async function prewarmPool(): Promise<void> {
  if (prewarmed) return;
  if (pool.length === 0) {
    log.debug("[PREWARM] Pool not initialized, skipping prewarm");
    return;
  }
  prewarmed = true;

  const start = Date.now();
  log.info(`[PREWARM] Warming ${pool.length} key(s) to ${PREWARM_MODEL}...`);

  // Fire a tiny request to each key in parallel.
  // max_tokens=1 keeps it cheap (1 token generated, ~10ms on warm model).
  // stream=false so we don't trigger the streaming parser.
  const results = await Promise.allSettled(
    pool.map(async (entry, i) => {
      const t0 = Date.now();
      try {
        await entry.client.chat.completions.create({
          model: PREWARM_MODEL,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
          stream: false,
        });
        const elapsed = Date.now() - t0;
        log.debug(`[PREWARM] Key #${i} (${entry.stats.keyPrefix}) warm in ${elapsed}ms`);
        return { ok: true, elapsed, index: i };
      } catch (err: unknown) {
        const elapsed = Date.now() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[PREWARM] Key #${i} (${entry.stats.keyPrefix}) failed in ${elapsed}ms: ${msg}`);
        return { ok: false, elapsed, index: i, error: msg };
      }
    })
  );

  const ok = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
  const fail = results.length - ok;
  const totalMs = Date.now() - start;

  if (fail === 0) {
    log.success(`[PREWARM] All ${ok} key(s) warm in ${totalMs}ms`);
  } else if (ok > 0) {
    log.warn(`[PREWARM] ${ok}/${results.length} key(s) warm in ${totalMs}ms (${fail} failed)`);
  } else {
    log.error(`[PREWARM] All ${fail} key(s) failed in ${totalMs}ms — first real request will be slow`);
  }
}

/**
 * Reset prewarm state — for tests that want to re-prewarm.
 */
export function resetPrewarm(): void {
  prewarmed = false;
}
