/**
 * taskState-mutation-killers.test.ts — Targeted tests to kill LOW + MEDIUM
 * priority survived mutations in src/taskState.ts.
 *
 * This file is named `taskState-mutation-killers.test.ts` so the
 * mutation-test.py script picks it up via the `{basename}*.test.ts` glob
 * (scripts/mutation-test.py:find_test_files).
 *
 * Per BUSINESS_RULES.md §17: this file does NOT modify any source code, only
 * adds regression tests. No `require()` calls (ESM `import` only). The
 * existing source is assumed correct — these tests close gaps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  throttle: vi.fn(),
}));

// ─── taskState.ts ───────────────────────────────────────────────────────────

describe("mutation-killers / taskState.ts — L171/L175/L179/L183 placeholder gating", () => {
  let tmpProject: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-taskstate-"));
    process.chdir(tmpProject);
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /**
   * Mutations on L171/L175/L179/L183:
   *   - `state.<section>.length === 0` → `=== 1`
   *   - `state.<section>.length === 0` → `state.<section>.length !== 0`
   *
   * Survived because existing tests either:
   *   (a) write 0 items per section, OR
   *   (b) write 1 item per section but only assert via getTaskStateSummary()
   *       (which uses a DIFFERENT formatter — sections with items.length > 0
   *       only) — NOT via the on-disk markdown that serializeTaskStateMarkdown
   *       produces.
   *
   * Killing strategy: write a state with EXACTLY 1 item in each section,
   * then READ THE RAW MARKDOWN FILE and assert that the placeholder text
   * ("_(nothing pending)_", "_(none recorded)_", "_(none known)_",
   * "_(none)_") is NOT present.
   *
   *   Mutation `=== 0 → === 1`: 1 === 1 → true → pushes placeholder.
   *   Test (expect placeholder NOT in markdown) fails. ✓ KILLED.
   *
   *   Mutation `=== 0 → !== 0`: 1 !== 0 → true → pushes placeholder.
   *   Test fails. ✓ KILLED.
   *
   * We also add the inverse check: with 0 items, placeholder IS present
   * (kills `=== 0 → !== 0` from the other direction: 0 !== 0 is false →
   * no placeholder; test expects placeholder → fails).
   */
  it("state with 1 item per section does NOT include placeholder text in markdown (kills `=== 0 → === 1` and `=== 0 → !== 0` on L171/L175/L179/L183)", async () => {
    const { writeTaskState } = await import("./../taskState.js");
    writeTaskState({
      title: "Test",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      done: ["d1"],
      todo: ["t1"],
      decisions: ["dec1"],
      bugs: ["b1"],
      dependencies: ["dep1"],
      notes: "",
    });

    const raw = fs.readFileSync(
      path.join(tmpProject, ".claude-killer", "TASK_STATE.md"),
      "utf8",
    );

    // Each section has exactly 1 item, so placeholders MUST NOT appear.
    expect(raw).not.toContain("_(nothing pending)_");
    expect(raw).not.toContain("_(none recorded)_");
    expect(raw).not.toContain("_(none known)_");
    expect(raw).not.toContain("_(none)_");
    // (Sanity) the items themselves ARE present.
    expect(raw).toContain("- [ ] t1");
    expect(raw).toContain("- dec1");
    expect(raw).toContain("- b1");
    expect(raw).toContain("- dep1");
  });

  it("state with 0 items per section DOES include placeholder text in markdown (kills `=== 0 → !== 0` from the empty-state direction)", async () => {
    const { writeTaskState } = await import("./../taskState.js");
    writeTaskState({
      title: "Test",
      updatedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
      done: [],
      todo: [],
      decisions: [],
      bugs: [],
      dependencies: [],
      notes: "",
    });

    const raw = fs.readFileSync(
      path.join(tmpProject, ".claude-killer", "TASK_STATE.md"),
      "utf8",
    );

    // Empty sections MUST have their placeholder.
    // Mutation `=== 0 → !== 0`: 0 !== 0 is false → placeholder NOT pushed.
    // Test (expect placeholder) fails. ✓ KILLED.
    expect(raw).toContain("_(nothing pending)_");
    expect(raw).toContain("_(none recorded)_");
    expect(raw).toContain("_(none known)_");
    expect(raw).toContain("_(none)_");
  });
});
