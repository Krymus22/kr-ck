/**
 * regression-bug-hunter-2c.test.ts — Regression tests for Bug Hunter #2c.
 *
 * Focus: context injection + checkpoint + patterns
 *   - src/checkpointWriter.ts
 *   - src/patternExtractor.ts
 *   - src/contextInjector.ts
 *   - src/progressiveContext.ts
 *
 * Each describe block below covers ONE bug found by Hunter #2c. The test
 * MUST fail on the pre-fix code and pass on the post-fix code.
 *
 * Bugs covered:
 *   1. patternExtractor.getPatternsCached — cache key missing projectRoot
 *      (state leak: different root returned stale patterns).
 *   2. checkpointWriter.formatCheckpoint — TypeError on partial LLM JSON
 *      (state.constraints.length etc. threw when arrays were missing).
 *   3. checkpointWriter.writeCheckpoint — no normalization after JSON.parse
 *      (state stored with undefined arrays, formatCheckpoint crashed later).
 *   4. progressiveContext.readSymbolFromFile — fs.readFileSync crash on
 *      non-existent file (not wrapped in try/catch).
 *   5. progressiveContext.detectSymbolRequest — trailing punctuation in
 *      filePath ("bar.ts." → ENOENT).
 *   6. progressiveContext.readSymbolFromFile — import filter false positives
 *      ("importantVar = 1" matched startsWith("import")).
 *   7. contextInjector.compactSummary — non-standard section after a
 *      relevant section leaked indented lines into the injection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Shared mocks (logger / lspAst / apiClient / history / taskState) ───────
vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({ chat: vi.fn() }));

vi.mock("../history.js", () => ({
  getHistory: vi.fn(() => []),
  estimateTokens: vi.fn(() => 0),
  loadHistoryDirect: vi.fn(),
  getSystemPrompt: vi.fn(() => "system prompt"),
  optimizeContext: vi.fn(),
}));

vi.mock("../taskState.js", () => ({ getTaskStateSummary: vi.fn() }));

vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn().mockResolvedValue({
    language: "typescript",
    lineCount: 50,
    symbols: [
      { name: "foo", type: "function", line: 10 },
      { name: "bar", type: "function", line: 30 },
    ],
  }),
}));

// ─── Bug 1: patternExtractor.getPatternsCached cache key ────────────────────

describe("Bug Hunter #2c — Bug 1: getPatternsCached cache key includes projectRoot", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ck-2c-a-"));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ck-2c-b-"));
    // Same extension so detection differs only by content.
    // dirA: camelCase. dirB: snake_case (different content → different patterns).
    fs.writeFileSync(
      path.join(dirA, "a.ts"),
      "const myVariable = 1;\nfunction doSomething() {}\n",
    );
    fs.writeFileSync(
      path.join(dirB, "b.py"),
      "my_variable = 1\ndef do_something():\n    pass\n",
    );
  });

  afterEach(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it("returns fresh patterns when projectRoot changes (no stale leak)", async () => {
    const { getPatternsCached, clearPatternCache } = await import("../patternExtractor.js");
    clearPatternCache();

    const pA1 = getPatternsCached(dirA);
    expect(pA1.namingConvention).toBe("camelCase");

    // Without the fix, this would return pA1 (camelCase) because the cache
    // only checked TTL, not the root. With the fix, dirB is re-extracted.
    const pB = getPatternsCached(dirB);
    expect(pB.namingConvention).toBe("snake_case");
    expect(pB).not.toBe(pA1);  // different object — fresh extraction

    // Calling dirA again: the single-entry cache was evicted when dirB was
    // cached, so dirA is re-extracted. The NEW object has the same content
    // as pA1 (same root → same patterns), but is a different reference.
    const pA2 = getPatternsCached(dirA);
    expect(pA2.namingConvention).toBe("camelCase");
    expect(pA2).toEqual(pA1);
    expect(pA2).not.toBe(pA1);  // re-extracted, not the cached pA1

    // Calling dirA a SECOND time in a row (no root switch) hits the cache
    // and returns the SAME object as the previous call.
    const pA3 = getPatternsCached(dirA);
    expect(pA3).toBe(pA2);  // cache hit — same reference
  });

  it("clearPatternCache fully resets the cached root", async () => {
    const { getPatternsCached, clearPatternCache } = await import("../patternExtractor.js");
    clearPatternCache();

    const pA1 = getPatternsCached(dirA);
    clearPatternCache();
    const pA2 = getPatternsCached(dirA);
    // After clear, a new object is produced (re-extracted).
    expect(pA2).not.toBe(pA1);
    expect(pA2).toEqual(pA1);
  });
});

// ─── Bug 2: formatCheckpoint tolerates partial state ────────────────────────

describe("Bug Hunter #2c — Bug 2: formatCheckpoint tolerates partial state", () => {
  it("does not throw when state has only `intention` (arrays missing)", async () => {
    const { formatCheckpoint } = await import("../checkpointWriter.js");
    // Simulate malformed LLM output: only intention, everything else missing.
    const partial = { intention: "fix bug" } as any;
    // OLD behavior: `state.constraints.length` throws TypeError.
    // NEW behavior: defensive — returns a string, no throw.
    expect(() => formatCheckpoint(partial)).not.toThrow();
    const out = formatCheckpoint(partial);
    expect(out).toContain("CHECKPOINT STATE");
    expect(out).toContain("fix bug");
    // Optional sections are simply omitted (not "undefined" or "[]").
    expect(out).not.toContain("undefined");
  });

  it("does not throw when arrays are null (LLM returned null)", async () => {
    const { formatCheckpoint } = await import("../checkpointWriter.js");
    const partial = {
      intention: "x",
      nextAction: "y",
      constraints: null,
      taskTree: null,
      filesInvolved: null,
      errorsAndCorrections: null,
      designDecisions: null,
    } as any;
    expect(() => formatCheckpoint(partial)).not.toThrow();
    const out = formatCheckpoint(partial);
    expect(out).toContain("Intention: x");
    expect(out).toContain("Next action: y");
  });

  it("does not throw when state itself is undefined (defensive null)", async () => {
    const { formatCheckpoint } = await import("../checkpointWriter.js");
    expect(() => formatCheckpoint(undefined as any)).not.toThrow();
    const out = formatCheckpoint(undefined as any);
    expect(out).toContain("CHECKPOINT STATE");
    expect(out).toContain("Intention:");
  });

  it("renders filesInvolved items defensively when entry is missing path/change", async () => {
    const { formatCheckpoint } = await import("../checkpointWriter.js");
    const partial = {
      intention: "x",
      filesInvolved: [{ path: "a.ts" }, { change: "edit" }, {}],
    } as any;
    expect(() => formatCheckpoint(partial)).not.toThrow();
    const out = formatCheckpoint(partial);
    expect(out).toContain("a.ts");
    expect(out).toContain("Files involved:");
  });
});

// ─── Bug 3: writeCheckpoint normalizes partial LLM JSON ─────────────────────

describe("Bug Hunter #2c — Bug 3: writeCheckpoint normalizes partial LLM JSON", () => {
  beforeEach(async () => {
    const { resetCheckpoints } = await import("../checkpointWriter.js");
    resetCheckpoints();
    const { chat } = await import("../apiClient.js");
    (chat as any).mockReset();
  });

  it("produces a fully-typed state even when LLM returns only intention", async () => {
    const { writeCheckpoint, getLastCheckpointState, formatCheckpoint } = await import("../checkpointWriter.js");
    const { chat } = await import("../apiClient.js");
    // LLM returns ONLY intention. OLD code: state.constraints === undefined.
    (chat as any).mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ intention: "fix bug X" }) } }],
    });

    const result = await writeCheckpoint(1);
    expect(result.state.intention).toBe("fix bug X");
    // All array fields MUST be arrays (not undefined).
    expect(Array.isArray(result.state.constraints)).toBe(true);
    expect(Array.isArray(result.state.taskTree)).toBe(true);
    expect(Array.isArray(result.state.filesInvolved)).toBe(true);
    expect(Array.isArray(result.state.errorsAndCorrections)).toBe(true);
    expect(Array.isArray(result.state.designDecisions)).toBe(true);
    expect(Array.isArray(result.state.crossTaskDiscoveries)).toBe(true);
    expect(result.state.constraints).toEqual([]);

    // And formatCheckpoint on the stored state MUST NOT throw.
    const stored = getLastCheckpointState();
    expect(stored).not.toBeNull();
    expect(() => formatCheckpoint(stored!)).not.toThrow();
  });

  it("preserves fields the LLM did return (does not wipe valid data)", async () => {
    const { writeCheckpoint } = await import("../checkpointWriter.js");
    const { chat } = await import("../apiClient.js");
    (chat as any).mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            intention: "feat",
            constraints: ["c1"],
            filesInvolved: [{ path: "a.ts", change: "added" }],
          }),
        },
      }],
    });

    const result = await writeCheckpoint(1);
    expect(result.state.intention).toBe("feat");
    expect(result.state.constraints).toEqual(["c1"]);
    expect(result.state.filesInvolved).toEqual([{ path: "a.ts", change: "added" }]);
    // Missing arrays still defaulted.
    expect(result.state.taskTree).toEqual([]);
    expect(result.state.designDecisions).toEqual([]);
  });
});

// ─── Bug 4: readSymbolFromFile handles file-not-found ───────────────────────

describe("Bug Hunter #2c — Bug 4: readSymbolFromFile handles file-not-found", () => {
  it("returns an error result instead of throwing when file does not exist", async () => {
    const { readSymbolFromFile } = await import("../progressiveContext.js");
    const bogus = path.join(os.tmpdir(), `ck-2c-nope-${Date.now()}.ts`);
    // OLD behavior: fs.readFileSync throws ENOENT, propagates up — the await
    // below would reject and the test would fail with an unhandled rejection.
    // NEW behavior: returns a ProgressiveReadResult with an error message.
    const result = await readSymbolFromFile(bogus, null);
    expect(result.partial).toBe(false);
    expect(result.symbolName).toBeNull();
    expect(result.fullFileLines).toBe(0);
    expect(result.content).toContain("[ERROR]");
    expect(result.content).toContain(bogus);
  });

  it("returns an error result when a symbol is requested but file is missing", async () => {
    const { readSymbolFromFile } = await import("../progressiveContext.js");
    const bogus = path.join(os.tmpdir(), `ck-2c-nope-sym-${Date.now()}.ts`);
    const result = await readSymbolFromFile(bogus, "someFunction");
    expect(result.partial).toBe(false);
    expect(result.symbolName).toBeNull();
    expect(result.content).toContain("[ERROR]");
  });
});

// ─── Bug 5: detectSymbolRequest strips trailing punctuation ─────────────────

describe("Bug Hunter #2c — Bug 5: detectSymbolRequest strips trailing punctuation", () => {
  it("strips trailing period from filePath (end-of-sentence)", async () => {
    const { detectSymbolRequest } = await import("../progressiveContext.js");
    const r = detectSymbolRequest("show function foo from bar.ts.");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("foo");
    // OLD: "bar.ts." → ENOENT. NEW: "bar.ts".
    expect(r!.filePath).toBe("bar.ts");
  });

  it("strips trailing comma, semicolon, exclamation", async () => {
    const { detectSymbolRequest } = await import("../progressiveContext.js");
    expect(detectSymbolRequest("read foo from a.ts,")!.filePath).toBe("a.ts");
    expect(detectSymbolRequest("read foo from a.ts;")!.filePath).toBe("a.ts");
    expect(detectSymbolRequest("read foo from a.ts!")!.filePath).toBe("a.ts");
  });

  it("strips trailing closing bracket/paren/quote", async () => {
    const { detectSymbolRequest } = await import("../progressiveContext.js");
    expect(detectSymbolRequest("read foo from a.ts)")!.filePath).toBe("a.ts");
    expect(detectSymbolRequest('read foo from a.ts]')!.filePath).toBe("a.ts");
    expect(detectSymbolRequest('read foo from a.ts"')!.filePath).toBe("a.ts");
    expect(detectSymbolRequest("read foo from a.ts'")!.filePath).toBe("a.ts");
  });

  it("preserves internal periods (file.ts still has its extension)", async () => {
    const { detectSymbolRequest } = await import("../progressiveContext.js");
    const r = detectSymbolRequest("read function foo from src/path/file.ts");
    expect(r!.filePath).toBe("src/path/file.ts");
  });

  it("preserves relative-path prefix (./, ../)", async () => {
    const { detectSymbolRequest } = await import("../progressiveContext.js");
    expect(detectSymbolRequest("read foo from ./a.ts")!.filePath).toBe("./a.ts");
    expect(detectSymbolRequest("read foo from ../a.ts")!.filePath).toBe("../a.ts");
  });
});

// ─── Bug 6: readSymbolFromFile import filter false positives ────────────────

describe("Bug Hunter #2c — Bug 6: import filter no longer matches 'importantVar'", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-2c-imports-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("does NOT treat 'importantVariable = 1' as an import", async () => {
    const { readSymbolFromFile } = await import("../progressiveContext.js");
    // File: line 1 has 'importantVariable = 1' (starts with "important"),
    // foo at line 10 (per mock). OLD code: startsWith("import") matched
    // "importantVariable" → bogus line included in Imports section.
    const filePath = path.join(tmpDir, "test.ts");
    const lines: string[] = ["importantVariable = 1"];
    for (let i = 2; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {}");
      else if (i === 30) lines.push("function bar() {}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // The bogus line must NOT appear in the extracted content.
    expect(result.content).not.toContain("importantVariable");
    // Also no "Imports (for context)" header should be present (no real imports).
    expect(result.content).not.toContain("Imports (for context)");
  });

  it("still detects real JS/TS imports", async () => {
    const { readSymbolFromFile } = await import("../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    const lines: string[] = [
      "import { something } from 'lib';",
      "import { other } from 'lib2';",
    ];
    for (let i = 3; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {}");
      else if (i === 30) lines.push("function bar() {}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    expect(result.content).toContain("Imports (for context)");
    expect(result.content).toContain("something");
    expect(result.content).toContain("other");
  });

  it("still detects Luau `local X = require(...)` imports", async () => {
    const { readSymbolFromFile } = await import("../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.luau");
    const lines: string[] = [
      "local ReplicatedStorage = game:GetService('ReplicatedStorage')",
      "local fooModule = require(ReplicatedStorage.foo)",
    ];
    for (let i = 3; i <= 45; i++) {
      if (i === 10) lines.push("function foo() end");
      else if (i === 30) lines.push("function bar() end");
      else lines.push(`-- line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    expect(result.content).toContain("require");
  });
});

// ─── Bug 7: compactSummary defends against unknown section after relevant ───

describe("Bug Hunter #2c — Bug 7: compactSummary defends against unknown sections", () => {
  beforeEach(async () => {
    const { resetContextInjection } = await import("../contextInjector.js");
    resetContextInjection();
    const { getTaskStateSummary } = await import("../taskState.js");
    (getTaskStateSummary as any).mockReset();
  });

  it("does NOT leak indented lines from an unknown section that follows a relevant one", async () => {
    const { getContextInjection } = await import("../contextInjector.js");
    const { getTaskStateSummary } = await import("../taskState.js");
    // Layout: Todo (relevant) → Comments (unknown section). The lines under
    // Comments must NOT be injected. OLD code: inRelevantSection stayed true
    // after Todo, and Comments was not in the (Done|Notes) closer, so its
    // indented items leaked.
    (getTaskStateSummary as any).mockReturnValue(
      [
        "## TASK_STATE",
        "Title: leak-test",
        "Todo:",
        "  ○ real todo item",
        "Comments:",
        "  this should NOT leak",
        "  neither should this",
      ].join("\n"),
    );

    // Throttle: 3rd call returns the injection.
    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");

    expect(result).toContain("real todo item");
    expect(result).not.toContain("this should NOT leak");
    expect(result).not.toContain("neither should this");
    expect(result).not.toContain("Comments:");
  });

  it("still injects multiple relevant sections in sequence", async () => {
    const { getContextInjection } = await import("../contextInjector.js");
    const { getTaskStateSummary } = await import("../taskState.js");
    (getTaskStateSummary as any).mockReturnValue(
      [
        "## TASK_STATE",
        "Title: multi",
        "Todo:",
        "  ○ item 1",
        "Decisions:",
        "  • decision A",
        "Bugs:",
        "  ! bug 1",
        "Dependencies:",
        "  ⚠ dep 1",
      ].join("\n"),
    );

    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");

    expect(result).toContain("item 1");
    expect(result).toContain("decision A");
    expect(result).toContain("bug 1");
    expect(result).toContain("dep 1");
  });

  it("metadata lines (Started:, Updated:) after Title do not cause leaks", async () => {
    const { getContextInjection } = await import("../contextInjector.js");
    const { getTaskStateSummary } = await import("../taskState.js");
    (getTaskStateSummary as any).mockReturnValue(
      [
        "## TASK_STATE",
        "Title: t",
        "Started: 2026-01-01",
        "Updated: 2026-01-02",
        "Todo:",
        "  ○ do thing",
      ].join("\n"),
    );

    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");

    expect(result).toContain("do thing");
    expect(result).not.toContain("2026-01-01");
    expect(result).not.toContain("2026-01-02");
  });
});
