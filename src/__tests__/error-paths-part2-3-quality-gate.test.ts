/**
 * error-paths-part2-3-quality-gate.test.ts — Error Path 3
 *
 * Scenario: Quality gate timeout (tsc takes >60s) → should handle gracefully.
 *
 * BUG FIXED: previously, a tsc timeout was treated as a regular "block"
 * (incrementing consecutiveBlocks), which burned all 8 retries on a problem
 * the agent can't fix. Now, timeouts are treated as a transient infrastructure
 * issue: the check is SKIPPED (not blocked) and consecutiveBlocks is NOT
 * incremented.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("../selfHealing.js", () => ({
  parseErrors: vi.fn(() => []),
  formatStructuredErrors: vi.fn(() => ""),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", () => ({
  get spawn() { return mockSpawn; },
  execSync: vi.fn(),
}));

let tmpProject: string;
let originalCwd: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalCwd = process.cwd();
  originalEnv = { ...process.env };
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "gate_timeout_"));
  fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({
    name: "timeout-test",
    scripts: { lint: "echo lint-ok" },
  }), "utf8");
  fs.writeFileSync(path.join(tmpProject, "tsconfig.json"), "{}", "utf8");
  process.chdir(tmpProject);
  mockSpawn.mockReset();
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env = originalEnv;
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.useRealTimers();
});

/**
 * Create a fake child process that NEVER emits "close" on its own —
 * simulating tsc hanging past the 60s timeout. The kill() method emits
 * "close" when called (mirroring real behavior: SIGKILL → process exits).
 */
function makeHangingChild() {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  child.kill = vi.fn(() => {
    child.emit("close", null);
  });
  return child;
}

/** Create a fake child that emits output + close after 1ms (real timer). */
function makeFailingChild(stdout: string, exitCode: number) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  child.kill = () => {};
  setTimeout(() => {
    child.stdout.emit("data", Buffer.from(stdout));
    child.emit("close", exitCode);
  }, 1);
  return child;
}

describe("Error path 3: Quality gate timeout (tsc >60s) → handled gracefully", () => {
  it("tsc timeout: gate SKIPS the check (allowed=true) and does NOT increment consecutiveBlocks", async () => {
    process.env.STRICT_MODE = "true";
    // Both tsc (npx) and lint (npm) hang — simulate slow CI
    mockSpawn.mockImplementation(() => makeHangingChild());

    const { runQualityGate, resetGateState, getGateState } = await import("../strictQualityGate.js");
    resetGateState();

    // Use fake timers to advance past the 60s timeout without real waiting
    vi.useFakeTimers();
    try {
      const gatePromise = runQualityGate([path.join(tmpProject, "slow.ts")]);
      // Advance past tsc timeout (60s) + lint timeout (60s) + small buffer
      await vi.advanceTimersByTimeAsync(125_000);
      const result = await gatePromise;

      // Assert: timeout was treated as "skip this check", NOT as a block
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("passed");

      // Assert: consecutiveBlocks was NOT incremented (timeout is transient,
      // not a code quality failure)
      const state = getGateState();
      expect(state.consecutiveBlocks).toBe(0);
      expect(state.totalBlocks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tsc timeout followed by real error: only the real error increments consecutiveBlocks", async () => {
    process.env.STRICT_MODE = "true";
    // First call: tsc hangs (timeout). Second call: tsc fails with real error.
    let npxCallCount = 0;
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === "npx") {
        npxCallCount++;
        if (npxCallCount === 1) {
          return makeHangingChild(); // first tsc hangs
        }
        return makeFailingChild("TS2322: Type error", 1); // second tsc fails
      }
      // lint always passes
      return makeFailingChild("", 0);
    });

    const { runQualityGate, resetGateState, getGateState } = await import("../strictQualityGate.js");
    resetGateState();

    // First gate run: tsc times out → skip, no block
    vi.useFakeTimers();
    let result1;
    try {
      const p1 = runQualityGate([path.join(tmpProject, "a.ts")]);
      await vi.advanceTimersByTimeAsync(125_000);
      result1 = await p1;
    } finally {
      vi.useRealTimers();
    }
    expect(result1.allowed).toBe(true);
    expect(getGateState().consecutiveBlocks).toBe(0);

    // Second gate run: tsc returns real error → block, increment
    const result2 = await runQualityGate([path.join(tmpProject, "b.ts")]);
    expect(result2.allowed).toBe(false);
    expect(result2.errorLog).toContain("TypeScript errors");
    expect(getGateState().consecutiveBlocks).toBe(1);
  });

  it("repeated tsc timeouts do NOT exhaust the 8-retry budget (gate keeps working)", async () => {
    process.env.STRICT_MODE = "true";
    // tsc always hangs
    mockSpawn.mockImplementation((cmd: string) => {
      if (cmd === "npx") return makeHangingChild();
      return makeFailingChild("", 0);
    });

    const { runQualityGate, resetGateState, getGateState } = await import("../strictQualityGate.js");
    resetGateState();

    // Simulate 10 consecutive tsc timeouts — before the fix, this would have
    // exhausted the 8-retry budget (consecutiveBlocks would be 8, and the gate
    // would give up). After the fix, consecutiveBlocks stays at 0.
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 10; i++) {
        const p = runQualityGate([path.join(tmpProject, `f${i}.ts`)]);
        await vi.advanceTimersByTimeAsync(125_000);
        const result = await p;
        // Every timeout → skip (allowed=true)
        expect(result.allowed).toBe(true);
        expect(getGateState().consecutiveBlocks).toBe(0);
      }

      // After 10 timeouts: consecutiveBlocks is still 0 (timeouts don't count)
      expect(getGateState().consecutiveBlocks).toBe(0);
      expect(getGateState().totalBlocks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
