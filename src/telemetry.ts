/**
 * telemetry.ts - Telemetry/metrics collection: session stats, API calls, tool usage.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

const TELEMETRY_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".claude-killer",
  "telemetry"
);

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
    fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    const filePath = path.join(TELEMETRY_DIR, `${session.sessionId}.json`);
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
    if (!fs.existsSync(TELEMETRY_DIR)) {
      return { totalSessions: 0, totalApiCalls: 0, totalTokens: 0, totalToolCalls: 0, avgSessionDuration: 0 };
    }

    const files = fs.readdirSync(TELEMETRY_DIR).filter((f) => f.endsWith(".json"));
    let totalApiCalls = 0;
    let totalTokens = 0;
    let totalToolCalls = 0;
    let totalDuration = 0;

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(TELEMETRY_DIR, file), "utf8"));
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
