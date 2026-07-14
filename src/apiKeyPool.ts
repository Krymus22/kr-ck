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
import * as fs from "node:fs";
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

// BUG FIX: timeout was 0 (infinite). If NVIDIA accepts the TCP connection
// but never responds (load balancer issue, server hang), the socket would
// hang forever, freezing any pool-mode request (sub-agents, hedging, etc.).
// This must match apiClient.ts: a finite socket timeout as defense-in-depth
// alongside the OpenAI client's request timeout.
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,
  timeout: 5 * 60 * 1000,  // 5 min socket timeout — matches apiClient.ts
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
 *
 * HIGH FIX (BH2 HIGH 4 / §4 / §5.5): the LAST key in the pool is reserved
 * for heartbeat ("reserva") so it doesn't compete with user requests for
 * the 40 RPM per-key budget. The first pass iterates only NON-RESERVE
 * keys. The reserve is used ONLY as a fallback when no non-reserve key is
 * available (and it's not in cooldown / mutex-locked / rate-limited).
 *
 * For single-key pools (pool.length === 1), the only key is also the
 * reserve — there's no other option, so it's used directly.
 */
function pickNextKey(): PoolEntry | null {
  if (pool.length === 0) return null;
  const now = Date.now();

  // Index of the reserve key (last in the pool). -1 means no reserve
  // (only relevant for single-key pools where the only key is also the
  // reserve and there's no other option).
  const reserveIdx = pool.length > 1 ? pool.length - 1 : -1;

  // §17.13 rule 119: SCOUT_EXCLUDE_KEY_INDEX — when scout is making requests,
  // apiClient sets a module-level flag that tells us to skip a specific key
  // index (default 0). This reserves that key for the main agent so the scout
  // can't exhaust its rate limit quota. We read it via dynamic import to avoid
  // circular dependency (apiClient imports apiKeyPool).
  // The function returns -1 when no key is excluded (main agent mode).
  let scoutExcludeIdx = -1;
  try {
    // Synchronous dynamic import workaround: apiClient exports a getter that
    // returns the current exclude index. We use a globalThis cache to avoid
    // re-importing on every pickNextKey call (which fires per LLM call).
    const getter = (globalThis as any).__ckGetScoutExcludeKeyIndex;
    if (getter) {
      scoutExcludeIdx = getter();
    }
  } catch { /* ignore — fail open (no exclusion) */ }

  // First pass: try all NON-RESERVE keys (round-robin from nextIndex).
  for (let i = 0; i < pool.length; i++) {
    const idx = (nextIndex + i) % pool.length;
    if (idx === reserveIdx) continue;  // skip reserve in first pass
    if (idx === scoutExcludeIdx) continue;  // §17.13 rule 119: skip scout-excluded key
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

  // Second pass (fallback): if no non-reserve key was available, use the
  // reserve key — but only if it's free, not in cooldown, and not
  // rate-limited. This prevents the pool from blocking user requests when
  // only the reserve is idle, while still preferring non-reserve keys for
  // normal operation so heartbeat has its own budget.
  // BH-SCOUT-EXCLUDE-KEY MEDIUM-1 fix: also skip reserve if it's the excluded key.
  if (reserveIdx >= 0 && reserveIdx !== scoutExcludeIdx) {
    const reserve = pool[reserveIdx];
    if (reserve.stats.cooldownUntil <= now && !reserve.mutex.locked) {
      const rl = checkRateLimit(reserve);
      if (rl.allowed) {
        nextIndex = (reserveIdx + 1) % pool.length;
        return reserve;
      }
    }
  }

  return null;
}

/**
 * Pick a key, waiting if necessary until one becomes available.
 * Throws if pool is empty or all keys are in long cooldown.
 *
 * BUG FIX: previously, when all keys were in 429 cooldown
 * (COOLDOWN_AFTER_429_MS = 60_000) and the default maxWaitMs was also
 * 60_000, the polling loop's deadline (Date.now() < deadline) would
 * expire at almost exactly the moment the cooldowns released. The
 * function would throw "All keys busy or rate-limited" instead of
 * returning the now-available key. The fix: do ONE final non-blocking
 * pickNextKey() check after the loop exits, so a key that became
 * available during the last 100ms sleep is still returned.
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
  // Last-chance check: a key may have become available in the final
  // 100ms sleep (e.g. cooldown expired exactly at the deadline). This
  // prevents the race where maxWaitMs == COOLDOWN_AFTER_429_MS.
  const lastChance = pickNextKey();
  if (lastChance) {
    await acquireMutex(lastChance);
    lastChance.callCount++;
    lastChance.stats.inFlight++;
    return lastChance;
  }
  // BH-403-SCOUT-SUMMARY MEDIUM-4 fix: include breakdown of WHY keys are
  // unavailable, so operators can distinguish "all busy" from "all 403'd
  // (possibly revoked)" — actionable hint for debugging.
  const now = Date.now();
  const in403 = pool.filter(e => e.stats.cooldownUntil > now && e.stats.errorCount > 0 && e.stats.rateLimitedCount === 0).length;
  const in429 = pool.filter(e => e.stats.cooldownUntil > now && e.stats.rateLimitedCount > 0).length;
  const busy = pool.filter(e => e.mutex.locked).length;
  let msg = `[API_POOL] All keys busy or rate-limited after ${maxWaitMs}ms - pool size: ${pool.length}`;
  msg += ` (busy: ${busy}, in 429 cooldown: ${in429}, in 403 cooldown: ${in403})`;
  if (in403 === pool.length && in429 === 0 && busy === 0) {
    msg += ` — all keys returned 403. Check NVIDIA_API_KEY validity (keys may be revoked).`;
  }
  throw new Error(msg);
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
    // §17.13 rule 113: 403 -> cooldown this key for 60s (same as 429).
    // NVIDIA free tier sometimes returns 403 when a key hits its 40 RPM quota
    // (instead of the correct 429). Other times it's a transient glitch.
    // Either way, cooldown + try another key is the right move.
    // Without this, the pool keeps using the same 403'd key and the user
    // sees persistent failures even when other keys are available.
    if (httpStatus === 403) {
      entry.stats.cooldownUntil = Date.now() + COOLDOWN_AFTER_429_MS;
      log.warn(`[API_POOL] Key #${entry.index} (${entry.stats.keyPrefix}) hit 403 - cooling down for ${COOLDOWN_AFTER_429_MS / 1000}s (try another key)`);
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

  // Prewarm ALL keys in parallel so they're all ready for the first request.
  // max_tokens=1 keeps it cheap (1 token generated, ~10ms on warm model).
  // stream=false so we don't trigger the streaming parser.
  //
  // CRITICAL FIX (BH2 CRITICAL 1): each prewarm request must respect the
  // per-key mutex + rate-limit + stats + 429-cooldown invariants — same as
  // a real user request. Without this, a user request arriving during the
  // 5-30s prewarm window could pickNextKey() the SAME entry (mutex still
  // unlocked) and fire a 2nd in-flight request on that key → 429 (violates
  // §5.1/§5.5: "1 in-flight por key — NVIDIA free tier não permite mais").
  // Prewarm 429s also need to set cooldownUntil (§5.3) so the next user
  // request doesn't immediately re-hit a rate-limited key.
  //
  // Prewarm is fire-and-forget and parallel; if a user request is already
  // in flight on a given key, skip prewarm for that key (don't wait —
  // prewarm is best-effort, user requests take priority).
  const results = await Promise.allSettled(
    pool.map(async (entry, i) => {
      const t0 = Date.now();
      // Non-blocking: if a user request holds the mutex, skip this key's
      // prewarm. The next idle moment will let the real first request
      // warm the model naturally.
      if (entry.mutex.locked) {
        log.debug(`[PREWARM] Key #${i} (${entry.stats.keyPrefix}) busy (mutex locked) — skipping`);
        return { ok: false, elapsed: 0, index: i, error: "skipped: mutex locked" };
      }
      // Synchronous lock — we just verified mutex.locked is false, and JS
      // is single-threaded so no other coroutine can grab it between the
      // check and the set. Same pattern as tryAcquireKeyImmediate().
      entry.mutex.locked = true;
      entry.callCount++;
      entry.stats.inFlight++;
      let httpStatus: number | null = null;
      let success = false;
      try {
        await entry.client.chat.completions.create({
          model: PREWARM_MODEL,
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
          stream: false,
        });
        success = true;
        const elapsed = Date.now() - t0;
        log.debug(`[PREWARM] Key #${i} (${entry.stats.keyPrefix}) warm in ${elapsed}ms`);
        return { ok: true, elapsed, index: i };
      } catch (err: unknown) {
        const elapsed = Date.now() - t0;
        const msg = err instanceof Error ? err.message : String(err);
        // Capture HTTP status so releaseKey() can set cooldownUntil on 429.
        httpStatus = (err as any)?.status ?? (err as any)?.response?.status ?? null;
        log.warn(`[PREWARM] Key #${i} (${entry.stats.keyPrefix}) failed in ${elapsed}ms: ${msg}`);
        return { ok: false, elapsed, index: i, error: msg };
      } finally {
        // releaseKey handles: inFlight--, totalCalls++, latency tracking,
        // 429 cooldown (§5.3), and releaseMutex. Same path as user requests,
        // so pool stats stay consistent and 429s during prewarm correctly
        // trigger cooldown for the next user request.
        releaseKey(entry, success, httpStatus, Date.now() - t0);
      }
    })
  );

  const ok = results.filter((r) => r.status === "fulfilled" && r.value.ok).length;
  const fail = results.length - ok;
  const totalMs = Date.now() - start;

  if (fail === 0) {
    log.success(`[PREWARM] All ${ok} key(s) warm in ${totalMs}ms`);
    emitPrewarmEvent({ type: "complete", ok, total: results.length, elapsed: totalMs });
  } else if (ok > 0) {
    log.warn(`[PREWARM] ${ok}/${results.length} key(s) warm in ${totalMs}ms (${fail} failed)`);
    emitPrewarmEvent({ type: "partial", ok, total: results.length, elapsed: totalMs });
  } else {
    log.error(`[PREWARM] All ${fail} key(s) failed in ${totalMs}ms — first real request will be slow`);
    emitPrewarmEvent({ type: "all_failed", total: results.length, elapsed: totalMs });
  }
}

/**
 * Reset prewarm state — for tests that want to re-prewarm.
 */
export function resetPrewarm(): void {
  prewarmed = false;
}

// --- Prewarm event system (for TUI display) --------------------------------
// Since commit 50898c8, log.* calls are suppressed in TUI mode. To surface
// prewarm results to the user without re-introducing scroll-stealing
// (console.log between Ink frames), we use a callback that the TUI registers.

export type PrewarmEvent =
  | { type: "complete"; ok: number; total: number; elapsed: number }
  | { type: "partial"; ok: number; total: number; elapsed: number }
  | { type: "all_failed"; total: number; elapsed: number };

type PrewarmListener = (event: PrewarmEvent) => void;
let prewarmListener: PrewarmListener | null = null;

/**
 * Register a listener for prewarm completion events. The TUI uses this to
 * surface prewarm results to the user (as systemMessages) without using
 * console.log (which would re-introduce scroll-stealing in TUI mode).
 *
 * Only one listener at a time (the TUI). Pass null to unregister.
 */
export function setPrewarmListener(cb: PrewarmListener | null): void {
  prewarmListener = cb;
}

function emitPrewarmEvent(event: PrewarmEvent): void {
  if (prewarmListener) {
    try {
      prewarmListener(event);
    } catch {
      // listener errors must never crash prewarm
    }
  }
}
