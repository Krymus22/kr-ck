/**
 * telemetry.test.ts — Tests for telemetry/metrics module.
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    writeFileSync: (...args: any[]) => (telemetryWriteSpy ?? actual.writeFileSync)(...args),
    mkdirSync: (...args: any[]) => (telemetryMkdirSpy ?? actual.mkdirSync)(...args),
    existsSync: (...args: any[]) => (telemetryExistsSpy ?? actual.existsSync)(...args),
    readdirSync: (...args: any[]) => (telemetryReaddirSpy ?? actual.readdirSync)(...args),
  };
});

let telemetryWriteSpy: ((...args: any[]) => any) | null = null;
let telemetryMkdirSpy: ((...args: any[]) => any) | null = null;
let telemetryExistsSpy: ((...args: any[]) => any) | null = null;
let telemetryReaddirSpy: ((...args: any[]) => any) | null = null;

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

import * as log from "../logger.js";

let sessionId: string | undefined;

afterAll(() => {
  if (sessionId) {
    try {
      // BUG FIX (Bug Hunter #8c): replaced `require("node:path")` with a
      // top-level ESM `import` (project rule: "Use `import` not `require()`").
      // Also use `os.homedir()` as the fallback (matches the source fix in
      // telemetry.ts) so cleanup finds the right file even when HOME is unset.
      const telemetryDir = path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
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

describe("saveSessionMetric error path (line 116)", () => {
  it("should log error when fs.writeFileSync throws", () => {
    telemetryMkdirSpy = () => undefined as any;
    telemetryWriteSpy = () => { throw new Error("disk full"); };
    try {
      startSession("error_session");
      endSession();
      expect(log.error).toHaveBeenCalled();
    } finally {
      telemetryWriteSpy = null;
      telemetryMkdirSpy = null;
    }
  });
});

describe("getAggregatedStats error paths (lines 129, 158)", () => {
  it("should return zeros when TELEMETRY_DIR does not exist (line 129)", () => {
    telemetryExistsSpy = () => false;
    try {
      const stats = getAggregatedStats();
      expect(stats).toEqual({ totalSessions: 0, totalApiCalls: 0, totalTokens: 0, totalToolCalls: 0, avgSessionDuration: 0 });
    } finally {
      telemetryExistsSpy = null;
    }
  });

  it("should return zeros when readdirSync throws (line 158)", () => {
    telemetryExistsSpy = () => true;
    telemetryReaddirSpy = () => { throw new Error("permission denied"); };
    try {
      const stats = getAggregatedStats();
      expect(stats).toEqual({ totalSessions: 0, totalApiCalls: 0, totalTokens: 0, totalToolCalls: 0, avgSessionDuration: 0 });
    } finally {
      telemetryExistsSpy = null;
      telemetryReaddirSpy = null;
    }
  });
});
