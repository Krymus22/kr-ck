/**
 * regression-bug-hunter-8c.test.ts — Regression tests for Bug Hunter #8c.
 *
 * Focus: Logger + shutdown + activity + telemetry + i18n.
 *
 * Each test below covers ONE specific bug fixed by Bug Hunter #8c. The test
 * is written so that it would FAIL on the pre-fix code and PASS on the
 * post-fix code (verified mentally by reading the diff).
 *
 * Bugs covered:
 *   1. logger.ts: toolCall appended "..." when JSON was EXACTLY 120 chars
 *      (nothing was actually truncated — misleading).
 *   2. logger.ts: no way to reset `tuiMode` flag → state leak between tests.
 *   3. gracefulShutdown.ts: if `shutdown()` rejected, `process.exit` was
 *      never called → process hung, user had to Ctrl+C twice.
 *   4. activityTracker.ts: `notify()` iterated the `listeners` Set directly;
 *      a listener that subscribed/unscribed during iteration caused
 *      non-deterministic behavior.
 *   5. telemetry.ts: `TELEMETRY_DIR` was a module-load const — changing HOME
 *      at runtime had no effect (stale path).
 *   6. telemetry.ts: `sessionId` was used unsanitized as a filename → path
 *      traversal vulnerability.
 *   7. telemetry.ts: `toolMetrics` Map was never cleared → state leak
 *      between sessions/tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Bug 1 + Bug 2: logger.ts ──────────────────────────────────────────────

describe("Bug Hunter #8c — logger.ts", () => {
  describe("Bug 1: toolCall truncation at exactly 120 chars", () => {
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.resetModules();
      vi.doMock("../config.js", () => ({ config: { debug: false } }));
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.doUnmock("../config.js");
    });

    it("does NOT append '...' when JSON is exactly 120 chars (nothing truncated)", async () => {
      const { toolCall, setTuiMode } = await import("../logger.js");
      setTuiMode(false);
      // Build args whose JSON.stringify is EXACTLY 120 chars.
      // {"x":"..."} where the inner string fills to 120 total.
      // We compute the right padding dynamically.
      const prefix = '{"x":"';
      const suffix = '"}';
      const padLen = 120 - prefix.length - suffix.length;
      const args = { x: "a".repeat(padLen) };
      expect(JSON.stringify(args).length).toBe(120); // sanity

      toolCall("tool", args);
      const out = String(logSpy.mock.calls[0]?.[0] ?? "");
      expect(out).not.toContain("...");
    });

    it("DOES append '...' when JSON exceeds 120 chars (actually truncated)", async () => {
      const { toolCall, setTuiMode } = await import("../logger.js");
      setTuiMode(false);
      const args = { x: "a".repeat(200) };
      expect(JSON.stringify(args).length).toBeGreaterThan(120); // sanity

      toolCall("tool", args);
      const out = String(logSpy.mock.calls[0]?.[0] ?? "");
      expect(out).toContain("...");
    });

    it("does NOT append '...' for short args", async () => {
      const { toolCall, setTuiMode } = await import("../logger.js");
      setTuiMode(false);
      toolCall("t", { a: 1 });
      const out = String(logSpy.mock.calls[0]?.[0] ?? "");
      expect(out).not.toContain("...");
    });
  });

  describe("Bug 2: _resetTuiModeForTests prevents state leak", () => {
    it("resets tuiMode to false after being set to true", async () => {
      vi.resetModules();
      vi.doMock("../config.js", () => ({ config: { debug: false } }));
      const { setTuiMode, isTuiMode, _resetTuiModeForTests } = await import("../logger.js");

      setTuiMode(true);
      expect(isTuiMode()).toBe(true);

      _resetTuiModeForTests();
      expect(isTuiMode()).toBe(false);

      vi.doUnmock("../config.js");
    });

    it("after reset, toolCall is no longer suppressed (console.log fires)", async () => {
      vi.resetModules();
      vi.doMock("../config.js", () => ({ config: { debug: false } }));
      const { setTuiMode, _resetTuiModeForTests, toolCall } = await import("../logger.js");
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});

      setTuiMode(true);
      spy.mockClear();
      toolCall("t", { a: 1 });
      expect(spy).not.toHaveBeenCalled(); // suppressed in TUI mode

      _resetTuiModeForTests();
      toolCall("t", { a: 1 });
      expect(spy).toHaveBeenCalled(); // no longer suppressed after reset

      spy.mockRestore();
      vi.doUnmock("../config.js");
    });
  });
});

// ─── Bug 3: gracefulShutdown.ts ────────────────────────────────────────────

describe("Bug Hunter #8c — gracefulShutdown.ts", () => {
  describe("Bug 3: process.exit is reached even if shutdown() rejects", () => {
    let onSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let tmpHome: string;

    beforeEach(() => {
      const fs = require("node:fs");
      const path = require("node:path");
      const os = require("node:os");
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bh8c-shutdown-"));
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      vi.resetModules();
      onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
      exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("__EXIT_PREVENTED__");
      }) as any);
    });

    afterEach(() => {
      onSpy.mockRestore();
      exitSpy.mockRestore();
      const fs = require("node:fs");
      fs.rmSync(tmpHome, { recursive: true, force: true });
      vi.useRealTimers();
    });

    it("SIGINT handler still calls process.exit(0) when shutdown() rejects (log.info throws)", async () => {
      vi.useFakeTimers();
      // Mock logger so log.info throws — this makes shutdown() reject on its
      // very first line (log.info(`[SHUTDOWN] Received ${signal}...`)).
      vi.doMock("../logger.js", () => ({
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(() => { throw new Error("info boom"); }),
      }));

      const { registerShutdownHandlers, resetShutdownState } = await import("../gracefulShutdown.js");
      resetShutdownState();
      registerShutdownHandlers();

      const sigintCall = onSpy.mock.calls.find((c) => c[0] === "SIGINT");
      expect(sigintCall).toBeDefined();
      const listener = sigintCall![1] as () => void;

      // Invoke the listener. The internal handler() catches the rejection
      // from shutdown() and still schedules setTimeout(process.exit, 100).
      try { listener(); } catch { /* sync throw from exitSpy — ignore */ }
      try { await vi.runAllTimersAsync(); } catch { /* exitSpy throws */ }

      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("uncaughtException handler still calls process.exit(1) when shutdown() rejects", async () => {
      vi.useFakeTimers();
      vi.doMock("../logger.js", () => ({
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(() => { throw new Error("error boom"); }),
        info: vi.fn(() => { throw new Error("info boom"); }),
      }));

      const { registerShutdownHandlers, resetShutdownState } = await import("../gracefulShutdown.js");
      resetShutdownState();
      registerShutdownHandlers();

      const uncaughtCall = onSpy.mock.calls.find((c) => c[0] === "uncaughtException");
      expect(uncaughtCall).toBeDefined();
      const listener = uncaughtCall![1] as (err: Error) => void;

      try { listener(new Error("original boom")); } catch { /* sync exitSpy */ }
      try { await vi.runAllTimersAsync(); } catch { /* exitSpy throws */ }

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});

