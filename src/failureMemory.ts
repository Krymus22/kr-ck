/**
 * failureMemory.ts - Learn from recent edit failures.
 *
 * When aplicar_diff or editar_arquivo fails, the error is saved to a
 * short-term memory (last 5 errors, max 2 lines each). Before the next
 * edit attempt, these errors are injected into the AI's context so it
 * doesn't repeat the same mistake.
 *
 * Storage: in-memory (resets on restart). Persistent storage would add
 * complexity for little gain - the AI only needs to remember errors from
 * the current session.
 *
 * Integration:
 *   - agent.ts: call recordFailure() when a tool returns an error
 *   - agent.ts: call getRecentFailures() and inject into context before
 *     the next edit tool call
 *   - fileEdit.ts: call recordFailure() on edit failures
 */

import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface FailureEntry {
  /** Tool that failed (aplicar_diff, editar_arquivo, etc.) */
  tool: string;
  /** File path that was being edited (if applicable) */
  filePath?: string;
  /** Error message (truncated to 2 lines / 200 chars) */
  error: string;
  /** Timestamp of the failure */
  timestamp: number;
}

// --- State ------------------------------------------------------------------

const MAX_FAILURES = 5;
const MAX_ERROR_LENGTH = 200;
const failures: FailureEntry[] = [];

// --- Public API -------------------------------------------------------------

/**
 * Record a failure. Only keeps the last MAX_FAILURES entries.
 * Error is truncated to MAX_ERROR_LENGTH chars to avoid context bloat.
 */
export function recordFailure(tool: string, error: string, filePath?: string): void {
  const truncatedError = error.slice(0, MAX_ERROR_LENGTH);
  failures.push({
    tool,
    filePath: filePath ?? undefined,
    error: truncatedError,
    timestamp: Date.now(),
  });

  // Keep only last MAX_FAILURES
  while (failures.length > MAX_FAILURES) {
    failures.shift();
  }

  log.debug(`[FAILURE_MEMORY] Recorded: ${tool} - ${truncatedError.slice(0, 80)}`);
}

/**
 * Get recent failures as a formatted string for context injection.
 * Returns empty string if no failures recorded.
 *
 * Format (compact, max ~10 lines):
 *   [FAILURES] Avoid these mistakes:
 *   - aplicar_diff: SEARCH not found in file.ts (2 min ago)
 *   - editar_arquivo: File not found: /path/to/file.luau (5 min ago)
 */
export function getRecentFailures(): string {
  if (failures.length === 0) return "";

  const lines: string[] = ["[FAILURES] Avoid these recent mistakes:"];
  const now = Date.now();

  for (const f of failures) {
    const ageMin = Math.round((now - f.timestamp) / 60000);
    const ageStr = ageMin < 1 ? "just now" : `${ageMin}min ago`;
    const fileStr = f.filePath ? ` in ${f.filePath.split("/").pop()}` : "";
    // Max 1 line per failure (truncate error to ~80 chars)
    const shortError = f.error.split("\n")[0]!.slice(0, 80);
    lines.push(`- ${f.tool}: ${shortError}${fileStr} (${ageStr})`);
  }

  return lines.join("\n");
}

/**
 * Get raw failure entries (for testing/debugging).
 */
export function getFailures(): FailureEntry[] {
  return [...failures];
}

/**
 * Clear all failures (for tests or /reset).
 */
export function clearFailures(): void {
  failures.length = 0;
}

/**
 * Check if there are recent failures that should be injected.
 */
export function hasRecentFailures(): boolean {
  return failures.length > 0;
}

/**
 * Get the most recent failure (or null if none).
 */
export function getMostRecentFailure(): FailureEntry | null {
  return failures.length > 0 ? failures[failures.length - 1]! : null;
}
