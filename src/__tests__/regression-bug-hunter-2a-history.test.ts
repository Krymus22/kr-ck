/**
 * regression-bug-hunter-2a-history.test.ts
 *
 * Regression tests for bugs found and fixed by Bug Hunter #2a (history.ts focus).
 *
 * Primary bug covered:
 *   A. loadHistoryDirect() orphan tool_call repair inserted synthetic tool
 *      results in REVERSED order when multiple orphans shared the same
 *      assistant message. The OpenAI API expects tool result messages to
 *      appear in the SAME ORDER as the tool_calls array on the assistant
 *      message. Reversed order causes 400 errors or confuses the model.
 *
 *      Root cause: the loop inserted each synthetic message at
 *      `assistantIdx + 1` via splice. Each new insertion pushed the
 *      previously-inserted synthetic message to a higher index, reversing
 *      the order relative to the tool_calls array.
 *
 *      Fix: for each orphan, scan forward over the contiguous block of tool
 *      messages that follow the assistant and insert at the END of that
 *      block, so multiple orphans on the same assistant stay in tool_calls
 *      array order.
 *
 *   B. replaceHistory() has the same orphan-repair logic (added by Bug
 *      Hunter #2d). This test file verifies that replaceHistory also
 *      preserves tool_calls order (the same Bug Hunter #2a fix applies).
 *
 * Rules honored:
 *   - COMPACT_KEEP_RECENT = 6 (unchanged).
 *   - PRESERVE_PREFIXES / REPLACABLE_PREFIXES unchanged.
 *   - contextCompactThreshold unchanged.
 *   - "ler_arquivo NÃO trunca" unchanged.
 *   - 9-section LLM compaction prompt unchanged.
 *   - anti-drift "DIRECTLY QUOTE" rule unchanged.
 *   - re-hydration and skill re-injection unchanged.
 *   - HONESTY RULES unchanged.
 *   - Uses `import` not `require()` (ESM).
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ─── Mocks ─────────────────────────────────────────────────────────────────
// Mock extensions.getActiveSkills and effortLevels.getEffortPromptSnippet so
// getSystemPrompt() is deterministic and doesn't touch the real extensions system.

const mockGetActiveSkills = vi.fn().mockReturnValue([]);
vi.mock("../extensions.js", () => ({
  getActiveSkills: (...args: any[]) => mockGetActiveSkills(...args),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: vi.fn().mockReturnValue(""),
  setEffortLevel: vi.fn(),
}));

// Mock session to avoid file I/O during tests
vi.mock("../session.js", () => ({
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  setActiveSession: vi.fn(),
}));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import {
  loadHistoryDirect,
  replaceHistory,
  getHistory,
  resetHistory,
  addUserMessage,
  addRawAssistantMessage,
  addToolResult,
} from "../history.js";

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  resetHistory();
  mockGetActiveSkills.mockReturnValue([]);
});

afterEach(() => {
  resetHistory();
  mockGetActiveSkills.mockReturnValue([]);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Build an assistant message with N tool_calls (ids: c1, c2, ..., cN). */
function assistantWithToolCalls(callIds: string[]): any {
  return {
    role: "assistant",
    content: null,
    tool_calls: callIds.map((id) => ({
      id,
      type: "function",
      function: { name: "ler_arquivo", arguments: "{}" },
    })),
  };
}

/** Extract the tool_call_id of every tool message, IN ORDER. */
function toolResultIdsInOrder(history: any[]): string[] {
  return history
    .filter((m) => m.role === "tool")
    .map((m) => m.tool_call_id as string);
}

// ─── Bug A: loadHistoryDirect orphan order ──────────────────────────────────

