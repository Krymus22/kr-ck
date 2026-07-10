/**
 * regression-bug-hunter-8b.test.ts — Regression tests for Bug Hunter #8b.
 *
 * Focus area: Model registry + plan executor + task state + todo.
 *
 * Each test below fails BEFORE the corresponding fix and passes AFTER.
 * The tests are organized by the source file they cover.
 *
 * Bugs covered:
 *   1. modelRegistry.ts: `formatContextWindow()` had a boundary rounding
 *      bug. For values where `tokens / 1000` rounded UP to 1000 (e.g.
 *      999_999 → 999.999 → toFixed(1) = "1000.0"), the function returned
 *      the ugly "1000.0k" instead of "1M". The same bug existed in the
 *      M branch: 1_999_999 → "2.0M" (with trailing .0) instead of "2M".
 *      The fix rounds first, then drops the ".0" for whole numbers, and
 *      re-routes k values that round up to 1000 into the M branch.
 *
 *   2. todo.ts: `renderTodoBar()` measured string length with `.length`
 *      AFTER wrapping substrings in ANSI color codes. Because each
 *      `\x1b[38;2;...m` escape adds ~23 chars that the terminal does NOT
 *      render visibly, `padEnd(innerWidth)` added fewer spaces than
 *      needed, and the closing `|` fell ~23 chars short of the `+`
 *      border. The box was visibly broken:
 *
 *          +----------------------------------------------------------------------------+
 *          | [3 tasks]                                           |   <- stops short
 *          | OK Done                                              |
 *          +----------------------------------------------------------------------------+
 *
 *      The fix computes the VISIBLE row text first (no ANSI), truncates
 *      and pads based on real character count, and only then re-injects
 *      the ANSI color around the icon.
 *
 *   3. todo.ts: `resetTodo()` was missing. Many test files mock
 *      `resetTodo` from `../todo.js` (e.g. `fase1-mocked.test.ts`,
 *      `slash-commands.test.tsx`, `gaps-compaction.test.ts`, etc.),
 *      which means the production code was expected to export it — but
 *      the source file did NOT. As a result, the module-level singleton
 *      `currentTodos` could never be properly cleared on `/reset`,
 *      `/session new`, `/session load`, or auto-load on startup, causing
 *      the previous session's todo list to leak into the new session.
 *      The fix adds `resetTodo()` as a proper exported function.
 *
 *   4. (REPORTED, NOT FIXED — see planExecutor rules)
 *      planExecutor.ts: `markStep(index, done)` does NOT validate that
 *      `index` is a finite integer. If the AI passes `NaN` (e.g. from a
 *      malformed tool call), the bounds check `index < 0 || index >=
 *      length` returns false for NaN (because all NaN comparisons are
 *      false), so the function proceeds to `currentPlan.steps[NaN]!.done
 *      = done` which throws `TypeError: Cannot set properties of
 *      undefined`. The BUSINESS_RULES §17 / bug hunter rules forbid
 *      changing plan executor logic (createPlan, markStep, formatPlan),
 *      so this bug is reported but not fixed. The test below documents
 *      the current (buggy) behavior so a future fix can flip the
 *      expectation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  formatContextWindow,
  getModelInfo,
  FALLBACK_MODEL_INFO,
  MODEL_REGISTRY,
} from "../modelRegistry.js";
import {
  setTodos,
  getTodos,
  resetTodo,
  renderTodoBar,
  todoWrite,
  type TodoItem,
} from "../todo.js";

// Helper: strip ANSI escape codes to compute visible length.
const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-9;]*m/g, "");

// ─── Bug 1: formatContextWindow boundary rounding ──────────────────────────

describe("Bug Hunter #8b — formatContextWindow boundary rounding", () => {
  it("999_999 -> '1M' (NOT '1000.0k')", () => {
    // BEFORE fix: returned "1000.0k" (k=999.999, toFixed(1) rounds to "1000.0").
    // AFTER fix: re-routes to "1M" because the rounded k value (1000) >= 1000.
    expect(formatContextWindow(999_999)).toBe("1M");
  });

  it("1_999_999 -> '2M' (NOT '2.0M')", () => {
    // BEFORE fix: returned "2.0M" (m=1.999999, toFixed(1) = "2.0", with .0).
    // AFTER fix: rounds to 2, Number.isInteger(2) -> "2M" (no trailing .0).
    expect(formatContextWindow(1_999_999)).toBe("2M");
  });

  it("999_949 -> '999.9k' (just below the boundary, no re-route)", () => {
    // 999.949 toFixed(1) = "999.9" — stays in k branch, no re-route to M.
    expect(formatContextWindow(999_949)).toBe("999.9k");
  });

  it("1_999_949 -> '2.0M'... actually '2M' (rounded M drops .0)", () => {
    // 1.999949 toFixed(1) = "2.0" -> Number("2.0") = 2 -> integer -> "2M".
    expect(formatContextWindow(1_999_949)).toBe("2M");
  });

  it("preserves existing behavior for round k values (256_000 -> '256k')", () => {
    expect(formatContextWindow(256_000)).toBe("256k");
  });

  it("preserves existing behavior for half k values (128_500 -> '128.5k')", () => {
    expect(formatContextWindow(128_500)).toBe("128.5k");
  });

  it("preserves existing behavior for 1M", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
  });

  it("preserves existing behavior for 1.5M", () => {
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
  });

  it("preserves existing behavior for small values (500 -> '500')", () => {
    expect(formatContextWindow(500)).toBe("500");
  });

  it("preserves existing behavior for 0", () => {
    expect(formatContextWindow(0)).toBe("0");
  });

  it("never returns a string with trailing '.0' for any registry value", () => {
    // Sanity: all actual context windows in the registry format cleanly.
    for (const m of MODEL_REGISTRY) {
      const formatted = formatContextWindow(m.contextWindow);
      expect(formatted).not.toMatch(/\.0[kM]?$/);
    }
  });
});

// ─── Bug 2: renderTodoBar ANSI alignment ───────────────────────────────────

describe("Bug Hunter #8b — renderTodoBar box alignment", () => {
  beforeEach(() => {
    setTodos([]);
  });

  it("every line of the rendered bar has the SAME visible width", () => {
    setTodos([
      { status: "completed", content: "Done", active_form: "Done" },
      { status: "in_progress", content: "Working", active_form: "Working..." },
      { status: "pending", content: "Pending", active_form: "Pending" },
    ]);

    const bar = renderTodoBar();
    const lines = bar.split("\n");
    expect(lines.length).toBe(6); // top border, header, 3 rows, bottom border

    const visibleLengths = lines.map((l) => stripAnsi(l).length);
    // All lines must have the same visible length so the box borders align.
    const first = visibleLengths[0]!;
    for (const len of visibleLengths) {
      expect(len).toBe(first);
    }
  });

  it("the closing '|' of each content line aligns with the '+' of the border", () => {
    setTodos([
      { status: "completed", content: "Done task", active_form: "Done" },
      { status: "pending", content: "Pending task", active_form: "Pending" },
    ]);

    const bar = renderTodoBar();
    const lines = bar.split("\n");

    // Top border ends with '+', bottom border ends with '+'.
    expect(stripAnsi(lines[0]!).endsWith("+")).toBe(true);
    expect(stripAnsi(lines[lines.length - 1]!).endsWith("+")).toBe(true);

    // Every middle line (header + rows) must end with '|'.
    for (let i = 1; i < lines.length - 1; i++) {
      expect(stripAnsi(lines[i]!).endsWith("|")).toBe(true);
    }
  });

  it("does not regress with a single todo (header + 1 row + 2 borders = 4 lines)", () => {
    setTodos([{ status: "pending", content: "Only task", active_form: "Only" }]);
    const bar = renderTodoBar();
    const lines = bar.split("\n");
    expect(lines.length).toBe(4);
    const visibleLengths = lines.map((l) => stripAnsi(l).length);
    expect(new Set(visibleLengths).size).toBe(1);
  });

  it("respects custom maxWidth (visible width = maxWidth for default 80)", () => {
    setTodos([{ status: "pending", content: "x", active_form: "x" }]);
    const bar = renderTodoBar(80);
    const lines = bar.split("\n");
    // innerWidth = max(40, 80-4) = 76; total visible = 2 + 1 + 76 + 1 = 80.
    expect(stripAnsi(lines[0]!).length).toBe(80);
  });

  it("respects custom maxWidth=40 (minimum innerWidth)", () => {
    setTodos([{ status: "pending", content: "x", active_form: "x" }]);
    const bar = renderTodoBar(40);
    const lines = bar.split("\n");
    // innerWidth = max(40, 40-4) = 40; total visible = 2 + 1 + 40 + 1 = 44.
    expect(stripAnsi(lines[0]!).length).toBe(44);
  });

  it("truncates long content with '...' and keeps the box aligned", () => {
    const long = "x".repeat(200);
    setTodos([{ status: "pending", content: long, active_form: long }]);
    const bar = renderTodoBar(80);
    const lines = bar.split("\n");
    // Row line (index 2) should contain "..." and still align with border.
    expect(stripAnsi(lines[2]!)).toContain("...");
    const visibleLengths = lines.map((l) => stripAnsi(l).length);
    expect(new Set(visibleLengths).size).toBe(1);
  });

  it("preserves existing content expectations (3 tasks, OK, [ ], active_form)", () => {
    setTodos([
      { status: "completed", content: "Done", active_form: "Done" },
      { status: "in_progress", content: "Working", active_form: "Working..." },
      { status: "pending", content: "Pending", active_form: "Pending" },
    ]);
    const bar = renderTodoBar();
    expect(bar).toContain("3 tasks");
    expect(bar).toContain("OK");
    expect(bar).toContain("[ ]");
    expect(bar).toContain("Working...");
    expect(bar).toContain("Done");
  });
});

// ─── Bug 3: resetTodo() exists and clears state ────────────────────────────

describe("Bug Hunter #8b — resetTodo() exists and clears state", () => {
  beforeEach(() => {
    setTodos([]);
  });

  it("resetTodo is an exported function from todo.js", () => {
    // BEFORE fix: resetTodo was undefined — the module did not export it.
    // Many test files mock it (e.g. fase1-mocked.test.ts), proving the
    // production code was expected to provide it.
    expect(typeof resetTodo).toBe("function");
  });

  it("resetTodo() clears all current todos", () => {
    setTodos([
      { status: "pending", content: "A", active_form: "A" },
      { status: "pending", content: "B", active_form: "B" },
    ]);
    expect(getTodos().length).toBe(2);
    resetTodo();
    expect(getTodos().length).toBe(0);
  });

  it("resetTodo() makes renderTodoBar() return empty string", () => {
    setTodos([{ status: "pending", content: "A", active_form: "A" }]);
    expect(renderTodoBar()).not.toBe("");
    resetTodo();
    expect(renderTodoBar()).toBe("");
  });

  it("resetTodo() is safe to call when todos are already empty", () => {
    expect(() => resetTodo()).not.toThrow();
    expect(getTodos().length).toBe(0);
  });

  it("resetTodo() is equivalent to setTodos([]) for state", () => {
    setTodos([
      { status: "in_progress", content: "X", active_form: "X" },
      { status: "completed", content: "Y", active_form: "Y" },
    ]);
    resetTodo();
    const afterReset = getTodos();

    setTodos([
      { status: "in_progress", content: "X", active_form: "X" },
      { status: "completed", content: "Y", active_form: "Y" },
    ]);
    setTodos([]);
    const afterSetEmpty = getTodos();

    expect(afterReset).toEqual(afterSetEmpty);
    expect(afterReset.length).toBe(0);
  });

  it("can re-populate after resetTodo()", () => {
    resetTodo();
    const result = todoWrite({
      items: [{ status: "pending", content: "Fresh", active_form: "Fresh" }],
    });
    expect(result).toContain("1 itens");
    expect(getTodos().length).toBe(1);
    expect(getTodos()[0]!.content).toBe("Fresh");
  });
});

// ─── getModelInfo fallback sanity (focus area #2) ──────────────────────────

describe("Bug Hunter #8b — getModelInfo() fallback behavior (sanity)", () => {
  it("returns the SAME FALLBACK_MODEL_INFO reference for unknown models", () => {
    // This is the documented contract — consumers rely on reference equality
    // to detect "model not in registry". The fix to formatContextWindow
    // must NOT change this behavior.
    expect(getModelInfo("totally/unknown-model")).toBe(FALLBACK_MODEL_INFO);
    expect(getModelInfo("")).toBe(FALLBACK_MODEL_INFO);
  });

  it("FALLBACK_MODEL_INFO has 128k context and 8192 max output (unchanged)", () => {
    expect(FALLBACK_MODEL_INFO.contextWindow).toBe(128_000);
    expect(FALLBACK_MODEL_INFO.maxOutputTokens).toBe(8_192);
  });

  it("GLM 5.2 (paid) still has maxOutputTokens = 32_768 (RULE: do not change)", () => {
    const glm52 = getModelInfo("z-ai/glm-5.2");
    expect(glm52.maxOutputTokens).toBe(32_768);
    expect(glm52.contextWindow).toBe(1_000_000);
  });
});

// ─── Bug 4 (REPORTED): planExecutor markStep NaN index ─────────────────────
//
// This bug is REPORTED but NOT FIXED because the bug hunter rules forbid
// changing plan executor logic (createPlan, markStep, formatPlan). The
// test below documents the current (buggy) behavior. When the rule is
// lifted, the expectation should be flipped to `false` (and the function
// should return false instead of throwing).

describe("Bug Hunter #8b — planExecutor.markStep NaN index (REPORTED, not fixed)", () => {
  beforeEach(async () => {
    const { clearPlan } = await import("./../planExecutor.js");
    clearPlan();
  });

  it("FIXED: markStep(NaN) returns false (Number.isInteger guard, BH15 HIGH 1)", async () => {
    const { createPlan, markStep } = await import("./../planExecutor.js");
    createPlan(["step 1", "step 2"]);
    // FIXED (BH15 HIGH 1): markStep now checks Number.isInteger(index)
    // before accessing steps[index]. NaN returns false instead of throwing.
    expect(markStep(NaN, true)).toBe(false);
  });

  it("FIXED: markStep(1.5) returns false (Number.isInteger guard, BH15 HIGH 1)", async () => {
    const { createPlan, markStep } = await import("./../planExecutor.js");
    createPlan(["a", "b"]);
    // FIXED: non-integer index returns false instead of throwing.
    expect(markStep(1.5, true)).toBe(false);
  });

  it("valid integer indices still work (regression: don't break the happy path)", async () => {
    const { createPlan, markStep, getPlan } = await import("./../planExecutor.js");
    createPlan(["a", "b"]);
    expect(markStep(0, true)).toBe(true);
    expect(getPlan()!.steps[0]!.done).toBe(true);
    expect(markStep(1, true)).toBe(true);
  });
});

// ─── ESM sanity: no require() in focus modules ────────────────────────────

describe("Bug Hunter #8b — ESM imports (no require) in focus modules", () => {
  it("modelRegistry.ts does not use require()", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../modelRegistry.ts"),
      "utf8",
    );
    const withoutComments = src
      .split("\n")
      .filter((line: string) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
  });

  it("planExecutor.ts does not use require()", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../planExecutor.ts"),
      "utf8",
    );
    const withoutComments = src
      .split("\n")
      .filter((line: string) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
  });

  it("taskState.ts does not use require()", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../taskState.ts"),
      "utf8",
    );
    const withoutComments = src
      .split("\n")
      .filter((line: string) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
  });

  it("todo.ts does not use require()", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../todo.ts"),
      "utf8",
    );
    const withoutComments = src
      .split("\n")
      .filter((line: string) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(withoutComments).not.toMatch(/\brequire\s*\(/);
  });
});

// ─── taskState roundtrip sanity (focus area #6) ───────────────────────────

describe("Bug Hunter #8b — taskState markdown roundtrip (sanity)", () => {
  it("serialize -> parse -> serialize is idempotent for a typical state", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { writeTaskState, readTaskState } = await import("../taskState.js");

    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "bh8b-taskstate-"));
    const originalCwd = process.cwd();
    process.chdir(tmpProject);

    try {
      writeTaskState({
        title: "Roundtrip test",
        updatedAt: "2026-07-08T10:00:00.000Z",
        startedAt: "2026-07-08T09:00:00.000Z",
        done: ["did A", "did B"],
        todo: ["do C"],
        decisions: ["use X"],
        bugs: ["bug in foo.ts:42"],
        dependencies: ["need libfoo"],
        notes: "important note",
      });

      const read1 = readTaskState();
      expect(read1).not.toBeNull();
      expect(read1!.title).toBe("Roundtrip test");
      expect(read1!.done).toEqual(["did A", "did B"]);
      expect(read1!.todo).toEqual(["do C"]);
      expect(read1!.decisions).toEqual(["use X"]);
      expect(read1!.bugs).toEqual(["bug in foo.ts:42"]);
      expect(read1!.dependencies).toEqual(["need libfoo"]);
      expect(read1!.notes).toBe("important note");
      expect(read1!.startedAt).toBe("2026-07-08T09:00:00.000Z");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });
});

// ─── State leak: module-level singletons (focus area #9) ──────────────────

describe("Bug Hunter #8b — module-level singletons can be reset", () => {
  it("todo: resetTodo() clears the module-level currentTodos singleton", () => {
    setTodos([
      { status: "pending", content: "leak check", active_form: "leak" },
    ]);
    expect(getTodos().length).toBe(1);
    resetTodo();
    expect(getTodos().length).toBe(0);
  });

  it("planExecutor: clearPlan() clears the module-level currentPlan singleton", async () => {
    const { createPlan, getPlan, clearPlan } = await import("./../planExecutor.js");
    createPlan(["leak check"]);
    expect(getPlan()).not.toBeNull();
    clearPlan();
    expect(getPlan()).toBeNull();
  });

  it("taskState: clearTaskState() removes the on-disk TASK_STATE.md", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const { writeTaskState, readTaskState, clearTaskState } = await import("../taskState.js");

    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "bh8b-leak-"));
    const originalCwd = process.cwd();
    process.chdir(tmpProject);

    try {
      writeTaskState({
        title: "Leak check",
        updatedAt: "2026-07-08T10:00:00.000Z",
        startedAt: "2026-07-08T10:00:00.000Z",
        done: [],
        todo: [],
        decisions: [],
        bugs: [],
        dependencies: [],
        notes: "",
      });
      expect(readTaskState()).not.toBeNull();
      clearTaskState();
      expect(readTaskState()).toBeNull();
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tmpProject, { recursive: true, force: true });
    }
  });
});
