/**
 * fileLock.ts - Per-file mutex with TTL.
 *
 * Prevents race conditions when multiple agents (main + sub-agents) try to
 * edit the SAME file at the same time. Each edit must acquire a lock first.
 *
 * Lock semantics:
 *   - acquire(filePath, holderId): blocks until lock is free, then takes it.
 *     Returns a release function. Throws on timeout.
 *   - tryAcquire(filePath, holderId): non-blocking. Returns null if locked.
 *   - Auto-release after TTL (default 30s) - prevents deadlocks if an agent
 *     crashes without releasing.
 *
 * Usage in fileEdit.ts:
 *   const release = await acquireLock(filePath, "main");
 *   try {
 *     // do the edit
 *   } finally {
 *     release();
 *   }
 *
 * No persistence - locks are in-memory only (single process).
 */

import * as log from "./logger.js";

const DEFAULT_TTL_MS = 30_000;  // 30 seconds
const ACQUIRE_TIMEOUT_MS = 60_000;  // max wait to acquire
const RETRY_INTERVAL_MS = 100;

interface LockEntry {
  holderId: string;
  acquiredAt: number;
  ttlMs: number;
  releaseFn: () => void;
}

const locks = new Map<string, LockEntry>();

/** Get current timestamp in ms. */
function now(): number {
  return Date.now();
}

/** Check if a lock has expired (TTL exceeded). */
function isExpired(entry: LockEntry): boolean {
  return now() - entry.acquiredAt > entry.ttlMs;
}

/**
 * Try to acquire a lock without blocking.
 * Returns a release function if successful, null if already locked.
 *
 * @param filePath - Absolute path of the file to lock
 * @param holderId - ID of the agent requesting the lock (e.g. "main", "sub-1")
 * @param ttlMs - Auto-release after this many ms (default 30s)
 */
export function tryAcquireLock(
  filePath: string,
  holderId: string,
  ttlMs: number = DEFAULT_TTL_MS
): (() => void) | null {
  const key = filePath;

  const existing = locks.get(key);
  if (existing) {
    if (isExpired(existing)) {
      // Lock is stale - take it over
      log.debug(`[FILE_LOCK] Stealing expired lock for ${filePath} (was held by ${existing.holderId})`);
    } else {
      // Lock is active - check if same holder (re-entrant)
      if (existing.holderId === holderId) {
        // Same holder re-acquiring - extend TTL and return no-op release
        existing.acquiredAt = now();
        existing.ttlMs = ttlMs;
        return () => { /* no-op: lock will be released by outer call */ };
      }
      // Different holder - reject
      return null;
    }
  }

  let released = false;
  const releaseFn = () => {
    if (released) return;
    released = true;
    const current = locks.get(key);
    if (current && current.holderId === holderId) {
      locks.delete(key);
      log.debug(`[FILE_LOCK] Released ${filePath} (holder: ${holderId})`);
    }
  };

  const entry: LockEntry = {
    holderId,
    acquiredAt: now(),
    ttlMs,
    releaseFn,
  };
  locks.set(key, entry);
  log.debug(`[FILE_LOCK] Acquired ${filePath} (holder: ${holderId}, ttl: ${ttlMs}ms)`);
  return releaseFn;
}

/**
 * Acquire a lock with blocking. Waits up to ACQUIRE_TIMEOUT_MS for the lock
 * to become free, polling every RETRY_INTERVAL_MS.
 *
 * @throws Error if lock cannot be acquired within timeout
 */
export async function acquireLock(
  filePath: string,
  holderId: string,
  ttlMs: number = DEFAULT_TTL_MS,
  timeoutMs: number = ACQUIRE_TIMEOUT_MS
): Promise<() => void> {
  const start = now();

  while (true) {
    const release = tryAcquireLock(filePath, holderId, ttlMs);
    if (release) return release;

    if (now() - start > timeoutMs) {
      const existing = locks.get(filePath);
      throw new Error(
        `Timeout acquiring lock for ${filePath} after ${timeoutMs}ms. ` +
        `Currently held by: ${existing?.holderId ?? "unknown"} ` +
        `(acquired ${existing ? Math.round((now() - existing.acquiredAt) / 1000) : 0}s ago)`
      );
    }

    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
  }
}

/**
 * Get info about who currently holds a lock (for debugging).
 * Returns null if no lock held.
 */
export function getLockHolder(filePath: string): { holderId: string; acquiredAt: number; ageMs: number } | null {
  const entry = locks.get(filePath);
  if (!entry || isExpired(entry)) return null;
  return {
    holderId: entry.holderId,
    acquiredAt: entry.acquiredAt,
    ageMs: now() - entry.acquiredAt,
  };
}

/**
 * Force-release a lock (for admin/cleanup operations).
 * Use with caution - bypasses normal release semantics.
 */
export function forceReleaseLock(filePath: string): boolean {
  const existed = locks.delete(filePath);
  if (existed) {
    log.info(`[FILE_LOCK] Force-released ${filePath}`);
  }
  return existed;
}

/**
 * List all currently held locks (for debugging/UI).
 */
export function listLocks(): Array<{ filePath: string; holderId: string; ageMs: number; expiresMs: number }> {
  const result: Array<{ filePath: string; holderId: string; ageMs: number; expiresMs: number }> = [];
  for (const [filePath, entry] of locks.entries()) {
    if (isExpired(entry)) continue;  // skip stale
    result.push({
      filePath,
      holderId: entry.holderId,
      ageMs: now() - entry.acquiredAt,
      expiresMs: Math.max(0, entry.ttlMs - (now() - entry.acquiredAt)),
    });
  }
  return result;
}

/** Clear all locks (for tests). */
export function clearAllLocks(): void {
  locks.clear();
}

/**
 * Get the current agent ID (from env var set by runSubAgent).
 * Returns "main" if not in a sub-agent context.
 */
export function getCurrentAgentId(): string {
  return process.env.CLAUDE_KILLER_AGENT_ID ?? "main";
}
