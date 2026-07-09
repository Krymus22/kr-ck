/**
 * unit-bugHunter-extended.test.ts — Deep unit tests for bugHunter.ts
 *
 * Covers functions and behaviors NOT covered by bugHunter.test.ts or
 * bugHunter-extended.test.ts:
 *   - snapshotFileBeforeEdit (file content capture, idempotency, missing files)
 *   - generateDiffAfterEdit (diff production, format, edge cases)
 *   - runBugHunter (returns findings array, returns empty when no bugs,
 *     multiple files, large/empty diffs, transient API errors)
 *   - runTestsForFindings (test results, skipped, not_tested)
 *   - allCriticalHighTestsPass (boolean logic)
 *   - resetBugHunterState (state clearing)
 *   - BugFinding severity levels and categories
 *   - Test status tracking
 *   - Multiple files in one run
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock apiClient — chat is hoisted so we can swap implementations per-test.
const { chatMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
}));
vi.mock("../apiClient.js", () => ({ chat: chatMock }));

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

// Mock testRunner — controllable per-test
vi.mock("../testRunner.js", () => ({
  detectLanguage: vi.fn((file: string) => {
    if (file.endsWith(".lua") || file.endsWith(".luau")) return "lua";
    if (file.endsWith(".py")) return "python";
    if (file.endsWith(".ts")) return "typescript";
    return "unknown";
  }),
  isTestRunnerAvailable: vi.fn((lang: string) => lang === "lua" || lang === "python"),
  getTestFilePath: vi.fn((file: string) => file.replace(/\.(lua|luau)$/, ".spec.$1")),
  runBugTest: vi.fn(() => ({ passed: true, ran: true, output: "" })),
}));

import {
  parseFindings,
  compareFindings,
  formatBugHuntMessage,
  allCriticalHighTestsPass,
  snapshotFileBeforeEdit,
  generateDiffAfterEdit,
  resetBugHunterState,
  runBugHunter,
  runTestsForFindings,
  type BugFinding,
} from "../bugHunter.js";

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  chatMock.mockReset();
  resetBugHunterState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-ext-"));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. snapshotFileBeforeEdit (6 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: snapshotFileBeforeEdit", () => {
  it("saves file content for later diff", () => {
    const f = path.join(tmpDir, "snap1.lua");
    fs.writeFileSync(f, "original content\n");
    snapshotFileBeforeEdit(f);
    // Should not throw. Internal state is verified via generateDiffAfterEdit.
    expect(() => snapshotFileBeforeEdit(f)).not.toThrow();
  });

  it("does not throw for non-existent file (silently skips)", () => {
    expect(() => snapshotFileBeforeEdit("/nonexistent/file.lua")).not.toThrow();
  });

  it("can be called multiple times on same file (overwrites snapshot)", () => {
    const f = path.join(tmpDir, "snap2.lua");
    fs.writeFileSync(f, "v1\n");
    snapshotFileBeforeEdit(f);
    fs.writeFileSync(f, "v2\n");
    snapshotFileBeforeEdit(f);  // Overwrites snapshot with v2
    // If snapshot wasn't overwritten, diff would show v1→v3. With overwrite, no diff.
    fs.writeFileSync(f, "v2\n");
    const diff = generateDiffAfterEdit(f);
    // No diff because snapshot was updated to v2 and file is still v2
    expect(diff).toBe("");
  });

  it("captures the file's exact content at snapshot time", () => {
    const f = path.join(tmpDir, "snap3.lua");
    fs.writeFileSync(f, "line A\nline B\n");
    snapshotFileBeforeEdit(f);
    fs.writeFileSync(f, "line A\nline MODIFIED\n");
    const diff = generateDiffAfterEdit(f);
    expect(diff).toContain("MODIFIED");
    expect(diff).toContain("line B");
  });

  it("handles relative paths (resolves to absolute internally)", () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(tmpDir);
      fs.writeFileSync("rel.lua", "content\n");
      snapshotFileBeforeEdit("rel.lua");
      fs.writeFileSync("rel.lua", "modified\n");
      const diff = generateDiffAfterEdit("rel.lua");
      expect(diff).toContain("modified");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("is idempotent when called repeatedly with no file changes", () => {
    const f = path.join(tmpDir, "snap4.lua");
    fs.writeFileSync(f, "static\n");
    snapshotFileBeforeEdit(f);
    snapshotFileBeforeEdit(f);
    snapshotFileBeforeEdit(f);
    const diff = generateDiffAfterEdit(f);
    expect(diff).toBe("");  // No changes
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. generateDiffAfterEdit (7 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: generateDiffAfterEdit", () => {
  it("returns empty string when no snapshot was taken", () => {
    const f = path.join(tmpDir, "nosnap.lua");
    fs.writeFileSync(f, "content\n");
    expect(generateDiffAfterEdit(f)).toBe("");
  });

  it("returns empty string when file is unchanged", () => {
    const f = path.join(tmpDir, "unchanged.lua");
    fs.writeFileSync(f, "same\n");
    snapshotFileBeforeEdit(f);
    expect(generateDiffAfterEdit(f)).toBe("");
  });

  it("produces a diff when file content changed", () => {
    const f = path.join(tmpDir, "changed.lua");
    fs.writeFileSync(f, "old\n");
    snapshotFileBeforeEdit(f);
    fs.writeFileSync(f, "new\n");
    const diff = generateDiffAfterEdit(f);
    expect(diff).not.toBe("");
    expect(diff).toContain("old");
    expect(diff).toContain("new");
  });

  it("diff includes [DIFF] header with filename", () => {
    const f = path.join(tmpDir, "diff_header.lua");
    fs.writeFileSync(f, "x\n");
    snapshotFileBeforeEdit(f);
    fs.writeFileSync(f, "y\n");
    const diff = generateDiffAfterEdit(f);
    expect(diff).toContain("[DIFF]");
    expect(diff).toContain("diff_header.lua");
  });

  it("handles empty file before (snapshot treated as no-snapshot due to falsy check)", () => {
    // Documents actual behavior: when the file is empty when snapshotted,
    // `if (!before)` treats empty string as falsy and returns "" (no diff).
    // This is a known limitation: snapshotFileBeforeEdit on an empty file
    // produces an empty snapshot, which generateDiffAfterEdit treats as
    // "no snapshot was taken".
    const f = path.join(tmpDir, "new_file.lua");
    fs.writeFileSync(f, "");
    snapshotFileBeforeEdit(f);
    fs.writeFileSync(f, "new content\n");
    const diff = generateDiffAfterEdit(f);
    // Because before="" is falsy, the function returns "" — documents this.
    expect(diff).toBe("");
  });

  it("handles file deletion (after is empty)", () => {
    const f = path.join(tmpDir, "deleted.lua");
    fs.writeFileSync(f, "content here\n");
    snapshotFileBeforeEdit(f);
    fs.writeFileSync(f, "");
    const diff = generateDiffAfterEdit(f);
    expect(diff).not.toBe("");
  });

  it("handles large diff (many changed lines)", () => {
    const f = path.join(tmpDir, "large.lua");
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 50 }, (_, i) => `LINE ${i}`).join("\n");
    fs.writeFileSync(f, before);
    snapshotFileBeforeEdit(f);
    fs.writeFileSync(f, after);
    const diff = generateDiffAfterEdit(f);
    expect(diff).not.toBe("");
    expect(diff.length).toBeGreaterThan(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. runBugHunter (8 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: runBugHunter", () => {
  it("returns shouldBlock=false and empty findings when filesModified is empty", async () => {
    const r = await runBugHunter([], "request", "response");
    expect(r.shouldBlock).toBe(false);
    expect(r.findings).toEqual([]);
    expect(r.completed).toBe(false);
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("returns findings array (may be empty) when LLM responds with no bugs", async () => {
    const f = path.join(tmpDir, "clean.lua");
    fs.writeFileSync(f, "local x = 1\nprint(x)\n");
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "FINDINGS: none\nVERDICT: PASS" }, finish_reason: "stop" }],
    });
    const r = await runBugHunter([f], "task", "done");
    expect(Array.isArray(r.findings)).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.shouldBlock).toBe(false);
    expect(r.completed).toBe(true);
  });

  it("returns findings array with bugs when LLM finds them", async () => {
    const f = path.join(tmpDir, "buggy.lua");
    fs.writeFileSync(f, "store:SetAsync(k, nil)\n");
    chatMock.mockResolvedValue({
      choices: [{
        message: {
          content: `[CRITICAL] ${f}:1 — SetAsync with nil\nFix: validate data`,
        },
        finish_reason: "stop",
      }],
    });
    const r = await runBugHunter([f], "task", "done");
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings[0].severity).toBe("critical");
    expect(r.shouldBlock).toBe(true);
  });

  it("returns completed=false when API fails after all retries", async () => {
    const f = path.join(tmpDir, "fail.lua");
    fs.writeFileSync(f, "x\n");
    chatMock.mockRejectedValue(new Error("network down"));
    const r = await runBugHunter([f], "task", "done");
    expect(r.completed).toBe(false);
    expect(r.shouldBlock).toBe(false);
  });

  it("returns completed=false when LLM returns empty content", async () => {
    const f = path.join(tmpDir, "empty.lua");
    fs.writeFileSync(f, "x\n");
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
    });
    const r = await runBugHunter([f], "task", "done");
    expect(r.completed).toBe(false);
  });

  it("returns completed=false when LLM returns very short content (<20 chars)", async () => {
    const f = path.join(tmpDir, "short.lua");
    fs.writeFileSync(f, "x\n");
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    });
    const r = await runBugHunter([f], "task", "done");
    expect(r.completed).toBe(false);
  });

  it("handles multiple files in one run", async () => {
    const f1 = path.join(tmpDir, "a.lua");
    const f2 = path.join(tmpDir, "b.lua");
    const f3 = path.join(tmpDir, "c.lua");
    fs.writeFileSync(f1, "x\n");
    fs.writeFileSync(f2, "y\n");
    fs.writeFileSync(f3, "z\n");
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "FINDINGS: none\nVERDICT: PASS" }, finish_reason: "stop" }],
    });
    const r = await runBugHunter([f1, f2, f3], "task", "done");
    expect(r.completed).toBe(true);
  });

  it("blocks when only medium/low findings (Bug Hunter blocks ANY findings)", async () => {
    // BUG FIX (medium-low-never-blocks): previously shouldBlock was false for
    // medium/low, making MAX_MEDIUM_LOW_ROUNDS=3 dead code (§10.1 violation).
    // Now shouldBlock = findings.length > 0 (ANY severity). The agent.ts
    // handler distinguishes severity and applies the appropriate cap.
    const f = path.join(tmpDir, "medium.lua");
    fs.writeFileSync(f, "x\n");
    chatMock.mockResolvedValue({
      choices: [{
        message: {
          content: `[MEDIUM] ${f}:1 — minor issue\nFix: refactor`,
        },
        finish_reason: "stop",
      }],
    });
    const r = await runBugHunter([f], "task", "done");
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.shouldBlock).toBe(true);  // ANY findings block (medium/low capped at 3 rounds by agent.ts)
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. runTestsForFindings (6 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: runTestsForFindings", () => {
  it("skips low/medium severity findings (only tests critical/high)", () => {
    const findings: BugFinding[] = [
      { severity: "low", file: "a.lua", description: "x", suggestion: "" },
      { severity: "medium", file: "b.lua", description: "y", suggestion: "" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBeUndefined();
    expect(result[1].testStatus).toBeUndefined();
  });

  it("marks testStatus='skipped' for unknown language", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "unknown.xyz", description: "x", suggestion: "" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBe("skipped");
  });

  it("does not set testFile when test file does not exist on disk", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "missing.lua", description: "x", suggestion: "" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testFile).toBeUndefined();
  });

  it("runs test when test file exists and language has runner", () => {
    // Create the test file at the expected path
    const srcFile = path.join(tmpDir, "feature.lua");
    const testFile = path.join(tmpDir, "feature.spec.lua");
    fs.writeFileSync(srcFile, "x\n");
    fs.writeFileSync(testFile, "-- test\n");
    const findings: BugFinding[] = [
      { severity: "critical", file: srcFile, description: "x", suggestion: "" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testFile).toBeTruthy();
    // testStatus should be passed/failed/skipped (not undefined) since we ran the test
    expect(["passed", "failed", "skipped"]).toContain(result[0].testStatus);
  });

  it("returns the same array (mutates in-place)", () => {
    const findings: BugFinding[] = [
      { severity: "low", file: "a.lua", description: "x", suggestion: "" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result).toBe(findings);  // Same reference
  });

  it("handles empty findings array", () => {
    const result = runTestsForFindings([], tmpDir);
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. allCriticalHighTestsPass (4 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: allCriticalHighTestsPass", () => {
  it("returns true when no critical/high findings", () => {
    expect(allCriticalHighTestsPass([
      { severity: "medium", file: "a", description: "x", suggestion: "" },
      { severity: "low", file: "b", description: "y", suggestion: "" },
    ])).toBe(true);
  });

  it("returns true when critical/high findings have testStatus=passed", () => {
    expect(allCriticalHighTestsPass([
      { severity: "critical", file: "a", description: "x", suggestion: "", testStatus: "passed" },
      { severity: "high", file: "b", description: "y", suggestion: "", testStatus: "passed" },
    ])).toBe(true);
  });

  it("returns false when any critical/high finding has testStatus=failed", () => {
    expect(allCriticalHighTestsPass([
      { severity: "critical", file: "a", description: "x", suggestion: "", testStatus: "passed" },
      { severity: "high", file: "b", description: "y", suggestion: "", testStatus: "failed" },
    ])).toBe(false);
  });

  it("returns true when critical/high findings have no testStatus (not tested)", () => {
    // not_tested is treated as "not failed" — only explicit 'failed' fails
    expect(allCriticalHighTestsPass([
      { severity: "critical", file: "a", description: "x", suggestion: "" },
    ])).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. resetBugHunterState (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: resetBugHunterState", () => {
  it("does not throw", () => {
    expect(() => resetBugHunterState()).not.toThrow();
  });

  it("can be called multiple times safely", () => {
    expect(() => {
      resetBugHunterState();
      resetBugHunterState();
      resetBugHunterState();
    }).not.toThrow();
  });

  it("clears snapshot state (generateDiffAfterEdit returns empty after reset)", () => {
    const f = path.join(tmpDir, "reset.lua");
    fs.writeFileSync(f, "before\n");
    snapshotFileBeforeEdit(f);
    fs.writeFileSync(f, "after\n");
    // Before reset: diff is produced
    expect(generateDiffAfterEdit(f)).not.toBe("");
    // After reset: snapshot cleared
    resetBugHunterState();
    expect(generateDiffAfterEdit(f)).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. BugFinding severity & category types (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: BugFinding severity levels", () => {
  it("supports all 4 severity levels (critical, high, medium, low)", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "a", description: "x", suggestion: "" },
      { severity: "high", file: "b", description: "x", suggestion: "" },
      { severity: "medium", file: "c", description: "x", suggestion: "" },
      { severity: "low", file: "d", description: "x", suggestion: "" },
    ];
    const severities = findings.map(f => f.severity);
    expect(severities).toContain("critical");
    expect(severities).toContain("high");
    expect(severities).toContain("medium");
    expect(severities).toContain("low");
  });

  it("BugFinding.testStatus supports passed/failed/skipped", () => {
    const f: BugFinding = {
      severity: "high", file: "x", description: "y", suggestion: "",
      testStatus: "passed",
    };
    expect(f.testStatus).toBe("passed");
    const f2: BugFinding = { ...f, testStatus: "failed" };
    expect(f2.testStatus).toBe("failed");
    const f3: BugFinding = { ...f, testStatus: "skipped" };
    expect(f3.testStatus).toBe("skipped");
  });

  it("BugFinding.testFile is optional", () => {
    const f: BugFinding = { severity: "low", file: "x", description: "y", suggestion: "" };
    expect(f.testFile).toBeUndefined();
    const f2: BugFinding = { ...f, testFile: "/path/to/test.lua" };
    expect(f2.testFile).toBe("/path/to/test.lua");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. parseFindings edge cases (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: parseFindings edge cases", () => {
  it("parses finding with dash separator instead of em-dash", () => {
    const content = `[HIGH] file.lua:10 - logic bug\nFix: refactor`;
    const findings = parseFindings(content);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("high");
  });

  it("parses finding with en-dash separator", () => {
    const content = `[MEDIUM] file.lua:20 – medium issue`;
    const findings = parseFindings(content);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it("parses multiple findings in single content", () => {
    const content = `
[CRITICAL] a.lua:1 — bug a
Fix: fix a

[HIGH] b.lua:2 — bug b
Fix: fix b

[MEDIUM] c.lua:3 — bug c
Fix: fix c
`;
    const findings = parseFindings(content);
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. compareFindings (4 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: compareFindings", () => {
  it("identifies all bugs as fixed when current is empty", () => {
    const prev: BugFinding[] = [
      { severity: "critical", file: "a", description: "bug A", suggestion: "" },
    ];
    const result = compareFindings([], prev);
    expect(result.fixed.length).toBe(1);
    expect(result.persisting.length).toBe(0);
    expect(result.newBugs.length).toBe(0);
  });

  it("identifies all bugs as new when previous is empty", () => {
    const curr: BugFinding[] = [
      { severity: "low", file: "b", description: "bug B", suggestion: "" },
    ];
    const result = compareFindings(curr, []);
    expect(result.newBugs.length).toBe(1);
    expect(result.fixed.length).toBe(0);
  });

  it("identifies persisting bugs by file + description match", () => {
    const bug = { severity: "high" as const, file: "x", description: "same bug", suggestion: "" };
    const result = compareFindings([bug], [bug]);
    expect(result.persisting.length).toBe(1);
    expect(result.fixed.length).toBe(0);
    expect(result.newBugs.length).toBe(0);
  });

  it("handles mixed scenario (1 fixed, 1 persisting, 1 new)", () => {
    const prev: BugFinding[] = [
      { severity: "critical", file: "a", description: "fixed bug", suggestion: "" },
      { severity: "high", file: "b", description: "persisting bug", suggestion: "" },
    ];
    const curr: BugFinding[] = [
      { severity: "high", file: "b", description: "persisting bug", suggestion: "" },
      { severity: "low", file: "c", description: "new bug", suggestion: "" },
    ];
    const result = compareFindings(curr, prev);
    expect(result.fixed.length).toBe(1);
    expect(result.persisting.length).toBe(1);
    expect(result.newBugs.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. formatBugHuntMessage (3 tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("bugHunter: formatBugHuntMessage", () => {
  it("returns ✓ message when no findings", () => {
    const msg = formatBugHuntMessage([], false);
    expect(msg).toContain("No bugs found");
    expect(msg).toContain("✓");
  });

  it("includes ✗ marker when shouldBlock=true", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.lua", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("✗");
    expect(msg).toContain("CRITICAL");
    expect(msg).toContain("f.lua");
  });

  it("includes comparison section when provided", () => {
    const findings: BugFinding[] = [
      { severity: "high", file: "f.lua", description: "bug", suggestion: "" },
    ];
    const comparison = {
      fixed: [{ severity: "critical" as const, file: "g.lua", description: "old", suggestion: "" }],
      persisting: [],
      newBugs: findings,
    };
    const msg = formatBugHuntMessage(findings, true, comparison);
    expect(msg).toContain("FIXED");
    expect(msg).toContain("NEW");
  });
});
