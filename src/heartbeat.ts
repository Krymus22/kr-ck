/**
 * heartbeat.ts - Background heartbeat to keep the model warm on NVIDIA NIM.
 *
 * Problem solved: NVIDIA NIM on build.nvidia.com (free tier) unloads models
 * from GPU memory after 30-60 minutes of inactivity. The next request then
 * triggers a "cold start" — the model must be reloaded from disk into VRAM,
 * which takes 5-60 seconds (we measured 42 seconds in real testing).
 *
 * Solution: send a tiny "heartbeat" request (1 token) every 5 minutes. This
 * resets the idle timeout on NVIDIA's side, keeping the model loaded in VRAM.
 * The first real user request then hits a warm model (600ms instead of 42s).
 *
 * Cost analysis (3 keys, 5-min interval):
 *   - 12 heartbeats/hour = 288/day per key
 *   - Free tier: 40 RPM = 57,600 requests/day per key
 *   - Heartbeat uses 0.5% of daily quota — negligible
 *   - ~5 tokens per heartbeat = 1,440 tokens/day — imperceptible
 *
 * The heartbeat uses a SINGLE key (round-robin) to avoid wasting all 3 keys'
 * rate limit on keep-alive. Real user requests use all 3 keys via the pool.
 */

import type OpenAI from "openai";
import * as log from "./logger.js";

// --- Config (env vars) -----------------------------------------------------

/** Heartbeat interval in milliseconds. Default: 1 minute (60000ms). */
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? "60000", 10);

/** Whether heartbeat is enabled. Default: true. Set HEARTBEAT_ENABLED=0 to disable. */
const HEARTBEAT_ENABLED = process.env.HEARTBEAT_ENABLED !== "0";

/** Model to heartbeat (from process.env.MODEL, set at module load). */
const HEARTBEAT_MODEL = process.env.MODEL ?? "moonshotai/kimi-k2.6";

// --- State -----------------------------------------------------------------

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatRunning = false;
let lastHeartbeatOk = true;
let lastHeartbeatLatencyMs = 0;
let lastHeartbeatTime = 0;
let consecutiveFailures = 0;
let totalHeartbeats = 0;
let totalSuccess = 0;
let totalFailures = 0;

// --- Types -----------------------------------------------------------------

export interface HeartbeatStats {
  enabled: boolean;
  running: boolean;
  intervalMs: number;
  model: string;
  totalHeartbeats: number;
  totalSuccess: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastHeartbeatOk: boolean;
  lastHeartbeatLatencyMs: number;
  lastHeartbeatTime: number; // epoch ms, 0 if never
  /** "warm" if last heartbeat was < 5s, "cold" if > 10s, "unknown" if never. */
  modelState: "warm" | "cold" | "unknown";
}

// --- Public API ------------------------------------------------------------

/**
 * Start the background heartbeat. Sends a tiny request every
 * HEARTBEAT_INTERVAL_MS (default 5 min) to keep the model warm.
 *
 * Uses the provided OpenAI client (typically the first key in the pool).
 * The heartbeat is fire-and-forget — it doesn't block or interfere with
 * real user requests.
 *
 * Idempotent: calling startHeartbeat() multiple times is safe (only starts
 * one timer).
 *
 * @param client  The OpenAI client to use for heartbeats (first pool key).
 */
export function startHeartbeat(client: OpenAI): void {
  if (!HEARTBEAT_ENABLED) {
    log.debug("[HEARTBEAT] Disabled via HEARTBEAT_ENABLED=0");
    return;
  }
  if (heartbeatTimer) {
    log.debug("[HEARTBEAT] Already running");
    return;
  }

  log.info(`[HEARTBEAT] Starting (interval=${HEARTBEAT_INTERVAL_MS}ms, model=${HEARTBEAT_MODEL})`);

  // Send first heartbeat immediately (don't wait 5 min for the first one)
  sendHeartbeat(client).catch(() => { /* errors logged inside */ });

  // Schedule periodic heartbeats
  heartbeatTimer = setInterval(() => {
    sendHeartbeat(client).catch(() => { /* errors logged inside */ });
  }, HEARTBEAT_INTERVAL_MS);

  // Don't keep the process alive just for the heartbeat
  if (heartbeatTimer && typeof heartbeatTimer.unref === "function") {
    heartbeatTimer.unref();
  }
}

/**
 * Stop the background heartbeat. Safe to call even if not running.
 */
export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    log.info("[HEARTBEAT] Stopped");
  }
}

/**
 * Get current heartbeat statistics. Used by the StatusBar to show
 * "warm" / "cold" / "unknown" state.
 */
export function getHeartbeatStats(): HeartbeatStats {
  let modelState: "warm" | "cold" | "unknown" = "unknown";
  if (lastHeartbeatTime > 0) {
    if (lastHeartbeatLatencyMs < 5000) modelState = "warm";
    else if (lastHeartbeatLatencyMs > 10000) modelState = "cold";
    else modelState = "warm"; // 5-10s is borderline, treat as warm
  }
  return {
    enabled: HEARTBEAT_ENABLED,
    running: heartbeatTimer !== null,
    intervalMs: HEARTBEAT_INTERVAL_MS,
    model: HEARTBEAT_MODEL,
    totalHeartbeats,
    totalSuccess,
    totalFailures,
    consecutiveFailures,
    lastHeartbeatOk,
    lastHeartbeatLatencyMs,
    lastHeartbeatTime,
    modelState,
  };
}

/**
 * Reset heartbeat state — for tests.
 */
export function resetHeartbeat(): void {
  stopHeartbeat();
  heartbeatRunning = false;
  lastHeartbeatOk = true;
  lastHeartbeatLatencyMs = 0;
  lastHeartbeatTime = 0;
  consecutiveFailures = 0;
  totalHeartbeats = 0;
  totalSuccess = 0;
  totalFailures = 0;
}

// --- Internal --------------------------------------------------------------

/**
 * Send a single heartbeat request. Updates stats on success/failure.
 * Never throws — errors are logged and stats are updated.
 */
async function sendHeartbeat(client: OpenAI): Promise<void> {
  if (heartbeatRunning) {
    log.debug("[HEARTBEAT] Previous heartbeat still running, skipping");
    return;
  }
  heartbeatRunning = true;
  totalHeartbeats++;

  const start = Date.now();
  try {
    await client.chat.completions.create({
      model: HEARTBEAT_MODEL,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
      temperature: 0,
    });
    const elapsed = Date.now() - start;
    lastHeartbeatLatencyMs = elapsed;
    lastHeartbeatTime = Date.now();
    lastHeartbeatOk = true;
    consecutiveFailures = 0;
    totalSuccess++;
    log.debug(`[HEARTBEAT] OK in ${elapsed}ms (${elapsed < 5000 ? "warm" : elapsed > 10000 ? "cold" : "borderline"})`);
  } catch (err: unknown) {
    const elapsed = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    lastHeartbeatOk = false;
    consecutiveFailures++;
    totalFailures++;
    log.warn(`[HEARTBEAT] Failed in ${elapsed}ms: ${msg}`);
    if (consecutiveFailures >= 3) {
      log.error(`[HEARTBEAT] ${consecutiveFailures} consecutive failures — model may be cold or API unstable`);
    }
  } finally {
    heartbeatRunning = false;
  }
}
