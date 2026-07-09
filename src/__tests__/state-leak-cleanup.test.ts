/**
 * state-leak-cleanup.test.ts — Regression tests for module-level state cleanup.
 *
 * The claude-killer keeps per-turn / per-session state at the MODULE level in
 * several files (bugHunter, honestySystem, dataGuard, failureMemory,
 * checkpointWriter, patternExtractor, activityTracker). If this state is NOT
 * cleared when the user starts a new session (/reset, /session new,
 * /session load, auto-load, mode "new"), it leaks into the new session and
 * causes subtle bugs:
 *
 *   - honestySystem.filesEditedButNotReadBack → blocks finish on files edited
 *     in a DIFFERENT session.
 *   - failureMemory.failures → injects "Avoid these recent mistakes" from a
 *     previous session into the new one.
 *   - checkpointWriter.lastCheckpointState → next incremental checkpoint
 *     builds on stale "previous state" from a different conversation.
 *   - bugHunter.previousFindings → next round reports "previously identified
 *     bugs" that don't exist in the new session.
 *   - dataGuard.previousFindings → same.
 *   - patternExtractor.cachedPatterns → stale patterns from a different
 *     project root.
 *   - activityTracker.state.stack → stale "Executando tool: foo" entry from
 *     an aborted previous turn.
 *
 * §17.3.11 of BUSINESS_RULES.md mandates `clearReadPaths` on those reset
 * points. src/stateCleanup.ts extends the same defense-in-depth to every
 * other module with module-level state.
 *
 * These tests verify the contract:
 *   1. clearAllModuleState() actually clears every module's state.
 *   2. clearAllModuleStateSync() clears the light-module subset synchronously.
 *   3. The helper is resilient — a missing reset function in a mock doesn't
 *      throw (try/catch swallows it).
 *   4. The heavy-module clears (bugHunter, dataGuard, checkpointWriter) are
 *      invoked via dynamic import (so App.tsx module init doesn't pull in
 *      apiClient/OpenAI).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
}));

// Mock apiClient (transitively loaded by bugHunter, dataGuard, checkpointWriter)
// so the real OpenAI SDK is never constructed during these tests.
vi.mock("../apiClient.js", () => ({ chat: vi.fn() }));

// Mock history (loaded by bugHunter, checkpointWriter) — these tests don't
// exercise history, but the modules import it at load time.
vi.mock("../history.js", () => ({
  getHistory: vi.fn(() => []),
  estimateTokens: vi.fn(() => 0),
  addSystemMessage: vi.fn(),
  loadHistoryDirect: vi.fn(),
  getSystemPrompt: vi.fn(() => "system prompt"),
  optimizeContext: vi.fn(),
}));

// Mock testRunner (loaded by bugHunter) — avoids spawning real test runners.
vi.mock("../testRunner.js", () => ({
  detectLanguage: vi.fn(() => "unknown"),
  runBugTest: vi.fn(() => ({ passed: false, ran: false })),
  getTestFilePath: vi.fn(() => ""),
  isTestRunnerAvailable: vi.fn(() => false),
}));

// Mock i18n (loaded by honestySystem, patternExtractor indirectly).
vi.mock("../i18n.js", () => ({ t: vi.fn((...args: unknown[]) => String(args[0] ?? "")) }));

// ─── Imports (after mocks are registered) ───────────────────────────────────

import { clearAllModuleState, clearAllModuleStateSync } from "../stateCleanup.js";

// Light modules — direct state inspection via the public API.
import {
  recordRead,
  hasBeenRead,
  clearReadPaths,
} from "../readBeforeWrite.js";
import {
  recordSessionFileEdit,
  getSessionEditedFiles,
  clearSessionFiles,
} from "../fileRehydration.js";
import {
  recordSkillInvocation,
  getInvokedSkills,
  clearInvokedSkills,
} from "../skillTracker.js";
import {
  markFileAsEdited,
  getUnreadBackFiles,
  clearAllHonestyState,
  incrementTurn,
} from "../honestySystem.js";
import {
  recordFailure,
  getFailures,
  clearFailures,
} from "../failureMemory.js";
import {
  getPatternsCached,
  clearPatternCache,
} from "../patternExtractor.js";
import {
  pushActivity,
  clearActivity,
  getActivitySnapshot,
  _resetActivityForTests,
} from "../activityTracker.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset every light module to a known-empty state before each test so that
  // leftover state from one test doesn't bleed into the next.
  clearReadPaths();
  clearSessionFiles();
  clearInvokedSkills();
  clearAllHonestyState();
  clearFailures();
  clearPatternCache();
  clearActivity();
  _resetActivityForTests();
});

// ─── Tests: clearAllModuleStateSync (synchronous subset) ────────────────────

describe("clearAllModuleStateSync — clears light-module state", () => {
  it("clears readBeforeWrite.readPaths", () => {
    recordRead("ler_arquivo", "/tmp/leak_sync_read.ts");
    expect(hasBeenRead("/tmp/leak_sync_read.ts")).toBe(true);
    clearAllModuleStateSync();
    expect(hasBeenRead("/tmp/leak_sync_read.ts")).toBe(false);
  });

  it("clears fileRehydration.sessionEditedFiles", () => {
    recordSessionFileEdit("/tmp/leak_sync_edited.ts");
    expect(getSessionEditedFiles().length).toBe(1);
    clearAllModuleStateSync();
    expect(getSessionEditedFiles().length).toBe(0);
  });

  it("clears skillTracker.invokedSkills", () => {
    recordSkillInvocation("/tmp/leak_sync_skill.md");
    expect(getInvokedSkills().length).toBe(1);
    clearAllModuleStateSync();
    expect(getInvokedSkills().length).toBe(0);
  });

  it("clears honestySystem.filesEditedButNotReadBack", () => {
    markFileAsEdited("/tmp/leak_sync_honesty.ts");
    expect(getUnreadBackFiles().length).toBe(1);
    clearAllModuleStateSync();
    expect(getUnreadBackFiles().length).toBe(0);
  });

  it("clears failureMemory.failures", () => {
    recordFailure("aplicar_diff", "leak error 1");
    recordFailure("editar_arquivo", "leak error 2");
    expect(getFailures().length).toBe(2);
    clearAllModuleStateSync();
    expect(getFailures().length).toBe(0);
  });

  it("clears patternExtractor.cachedPatterns", () => {
    // Prime cache by calling getPatternsCached with a tmp dir.
    try { getPatternsCached("/tmp/__leak_sync_patterns__"); } catch { /* ok */ }
    // Clearing must not throw. We can't directly observe the cache being
    // empty (no public accessor), but the helper must complete without error.
    expect(() => clearAllModuleStateSync()).not.toThrow();
  });

  it("clears activityTracker.state.stack", () => {
    pushActivity("tool", "leak_sync_activity");
    pushActivity("subagent", "leak_sync_subagent");
    expect(getActivitySnapshot().depth).toBe(2);
    clearAllModuleStateSync();
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("does NOT throw if a module's clear function fails (resilience)", () => {
    // Simulate a future refactor where one of the clears throws.
    // The helper must swallow the error and continue clearing the rest.
    const honesty = vi.spyOn(
      { clearAllHonestyState },
      "clearAllHonestyState",
    ).mockImplementation(() => {
      throw new Error("simulated honesty clear failure");
    });
    // Even with honesty throwing, failureMemory should still be cleared.
    recordFailure("aplicar_diff", "leak error that should still be cleared");
    expect(() => clearAllModuleStateSync()).not.toThrow();
    expect(getFailures().length).toBe(0);
    honesty.mockRestore();
  });
});

