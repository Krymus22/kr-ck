/**
 * telemetry.ts - Telemetry/metrics collection: session stats, API calls, tool usage.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

/**
 * Compute the telemetry directory lazily.
 *
 * BUG FIX (Bug Hunter #8c): previously `TELEMETRY_DIR` was a module-load-time
 * const computed from `process.env.HOME ?? process.env.USERPROFILE ?? "."`.
 * Two problems:
 *   1. The fallback `"."` wrote telemetry JSON files into the CURRENT WORKING
 *      DIRECTORY when both HOME and USERPROFILE were unset (e.g., some CI
 *      runners, sandboxed shells, or systemd services with no home). This is
 *      a PRIVACY LEAK — telemetry files (with session IDs, token counts,
 *      tool call counts) would appear in the user's project directory and
 *      could be accidentally committed to git. Fall back to `os.homedir()`
 *      instead, which consults the system user database as a last resort.
 *   2. Because the path was captured at module load, changing HOME at runtime
 *      (common in tests, and possible if a user re-exports env vars mid-run)
 *      had no effect — telemetry still went to the stale path. Compute it
 *      lazily inside each function so env changes are respected.
 */
function getTelemetryDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
    ".claude-killer",
    "telemetry"
  );
}

/**
 * Sanitize a session ID for use as a filename.
 *
 * BUG FIX (Bug Hunter #8c): `sessionId` was used directly in
 * `path.join(TELEMETRY_DIR, \`${sessionId}.json\`)`. If a caller passed a
 * sessionId containing path separators (e.g. `"../../etc/passwd"`), the
 * resulting path could traverse out of the telemetry directory — a path
 * traversal vulnerability that could overwrite arbitrary files. Strip all
 * `/` and `\` characters from the sessionId before using it as a filename.
 */
function sanitizeSessionId(sessionId: string): string {
  return sessionId.replaceAll(/[\\/]/g, "_");
}

export interface SessionMetric {
  sessionId: string;
  startTime: string;
  endTime?: string;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  apiCalls: number;
  toolCalls: Record<string, number>;
  errors: number;
  totalChars: number;
  messagesCount: number;
  durationMs: number;
}

export interface ToolMetric {
  name: string;
  callCount: number;
  totalDurationMs: number;
  successCount: number;
  errorCount: number;
}

let currentSession: SessionMetric | null = null;
const toolMetrics: Map<string, ToolMetric> = new Map();

export function startSession(sessionId?: string): SessionMetric {
  currentSession = {
    sessionId: sessionId ?? `session_${Date.now()}`,
    startTime: new Date().toISOString(),
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    apiCalls: 0,
    toolCalls: {},
    errors: 0,
    totalChars: 0,
    messagesCount: 0,
    durationMs: 0,
  };
  return currentSession;
}

export function endSession(): SessionMetric | null {
  if (!currentSession) return null;
  currentSession.endTime = new Date().toISOString();
  currentSession.durationMs = Date.now() - new Date(currentSession.startTime).getTime();

  saveSessionMetric(currentSession);
  const session = currentSession;
  currentSession = null;
  return session;
}

export function recordApiCall(promptTokens: number, completionTokens: number): void {
  if (!currentSession) return;
  currentSession.apiCalls++;
  currentSession.promptTokens += promptTokens;
  currentSession.completionTokens += completionTokens;
  currentSession.totalTokens += promptTokens + completionTokens;
}

export function recordToolCall(toolName: string, durationMs: number, success: boolean): void {
  if (!currentSession) return;
  currentSession.toolCalls[toolName] = (currentSession.toolCalls[toolName] ?? 0) + 1;

  let metric = toolMetrics.get(toolName);
  if (!metric) {
    metric = { name: toolName, callCount: 0, totalDurationMs: 0, successCount: 0, errorCount: 0 };
    toolMetrics.set(toolName, metric);
  }
  metric.callCount++;
  metric.totalDurationMs += durationMs;
  if (success) metric.successCount++;
  else metric.errorCount++;
}

export function recordError(): void {
  if (currentSession) currentSession.errors++;
}

export function recordMessage(chars: number): void {
  if (!currentSession) return;
  currentSession.messagesCount++;
  currentSession.totalChars += chars;
}

export function getCurrentSession(): SessionMetric | null {
  return currentSession;
}

export function getToolMetrics(): ToolMetric[] {
  return Array.from(toolMetrics.values()).sort((a, b) => b.callCount - a.callCount);
}

function saveSessionMetric(session: SessionMetric): void {
  try {
    const dir = getTelemetryDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${sanitizeSessionId(session.sessionId)}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf8");
  } catch (err) {
    log.error(`Failed to save telemetry: ${(err as Error).message}`);
  }
}

export function getAggregatedStats(): {
  totalSessions: number;
  totalApiCalls: number;
  totalTokens: number;
  totalToolCalls: number;
  avgSessionDuration: number;
} {
  try {
    const telemetryDir = getTelemetryDir();
    if (!fs.existsSync(telemetryDir)) {
      return { totalSessions: 0, totalApiCalls: 0, totalTokens: 0, totalToolCalls: 0, avgSessionDuration: 0 };
    }

    const files = fs.readdirSync(telemetryDir).filter((f) => f.endsWith(".json"));
    let totalApiCalls = 0;
    let totalTokens = 0;
    let totalToolCalls = 0;
    let totalDuration = 0;

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(telemetryDir, file), "utf8"));
        totalApiCalls += data.apiCalls ?? 0;
        totalTokens += data.totalTokens ?? 0;
        totalToolCalls += Object.values(data.toolCalls ?? {}).reduce((a: number, b: unknown) => a + (b as number), 0);
        totalDuration += data.durationMs ?? 0;
      } catch {
        // skip
      }
    }

    return {
      totalSessions: files.length,
      totalApiCalls,
      totalTokens,
      totalToolCalls,
      avgSessionDuration: files.length > 0 ? totalDuration / files.length : 0,
    };
  } catch {
    return { totalSessions: 0, totalApiCalls: 0, totalTokens: 0, totalToolCalls: 0, avgSessionDuration: 0 };
  }
}

/**
 * Reset all telemetry state (for tests).
 *
 * BUG FIX (Bug Hunter #8c): the `toolMetrics` Map was NEVER cleared — not by
 * `endSession()`, not by any test helper. This caused state to leak between
 * test files: `getToolMetrics()` in test file B would return tool call
 * counts from test file A. The existing tests worked around this with
 * `>=` assertions and `find()` lookups, but the leak was real and could
 * mask regressions. Exposing `_resetTelemetryForTests()` lets tests start
 * from a clean slate, matching the pattern already used by
 * `activityTracker._resetActivityForTests()` and
 * `gracefulShutdown.resetShutdownState()`.
 */
export function _resetTelemetryForTests(): void {
  currentSession = null;
  toolMetrics.clear();
}