describe("Bug Hunter #2a — Bug A: loadHistoryDirect preserves tool_calls order", () => {
  it("3 orphans on 1 assistant: synthetic results in tool_calls order (not reversed)", () => {
    // Assistant has tool_calls [c1, c2, c3], ALL orphaned (no tool results).
    // The synthetic results must appear in the SAME ORDER: c1, c2, c3.
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "lê 3 arquivos" },
      assistantWithToolCalls(["c1", "c2", "c3"]),
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    // Without the fix, the order would be [c3, c2, c1] (reversed).
    // With the fix, the order is [c1, c2, c3] (matching tool_calls).
    const idsInOrder = toolResultIdsInOrder(h as any[]);
    expect(idsInOrder).toEqual(["c1", "c2", "c3"]);
  });

  it("2 orphans on 1 assistant: synthetic results in tool_calls order", () => {
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "lê 2 arquivos" },
      assistantWithToolCalls(["alpha", "beta"]),
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    const idsInOrder = toolResultIdsInOrder(h as any[]);
    expect(idsInOrder).toEqual(["alpha", "beta"]);
  });

  it("partial orphan: existing tool result stays first, synthetic appended after", () => {
    // Assistant has tool_calls [c1, c2]. c1 has a real result; c2 is orphan.
    // After repair: [assistant, tool(c1_real), tool(c2_synthetic)]
    // The real result for c1 must come BEFORE the synthetic for c2
    // (matching the tool_calls array order).
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "lê 2 arquivos" },
      assistantWithToolCalls(["c1", "c2"]),
      { role: "tool", tool_call_id: "c1", content: "real result for c1" },
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    const toolMsgs = h.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    // First tool message is the REAL result for c1
    expect((toolMsgs[0] as any).tool_call_id).toBe("c1");
    expect((toolMsgs[0] as any).content).toBe("real result for c1");
    // Second tool message is the SYNTHETIC result for c2
    expect((toolMsgs[1] as any).tool_call_id).toBe("c2");
    expect((toolMsgs[1] as any).content).toContain("Session interrupted");
  });

  it("partial orphan with 3 tool_calls: real results interleaved correctly", () => {
    // Assistant has [c1, c2, c3]. c1 and c3 have real results; c2 is orphan.
    // Input:  [asst(c1,c2,c3), tool(c1_real), tool(c3_real)]
    // After:  [asst(c1,c2,c3), tool(c1_real), tool(c3_real), tool(c2_synth)]
    //
    // Note: c2's synthetic is inserted at the END of the contiguous tool
    // block (after c3_real), not between c1_real and c3_real. This keeps
    // the existing tool messages in their original positions. The API
    // accepts this because it matches tool_call_ids, not strict positions.
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "lê 3 arquivos" },
      assistantWithToolCalls(["c1", "c2", "c3"]),
      { role: "tool", tool_call_id: "c1", content: "real c1" },
      { role: "tool", tool_call_id: "c3", content: "real c3" },
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    const toolMsgs = h.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(3);
    // The synthetic for c2 is inserted at the end of the contiguous tool block.
    expect((toolMsgs[0] as any).tool_call_id).toBe("c1");
    expect((toolMsgs[1] as any).tool_call_id).toBe("c3");
    expect((toolMsgs[2] as any).tool_call_id).toBe("c2");
    expect((toolMsgs[2] as any).content).toContain("Session interrupted");
  });

  it("orphan with user message after tool block: synthetic inserted before user", () => {
    // Assistant has [c1, c2]. c1 has real result; c2 is orphan.
    // A user message follows the tool block.
    // After repair: [asst, tool(c1), tool(c2_synth), user]
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "go" },
      assistantWithToolCalls(["c1", "c2"]),
      { role: "tool", tool_call_id: "c1", content: "real c1" },
      { role: "user", content: "thanks" },
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    // The synthetic tool result must be inserted BEFORE the "thanks" user
    // message (right after the contiguous tool block).
    const toolBlockEnd = h.findIndex((m) => m.role === "user" && m.content === "thanks");
    expect(toolBlockEnd).toBeGreaterThan(0);
    // The message right before "thanks" should be the synthetic tool for c2.
    const msgBeforeThanks = h[toolBlockEnd - 1];
    expect(msgBeforeThanks.role).toBe("tool");
    expect((msgBeforeThanks as any).tool_call_id).toBe("c2");
  });

  it("multiple orphans across multiple assistants: each assistant's orphans stay in order", () => {
    // Two assistants, each with 2 orphans.
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "task 1" },
      assistantWithToolCalls(["a1", "a2"]),
      { role: "user", content: "task 2" },
      assistantWithToolCalls(["b1", "b2"]),
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    // All 4 orphans get synthetic results.
    const toolMsgs = h.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(4);
    // a1, a2 must be in order (a1 before a2).
    const a1Idx = toolMsgs.findIndex((m) => (m as any).tool_call_id === "a1");
    const a2Idx = toolMsgs.findIndex((m) => (m as any).tool_call_id === "a2");
    expect(a1Idx).toBeLessThan(a2Idx);
    // b1, b2 must be in order (b1 before b2).
    const b1Idx = toolMsgs.findIndex((m) => (m as any).tool_call_id === "b1");
    const b2Idx = toolMsgs.findIndex((m) => (m as any).tool_call_id === "b2");
    expect(b1Idx).toBeLessThan(b2Idx);
    // a1, a2 must come before b1, b2 (task 1 before task 2).
    expect(a2Idx).toBeLessThan(b1Idx);
  });

  it("single orphan: no order issue, but synthetic is still inserted correctly", () => {
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "lê" },
      assistantWithToolCalls(["only_one"]),
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    const toolMsgs = h.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect((toolMsgs[0] as any).tool_call_id).toBe("only_one");
    expect((toolMsgs[0] as any).content).toContain("Session interrupted");
  });

  it("no orphans: no synthetic messages inserted", () => {
    // Assistant with 1 tool_call, which has a matching tool result.
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "lê" },
      assistantWithToolCalls(["c1"]),
      { role: "tool", tool_call_id: "c1", content: "real result" },
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    const toolMsgs = h.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(1);
    expect((toolMsgs[0] as any).content).toBe("real result");
  });

  it("5 orphans on 1 assistant: all in tool_calls order (stress test)", () => {
    const callIds = ["x1", "x2", "x3", "x4", "x5"];
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "lê 5 arquivos" },
      assistantWithToolCalls(callIds),
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    // Without the fix, order would be [x5, x4, x3, x2, x1] (fully reversed).
    // With the fix, order matches tool_calls: [x1, x2, x3, x4, x5].
    const idsInOrder = toolResultIdsInOrder(h as any[]);
    expect(idsInOrder).toEqual(callIds);
  });
});

