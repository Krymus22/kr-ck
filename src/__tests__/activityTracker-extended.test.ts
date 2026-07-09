/**
 * activityTracker-extended.test.ts — Extended tests for activityTracker.ts
 *
 * Covers:
 *   - All ActivityCategory values produce valid snapshots
 *   - pushActivity returns a "done" pop function
 *   - Stack semantics: nested pushes, out-of-order pops, multi-pop safety
 *   - getActivitySnapshot fields: current, depth, displayLabel, shortLabel, elapsedMs
 *   - subscribeToActivity: listener is called on push/pop; unsubscribe works
 *   - clearActivity empties the stack
 *   - withActivity / withActivitySync wrappers (return value, exception propagation)
 *   - notifyActivity forces a notify
 *   - Edge cases: empty stack snapshot, very deep stacks
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  pushActivity,
  clearActivity,
  getActivitySnapshot,
  subscribeToActivity,
  withActivity,
  withActivitySync,
  notifyActivity,
  _resetActivityForTests,
  type ActivityCategory,
  type ActivitySnapshot,
} from "../activityTracker.js";

beforeEach(() => {
  _resetActivityForTests();
});

// ─── pushActivity / pop semantics ──────────────────────────────────────────
describe("pushActivity", () => {
  it("returns a function (the pop callback)", () => {
    const done = pushActivity("tool", "ler_arquivo");
    expect(typeof done).toBe("function");
    done();
  });

  it("pushing one activity sets depth=1 and current to that activity", () => {
    const done = pushActivity("tool", "ler_arquivo");
    const snap = getActivitySnapshot();
    expect(snap.depth).toBe(1);
    expect(snap.current).not.toBeNull();
    expect(snap.current!.category).toBe("tool");
    expect(snap.current!.label).toBe("ler_arquivo");
    done();
  });

  it("pushing two activities sets depth=2 with LIFO top", () => {
    const done1 = pushActivity("api_call", "kimi");
    const done2 = pushActivity("tool", "ler_arquivo");
    const snap = getActivitySnapshot();
    expect(snap.depth).toBe(2);
    expect(snap.current!.category).toBe("tool");
    done2();
    done1();
  });

  it("popping the top of stack returns to the previous", () => {
    const done1 = pushActivity("api_call", "kimi");
    const done2 = pushActivity("tool", "ler_arquivo");
    done2();
    const snap = getActivitySnapshot();
    expect(snap.depth).toBe(1);
    expect(snap.current!.category).toBe("api_call");
    done1();
  });

  it("popping a middle entry also pops all descendants", () => {
    const d1 = pushActivity("api_call", "kimi");
    const d2 = pushActivity("tool", "ler_arquivo");
    const d3 = pushActivity("quality_gate", "tsc");
    expect(getActivitySnapshot().depth).toBe(3);
    d1();
    expect(getActivitySnapshot().depth).toBe(0);
    // subsequent pops are no-ops
    d2();
    d3();
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("calling pop more than once is a no-op (safe)", () => {
    const done = pushActivity("tool", "ler_arquivo");
    done();
    expect(getActivitySnapshot().depth).toBe(0);
    expect(() => done()).not.toThrow();
    expect(getActivitySnapshot().depth).toBe(0);
  });
});

// ─── All ActivityCategory values produce valid snapshots ───────────────────
describe("All ActivityCategory values", () => {
  const categories: ActivityCategory[] = [
    "idle", "thinking", "streaming", "tool", "subagent",
    "quality_gate", "compacting", "checkpoint",
    "api_call", "api_retry", "bug_hunter", "dataguard",
  ];

  for (const cat of categories) {
    it(`category '${cat}' produces a non-null current with displayLabel and shortLabel`, () => {
      const done = pushActivity(cat, "test-label");
      const snap = getActivitySnapshot();
      expect(snap.current).not.toBeNull();
      expect(snap.current!.category).toBe(cat);
      expect(typeof snap.displayLabel).toBe("string");
      expect(typeof snap.shortLabel).toBe("string");
      done();
    });
  }
});

// ─── displayLabel / shortLabel formatting ──────────────────────────────────
describe("Label formatting per category", () => {
  it("thinking: displayLabel starts with 'Pensando:'", () => {
    const done = pushActivity("thinking", "estratégia");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Pensando");
    expect(snap.displayLabel).toContain("estratégia");
    expect(snap.shortLabel).toBe("pensando");
    done();
  });

  it("streaming with empty label: displayLabel is 'Gerando resposta'", () => {
    const done = pushActivity("streaming", "");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Gerando resposta");
    done();
  });

  it("streaming with label: displayLabel includes the label", () => {
    const done = pushActivity("streaming", "kimi-k2");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("kimi-k2");
    expect(snap.shortLabel).toBe("streaming");
    done();
  });

  it("tool: displayLabel includes 'Executando tool:' prefix", () => {
    const done = pushActivity("tool", "aplicar_diff");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Executando tool");
    expect(snap.shortLabel).toBe("aplicar_diff");
    done();
  });

  it("subagent: displayLabel starts with 'Sub-agente:'", () => {
    const done = pushActivity("subagent", "worker-1");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Sub-agente");
    expect(snap.shortLabel).toBe("sub-agente");
    done();
  });

  it("quality_gate: displayLabel starts with 'Quality gate:'", () => {
    const done = pushActivity("quality_gate", "tsc");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Quality gate");
    expect(snap.shortLabel).toBe("quality gate");
    done();
  });

  it("compacting: displayLabel is fixed string", () => {
    const done = pushActivity("compacting", "");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Compactando");
    expect(snap.shortLabel).toBe("compactando");
    done();
  });

  it("checkpoint: displayLabel is fixed string", () => {
    const done = pushActivity("checkpoint", "");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("checkpoint").toBeTruthy();
    expect(snap.shortLabel).toBe("checkpoint");
    done();
  });

  it("api_call: displayLabel includes the label", () => {
    const done = pushActivity("api_call", "kimi-api");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("kimi-api");
    expect(snap.shortLabel).toBe("API");
    done();
  });

  it("api_retry: displayLabel includes 'Tentando novamente:'", () => {
    const done = pushActivity("api_retry", "after 504");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toContain("Tentando novamente");
    expect(snap.shortLabel).toBe("retry");
    done();
  });

  it("idle: displayLabel is the raw label", () => {
    const done = pushActivity("idle", "raw text");
    const snap = getActivitySnapshot();
    expect(snap.displayLabel).toBe("raw text");
    done();
  });
});

// ─── getActivitySnapshot — fields ──────────────────────────────────────────
describe("getActivitySnapshot fields", () => {
  it("returns current=null when stack is empty", () => {
    const snap = getActivitySnapshot();
    expect(snap.current).toBeNull();
    expect(snap.depth).toBe(0);
    expect(snap.displayLabel).toBe("");
    expect(snap.shortLabel).toBe("");
    expect(snap.elapsedMs).toBe(0);
  });

  it("elapsedMs is a non-negative number", () => {
    const done = pushActivity("tool", "x");
    const snap = getActivitySnapshot();
    expect(typeof snap.elapsedMs).toBe("number");
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(0);
    done();
  });

  it("elapsedMs increases with time", async () => {
    const done = pushActivity("tool", "x");
    const snap1 = getActivitySnapshot();
    await new Promise((r) => setTimeout(r, 30));
    const snap2 = getActivitySnapshot();
    expect(snap2.elapsedMs).toBeGreaterThanOrEqual(snap1.elapsedMs);
    done();
  });
});

// ─── subscribeToActivity ───────────────────────────────────────────────────
describe("subscribeToActivity", () => {
  it("returns an unsubscribe function", () => {
    const unsub = subscribeToActivity(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("listener is called on push", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    const done = pushActivity("tool", "x");
    expect(listener).toHaveBeenCalled();
    done();
  });

  it("listener is called on pop", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    const done = pushActivity("tool", "x");
    listener.mockClear();
    done();
    expect(listener).toHaveBeenCalled();
  });

  it("unsubscribe stops further notifications", () => {
    const listener = vi.fn();
    const unsub = subscribeToActivity(listener);
    unsub();
    const done = pushActivity("tool", "x");
    expect(listener).not.toHaveBeenCalled();
    done();
  });

  it("listener receives an ActivitySnapshot", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    const done = pushActivity("tool", "ler_arquivo");
    const snap = listener.mock.calls[0]![0] as ActivitySnapshot;
    expect(snap).toBeDefined();
    expect(snap.current).not.toBeNull();
    expect(snap.current!.category).toBe("tool");
    done();
  });

  it("multiple listeners are all called", () => {
    const l1 = vi.fn();
    const l2 = vi.fn();
    const l3 = vi.fn();
    subscribeToActivity(l1);
    subscribeToActivity(l2);
    subscribeToActivity(l3);
    const done = pushActivity("tool", "x");
    expect(l1).toHaveBeenCalled();
    expect(l2).toHaveBeenCalled();
    expect(l3).toHaveBeenCalled();
    done();
  });

  it("a listener that throws does not break the agent (others still called)", () => {
    const goodListener = vi.fn();
    const badListener = () => { throw new Error("listener error"); };
    subscribeToActivity(badListener);
    subscribeToActivity(goodListener);
    expect(() => pushActivity("tool", "x")).not.toThrow();
    expect(goodListener).toHaveBeenCalled();
  });
});

// ─── clearActivity ─────────────────────────────────────────────────────────
describe("clearActivity", () => {
  it("empties a non-empty stack", () => {
    pushActivity("tool", "x");
    pushActivity("api_call", "y");
    expect(getActivitySnapshot().depth).toBe(2);
    clearActivity();
    expect(getActivitySnapshot().depth).toBe(0);
    expect(getActivitySnapshot().current).toBeNull();
  });

  it("is a no-op on empty stack", () => {
    expect(() => clearActivity()).not.toThrow();
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("notifies listeners when clearing", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    pushActivity("tool", "x");
    listener.mockClear();
    clearActivity();
    expect(listener).toHaveBeenCalled();
  });
});

// ─── notifyActivity ────────────────────────────────────────────────────────
describe("notifyActivity", () => {
  it("forces a notification without changing state", () => {
    const listener = vi.fn();
    subscribeToActivity(listener);
    pushActivity("tool", "x");
    const depthBefore = getActivitySnapshot().depth;
    listener.mockClear();
    notifyActivity();
    expect(listener).toHaveBeenCalled();
    expect(getActivitySnapshot().depth).toBe(depthBefore);
  });
});

// ─── withActivity / withActivitySync ───────────────────────────────────────
describe("withActivitySync", () => {
  it("returns the wrapped function's value", () => {
    const result = withActivitySync("tool", "calc", () => 42);
    expect(result).toBe(42);
  });

  it("pops the activity after returning", () => {
    withActivitySync("tool", "calc", () => 1);
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("pops the activity even if the wrapped function throws", () => {
    expect(() =>
      withActivitySync("tool", "calc", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("supports returning objects", () => {
    const r = withActivitySync("tool", "x", () => ({ a: 1, b: "y" }));
    expect(r.a).toBe(1);
    expect(r.b).toBe("y");
  });
});

describe("withActivity (async)", () => {
  it("returns the wrapped promise's resolved value", async () => {
    const result = await withActivity("api_call", "kimi", async () => 100);
    expect(result).toBe(100);
  });

  it("pops the activity after resolving", async () => {
    await withActivity("api_call", "kimi", async () => 1);
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("pops the activity even when the promise rejects", async () => {
    await expect(
      withActivity("api_call", "kimi", async () => {
        throw new Error("net");
      }),
    ).rejects.toThrow("net");
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("activity is on the stack while the async fn is running", async () => {
    let depthDuring = -1;
    await withActivity("api_call", "kimi", async () => {
      depthDuring = getActivitySnapshot().depth;
      return 1;
    });
    expect(depthDuring).toBe(1);
    expect(getActivitySnapshot().depth).toBe(0);
  });
});

// ─── Very deep stacks ──────────────────────────────────────────────────────
describe("Very deep stacks", () => {
  it("supports 20 nested activities", () => {
    const dones: Array<() => void> = [];
    for (let i = 0; i < 20; i++) {
      dones.push(pushActivity("tool", `step_${i}`));
    }
    expect(getActivitySnapshot().depth).toBe(20);
    expect(getActivitySnapshot().current!.label).toBe("step_19");
    // pop in reverse
    for (let i = dones.length - 1; i >= 0; i--) {
      dones[i]!();
    }
    expect(getActivitySnapshot().depth).toBe(0);
  });

  it("popping from the middle of a 10-deep stack empties it", () => {
    const dones: Array<() => void> = [];
    for (let i = 0; i < 10; i++) {
      dones.push(pushActivity("tool", `x_${i}`));
    }
    dones[3]!(); // pops indices 3..9
    expect(getActivitySnapshot().depth).toBe(3);
    // cleanup
    dones[2]!();
    dones[1]!();
    dones[0]!();
    expect(getActivitySnapshot().depth).toBe(0);
  });
});

// ─── operationStartedAt (elapsed timer stability) ──────────────────────────
// BUG FIX (elapsed-jumpy): These tests verify that the elapsed timer is
// stable across nested push/pop. Previously, elapsedMs was computed from
// the TOP activity's startedAt, which jumped around when activities nested.
// Now it's computed from operationStartedAt (set when the stack first
// became non-empty), so the timer is monotonically increasing.
describe("operationStartedAt — elapsed timer stability", () => {
  it("elapsedMs is 0 when stack is empty", () => {
    const snap = getActivitySnapshot();
    expect(snap.elapsedMs).toBe(0);
  });

  it("elapsedMs increases monotonically across nested push/pop", () => {
    const done1 = pushActivity("thinking", "outer");
    const snap1 = getActivitySnapshot();
    const elapsed1 = snap1.elapsedMs;

    // Wait a bit, then push a nested activity
    const start = Date.now();
    while (Date.now() - start < 50) { /* busy wait 50ms */ }

    const done2 = pushActivity("tool", "inner");
    const snap2 = getActivitySnapshot();
    const elapsed2 = snap2.elapsedMs;

    // elapsed2 should be > elapsed1 (timer didn't reset on nested push)
    expect(elapsed2).toBeGreaterThan(elapsed1);

    // Pop the inner activity — timer should continue, not jump back
    done2();
    const snap3 = getActivitySnapshot();
    const elapsed3 = snap3.elapsedMs;

    // elapsed3 should be > elapsed2 (timer continued, didn't reset on pop)
    expect(elapsed3).toBeGreaterThanOrEqual(elapsed2);

    // Cleanup
    done1();
  });

  it("nested push does NOT reset elapsedMs to ~0", () => {
    const done1 = pushActivity("thinking", "outer");

    // Wait 100ms
    const start = Date.now();
    while (Date.now() - start < 100) { /* busy wait */ }

    // Push nested — elapsed should NOT reset
    const done2 = pushActivity("tool", "inner");
    const snap = getActivitySnapshot();

    // elapsed should be >= 100ms (from outer push), NOT ~0ms (from inner push)
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(90);

    done2();
    done1();
  });

  it("popping nested activity does NOT jump elapsed backward", () => {
    const done1 = pushActivity("thinking", "outer");

    // Wait 100ms
    const start1 = Date.now();
    while (Date.now() - start1 < 100) { /* busy wait */ }

    const done2 = pushActivity("tool", "inner");

    // Wait another 100ms
    const start2 = Date.now();
    while (Date.now() - start2 < 100) { /* busy wait */ }

    const elapsedBeforePop = getActivitySnapshot().elapsedMs;

    // Pop inner — elapsed should NOT jump back to outer's startedAt
    done2();
    const elapsedAfterPop = getActivitySnapshot().elapsedMs;

    // After pop, elapsed should be >= before pop (continued forward)
    expect(elapsedAfterPop).toBeGreaterThanOrEqual(elapsedBeforePop);

    done1();
  });

  it("elapsed resets to 0 when ALL activities are popped", () => {
    const done1 = pushActivity("thinking", "first");
    const done2 = pushActivity("tool", "second");

    // Pop both — stack becomes empty, operationStartedAt cleared
    done2();
    done1();

    const snap = getActivitySnapshot();
    expect(snap.current).toBeNull();
    expect(snap.elapsedMs).toBe(0);
  });

  it("elapsed does NOT reset when popping to non-empty stack", () => {
    const done1 = pushActivity("thinking", "outer");
    const done2 = pushActivity("tool", "inner");

    // Wait 100ms
    const start = Date.now();
    while (Date.now() - start < 100) { /* busy wait */ }

    // Pop inner — stack still has outer, elapsed should continue
    done2();
    const snap = getActivitySnapshot();
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(90);

    done1();
  });

  it("new operation after clearing gets a fresh elapsed timer", () => {
    const done1 = pushActivity("thinking", "first operation");
    // Wait 100ms
    const start1 = Date.now();
    while (Date.now() - start1 < 100) { /* busy wait */ }
    done1();

    // BUG FIX (timer-trava): operationStartedAt is NOT immediately nulled
    // when the stack empties — there's a 500ms grace period to prevent
    // timer resets from brief stack flickers. Use clearActivity() to
    // immediately null it (simulating the end of an operation, not just
    // a brief pop→push gap).
    clearActivity();

    // Stack is now empty — operationStartedAt is null
    expect(getActivitySnapshot().elapsedMs).toBe(0);

    // New operation — fresh timer
    const done2 = pushActivity("tool", "second operation");
    const snap = getActivitySnapshot();
    // Fresh timer — elapsed should be very small (< 50ms)
    expect(snap.elapsedMs).toBeLessThan(50);

    done2();
  });

  it("clearActivity resets operationStartedAt", () => {
    const done1 = pushActivity("thinking", "outer");
    // Wait 100ms
    const start = Date.now();
    while (Date.now() - start < 100) { /* busy wait */ }

    clearActivity();
    const snap = getActivitySnapshot();
    expect(snap.current).toBeNull();
    expect(snap.elapsedMs).toBe(0);

    // Safety: done1 should be a no-op (already cleared)
    done1();
  });

  it("mid-stack pop (popping from the middle) keeps operationStartedAt", () => {
    // Push 3 activities
    const done1 = pushActivity("thinking", "first");
    const done2 = pushActivity("tool", "second");
    const done3 = pushActivity("tool", "third");

    // Wait 100ms
    const start = Date.now();
    while (Date.now() - start < 100) { /* busy wait */ }

    // Pop from the middle (done2 pops indices 1..2, leaving only done1)
    done2();
    const snap = getActivitySnapshot();
    // Stack is non-empty (has done1), so elapsed should continue
    expect(snap.elapsedMs).toBeGreaterThanOrEqual(90);
    expect(snap.current?.label).toBe("first");

    done1();
    // done3 was already popped by done2 (mid-stack pop), so this is a no-op
    done3();
  });
});
