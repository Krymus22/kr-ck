/**
 * progressiveContext-extended.test.ts — Extended tests for progressiveContext.ts
 *
 * Covers 30+ tests across:
 *   - detectSymbolRequest (multiple languages, patterns, edge cases)
 *   - readSymbolFromFile (full read fallback, partial extraction, AST errors)
 *   - ProgressiveReadResult shape
 *
 * Mocks logger and lspAst (parseFile) to keep tests deterministic and fast.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

// Mock parseFile to return a controllable AST
// Note: vi.mock factory is hoisted, so we use vi.hoisted to keep references
const { mockAst } = vi.hoisted(() => ({
  mockAst: {
    language: "typescript",
    lineCount: 50,
    symbols: [
      { name: "foo", type: "function", line: 10 },
      { name: "bar", type: "function", line: 30 },
    ],
  },
}));
vi.mock("../lspAst.js", () => ({
  parseFile: vi.fn().mockResolvedValue(mockAst),
}));

import { readSymbolFromFile, detectSymbolRequest } from "../progressiveContext.js";

describe("detectSymbolRequest (extended)", () => {
  it("detects 'read function X from file'", () => {
    const r = detectSymbolRequest("read function GetCoins from InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
    expect(r!.filePath).toBe("InventoryService.luau");
  });

  it("detects 'show me the X from file'", () => {
    const r = detectSymbolRequest("show me the parseArgs from file.ts");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("parseArgs");
    expect(r!.filePath).toBe("file.ts");
  });

  it("detects 'show X from file' (no filler words)", () => {
    const r = detectSymbolRequest("show parseArgs from file.ts");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("parseArgs");
  });

  it("detects Portuguese 'ler a função X de file'", () => {
    const r = detectSymbolRequest("ler a função GetCoins de InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
    expect(r!.filePath).toBe("InventoryService.luau");
  });

  it("detects 'ver função X em file' (PT-BR)", () => {
    const r = detectSymbolRequest("ver função GetCoins em arquivo.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
  });

  it("detects 'mostra X de file' (PT-BR)", () => {
    const r = detectSymbolRequest("mostra GetCoins de arquivo.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
  });

  it("detects 'function X from file' pattern (second regex)", () => {
    const r = detectSymbolRequest("function GetCoins from InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
  });

  it("detects 'função X de file' pattern (second regex with ç)", () => {
    const r = detectSymbolRequest("função GetCoins de InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
  });

  it("detects 'função X de file' pattern (second regex with ã)", () => {
    const r = detectSymbolRequest("funçao GetCoins de InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
  });

  it("returns null for empty string", () => {
    expect(detectSymbolRequest("")).toBeNull();
  });

  it("returns null for plain text without a function request", () => {
    expect(detectSymbolRequest("fix the bug in InventoryService")).toBeNull();
  });

  it("returns null for a function name without a file path", () => {
    expect(detectSymbolRequest("show me GetCoins")).toBeNull();
  });

  it("returns null for a file path without a function name", () => {
    expect(detectSymbolRequest("read file InventoryService.luau")).toBeNull();
  });

  it("is case-insensitive for verb matching", () => {
    const r = detectSymbolRequest("READ FUNCTION Foo FROM bar.ts");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("Foo");
    expect(r!.filePath).toBe("bar.ts");
  });

  it("detects 'read X in file' (in keyword)", () => {
    const r = detectSymbolRequest("read GetCoins in InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
  });

  it("detects 'ver X em file' (em keyword)", () => {
    const r = detectSymbolRequest("ver GetCoins em InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
  });

  it("handles function name with underscore", () => {
    const r = detectSymbolRequest("read function get_coins from InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("get_coins");
  });

  it("handles function name with numbers", () => {
    const r = detectSymbolRequest("read function get2coins from file.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("get2coins");
  });

  it("returns null for whitespace-only input", () => {
    expect(detectSymbolRequest("   ")).toBeNull();
  });

  it("handles message with leading whitespace", () => {
    const r = detectSymbolRequest("  read function Foo from bar.ts");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("Foo");
  });

  it("detects using 'ler' verb", () => {
    const r = detectSymbolRequest("ler GetCoins de InventoryService.luau");
    expect(r).not.toBeNull();
    expect(r!.symbolName).toBe("GetCoins");
  });
});

describe("readSymbolFromFile (extended)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-ctx-ext-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns full file when symbolName is null", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n");
    const result = await readSymbolFromFile(filePath, null);
    expect(result.partial).toBe(false);
    expect(result.symbolName).toBeNull();
    expect(result.content).toContain("const x = 1");
    expect(result.content).toContain("const y = 2");
    expect(result.savingsPercent).toBe(0);
  });

  it("returns full file when symbolName is empty string", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\n");
    const result = await readSymbolFromFile(filePath, "");
    // Empty string is falsy, so should return full file
    expect(result.partial).toBe(false);
    expect(result.content).toContain("const x = 1");
  });

  it("extracts a specific symbol when found in AST", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    // Build a 45-line file with foo at line 10, bar at line 30 (matching mock AST)
    const lines: string[] = ["import { something } from 'lib';", ""];
    for (let i = 3; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    expect(result.symbolName).toBe("foo");
    expect(result.savingsPercent).toBeGreaterThan(0);
  });

  it("falls back to full read when symbol not found in AST", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\n");
    const result = await readSymbolFromFile(filePath, "nonexistent");
    expect(result.partial).toBe(false);
    expect(result.symbolName).toBeNull();
    expect(result.savingsPercent).toBe(0);
  });

  it("is case-insensitive for symbol name lookup", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {}");
      else if (i === 30) lines.push("function bar() {}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    // "FOO" should match "foo" case-insensitively
    const result = await readSymbolFromFile(filePath, "FOO");
    expect(result.partial).toBe(true);
    expect(result.symbolName).toBe("FOO");
  });

  it("returns correct ProgressiveReadResult shape", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\n");
    const result = await readSymbolFromFile(filePath, null);
    expect(result).toHaveProperty("content");
    expect(result).toHaveProperty("partial");
    expect(result).toHaveProperty("symbolName");
    expect(result).toHaveProperty("fullFileLines");
    expect(result).toHaveProperty("extractedLines");
    expect(result).toHaveProperty("savingsPercent");
    expect(typeof result.content).toBe("string");
    expect(typeof result.partial).toBe("boolean");
    expect(typeof result.fullFileLines).toBe("number");
    expect(typeof result.extractedLines).toBe("number");
    expect(typeof result.savingsPercent).toBe("number");
  });

  it("fullFileLines matches the number of lines in the file", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "a\nb\nc\nd\n");
    const result = await readSymbolFromFile(filePath, null);
    // 4 lines (a, b, c, d) + empty trailing
    expect(result.fullFileLines).toBeGreaterThanOrEqual(4);
  });

  it("extractedLines equals fullFileLines on full read", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "a\nb\nc\n");
    const result = await readSymbolFromFile(filePath, null);
    expect(result.extractedLines).toBe(result.fullFileLines);
  });

  it("handles files with only one line", async () => {
    const filePath = path.join(tmpDir, "one.ts");
    fs.writeFileSync(filePath, "single line");
    const result = await readSymbolFromFile(filePath, null);
    expect(result.fullFileLines).toBe(1);
    expect(result.content).toBe("single line");
  });

  it("handles empty file", async () => {
    const filePath = path.join(tmpDir, "empty.ts");
    fs.writeFileSync(filePath, "");
    const result = await readSymbolFromFile(filePath, null);
    // empty string splits to [""] which is 1 line
    expect(result.content).toBe("");
    expect(result.fullFileLines).toBe(1);
  });

  it("falls back to full read when AST parsing throws", async () => {
    // Override parseFile mock for this test
    const { parseFile } = await import("../lspAst.js");
    vi.mocked(parseFile).mockRejectedValueOnce(new Error("AST parse failed"));

    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\nconst y = 2;\n");
    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(false);
    expect(result.symbolName).toBeNull();
    expect(result.savingsPercent).toBe(0);
    expect(result.content).toContain("const x = 1");
  });

  it("extractedLines is less than fullFileLines on successful extraction", async () => {
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
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    expect(result.extractedLines).toBeLessThan(result.fullFileLines);
  });

  it("includes imports in extracted content when present", async () => {
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
  });
});

describe("readSymbolFromFile edge cases (extended)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-ctx-edge-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("handles a file with just imports and no symbols", async () => {
    const filePath = path.join(tmpDir, "imports.ts");
    fs.writeFileSync(filePath, "import { foo } from 'lib';\nimport { bar } from 'lib2';\n");
    const result = await readSymbolFromFile(filePath, "nonexistent");
    expect(result.partial).toBe(false);
    expect(result.savingsPercent).toBe(0);
  });

  it("extracts the last symbol in the file (no next symbol)", async () => {
    const filePath = path.join(tmpDir, "test.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 35; i++) {
      if (i === 10) lines.push("function foo() {}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    // bar is the LAST symbol - endLine defaults to file length
    const result = await readSymbolFromFile(filePath, "bar");
    expect(result.partial).toBe(true);
    expect(result.symbolName).toBe("bar");
  });

  it("savingsPercent is between 0 and 100 (inclusive) on successful extraction", async () => {
    const filePath = path.join(tmpDir, "big.ts");
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      if (i === 10) lines.push("function foo() {}");
      else if (i === 30) lines.push("function bar() {}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    const result = await readSymbolFromFile(filePath, "foo");
    if (result.partial) {
      expect(result.savingsPercent).toBeGreaterThanOrEqual(0);
      expect(result.savingsPercent).toBeLessThanOrEqual(100);
    }
  });
});