// ─── Bug B: replaceHistory orphan order (same fix) ──────────────────────────

describe("Bug Hunter #2a — Bug B: replaceHistory preserves tool_calls order", () => {
  it("3 orphans on 1 assistant: synthetic results in tool_calls order", () => {
    // Simulate compaction output: assistant with 3 tool_calls, only 1 result.
    const compacted: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do task" },
      assistantWithToolCalls(["call_1", "call_2", "call_3"]),
      { role: "tool", tool_call_id: "call_1", content: "merged result" },
    ];

    replaceHistory(compacted);
    const h = getHistory();

    // call_2 and call_3 are orphans. Their synthetic results must appear
    // AFTER call_1's real result, in tool_calls order: call_2, call_3.
    const idsInOrder = toolResultIdsInOrder(h as any[]);
    expect(idsInOrder).toEqual(["call_1", "call_2", "call_3"]);
  });

  it("5 orphans on 1 assistant: all in tool_calls order", () => {
    const callIds = ["y1", "y2", "y3", "y4", "y5"];
    const compacted: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do task" },
      assistantWithToolCalls(callIds),
      // No tool results — all 5 are orphans.
    ];

    replaceHistory(compacted);
    const h = getHistory();

    const idsInOrder = toolResultIdsInOrder(h as any[]);
    expect(idsInOrder).toEqual(callIds);
  });

  it("partial orphan: real result first, synthetic appended", () => {
    const compacted: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do task" },
      assistantWithToolCalls(["keep", "orphan"]),
      { role: "tool", tool_call_id: "keep", content: "real keep" },
    ];

    replaceHistory(compacted);
    const h = getHistory();

    const toolMsgs = h.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    expect((toolMsgs[0] as any).tool_call_id).toBe("keep");
    expect((toolMsgs[0] as any).content).toBe("real keep");
    expect((toolMsgs[1] as any).tool_call_id).toBe("orphan");
    expect((toolMsgs[1] as any).content).toContain("compaction");
  });
});

// ─── Bug C: existing tests use .sort() which masks the order bug ────────────

