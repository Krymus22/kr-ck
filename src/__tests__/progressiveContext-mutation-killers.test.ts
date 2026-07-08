/**
 * progressiveContext-mutation-killers.test.ts — Targeted tests to kill LOW + MEDIUM
 * priority survived mutations in src/progressiveContext.ts.
 *
 * This file is named `progressiveContext-mutation-killers.test.ts` so the
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
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
}));

// Hoisted mock state for lspAst.parseFile — module-level vi.mock applies to all
// progressiveContext tests in this file.
const progctxMockState = vi.hoisted(() => ({
  ast: {
    language: "typescript",
    lineCount: 50,
    symbols: [
      { name: "foo", type: "function", line: 10 },
      { name: "bar", type: "function", line: 30 },
    ],
  },
}));
vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn().mockResolvedValue(progctxMockState.ast),
}));

// ─── progressiveContext.ts ──────────────────────────────────────────────────

describe("mutation-killers / progressiveContext.ts — L113/L118/L120/L124 line arithmetic", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-progctx-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /**
   * Mutations:
   *   L113: `Math.max(0, symbol.line - 1)` → `symbol.line + 1` (startLine wrong)
   *   L120: `endLine = nextSymbol!.line - 1` → `+ 1` (endLine wrong)
   *   L124: `Math.max(0, startLine - 3)` → `startLine + 3` (contextStart wrong)
   *
   * Killing strategy: write a file with foo at line 10 and bar at line 30
   * (matching the mock AST). Extract "foo". Verify the extracted content
   * does NOT include "function bar" (which is at line 30). With mutation
   * L120 (`+ 1`), endLine = 30 + 1 = 31, so the slice includes line 30
   * → "function bar" appears in content. Test fails.
   */
  it("extracting 'foo' does NOT include 'function bar' from the next symbol (kills `- → +` on L120)", async () => {
    // Mock parseFile to return an AST with foo@10, bar@30

    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // Without mutation: endLine = 30 - 1 = 29. Slice [contextStart, 29)
    //   does NOT include line 30 ("function bar").
    // With mutation `- → +`: endLine = 30 + 1 = 31. Slice includes line 30
    //   → "function bar" is in the content.
    expect(result.content).not.toContain("function bar");
  });

  /**
   * Mutation L124: `Math.max(0, startLine - 3)` → `startLine + 3`
   *
   * Effect: contextStart = startLine + 3, which is 3 lines AFTER the
   * function start. So the lines BEFORE the function (comments,
   * decorators) would NOT be included.
   *
   * Killing strategy: write a file with a comment 3 lines before the
   * function (e.g., at line 7 for a function at line 10). Extract the
   * function. Without mutation: contextStart = max(0, 9 - 3) = 6 →
   * slice(6, ...) includes lines 7,8,9,10 → comment at line 7 IS in
   * content. With mutation: contextStart = 9 + 3 = 12 → slice(12, ...)
   * does NOT include line 7 → comment NOT in content. Test fails.
   */
  it("extracted content includes lines 3 before the function (kills `- → +` on L124)", async () => {

    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 45; i++) {
      if (i === 7) lines.push("// IMPORTANT COMMENT BEFORE FUNCTION");
      else if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // Without mutation: contextStart = max(0, 9 - 3) = 6. slice(6, endLine)
    //   includes lines 7,8,9,10 → comment IS in content.
    // With mutation `- → +`: contextStart = 9 + 3 = 12. slice(12, ...) does
    //   NOT include line 7 → comment NOT in content.
    expect(result.content).toContain("IMPORTANT COMMENT BEFORE FUNCTION");
  });

  /**
   * Mutation L118: `symbolIdx >= 0 && symbolIdx < ast.symbols.length - 1`
   *                mutation: `>= 0` → `> 0`
   *
   * Effect: for the FIRST symbol (idx=0), original `0 >= 0` = true →
   * endLine is set from the next symbol. With mutation `0 > 0` = false
   * → endLine stays at lines.length (whole rest of file).
   *
   * Killing strategy: extract the FIRST symbol (foo at idx=0). Without
   * mutation: endLine = nextSymbol.line - 1 = 29. With mutation:
   * endLine = lines.length (e.g. 45). The content would include "function
   * bar" (line 30). Test fails.
   *
   * This is the same scenario as the L120 test, but the mutation is at
   * L118. The same assertion ("function bar" not in content) kills both.
   */
  it("extracting FIRST symbol uses next symbol to bound endLine (kills `>= 0 → > 0` on L118)", async () => {

    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // foo is the FIRST symbol (idx=0). Without mutation: endLine=29 (from
    // next symbol bar@30). With mutation `>= 0 → > 0`: 0 > 0 is false →
    // endLine stays at lines.length=45 → content includes "function bar".
    expect(result.content).not.toContain("function bar");
  });
});

