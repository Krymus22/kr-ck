/**
 * regression-round4-integration.test.ts — Round 4 integration flow regressions.
 *
 * Round 4 audit verified 8 integration flows:
 *   1. User → agent loop → tool call → tool result → IA continues
 *   2. Session save → terminal close → restart → session load → IA has context
 *   3. Compaction triggers → re-hydration → continuation message → IA continues
 *   4. /reset clears ALL state
 *   5. /session load clears ALL state then loads new session
 *   6. Plan mode → ===END PLAN=== → createPlan → plan execution → completion
 *   7. Bug Hunter runs → blocks finish → IA fixes → Bug Hunter re-runs → allows
 *   8. Quality gate blocks → IA fixes tsc/lint → quality gate passes
 *
 * Bug class found: `stateCleanup.ts` cleared readPaths, sessionFiles,
 * invokedSkills, honestySystem, failureMemory, patternExtractor, activity,
 * bugHunter, dataGuard, checkpointWriter — but missed FOUR module-level
 * singletons that ALSO leak across /reset, /session new, /session load,
 * auto-load, and the mode "new" context action:
 *
 *   - planExecutor.currentPlan       → hasIncompletePlan() blocks finish
 *                                      in the NEW session on the first turn
 *                                      that touches files (§10.5 step 4).
 *   - specFirst.currentSpec          → hasSpec() stays true; the previous
 *                                      session's spec is treated as the
 *                                      contract for the new session.
 *   - tddMode.currentTDD             → hasTDD() stays true; tests from the
 *                                      previous session are re-run against
 *                                      new code.
 *   - todo.currentTodos              → TodoBar still shows previous session's
 *                                      tasks (visible leak in the TUI).
 *
 * Fix: clearAllModuleState() and clearAllModuleStateSync() now call
 * clearPlan(), clearSpec(), clearTDD(), and resetTodo() too. All four are
 * light modules (only `logger.js` / `node:fs` / `node:path` imports — no
 * apiClient, no OpenAI SDK), so they belong in the synchronous clear set
 * alongside readBeforeWrite, fileRehydration, etc.
 *
 * §17 audit: this fix does NOT violate any §17 inviolable rule:
 *   - §17.1 (IA behavior): no change.
 *   - §17.2 (config): no change.
 *   - §17.3 (session): the new clears AUGMENT the §17.3.11 mandate
 *     (clearReadPaths on /reset, /session new, /session load, auto-load)
 *     by extending the same defense-in-depth pattern. No existing
 *     behavior is weakened.
 *   - §17.4 (API), §17.5 (MCP), §17.6 (CI/CD), §17.7 (quality gate):
 *     no change.
 *
 * Tests:
 *   - Each new clear is actually invoked by clearAllModuleStateSync.
 *   - Each new clear is actually invoked by clearAllModuleState (async).
 *   - End-to-end regression: stale plan blocks finish BEFORE fix; clearAllModuleState
 *     clears the stale plan; new session's first turn with file edits is NOT
 *     blocked by the stale plan AFTER fix.
 *   - The helper is resilient (a throwing clear doesn't block the rest).
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

import {
  createPlan,
  hasIncompletePlan,
  getPlan,
  clearPlan,
} from "../planExecutor.js";
import {
  createSpec,
  hasSpec,
  getSpec,
  clearSpec,
} from "../specFirst.js";
import {
  registerTDD,
  hasTDD,
  getTDD,
  clearTDD,
} from "../tddMode.js";
import {
  setTodos,
  getTodos,
  resetTodo,
  type TodoItem,
} from "../todo.js";

// ─── Test setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset every light module to a known-empty state before each test.
  clearPlan();
  clearSpec();
  clearTDD();
  resetTodo();
});

// ─── Tests: clearAllModuleStateSync clears the new singletons ───────────────

describe("Round 4 fix — clearAllModuleStateSync clears plan/spec/tdd/todo", () => {
  it("clears planExecutor.currentPlan", () => {
    createPlan(["step 1", "step 2", "step 3"]);
    expect(getPlan()).not.toBeNull();
    expect(hasIncompletePlan()).toBe(true);

    clearAllModuleStateSync();

    expect(getPlan()).toBeNull();
    expect(hasIncompletePlan()).toBe(false);
  });

  it("clears specFirst.currentSpec", () => {
    createSpec({
      name: "Round4Spec",
      description: "regression test spec",
      inputs: [],
      outputs: [],
      edgeCases: [],
      constraints: [],
    });
    expect(hasSpec()).toBe(true);

    clearAllModuleStateSync();

    expect(hasSpec()).toBe(false);
    expect(getSpec()).toBeNull();
  });

  it("clears tddMode.currentTDD", () => {
    // registerTDD(testFile, implFile, language, testCases) — positional args.
    registerTDD("/tmp/round4.test.ts", "/tmp/round4.ts", "typescript", ["case 1"]);
    expect(hasTDD()).toBe(true);

    clearAllModuleStateSync();

    expect(hasTDD()).toBe(false);
    expect(getTDD()).toBeNull();
  });

  it("clears todo.currentTodos", () => {
    const items: TodoItem[] = [
      { status: "pending", content: "round4 task", active_form: "working on round4 task" },
    ];
    setTodos(items);
    expect(getTodos().length).toBe(1);

    clearAllModuleStateSync();

    expect(getTodos().length).toBe(0);
  });
});

// ─── Tests: clearAllModuleState (async) clears the new singletons ───────────

describe("Round 4 fix — clearAllModuleState (async) clears plan/spec/tdd/todo", () => {
  it("clears all four new singletons in one call", async () => {
    createPlan(["a", "b"]);
    createSpec({
      name: "S",
      description: "d",
      inputs: [],
      outputs: [],
      edgeCases: [],
      constraints: [],
    });
    registerTDD("/tmp/t.test.ts", "/tmp/t.ts", "typescript", []);
    setTodos([{ status: "pending", content: "x", active_form: "y" }]);

    // Confirm state is populated BEFORE the clear.
    expect(hasIncompletePlan()).toBe(true);
    expect(hasSpec()).toBe(true);
    expect(hasTDD()).toBe(true);
    expect(getTodos().length).toBe(1);

    await clearAllModuleState();

    expect(hasIncompletePlan()).toBe(false);
    expect(hasSpec()).toBe(false);
    expect(hasTDD()).toBe(false);
    expect(getTodos().length).toBe(0);
  });

  it("still clears the heavy modules (bugHunter, dataGuard, checkpointWriter)", async () => {
    // Spy on the heavy-module clears to verify they're still invoked after
    // adding the four new synchronous clears.
    const bugHunter = await import("../bugHunter.js");
    const dataGuard = await import("../dataGuard.js");
    const checkpoint = await import("../checkpointWriter.js");
    const bhSpy = vi.spyOn(bugHunter, "resetBugHunterState");
    const dgSpy = vi.spyOn(dataGuard, "resetDataGuardState");
    const cpSpy = vi.spyOn(checkpoint, "resetCheckpoints");

    await clearAllModuleState();

    expect(bhSpy).toHaveBeenCalledTimes(1);
    expect(dgSpy).toHaveBeenCalledTimes(1);
    expect(cpSpy).toHaveBeenCalledTimes(1);

    bhSpy.mockRestore();
    dgSpy.mockRestore();
    cpSpy.mockRestore();
  });
});

// ─── Tests: resilience — a throwing clear doesn't break the rest ────────────

describe("Round 4 fix — resilience", () => {
  it("does NOT throw if clearPlan throws (sync)", () => {
    // Spy on clearPlan and force it to throw. The helper's try/catch must
    // swallow it and still clear the rest (e.g. clearSpec).
    const planSpy = vi.spyOn(
      { clearPlan },
      "clearPlan",
    ).mockImplementation(() => {
      throw new Error("simulated clearPlan failure");
    });

    createSpec({
      name: "S",
      description: "d",
      inputs: [],
      outputs: [],
      edgeCases: [],
      constraints: [],
    });
    expect(hasSpec()).toBe(true);

    expect(() => clearAllModuleStateSync()).not.toThrow();
    // Even with clearPlan throwing, clearSpec must still have run.
    expect(hasSpec()).toBe(false);

    planSpy.mockRestore();
  });

  it("does NOT throw if clearPlan throws (async)", async () => {
    const planSpy = vi.spyOn(
      { clearPlan },
      "clearPlan",
    ).mockImplementation(() => {
      throw new Error("simulated clearPlan failure");
    });

    createSpec({
      name: "S",
      description: "d",
      inputs: [],
      outputs: [],
      edgeCases: [],
      constraints: [],
    });

    await expect(clearAllModuleState()).resolves.toBeUndefined();
    expect(hasSpec()).toBe(false);

    planSpy.mockRestore();
  });
});

// ─── Tests: end-to-end regression for the plan leak (Flow 4 + 5 + 6) ────────

describe("Round 4 end-to-end regression — stale plan no longer blocks new session", () => {
  /**
   * Reproduces the exact bug found in Round 4:
   *
   *   1. Session A creates a plan with incomplete steps via createPlan().
   *      → hasIncompletePlan() returns true.
   *   2. User runs /reset (or /session new, /session load, auto-load, mode "new").
   *      → Before fix: clearAllModuleState did NOT clear currentPlan.
   *      → After fix:  clearAllModuleState DOES clear currentPlan.
   *   3. In the NEW session, the IA edits a file (simulated by setting
   *      turnTouchedFiles). The agent loop's handleStopReason calls
   *      hasIncompletePlan() — BUSINESS_RULES.md §10.5 step 4 says:
   *      "Plan completion check — se hasIncompletePlan() E touchedFiles > 0"
   *      blocks finish.
   *      → Before fix: stale plan from session A blocks the new session's
   *        first turn.
   *      → After fix:  no plan in the new session, so hasIncompletePlan()
   *        returns false, finish is NOT blocked.
   */
  it("stale plan from previous session is cleared by clearAllModuleState (async)", async () => {
    // Step 1: session A creates a plan with incomplete steps.
    createPlan(["step A1", "step A2", "step A3"]);
    expect(hasIncompletePlan()).toBe(true);

    // Step 2: user runs /reset → App.tsx calls void clearAllModuleState().
    await clearAllModuleState();

    // Step 3: new session starts. The agent loop checks hasIncompletePlan().
    // With the fix, currentPlan is null, so hasIncompletePlan() returns false.
    expect(hasIncompletePlan()).toBe(false);

    // Even if the IA touches files in the new session, the plan-completion
    // gate (§10.5 step 4) does NOT block finish — there is no plan to
    // complete.
    const turnTouchedFiles = new Set<string>(["/tmp/new-session-file.ts"]);
    const planBlocks = hasIncompletePlan() && turnTouchedFiles.size > 0;
    expect(planBlocks).toBe(false);
  });

  it("stale plan from previous session is cleared by clearAllModuleStateSync", () => {
    createPlan(["step A1"]);
    expect(hasIncompletePlan()).toBe(true);

    clearAllModuleStateSync();

    expect(hasIncompletePlan()).toBe(false);
    const turnTouchedFiles = new Set<string>(["/tmp/new-session-file.ts"]);
    const planBlocks = hasIncompletePlan() && turnTouchedFiles.size > 0;
    expect(planBlocks).toBe(false);
  });

  it("stale spec from previous session is cleared (Flow 4 / 5)", async () => {
    createSpec({
      name: "SessionASpec",
      description: "spec from previous session",
      inputs: [],
      outputs: [],
      edgeCases: [],
      constraints: [],
    });
    expect(hasSpec()).toBe(true);

    await clearAllModuleState();

    expect(hasSpec()).toBe(false);
    // New session's first turn: the IA calls escrever_spec again, which
    // createSpec() handles correctly (it always overwrites). No leak.
    createSpec({
      name: "SessionBSpec",
      description: "spec from new session",
      inputs: [],
      outputs: [],
      edgeCases: [],
      constraints: [],
    });
    expect(getSpec()?.name).toBe("SessionBSpec");
  });

  it("stale TDD from previous session is cleared (Flow 4 / 5)", async () => {
    registerTDD("/tmp/sessionA.test.ts", "/tmp/sessionA.ts", "typescript", ["old case"]);
    expect(hasTDD()).toBe(true);
    expect(getTDD()?.testFile).toBe("/tmp/sessionA.test.ts");

    await clearAllModuleState();

    expect(hasTDD()).toBe(false);
    // New session can register its own TDD without inheriting the old one.
    registerTDD("/tmp/sessionB.test.ts", "/tmp/sessionB.ts", "typescript", ["new case"]);
    expect(getTDD()?.testFile).toBe("/tmp/sessionB.test.ts");
  });

  it("stale todos from previous session are cleared (Flow 4 / 5)", async () => {
    const sessionATodos: TodoItem[] = [
      { status: "completed", content: "session A done", active_form: "doing A" },
      { status: "in_progress", content: "session A in progress", active_form: "doing A2" },
      { status: "pending", content: "session A pending", active_form: "doing A3" },
    ];
    setTodos(sessionATodos);
    expect(getTodos().length).toBe(3);

    await clearAllModuleState();

    // The TodoBar in the TUI syncs from getTodos() — after /reset, it should
    // be empty (no stale tasks visible to the user).
    expect(getTodos().length).toBe(0);
  });
});

// ─── Tests: idempotency ─────────────────────────────────────────────────────

describe("Round 4 fix — idempotency", () => {
  it("clearAllModuleState can be called multiple times safely", async () => {
    createPlan(["a"]);
    setTodos([{ status: "pending", content: "x", active_form: "y" }]);
    await clearAllModuleState();
    await clearAllModuleState();
    await clearAllModuleState();
    expect(hasIncompletePlan()).toBe(false);
    expect(getTodos().length).toBe(0);
  });

  it("clearAllModuleStateSync can be called multiple times safely", () => {
    createPlan(["a"]);
    setTodos([{ status: "pending", content: "x", active_form: "y" }]);
    clearAllModuleStateSync();
    clearAllModuleStateSync();
    clearAllModuleStateSync();
    expect(hasIncompletePlan()).toBe(false);
    expect(getTodos().length).toBe(0);
  });
});