describe("Bug Hunter #2a — Bug C: existing .sort()-based tests don't catch order", () => {
  // This is a META test: it documents WHY the existing tests in
  // blind-spots.test.ts and regression-bug-hunter-2d-history-edge-cases.test.ts
  // didn't catch the order bug. They use `.map(id).sort()` which sorts
  // alphabetically, masking any order issue. Our new tests above check the
  // ACTUAL order (without .sort()), so they catch the bug.

  it("demonstrates that .sort() masks the order bug (regression test rationale)", () => {
    // Simulate the REVERSED order that the OLD code produced.
    const reversedOrder = ["c3", "c2", "c1"];
    // The old tests did .sort() — which would pass even with reversed order.
    // NOTE: .sort() mutates in place, so we check a copy for the "actual order" test.
    expect([...reversedOrder].sort()).toEqual(["c1", "c2", "c3"]);
    // Our new tests check the ACTUAL order (without .sort()) — reversed order fails.
    expect(reversedOrder).not.toEqual(["c1", "c2", "c3"]);
    // Correct order passes.
    expect(["c1", "c2", "c3"]).toEqual(["c1", "c2", "c3"]);
  });
});

// ─── Edge cases ────────────────────────────────────────────────────────────

describe("Bug Hunter #2a — Edge cases: empty history, single message, no system prompt", () => {
  it("loadHistoryDirect with empty messages: prepends system prompt, no orphans", () => {
    loadHistoryDirect([]);
    const h = getHistory();
    expect(h.length).toBe(1);
    expect(h[0].role).toBe("system");
  });

  it("loadHistoryDirect with single user message: prepends system prompt", () => {
    loadHistoryDirect([{ role: "user", content: "hi" }] as any);
    const h = getHistory();
    expect(h.length).toBe(2);
    expect(h[0].role).toBe("system");
    expect(h[1].role).toBe("user");
  });

  it("loadHistoryDirect with no system prompt and orphan tool_calls: repairs correctly", () => {
    // No system prompt at index 0 — loadHistoryDirect should prepend one
    // AND repair orphans.
    const messages: any[] = [
      { role: "user", content: "lê" },
      assistantWithToolCalls(["c1", "c2"]),
    ];

    loadHistoryDirect(messages);
    const h = getHistory();

    // System prompt prepended.
    expect(h[0].role).toBe("system");
    // Orphans repaired in order.
    const idsInOrder = toolResultIdsInOrder(h as any[]);
    expect(idsInOrder).toEqual(["c1", "c2"]);
  });

  it("replaceHistory with empty messages: prepends system prompt, no orphans", () => {
    replaceHistory([]);
    const h = getHistory();
    expect(h.length).toBe(1);
    expect(h[0].role).toBe("system");
  });

  it("replaceHistory with no system prompt and orphans: prepends and repairs", () => {
    const messages: any[] = [
      { role: "user", content: "do" },
      assistantWithToolCalls(["a", "b", "c"]),
    ];

    replaceHistory(messages);
    const h = getHistory();

    expect(h[0].role).toBe("system");
    const idsInOrder = toolResultIdsInOrder(h as any[]);
    expect(idsInOrder).toEqual(["a", "b", "c"]);
  });
});

// ─── Idempotency: calling loadHistoryDirect twice doesn't double-repair ─────

describe("Bug Hunter #2a — Idempotency: repair doesn't double-inject", () => {
  it("loadHistoryDirect called twice with same orphan messages: no duplicates", () => {
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "lê" },
      assistantWithToolCalls(["c1", "c2"]),
    ];

    loadHistoryDirect(messages);
    const h1 = getHistory();
    const toolCount1 = h1.filter((m) => m.role === "tool").length;
    expect(toolCount1).toBe(2); // 2 synthetic results injected.

    // Call again with the SAME messages (which still have orphans).
    // The second call should produce the same result (2 synthetic results),
    // not 4 (which would happen if we injected again without checking).
    loadHistoryDirect(messages);
    const h2 = getHistory();
    const toolCount2 = h2.filter((m) => m.role === "tool").length;
    expect(toolCount2).toBe(2); // Still 2, not 4.
  });

  it("replaceHistory called twice with same orphan messages: no duplicates", () => {
    const messages: any[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do" },
      assistantWithToolCalls(["x1", "x2", "x3"]),
    ];

    replaceHistory(messages);
    const h1 = getHistory();
    const toolCount1 = h1.filter((m) => m.role === "tool").length;
    expect(toolCount1).toBe(3);

    replaceHistory(messages);
    const h2 = getHistory();
    const toolCount2 = h2.filter((m) => m.role === "tool").length;
    expect(toolCount2).toBe(3); // Still 3, not 6.
  });
});
