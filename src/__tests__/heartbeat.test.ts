/**
 * heartbeat.test.ts — tests for the heartbeat module.
 *
 * The heartbeat sends a tiny "hi" request every 5 min to keep the model
 * warm on NVIDIA NIM (prevents cold start of 5-60s).
 *
 * Tests cover:
 *   - startHeartbeat() sends an immediate heartbeat
 *   - startHeartbeat() is idempotent (calling twice = 1 timer)
 *   - stopHeartbeat() stops the timer
 *   - getHeartbeatStats() returns correct state
 *   - Heartbeat handles errors gracefully (doesn't crash)
 *   - resetHeartbeat() clears all state
 *   - Heartbeat uses correct model and max_tokens=1
 *   - HEARTBEAT_ENABLED=0 disables heartbeat
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock OpenAI
const mockCreate = vi.hoisted(() => vi.fn(async () => ({
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
})));

const mockOpenAI = vi.hoisted(() => ({
  chat: { completions: { create: mockCreate } },
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = mockOpenAI.chat;
    constructor() {}
  },
}));

// Import AFTER mocks
import { startHeartbeat, stopHeartbeat, getHeartbeatStats, resetHeartbeat } from "../heartbeat.js";

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("heartbeat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    resetHeartbeat();
  });

  afterEach(() => {
    stopHeartbeat();
    resetHeartbeat();
  });

  describe("startHeartbeat", () => {
    it("sends an immediate heartbeat when started", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);

      // Wait a tick for the async heartbeat to complete
      await new Promise((r) => setTimeout(r, 50));

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const stats = getHeartbeatStats();
      expect(stats.totalHeartbeats).toBe(1);
      expect(stats.totalSuccess).toBe(1);
    });

    it("is idempotent — calling twice = 1 timer", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      startHeartbeat(client); // should be no-op

      await new Promise((r) => setTimeout(r, 50));

      // Only 1 immediate heartbeat, not 2
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("uses the correct model from process.env.MODEL", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);

      await new Promise((r) => setTimeout(r, 50));

      const call = mockCreate.mock.calls[0]?.[0];
      expect(call.model).toBeDefined();
      expect(typeof call.model).toBe("string");
    });

    it("uses max_tokens=1 (cheap request)", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);

      await new Promise((r) => setTimeout(r, 50));

      const call = mockCreate.mock.calls[0]?.[0];
      expect(call.max_tokens).toBe(1);
    });

    it("uses stream=false (no streaming parser)", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);

      await new Promise((r) => setTimeout(r, 50));

      const call = mockCreate.mock.calls[0]?.[0];
      expect(call.stream).toBe(false);
    });

    it("sends 'hi' as the user message", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);

      await new Promise((r) => setTimeout(r, 50));

      const call = mockCreate.mock.calls[0]?.[0];
      expect(call.messages).toEqual([{ role: "user", content: "hi" }]);
    });
  });

  describe("stopHeartbeat", () => {
    it("stops the timer (no more heartbeats)", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));
      expect(mockCreate).toHaveBeenCalledTimes(1);

      stopHeartbeat();

      // Wait and verify no more heartbeats
      await new Promise((r) => setTimeout(r, 100));
      expect(mockCreate).toHaveBeenCalledTimes(1); // still 1
    });

    it("is safe to call when not running", () => {
      expect(() => stopHeartbeat()).not.toThrow();
    });
  });

  describe("getHeartbeatStats", () => {
    it("returns 'unknown' modelState before any heartbeat", () => {
      const stats = getHeartbeatStats();
      expect(stats.modelState).toBe("unknown");
      expect(stats.totalHeartbeats).toBe(0);
      expect(stats.lastHeartbeatLatencyMs).toBe(0);
    });

    it("returns 'warm' when last heartbeat was < 5s", async () => {
      // Mock with a small delay so latency > 0
      mockCreate.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { choices: [{ message: { content: "hi" } }], usage: {} };
      });
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 100));

      const stats = getHeartbeatStats();
      expect(stats.modelState).toBe("warm");
      expect(stats.lastHeartbeatOk).toBe(true);
      expect(stats.lastHeartbeatLatencyMs).toBeGreaterThan(0);
    });

    it("returns correct stats after successful heartbeat", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));

      const stats = getHeartbeatStats();
      expect(stats.totalHeartbeats).toBe(1);
      expect(stats.totalSuccess).toBe(1);
      expect(stats.totalFailures).toBe(0);
      expect(stats.consecutiveFailures).toBe(0);
      expect(stats.lastHeartbeatOk).toBe(true);
    });

    it("tracks failures correctly", async () => {
      mockCreate.mockRejectedValue(new Error("Network error"));
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));

      const stats = getHeartbeatStats();
      expect(stats.totalHeartbeats).toBe(1);
      expect(stats.totalSuccess).toBe(0);
      expect(stats.totalFailures).toBe(1);
      expect(stats.consecutiveFailures).toBe(1);
      expect(stats.lastHeartbeatOk).toBe(false);
    });
  });

  describe("error handling", () => {
    it("does NOT crash when heartbeat request fails", async () => {
      mockCreate.mockRejectedValue(new Error("API error"));
      const client = { chat: { completions: { create: mockCreate } } } as any;

      expect(() => startHeartbeat(client)).not.toThrow();
      await new Promise((r) => setTimeout(r, 50));

      // App is still alive
      const stats = getHeartbeatStats();
      expect(stats.totalFailures).toBe(1);
    });

    it("tracks consecutive failures", async () => {
      mockCreate.mockRejectedValue(new Error("API error"));
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));

      // First failure
      let stats = getHeartbeatStats();
      expect(stats.consecutiveFailures).toBe(1);

      // Reset and try again — still failing
      resetHeartbeat();
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));
      stats = getHeartbeatStats();
      expect(stats.consecutiveFailures).toBe(1); // reset cleared it
    });

    it("resets consecutive failures on success", async () => {
      // First: fail
      mockCreate.mockRejectedValueOnce(new Error("API error"));
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));
      expect(getHeartbeatStats().consecutiveFailures).toBe(1);

      // Stop, reset, then succeed
      stopHeartbeat();
      resetHeartbeat();
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));
      expect(getHeartbeatStats().consecutiveFailures).toBe(0);
      expect(getHeartbeatStats().totalSuccess).toBe(1);
    });
  });

  describe("resetHeartbeat", () => {
    it("clears all state", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));
      expect(getHeartbeatStats().totalHeartbeats).toBe(1);

      resetHeartbeat();
      const stats = getHeartbeatStats();
      expect(stats.totalHeartbeats).toBe(0);
      expect(stats.totalSuccess).toBe(0);
      expect(stats.totalFailures).toBe(0);
      expect(stats.consecutiveFailures).toBe(0);
      expect(stats.lastHeartbeatLatencyMs).toBe(0);
      expect(stats.lastHeartbeatTime).toBe(0);
      expect(stats.modelState).toBe("unknown");
    });

    it("stops the timer", async () => {
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHeartbeat(client);
      await new Promise((r) => setTimeout(r, 50));

      resetHeartbeat();
      await new Promise((r) => setTimeout(r, 100));

      // No more heartbeats after reset
      const count = mockCreate.mock.calls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(mockCreate.mock.calls.length).toBe(count);
    });
  });

  describe("HEARTBEAT_ENABLED=0", () => {
    it("disables heartbeat when HEARTBEAT_ENABLED=0", async () => {
      const original = process.env.HEARTBEAT_ENABLED;
      process.env.HEARTBEAT_ENABLED = "0";

      // Re-import to pick up the env var
      vi.resetModules();
      const { startHeartbeat: startHb, getHeartbeatStats: getStats } = await import("../heartbeat.js");
      const client = { chat: { completions: { create: mockCreate } } } as any;
      startHb(client);
      await new Promise((r) => setTimeout(r, 50));

      // No heartbeat should be sent
      expect(mockCreate).not.toHaveBeenCalled();
      const stats = getStats();
      expect(stats.enabled).toBe(false);

      process.env.HEARTBEAT_ENABLED = original;
      vi.resetModules();
    });
  });
});
