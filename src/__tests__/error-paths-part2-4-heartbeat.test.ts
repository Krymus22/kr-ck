/**
 * error-paths-part2-4-heartbeat.test.ts — Error Path 4
 *
 * Scenario: Heartbeat fails 5 times → should auto-stop (not keep retrying).
 *
 * BUG FIXED: after auto-stop, consecutiveFailures was NOT reset to 0. This
 * meant that restarting the heartbeat would immediately re-trigger auto-stop
 * on the first failure (>= 5+1 >= 5), making it effectively un-restartable
 * without an explicit resetHeartbeat() call. Now, consecutiveFailures is
 * reset to 0 after auto-stop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../invariants.js", () => ({
  invariant: vi.fn(),
}));

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

let originalInterval: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  originalInterval = process.env.HEARTBEAT_INTERVAL_MS;
});

afterEach(() => {
  if (originalInterval === undefined) delete process.env.HEARTBEAT_INTERVAL_MS;
  else process.env.HEARTBEAT_INTERVAL_MS = originalInterval;
  vi.resetModules();
});

describe("Error path 4: Heartbeat fails 5× → auto-stops and resets counter", () => {
  it("auto-stops after exactly 5 consecutive failures (does NOT keep retrying)", async () => {
    const { startHeartbeat, stopHeartbeat, getHeartbeatStats, resetHeartbeat } = await import("../heartbeat.js");
    resetHeartbeat();

    // All heartbeats fail
    mockCreate.mockRejectedValue(new Error("NVIDIA NIM down (503)"));
    const client = { chat: { completions: { create: mockCreate } } } as any;

    // Trigger 5 consecutive failures via start/stop (each start sends an
    // immediate heartbeat). We do NOT call resetHeartbeat between iterations
    // so consecutiveFailures accumulates.
    for (let i = 0; i < 5; i++) {
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 60));
      // Only stop if still running (the 5th failure auto-stops internally)
      const stats = getHeartbeatStats();
      if (stats.running) stopHeartbeat();
    }

    const stats = getHeartbeatStats();
    // Assert: 5 failures recorded
    expect(stats.totalFailures).toBe(5);
    expect(stats.totalHeartbeats).toBe(5);

    // Assert: auto-stop triggered (timer cleared)
    expect(stats.running).toBe(false);

    // Assert: NO more heartbeats fire after auto-stop
    const callsAfterStop = mockCreate.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(mockCreate.mock.calls.length).toBe(callsAfterStop); // unchanged
  });

  it("resets consecutiveFailures to 0 after auto-stop (can be cleanly restarted)", async () => {
    const { startHeartbeat, stopHeartbeat, getHeartbeatStats, resetHeartbeat } = await import("../heartbeat.js");
    resetHeartbeat();

    // Phase 1: trigger 5 failures → auto-stop
    mockCreate.mockRejectedValue(new Error("fail"));
    const client = { chat: { completions: { create: mockCreate } } } as any;
    for (let i = 0; i < 5; i++) {
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 60));
      if (getHeartbeatStats().running) stopHeartbeat();
    }

    // After auto-stop: consecutiveFailures is 0 (BUG FIX — was 5 before fix)
    let stats = getHeartbeatStats();
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.running).toBe(false);

    // Phase 2: restart heartbeat with SUCCESS — should work cleanly
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "hi" } }],
      usage: {},
    });
    startHeartbeat(client);
    await new Promise((r) => setTimeout(r, 60));

    stats = getHeartbeatStats();
    expect(stats.running).toBe(true);
    expect(stats.lastHeartbeatOk).toBe(true);
    expect(stats.consecutiveFailures).toBe(0);
    expect(stats.totalSuccess).toBeGreaterThanOrEqual(1);

    stopHeartbeat();
  });

  it("does NOT auto-stop after only 4 consecutive failures (threshold is exactly 5)", async () => {
    const { startHeartbeat, stopHeartbeat, getHeartbeatStats, resetHeartbeat } = await import("../heartbeat.js");
    resetHeartbeat();

    mockCreate.mockRejectedValue(new Error("fail"));
    const client = { chat: { completions: { create: mockCreate } } } as any;

    // Only 4 failures — should NOT trigger auto-stop
    for (let i = 0; i < 4; i++) {
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 60));
      stopHeartbeat();
    }

    const stats = getHeartbeatStats();
    expect(stats.consecutiveFailures).toBe(4);
    expect(stats.totalFailures).toBe(4);
    // Did NOT auto-stop (consecutiveFailures is 4, not reset to 0 — auto-stop didn't fire)
  });

  it("a single success after failures resets consecutiveFailures to 0", async () => {
    const { startHeartbeat, stopHeartbeat, getHeartbeatStats, resetHeartbeat } = await import("../heartbeat.js");
    resetHeartbeat();

    const client = { chat: { completions: { create: mockCreate } } } as any;

    // 3 failures
    mockCreate.mockRejectedValue(new Error("fail"));
    for (let i = 0; i < 3; i++) {
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 60));
      stopHeartbeat();
    }
    expect(getHeartbeatStats().consecutiveFailures).toBe(3);

    // 1 success
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "hi" } }],
      usage: {},
    });
    startHeartbeat(client);
    await new Promise((r) => setTimeout(r, 60));
    stopHeartbeat();

    // consecutiveFailures reset to 0 by the success
    expect(getHeartbeatStats().consecutiveFailures).toBe(0);
    expect(getHeartbeatStats().totalSuccess).toBe(1);
  });

  it("after auto-stop + restart, the threshold is still 5 (not lowered by the reset)", async () => {
    const { startHeartbeat, stopHeartbeat, getHeartbeatStats, resetHeartbeat } = await import("../heartbeat.js");
    resetHeartbeat();

    mockCreate.mockRejectedValue(new Error("fail"));
    const client = { chat: { completions: { create: mockCreate } } } as any;

    // Phase 1: 5 failures → auto-stop, counter reset to 0
    for (let i = 0; i < 5; i++) {
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 60));
      if (getHeartbeatStats().running) stopHeartbeat();
    }
    expect(getHeartbeatStats().consecutiveFailures).toBe(0);

    // Phase 2: 4 more failures — should NOT auto-stop (counter is 4, < 5)
    for (let i = 0; i < 4; i++) {
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 60));
      stopHeartbeat();
    }
    expect(getHeartbeatStats().consecutiveFailures).toBe(4);
    expect(getHeartbeatStats().running).toBe(false); // stopped manually, not auto-stop

    // Phase 3: 1 more failure (5th) → auto-stop fires again
    startHeartbeat(client);
    await new Promise((r) => setTimeout(r, 60));
    // 5th failure → consecutiveFailures hits 5 → auto-stop → counter reset to 0
    expect(getHeartbeatStats().consecutiveFailures).toBe(0);
    // totalFailures = 5 (phase1) + 4 (phase2) + 1 (phase3) = 10
    expect(getHeartbeatStats().totalFailures).toBe(10);
  });
});