// ─── Bug 4: activityTracker.ts ─────────────────────────────────────────────

describe("Bug Hunter #8c — activityTracker.ts", () => {
  describe("Bug 4: notify() is stable when listeners mutate the Set during iteration", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("a listener that unsubscribes itself does not break notification of others", async () => {
      const { pushActivity, subscribeToActivity, _resetActivityForTests } = await import("../activityTracker.js");
      _resetActivityForTests();

      const calls: string[] = [];
      // First listener unsubscribes itself when called.
      let unsub: () => void;
      const selfUnsub = () => {
        calls.push("self-unsub");
        unsub();
      };
      unsub = subscribeToActivity(selfUnsub);

      // Second listener should still be called after the first unsubscribes.
      const other = vi.fn(() => { calls.push("other"); });
      subscribeToActivity(other);

      pushActivity("tool", "x");

      expect(calls).toContain("self-unsub");
      expect(calls).toContain("other");
      expect(other).toHaveBeenCalledTimes(1);
    });

    it("a listener that subscribes a new listener during iteration does NOT have the new one called in the same notify", async () => {
      const { pushActivity, subscribeToActivity, getActivitySnapshot, _resetActivityForTests } = await import("../activityTracker.js");
      _resetActivityForTests();

      const newListener = vi.fn();
      const addingListener = () => {
        // Subscribe a new listener DURING the notification. With the snapshot
        // fix, the new listener must NOT be called in this same notify pass
        // (it would be non-deterministic without the snapshot).
        subscribeToActivity(newListener);
      };
      subscribeToActivity(addingListener);

      pushActivity("tool", "x");

      // The new listener was subscribed during notify, but because we
      // snapshot the listener array before iterating, it is NOT called in
      // this notification round.
      expect(newListener).not.toHaveBeenCalled();

      // A subsequent push DOES notify the new listener (proving it was
      // successfully subscribed — just deferred to the next round).
      pushActivity("tool", "y");
      expect(newListener).toHaveBeenCalled();
    });
  });
});