describe("mutation-killers / progressiveContext.ts — L144/L148 imports header gating", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-progctx-imp-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /**
   * Mutation L144: `importLines.length > 0` → `>= 0` (no effect)
   *                `.length > 0` → `.length > 1` (needs MORE than 1)
   *
   * Survived because existing tests use 2 import lines, where both
   * `> 0` and `> 1` are true.
   *
   * Killing strategy: write a file with EXACTLY 1 import line. Extract
   * a function. Without mutation: imports header IS added (1 > 0). With
   * mutation `> 1`: imports header NOT added (1 > 1 is false). Test
   * asserting content contains "Imports (for context)" fails.
   */
  it("single import line still triggers imports header (kills `.length > 0 → .length > 1` on L144)", async () => {

    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    // EXACTLY 1 import line
    const lines: string[] = ["import { something } from 'lib';"];
    for (let i = 2; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // Without mutation: 1 > 0 → true → imports header IS added.
    // With mutation `.length > 0 → .length > 1`: 1 > 1 → false → NO header.
    expect(result.content).toContain("Imports (for context)");
    expect(result.content).toContain("something");
  });

  /**
   * Mutation L148: `extractedLines.length + importLines.length` → `-`
   *
   * Effect: extractedLineCount = extractedLines.length - importLines.length.
   * For a file with both, this under-counts. savingsPercent = round((1 - extractedLineCount / fullLines) * 100).
   *
   * Killing strategy: write a file with known line counts. Verify
   * `result.extractedLines` equals the SUM, not the difference.
   *
   * With 1 import line and ~3 extracted lines (function body), the
   * sum = 4, the difference = 2. savingsPercent = round((1 - 4/45)*100)
   * = 91 vs round((1 - 2/45)*100) = 96. We can assert exact value of
   * `extractedLines`.
   */
  it("extractedLines is sum of extracted body lines + import lines (kills `+ → -` on L148)", async () => {

    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    // 2 import lines
    const lines: string[] = ["import { a } from 'lib1';", "import { b } from 'lib2';"];
    for (let i = 3; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // extractedLines.length = endLine - contextStart.
    // startLine = 10 - 1 = 9. contextStart = max(0, 9-3) = 6.
    // endLine = bar.line - 1 = 29.
    // extractedLines = lines.slice(6, 29) → 23 lines.
    // importLines.length = 2.
    // extractedLineCount (without mutation) = 23 + 2 = 25.
    // extractedLineCount (with mutation `+ → -`) = 23 - 2 = 21.
    expect(result.extractedLines).toBe(25);
  });
});

describe("mutation-killers / progressiveContext.ts — L138/L139 import regex", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-progctx-regex-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /**
   * Mutations on L138-139 (import filter):
   *   - `&&` → `||` on `(trimmed) && /\brequire\b/`: any "local X" OR
   *     any "require" would match (over-broad).
   *   - `||` → `&&` between import/local-require and #include: needs BOTH
   *     to match (impossible) → no imports detected.
   *   - `||` → `&&` between #include and `use\s`: needs BOTH (impossible).
   *
   * Killing strategy for `&& → ||` (L138):
   *   Write a Luau file with `local X = 5` (no require). Without
   *   mutation: NOT matched (local without require). With mutation:
   *   matched (local OR require → local alone matches). Imports header
   *   appears; content includes "local X = 5". Test asserting content
   *   does NOT include "local X = 5" fails.
   *
   * Killing strategy for `|| → &&` (L139 first): we test that a TS
   *   `import` line IS detected. With mutation, the AND with #include
   *   fails (no #include in TS) → no imports detected → header missing.
   *   Test asserting header IS present fails. (This is the same
   *   assertion as the L144 test for "Imports (for context)".)
   */
  it("Luau `local X = 5` (no require) is NOT treated as import (kills `&& → ||` on L138)", async () => {
    // Uses the module-level vi.mock("../lspAst.js") — the mock AST has
    // foo@10, bar@30 which is what we need.
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.luau");
    const lines: string[] = ["local NotAnImport = 5"];
    for (let i = 2; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`-- line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // Without mutation: "local NotAnImport = 5" — starts with "local"
    //   AND contains "require"? NO "require" → false. Not treated as import.
    //   Content does NOT have "Imports (for context)" header.
    // With mutation `&& → ||`: "local NotAnImport = 5" — starts with "local"
    //   OR contains "require"? "local" matches → true. Treated as import.
    //   Content DOES have "Imports (for context)" header.
    expect(result.content).not.toContain("Imports (for context)");
    expect(result.content).not.toContain("NotAnImport");
  });
});

describe("mutation-killers / progressiveContext.ts — L138 second `|| → &&` (Luau require)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-progctx-lua-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /**
   * Mutation: L138 second `||` → `&&` (between local-require and #include)
   *
   * The import filter is:
   *   /^import\b/ || (/^local\b/ && /\brequire\b/) || /^#include\b/ || /^use\s/
   *
   * With the SECOND `||` mutated to `&&`:
   *   /^import\b/ || ((/^local\b/ && /\brequire\b/) && /^#include\b/) || /^use\s/
   *
   * The middle clause becomes (local && require && #include) — impossible
   * (a line can't be both local+require and #include). So Luau
   * `local X = require(...)` imports are NEVER detected.
   *
   * Killing strategy: write a Luau file with `local X = require("lib")` at
   * line 1. Extract "foo". Without mutation: the require line IS detected
   * as an import → "Imports (for context)" header IS added. With mutation:
   * the require line is NOT detected → no header. Test asserts header
   * present → fails. ✓ KILLED.
   */
  it("Luau `local X = require(...)` IS detected as import (kills `|| → &&` on L138 second)", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.luau");
    const lines: string[] = ['local Rojo = require("@lune/rojo")'];
    for (let i = 2; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`-- line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // Without mutation: `local X = require(...)` matches (local && require)
    //   → import detected → header added.
    // With mutation `|| → &&` on L138 second: middle clause requires
    //   (local && require && #include) → impossible → not detected → no header.
    expect(result.content).toContain("Imports (for context)");
    expect(result.content).toContain("Rojo");
  });
});

describe("mutation-killers / progressiveContext.ts — L139 `|| → &&` (#include)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-progctx-cc-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  /**
   * Mutation: L139 `||` → `&&` (between #include and use\s)
   *
   * The import filter is:
   *   /^import\b/ || (/^local\b/ && /\brequire\b/) || /^#include\b/ || /^use\s/
   *
   * With the THIRD `||` (L139) mutated to `&&`:
   *   /^import\b/ || (/^local\b/ && /\brequire\b/) || (/^#include\b/ && /^use\s/)
   *
   * The last clause becomes (#include && use\s) — impossible (a line can't
   * start with both #include and use). So C/C++ `#include` lines are NEVER
   * detected as imports.
   *
   * Killing strategy: write a C file with `#include <stdio.h>` at line 1.
   * Extract "foo". Without mutation: #include IS detected → header added.
   * With mutation: #include NOT detected → no header. Test asserts header
   * present → fails. ✓ KILLED.
   */
  it("C/C++ `#include` IS detected as import (kills `|| → &&` on L139)", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.c");
    const lines: string[] = ["#include <stdio.h>"];
    for (let i = 2; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");

    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    // Without mutation: `#include <stdio.h>` matches /^#include\b/ →
    //   import detected → header added.
    // With mutation `|| → &&` on L139: last clause requires
    //   (#include && use\s) → impossible → not detected → no header.
    expect(result.content).toContain("Imports (for context)");
    expect(result.content).toContain("stdio.h");
  });
});
