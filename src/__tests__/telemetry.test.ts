/**
 * telemetry.test.ts — Tests for telemetry/metrics module.
 */

import { describe, it, expect, afterAll } from "vitest";
import {
  startSession,
  endSession,
  recordApiCall,
  recordToolCall,
  recordError,
  recordMessage,
  getCurrentSession,
  getToolMetrics,
  getAggregatedStats,
} from "../telemetry.js";

let sessionId: string | undefined;

afterAll(() => {
  if (sessionId) {
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const telemetryDir = path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".claude-killer",
        "telemetry"
      );
      const filePath = path.join(telemetryDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }
});

describe("session lifecycle", () => {
  it("should start a session", () => {
    const session = startSession("test_telemetry_1");
    sessionId = session.sessionId;
    expect(session.sessionId).toBe("test_telemetry_1");
    expect(session.startTime).toBeDefined();
  });

  it("should record API calls", () => {
    recordApiCall(100, 50);
    recordApiCall(200, 100);
    const session = getCurrentSession();
    expect(session).not.toBeNull();
    expect(session!.apiCalls).toBe(2);
    expect(session!.promptTokens).toBe(300);
    expect(session!.completionTokens).toBe(150);
  });

  it("should record tool calls", () => {
    recordToolCall("ler_arquivo", 50, true);
    recordToolCall("aplicar_diff", 100, false);
    const session = getCurrentSession();
    expect(session!.toolCalls["ler_arquivo"]).toBe(1);
    expect(session!.toolCalls["aplicar_diff"]).toBe(1);
  });

  it("should record errors", () => {
    recordError();
    const session = getCurrentSession();
    expect(session!.errors).toBe(1);
  });

  it("should record messages", () => {
    recordMessage(100);
    recordMessage(200);
    const session = getCurrentSession();
    expect(session!.messagesCount).toBe(2);
    expect(session!.totalChars).toBe(300);
  });

  it("should end session", () => {
    const session = endSession();
    expect(session).not.toBeNull();
    expect(session!.endTime).toBeDefined();
    expect(session!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should return null if no active session", () => {
    const session = getCurrentSession();
    expect(session).toBeNull();
  });
});

describe("getToolMetrics", () => {
  it("should return tool metrics sorted by count", () => {
    startSession("metrics_test");
    recordToolCall("ler_arquivo", 10, true);
    recordToolCall("ler_arquivo", 20, true);
    recordToolCall("aplicar_diff", 30, true);
    endSession();

    const metrics = getToolMetrics();
    expect(metrics.length).toBeGreaterThanOrEqual(2);
    expect(metrics[0].callCount).toBeGreaterThanOrEqual(metrics[1].callCount);
  });
});

describe("getAggregatedStats", () => {
  it("should return aggregated stats", () => {
    const stats = getAggregatedStats();
    expect(stats).toBeDefined();
    expect(typeof stats.totalSessions).toBe("number");
    expect(typeof stats.totalApiCalls).toBe("number");
    expect(typeof stats.totalTokens).toBe("number");
  });
});