// ─── Bug 5, 6, 7: telemetry.ts ─────────────────────────────────────────────

describe("Bug Hunter #8c — telemetry.ts", () => {
  describe("Bug 5: TELEMETRY_DIR is computed lazily (respects env changes)", () => {
    let writeSpy: ReturnType<typeof vi.fn>;
    let mkdirSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.resetModules();
      writeSpy = vi.fn();
      mkdirSpy = vi.fn();
      vi.doMock("../logger.js", () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          writeFileSync: (...args: any[]) => writeSpy(...args),
          mkdirSync: (...args: any[]) => mkdirSpy(...args),
          existsSync: () => false,
          readdirSync: () => [],
        };
      });
    });

    afterEach(() => {
      vi.doUnmock("../logger.js");
      vi.doUnmock("node:fs");
    });

    it("uses the CURRENT process.env.HOME at call time, not at module load", async () => {
      const os = require("node:os");
      const path = require("node:path");
      const origHome = process.env.HOME;
      const origProfile = process.env.USERPROFILE;

      // Module loads with HOME=/home/original
      process.env.HOME = "/home/original";
      process.env.USERPROFILE = "/home/original";
      const { startSession, endSession } = await import("../telemetry.js");
      // ... then HOME changes BEFORE endSession writes.
      process.env.HOME = "/home/changed";

      startSession("bh8c_lazy_path");
      endSession();

      // The mkdir call should use the CHANGED home, not the original.
      const dirPassed = mkdirSpy.mock.calls[0]?.[0] as string;
      expect(dirPassed).toContain("/home/changed");
      expect(dirPassed).not.toContain("/home/original");

      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
    });

    it("falls back to os.homedir() (not '.') when HOME and USERPROFILE are both unset", async () => {
      const os = require("node:os");
      const origHome = process.env.HOME;
      const origProfile = process.env.USERPROFILE;
      delete process.env.HOME;
      delete process.env.USERPROFILE;

      const { startSession, endSession } = await import("../telemetry.js");
      startSession("bh8c_homdir_fallback");
      endSession();

      const dirPassed = mkdirSpy.mock.calls[0]?.[0] as string;
      // Should NOT be relative ("." or ".claude-killer/telemetry" without a home).
      // Must start with the OS home directory.
      const expectedHome = os.homedir();
      expect(dirPassed.startsWith(expectedHome)).toBe(true);

      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
    });
  });

  describe("Bug 6: sessionId is sanitized to prevent path traversal", () => {
    let writeSpy: ReturnType<typeof vi.fn>;
    let mkdirSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.resetModules();
      writeSpy = vi.fn();
      mkdirSpy = vi.fn();
      vi.doMock("../logger.js", () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          writeFileSync: (...args: any[]) => writeSpy(...args),
          mkdirSync: (...args: any[]) => mkdirSpy(...args),
          existsSync: () => false,
          readdirSync: () => [],
        };
      });
    });

    afterEach(() => {
      vi.doUnmock("../logger.js");
      vi.doUnmock("node:fs");
    });

    it("strips path separators from sessionId when writing the file", async () => {
      const { startSession, endSession } = await import("../telemetry.js");
      // Malicious sessionId that tries to traverse out of the telemetry dir.
      startSession("../../etc/passwd");
      endSession();

      const filePath = writeSpy.mock.calls[0]?.[0] as string;
      // The path separators must be replaced with "_", so the file is written
      // INSIDE the telemetry directory, not traversing out of it.
      // Check that the path does NOT escape the telemetry directory (no ".."
      // path segments that would traverse up).
      expect(filePath).not.toMatch(/\.\.\//);
      expect(filePath).not.toMatch(/\.\.\\/);
      // The sanitized filename should contain underscores where separators were.
      expect(filePath).toContain("_etc_passwd.json");
      // The file must be INSIDE the telemetry directory (not in /etc or similar).
      expect(filePath).toContain("telemetry");
    });

    it("strips backslashes from sessionId (Windows path traversal)", async () => {
      const { startSession, endSession } = await import("../telemetry.js");
      startSession("..\\..\\windows\\system32");
      endSession();

      const filePath = writeSpy.mock.calls[0]?.[0] as string;
      // No double-backslashes that would traverse up on Windows.
      expect(filePath).not.toMatch(/\.\.\\\\/);
      // The file must be INSIDE the telemetry directory.
      expect(filePath).toContain("telemetry");
      // The sanitized filename should have underscores, not backslashes.
      expect(filePath).toContain("_windows_");
    });

    it("preserves a normal sessionId unchanged", async () => {
      const { startSession, endSession } = await import("../telemetry.js");
      startSession("normal_session_123");
      endSession();

      const filePath = writeSpy.mock.calls[0]?.[0] as string;
      expect(filePath).toContain("normal_session_123.json");
    });
  });

  describe("Bug 7: _resetTelemetryForTests clears state (no leak between sessions)", () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doMock("../logger.js", () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
      }));
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return {
          ...actual,
          writeFileSync: vi.fn(),
          mkdirSync: vi.fn(),
          existsSync: () => false,
          readdirSync: () => [],
        };
      });
    });

    afterEach(() => {
      vi.doUnmock("../logger.js");
      vi.doUnmock("node:fs");
    });

    it("clears toolMetrics so getToolMetrics returns empty after reset", async () => {
      const { startSession, recordToolCall, endSession, getToolMetrics, _resetTelemetryForTests } = await import("../telemetry.js");

      startSession("bh8c_leak_before");
      recordToolCall("tool_a", 10, true);
      recordToolCall("tool_b", 20, true);
      endSession();

      // Before reset: metrics present.
      const before = getToolMetrics();
      expect(before.length).toBeGreaterThanOrEqual(2);

      _resetTelemetryForTests();

      // After reset: metrics cleared.
      const after = getToolMetrics();
      expect(after).toEqual([]);
    });

    it("clears currentSession so getCurrentSession returns null after reset", async () => {
      const { startSession, getCurrentSession, _resetTelemetryForTests } = await import("../telemetry.js");

      startSession("bh8c_session_leak");
      expect(getCurrentSession()).not.toBeNull();

      _resetTelemetryForTests();
      expect(getCurrentSession()).toBeNull();
    });

    it("does not throw when called with no active session", async () => {
      const { _resetTelemetryForTests } = await import("../telemetry.js");
      expect(() => _resetTelemetryForTests()).not.toThrow();
    });
  });
});
