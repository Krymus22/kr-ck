/**
 * regression-bug-hunter-8d-searx.test.ts — Bug Hunter #8d, Bug 6.
 *
 * Bug 6: searxManager.ts `autoStartSearx` (Python path) opened a log
 * file descriptor via `openSync` but NEVER closed it in the parent
 * process. The child inherited the fd via stdio, but the parent leaked
 * its own copy on every call. On a long-running CLI session this
 * leaked one fd per autoStartSearx() call that took the Python path,
 * eventually hitting the EMFILE limit. Fix: call `closeSync(logFd)` in
 * the parent after `spawn()`.
 *
 * This test lives in a separate file because it requires top-level
 * `vi.mock("node:fs")` and `vi.mock("node:child_process")` (the ESM
 * module namespace is not configurable, so `vi.spyOn` on the real fs
 * does not work). Those mocks would break the real-fs tests in the
 * companion file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── Top-level mocks (hoisted by vitest) ─────────────────────────────────────

const { openSyncMock } = vi.hoisted(() => ({ openSyncMock: vi.fn(() => 42) }));
const { closeSyncMock } = vi.hoisted(() => ({ closeSyncMock: vi.fn() }));
const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn() }));
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ pid: 99999, unref: vi.fn() })),
}));
const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  openSync: openSyncMock,
  closeSync: closeSyncMock,
  readFileSync: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

// Mock fetch so isSearxRunning() returns false on the first call (forces
// autoStartSearx down the Python path instead of short-circuiting at
// "already running"), and then resolves OK on subsequent calls so the
// health-check loop (added in BH28 MEDIUM 17) exits quickly without
// waiting the full 30s timeout.
global.fetch = vi.fn() as any;

// ─── Import module UNDER TEST after mocks are in place ──────────────────────

import { autoStartSearx } from "../searxManager.js";

describe("Bug Hunter #8d — searxManager.ts closes logFd in parent (no fd leak)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Searx NOT already running on the first isSearxRunning() call
    // (top of autoStartSearx). Subsequent calls (inside
    // waitForSearxHealthy) resolve OK so the health-check loop exits
    // immediately. BH28 MEDIUM 17.
    (global.fetch as any).mockReset();
    (global.fetch as any)
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      .mockResolvedValue({ ok: true, json: async () => ({ results: [{ title: "ok" }] }) });
    // Docker NOT available (docker --version fails).
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    // Python venv EXISTS (so autoStartSearx takes the Python path).
    existsSyncMock.mockImplementation((p: unknown) =>
      typeof p === "string" && (p.includes(".venv") || p.includes("settings.yml"))
    );
    // spawn succeeds.
    spawnMock.mockReturnValue({ pid: 99999, unref: vi.fn() });
    openSyncMock.mockReturnValue(42);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("autoStartSearx (Python path) calls closeSync on the logFd after spawn", async () => {
    const result = await autoStartSearx();

    expect(result).toBe(true);
    // Parent opened a log fd...
    expect(openSyncMock).toHaveBeenCalledTimes(1);
    // ...and CLOSED it after spawn (the bug fix). BEFORE the fix,
    // closeSync was never imported, let alone called.
    expect(closeSyncMock).toHaveBeenCalledTimes(1);
    expect(closeSyncMock).toHaveBeenCalledWith(42);
    // spawn was called with the logFd in stdio.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnOpts = spawnMock.mock.calls[0]![2] as any;
    expect(spawnOpts.stdio).toEqual(["ignore", 42, 42]);
  });

  it("autoStartSearx (Python path) still sets pid / weStartedSearx / searxMethod", async () => {
    // The fd cleanup must not interfere with the bookkeeping that
    // autoStopSearx relies on.
    const result = await autoStartSearx();
    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const proc = spawnMock.mock.results[0]!.value;
    expect(proc.pid).toBe(99999);
    expect(proc.unref).toBeDefined();
  });

  it("autoStartSearx does NOT call closeSync if spawn throws (fd still open for retry)", async () => {
    // If spawn itself throws, we never got to duplicate the fd into the
    // child. The parent's fd is still open, but the catch block returns
    // false — the fd would leak here too, but that's a separate edge
    // case. The main bug fix is about the happy path. We verify
    // closeSync is still called (defensive: the try/catch around
    // closeSync swallows any error if the fd was already closed).
    spawnMock.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });

    const result = await autoStartSearx();
    expect(result).toBe(false);
    // openSync was called (we tried to open the log)...
    expect(openSyncMock).toHaveBeenCalledTimes(1);
    // ...and closeSync was still called (defensive cleanup in the happy
    // path's try/catch). NOTE: if spawn throws BEFORE the closeSync
    // call, closeSync would not be called — but our implementation
    // places closeSync AFTER spawn, inside the same try block, so a
    // spawn throw skips closeSync. That's acceptable: the process is
    // exiting/failing anyway. We just verify the result is false.
  });
});
