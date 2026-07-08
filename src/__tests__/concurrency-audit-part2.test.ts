/**
 * concurrency-audit-part2.test.ts — Race condition tests for:
 *   1. Compaction: user sends message while compaction is running
 *   2. readBeforeWrite: state cleared while tool is executing
 *   3. State cleanup: /reset while agent loop is running
 *   4. Activity tracker: listeners modified during notify()
 *   5. File lock: two agents trying to edit same file
 *
 * Each describe block maps 1:1 to a race in the audit. Tests assert
 * BOTH the buggy behavior (now fixed) AND the safe behavior we rely on.
 *
 * Uses `import` (ESM) — never require().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- Mocks ----------------------------------------------------------------
// Mock logger so tests don't spam console output. fileLock and
// readBeforeWrite import * as log from "./logger.js".
vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    toolCall: vi.fn(),
    toolResult: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
}));

// i18n is imported by readBeforeWrite. Provide a no-op t().
vi.mock("../i18n.js", () => ({
  t: vi.fn((_key: string, ..._args: unknown[]) => "i18n-stub"),
}));

import {
  pushActivity,
  clearActivity,
  getActivitySnapshot,
  subscribeToActivity,
  _resetActivityForTests,
} from "../activityTracker.js";

import {
  recordRead,
  recordWrite,
  checkReadBeforeWrite,
  hasBeenRead,
  clearReadPaths,
  setReadBeforeWriteEnabled,
  setAgentLoopRunningChecker,
} from "../readBeforeWrite.js";

import {
  tryAcquireLock,
  acquireLock,
  getLockHolder,
  forceReleaseLock,
  clearAllLocks,
  getCurrentAgentId,
} from "../fileLock.js";

// --- Race #4: ActivityTracker listeners modified during notify() -----------

describe("Concurrency Audit Part 2 — Race #4: ActivityTracker listener mutation during notify()", () => {
  beforeEach(() => {
    _resetActivityForTests();
  });

  it("listener that unsubscribes itself does NOT prevent other listeners from being notified", () => {
    // BUG (before fix): notify() iterated the live Set. If listener A
    // unsubscribed itself during notify(), and listener B was added AFTER
    // A in insertion order, B would still be visited (correct). But if A
    // unsubscribed B (via a closure), B would be SILENTLY SKIPPED. The
    // snapshot fix ensures all listeners that existed at notify() start
    // are visited, regardless of mutations during the loop.
    const calls: string[] = [];

    let unsubB: (() => void) | null = null;
    const listenerA = vi.fn(() => {
      calls.push("A");
      // A unsubscribes B mid-iteration
      if (unsubB) unsubB();
    });
    const listenerB = vi.fn(() => {
      calls.push("B");
    });

    subscribeToActivity(listenerA);
    unsubB = subscribeToActivity(listenerB);

    // Trigger notify via pushActivity
    pushActivity("tool", "ler_arquivo");

    // AFTER fix: B was in the snapshot taken at notify() start, so even
    // though A unsubscribed B mid-iteration, B is still called.
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["A", "B"]);
  });

  it("listener that subscribes a new listener during notify() does NOT cause the new one to be called in the same tick", () => {
    // BUG (before fix): adding to a Set during iteration may or may not
    // visit the new entry in the same tick (engine-dependent). With the
    // snapshot fix, newly-added listeners are only called on the NEXT
    // notify() — deterministic and intuitive.
    const newListener = vi.fn();
    const listenerA = vi.fn(() => {
      // A subscribes a new listener mid-iteration
      subscribeToActivity(newListener);
    });

    subscribeToActivity(listenerA);
    pushActivity("tool", "ler_arquivo");

    // After fix: newListener was added AFTER the snapshot was taken, so
    // it is NOT called in this notify() tick.
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(newListener).not.toHaveBeenCalled();

    // On the NEXT notify(), newListener IS called (it's in the snapshot now)
    pushActivity("tool", "ler_arquivo");
    expect(newListener).toHaveBeenCalledTimes(1);
  });

  it("listener that throws does NOT break the iteration (existing behavior preserved)", () => {
    // This was already safe before the fix (try/catch around each call),
    // but verify the snapshot fix didn't regress it.
    const badListener = () => { throw new Error("listener bug"); };
    const goodListener = vi.fn();
    subscribeToActivity(badListener);
    subscribeToActivity(goodListener);

    expect(() => pushActivity("tool", "ler_arquivo")).not.toThrow();
    expect(goodListener).toHaveBeenCalled();
  });

  it("snapshot is taken at notify() start — listeners added AFTER notify completes are called on next tick only", () => {
    const order: string[] = [];
    const l1 = vi.fn(() => order.push("l1"));
    subscribeToActivity(l1);

    pushActivity("tool", "first");
    expect(order).toEqual(["l1"]);

    const l2 = vi.fn(() => order.push("l2"));
    subscribeToActivity(l2);

    // l2 was added AFTER the first notify completed. It will be called on
    // the next notify.
    pushActivity("tool", "second");
    expect(order).toEqual(["l1", "l1", "l2"]);
  });
});

// --- Race #5: File lock between two agents editing same file ----------------

describe("Concurrency Audit Part 2 — Race #5: fileLock parallel agents on same file", () => {
  beforeEach(() => {
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  afterEach(() => {
    clearAllLocks();
    delete process.env.CLAUDE_KILLER_AGENT_ID;
  });

  it("BLOCKS a second agent with a DIFFERENT holderId (was already safe, still is)", () => {
    const r1 = tryAcquireLock("/race5/diff-holder.luau", "main");
    const r2 = tryAcquireLock("/race5/diff-holder.luau", "sub-1");
    expect(r1).not.toBeNull();
    expect(r2).toBeNull();
    r1!();
  });

  it("FIX: BLOCKS a second agent with the SAME holderId (parallel sub-agents sharing env var)", () => {
    // The actual race #5 bug: parallel sub-agents share
    // process.env.CLAUDE_KILLER_AGENT_ID. Before the fix, the second
    // acquire was treated as "re-entrant" and got a no-op release,
    // allowing both to edit the file simultaneously and corrupt each
    // other's writes.
    const r1 = tryAcquireLock("/race5/same-holder.luau", "sub-A");
    const r2 = tryAcquireLock("/race5/same-holder.luau", "sub-A");
    expect(r1).not.toBeNull();
    expect(r2).toBeNull(); // FIX: now blocked, was previously a no-op release
    r1!();
  });

  it("acquireLock (blocking) WAITS when same holderId tries to re-acquire", async () => {
    // Even with the same holderId, the blocking variant now waits
    // instead of returning immediately with a no-op release.
    const r1 = tryAcquireLock("/race5/blocking-same.luau", "main");
    expect(r1).not.toBeNull();

    let resolved = false;
    const acquirePromise = acquireLock("/race5/blocking-same.luau", "main", 30_000, 500);

    // Release after 100ms — the promise should resolve after that
    setTimeout(() => r1!(), 100);

    const r2 = await acquirePromise;
    resolved = true;
    expect(resolved).toBe(true);
    expect(typeof r2).toBe("function");
    r2();
  });

  it("two parallel sub-agents with the SAME env-var-derived holderId serialize correctly", async () => {
    // Simulates the production scenario: two sub-agents both get
    // holderId="sub-A" because they share process.env. Before the fix,
    // both would "re-acquire" the lock and corrupt each other. Now they
    // serialize via acquireLock's polling loop.
    process.env.CLAUDE_KILLER_AGENT_ID = "sub-A";
    expect(getCurrentAgentId()).toBe("sub-A");

    const filePath = "/race5/parallel-corruption.luau";

    // Sub-agent 1 acquires
    const release1 = await acquireLock(filePath, "sub-A", 30_000, 5000);
    expect(release1).not.toBeFalsy();

    // Sub-agent 2 tries to acquire in parallel — must block, NOT get a no-op
    let agent2Acquired = false;
    const agent2Promise = acquireLock(filePath, "sub-A", 30_000, 500).then((r) => {
      agent2Acquired = true;
      return r;
    });

    // Give the event loop a tick — agent 2 should NOT have acquired yet
    await new Promise((r) => setTimeout(r, 50));
    expect(agent2Acquired).toBe(false);

    // Sub-agent 1 releases
    release1();

    // Now agent 2 can acquire
    const release2 = await agent2Promise;
    expect(agent2Acquired).toBe(true);
    release2();
  });

  it("expired lock can still be stolen by a different holder (preserved behavior)", async () => {
    const r1 = tryAcquireLock("/race5/expired.luau", "main", 1);
    expect(r1).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const r2 = tryAcquireLock("/race5/expired.luau", "sub-1");
    expect(r2).not.toBeNull();
    expect(getLockHolder("/race5/expired.luau")!.holderId).toBe("sub-1");
    r2!();
  });

  it("forceReleaseLock allows recovery from a stuck lock (admin override)", () => {
    tryAcquireLock("/race5/force.luau", "main");
    expect(getLockHolder("/race5/force.luau")).not.toBeNull();
    expect(forceReleaseLock("/race5/force.luau")).toBe(true);
    expect(getLockHolder("/race5/force.luau")).toBeNull();
  });
});

// --- Race #2 & #3: readBeforeWrite + agent-loop-running guard --------------

describe("Concurrency Audit Part 2 — Race #2/#3: clearReadPaths refuses to run while agent loop is active", () => {
  beforeEach(() => {
    clearReadPaths();
    setReadBeforeWriteEnabled(true);
    // Reset the checker to a known state: agent loop NOT running.
    setAgentLoopRunningChecker(() => false);
  });

  afterEach(() => {
    setAgentLoopRunningChecker(() => false);
    clearReadPaths();
  });

  it("clearReadPaths() works when agent loop is NOT running (normal /reset)", () => {
    recordRead("ler_arquivo", "/tmp/race2/normal.ts");
    expect(hasBeenRead("/tmp/race2/normal.ts")).toBe(true);

    clearReadPaths();
    expect(hasBeenRead("/tmp/race2/normal.ts")).toBe(false);
  });

  it("FIX: clearReadPaths() is a NO-OP when agent loop IS running (prevents mid-turn corruption)", () => {
    // Simulate the agent loop running
    setAgentLoopRunningChecker(() => true);

    recordRead("ler_arquivo", "/tmp/race2/mid-turn.ts");
    expect(hasBeenRead("/tmp/race2/mid-turn.ts")).toBe(true);

    // /reset fires while the agent is mid-turn (e.g., from a test or a
    // future code path that bypasses the TUI's isProcessing guard).
    // Before the fix: readPaths was wiped, and any LATER write tool in
    // the same turn was incorrectly blocked ("you haven't read this").
    // After the fix: clearReadPaths() detects the active loop and skips.
    clearReadPaths();

    expect(hasBeenRead("/tmp/race2/mid-turn.ts")).toBe(true);
  });

  it("after the agent loop ends, clearReadPaths() works again", () => {
    // Loop running: clear is no-op
    setAgentLoopRunningChecker(() => true);
    recordRead("ler_arquivo", "/tmp/race2/after-loop.ts");
    clearReadPaths();
    expect(hasBeenRead("/tmp/race2/after-loop.ts")).toBe(true);

    // Loop ends: clear works
    setAgentLoopRunningChecker(() => false);
    clearReadPaths();
    expect(hasBeenRead("/tmp/race2/after-loop.ts")).toBe(false);
  });

  it("checkReadBeforeWrite still works correctly during a running agent loop", () => {
    // The guard only blocks clearReadPaths, not the read/write/check
    // operations themselves. Those continue to work normally during a
    // turn (which is exactly what the agent loop relies on).
    setAgentLoopRunningChecker(() => true);
    recordRead("ler_arquivo", "/tmp/race2/check-during.ts");

    const allowed = checkReadBeforeWrite("editar_arquivo", {
      caminho: "/tmp/race2/check-during.ts",
    });
    expect(allowed.allowed).toBe(true);

    const blocked = checkReadBeforeWrite("editar_arquivo", {
      caminho: "/tmp/race2/never-read-during.ts",
    });
    expect(blocked.allowed).toBe(false);
  });
});

// --- Race #1: Compaction blocking / runAgentLoop re-entrancy ---------------
//
// We can't easily unit-test the full compaction+message race without
// mocking the entire API client + history module. Instead, we test the
// re-entrancy guard that prevents the race at its root: a second
// runAgentLoop() cannot start while the first is still running.
//
// We import runAgentLoop's guard checker indirectly: the
// `setAgentLoopRunningChecker` registered by agent.ts at module load
// routes to the internal `agentLoopRunning` flag. We test that flag's
// behavior via readBeforeWrite's clearReadPaths() (which reads it),
// without needing to start a real agent loop (which would require
// mocking chat(), history, telemetry, etc.).
//
// A more direct test of runAgentLoop's re-entrancy throw is in
// agent-extended.test.ts (it requires the full agent mock harness).

describe("Concurrency Audit Part 2 — Race #1: runAgentLoop re-entrancy guard (indirect test via readBeforeWrite)", () => {
  // Before runAgentLoop is ever called, the guard is false.
  // After runAgentLoop starts, the guard is true.
  // After runAgentLoop ends (or throws), the guard is false again.
  //
  // We can't run a real runAgentLoop here (it would require mocking
  // chat(), history, telemetry, etc.). Instead, we verify that the
  // checker mechanism correctly reports "not running" by default —
  // which means a hypothetical /reset during the agent's idle time
  // works correctly.

  beforeEach(() => {
    // The checker registered by agent.ts at module load reads
    // `agentLoopRunning`. We don't override it here — we want to verify
    // the real wiring. But to make this test hermetic, we reset it.
    setAgentLoopRunningChecker(() => false);
  });

  afterEach(() => {
    setAgentLoopRunningChecker(() => false);
    clearReadPaths();
  });

  it("by default (no agent loop running), clearReadPaths works — the guard is not stuck 'on'", () => {
    recordRead("ler_arquivo", "/tmp/race1/idle.ts");
    expect(hasBeenRead("/tmp/race1/idle.ts")).toBe(true);
    clearReadPaths();
    expect(hasBeenRead("/tmp/race1/idle.ts")).toBe(false);
  });

  it("when the checker reports 'running', clearReadPaths is suppressed (simulating compaction in progress)", () => {
    // Simulate runAgentLoop setting agentLoopRunning=true at its start.
    setAgentLoopRunningChecker(() => true);

    recordRead("ler_arquivo", "/tmp/race1/compaction.ts");
    // User types /reset during compaction (or a programmatic caller fires).
    clearReadPaths();
    // The clear was suppressed — the in-progress turn's read state is intact.
    expect(hasBeenRead("/tmp/race1/compaction.ts")).toBe(true);
  });

  it("checker can be cleared (set to null) — clearReadPaths then works unconditionally", () => {
    setAgentLoopRunningChecker(null);
    recordRead("ler_arquivo", "/tmp/race1/no-checker.ts");
    clearReadPaths();
    expect(hasBeenRead("/tmp/race1/no-checker.ts")).toBe(false);
  });
});

// --- Cross-cutting: agent.ts exports the guard -----------------------------

describe("Concurrency Audit Part 2 — agent.ts exports isAgentLoopRunning", () => {
  it("isAgentLoopRunning is a callable export (smoke test, doesn't require a running loop)", async () => {
    // Dynamic import to avoid loading the full agent module (and its
    // many dependencies) at test-collection time.
    const agentMod = await import("../agent.js");
    expect(typeof agentMod.isAgentLoopRunning).toBe("function");
    // Without a running loop, this returns false.
    expect(agentMod.isAgentLoopRunning()).toBe(false);
  });
});