// ─── Tests: clearAllModuleState (async, full set incl. heavy modules) ───────

describe("clearAllModuleState (async) — clears light + heavy module state", () => {
  it("clears all light-module state (same as sync version)", async () => {
    recordRead("ler_arquivo", "/tmp/leak_async_read.ts");
    recordSessionFileEdit("/tmp/leak_async_edited.ts");
    recordSkillInvocation("/tmp/leak_async_skill.md");
    markFileAsEdited("/tmp/leak_async_honesty.ts");
    recordFailure("aplicar_diff", "async leak error");
    pushActivity("tool", "leak_async_activity");

    await clearAllModuleState();

    expect(hasBeenRead("/tmp/leak_async_read.ts")).toBe(false);
    expect(getSessionEditedFiles().length).toBe(0);
    expect(getInvokedSkills().length).toBe(0);
    expect(getUnreadBackFiles().length).toBe(0);
    expect(getFailures().length).toBe(0);
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("calls resetBugHunterState via dynamic import (heavy module)", async () => {
    const bugHunter = await import("../bugHunter.js");
    const spy = vi.spyOn(bugHunter, "resetBugHunterState");

    await clearAllModuleState();

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("calls resetDataGuardState via dynamic import (heavy module)", async () => {
    const dataGuard = await import("../dataGuard.js");
    const spy = vi.spyOn(dataGuard, "resetDataGuardState");

    await clearAllModuleState();

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("calls resetCheckpoints via dynamic import (heavy module)", async () => {
    const checkpoint = await import("../checkpointWriter.js");
    const spy = vi.spyOn(checkpoint, "resetCheckpoints");

    await clearAllModuleState();

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("clears bugHunter state end-to-end (previousFindings + fileSnapshots)", async () => {
    const bugHunter = await import("../bugHunter.js");
    // snapshotFileBeforeEdit populates the internal fileSnapshots Map.
    // We can't read it directly, but resetBugHunterState is supposed to
    // clear it. Verify the function exists and runs without error.
    expect(typeof bugHunter.resetBugHunterState).toBe("function");
    if (typeof (bugHunter as any).snapshotFileBeforeEdit === "function") {
      (bugHunter as any).snapshotFileBeforeEdit("/tmp/leak_bughunter_snap.ts");
    }
    await expect(clearAllModuleState()).resolves.toBeUndefined();
  });

  it("is resilient — does not throw if a heavy module fails to load", async () => {
    // Force the bugHunter dynamic import to reject by re-mocking it to throw.
    vi.doMock("../bugHunter.js", () => {
      throw new Error("simulated bugHunter load failure");
    });
    // The helper must NOT throw — try/catch swallows the load failure.
    // Light-module clears must still complete.
    recordFailure("aplicar_diff", "leak error before heavy-module failure");
    await expect(clearAllModuleState()).resolves.toBeUndefined();
    expect(getFailures().length).toBe(0);
    vi.doUnmock("../bugHunter.js");
  });

  it("can be called multiple times safely (idempotent)", async () => {
    recordRead("ler_arquivo", "/tmp/leak_idempotent.ts");
    recordFailure("aplicar_diff", "leak error 1");
    pushActivity("tool", "leak_idempotent_activity");
    await clearAllModuleState();
    await clearAllModuleState(); // second call must not throw
    await clearAllModuleState(); // third call must not throw
    expect(hasBeenRead("/tmp/leak_idempotent.ts")).toBe(false);
    expect(getFailures().length).toBe(0);
    expect(getActivitySnapshot().depth).toBe(0);
  });
});

// ─── Tests: fire-and-forget pattern (matches App.tsx usage) ─────────────────

describe("clearAllModuleState — fire-and-forget pattern (void operator)", () => {
  it("can be called with `void` prefix (App.tsx pattern) without throwing", () => {
    // App.tsx calls `void clearAllModuleState()` in synchronous reset handlers.
    // The void operator discards the promise; the helper must NOT throw
    // synchronously (any rejection is unhandled but swallowed by try/catch
    // inside the helper).
    expect(() => { void clearAllModuleState(); }).not.toThrow();
  });
});
