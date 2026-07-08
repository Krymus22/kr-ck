/**
 * telemetry-mutation-killers.test.ts — Targeted tests to kill LOW + MEDIUM
 * priority survived mutations in src/telemetry.ts.
 *
 * This file is named `telemetry-mutation-killers.test.ts` so the
 * mutation-test.py script picks it up via the `{basename}*.test.ts` glob
 * (scripts/mutation-test.py:find_test_files).
 *
 * Per BUSINESS_RULES.md §17: this file does NOT modify any source code, only
 * adds regression tests. No `require()` calls (ESM `import` only). The
 * existing source is assumed correct — these tests close gaps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// ─── telemetry.ts ───────────────────────────────────────────────────────────

describe("mutation-killers / telemetry.ts — L96 duration arithmetic", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.resetModules(); });

  /**
   * Mutation: L96 `currentSession.durationMs = Date.now() - new Date(currentSession.startTime).getTime();`
   *           mutation: `-` → `+`
   *
   * Effect: durationMs becomes (now + startTime) — a huge number (~3.4e12).
   *
   * Survived because existing tests only assert `durationMs >= 0` —
   * which is also true for the huge mutated value.
   *
   * Killing strategy: assert durationMs is REASONABLE (less than, say,
   * 60_000ms = 1 minute) for a session that just ended immediately.
   */
  it("endSession computes a small durationMs, not a huge sum (kills `- → +` on L96)", async () => {
    const { startSession, endSession, _resetTelemetryForTests } = await import("./../telemetry.js");
    _resetTelemetryForTests();
    startSession("mut-test-duration");
    const session = endSession();
    expect(session).not.toBeNull();
    // Without mutation: durationMs is small (a few ms).
    // With mutation `- → +`: durationMs is now + startTime ≈ 3.4e12 ms.
    expect(session!.durationMs).toBeLessThan(60_000);
    _resetTelemetryForTests();
  });
});

describe("mutation-killers / telemetry.ts — L192 avg-over-zero-files guard", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-telem-avg-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * Mutations on L192: `files.length > 0 ? totalDuration / files.length : 0`
   *   - `> 0` → `>= 0`: no observable effect (length is always >= 0).
   *   - `.length > 0` → `.length > 1`: needs MORE than 1 file to compute avg.
   *
   * Killing strategy: write EXACTLY 1 telemetry JSON file. Without
   * mutation: avg = totalDuration / 1 = totalDuration. With mutation
   * `> 1`: avg = 0 (because 1 > 1 is false). Test asserting
   * `avgSessionDuration > 0` (when the file has durationMs > 0) fails.
   */
  it("single telemetry file with durationMs=5000 yields avgSessionDuration=5000 (kills `.length > 0 → .length > 1` on L192)", async () => {
    const { getAggregatedStats, _resetTelemetryForTests } = await import("./../telemetry.js");
    _resetTelemetryForTests();
    const telemetryDir = path.join(tmpHome, ".claude-killer", "telemetry");
    fs.mkdirSync(telemetryDir, { recursive: true });
    fs.writeFileSync(
      path.join(telemetryDir, "session-1.json"),
      JSON.stringify({
        sessionId: "session-1",
        startTime: "2026-01-01T00:00:00.000Z",
        endTime: "2026-01-01T00:00:05.000Z",
        totalTokens: 0, promptTokens: 0, completionTokens: 0,
        apiCalls: 0, toolCalls: {}, errors: 0, totalChars: 0,
        messagesCount: 0, durationMs: 5000,
      }),
      "utf8",
    );

    const stats = getAggregatedStats();
    expect(stats.totalSessions).toBe(1);
    // Without mutation: 1 > 0 → true → 5000 / 1 = 5000.
    // With mutation `.length > 0 → .length > 1`: 1 > 1 → false → 0.
    expect(stats.avgSessionDuration).toBe(5000);
    _resetTelemetryForTests();
  });
});


// Hoisted mock state for lspAst.parseFile — module-level vi.mock applies to all
// progressiveContext tests in this file. Other tests in this file do NOT import
// lspAst.js, so they are unaffected.
const progctxMockState = vi.hoisted(() => ({
  ast: {
    language: "typescript",
    lineCount: 50,
    symbols: [
      { name: "foo", type: "function", line: 10 },
      { name: "bar", type: "function", line: 30 },
    ],
  },
}));
vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn().mockResolvedValue(progctxMockState.ast),
}));
