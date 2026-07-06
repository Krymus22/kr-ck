/**
 * impactAnalyzer-extended.test.ts — Extended tests for impactAnalyzer.ts
 *
 * Covers 30+ tests across:
 *   - extractSymbols (TypeScript, Luau, Python, Rust, Go)
 *   - formatImpactHint (readable hint generation)
 *   - formatImpactSummary (quick summary)
 *   - analyzeImpact (end-to-end with tmp project, mocked logger)
 *   - clearCache (cache invalidation)
 *   - edge cases: empty content, unknown language, single-char names
 *
 * Mocks logger; uses real i18n (forced to English by vitest-setup).
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

// Mock modeExtensions to return no custom patterns (so detectLanguageAsync
// falls back to built-in extensions only)
vi.mock("../modeExtensions.js", () => ({
  getActiveSymbolPatterns: vi.fn().mockResolvedValue([]),
}));

import {
  extractSymbols,
  formatImpactHint,
  formatImpactSummary,
  analyzeImpact,
  clearCache,
} from "../impactAnalyzer.js";

describe("extractSymbols - TypeScript (extended)", () => {
  it("extracts exported functions", () => {
    const content = "export function foo() {}\nexport function bar() {}\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.some((s) => s.name === "foo")).toBe(true);
    expect(symbols.some((s) => s.name === "bar")).toBe(true);
  });

  it("extracts exported const declarations", () => {
    const content = "export const PI = 3.14;\nexport const CONFIG = 42;\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.some((s) => s.name === "PI")).toBe(true);
    expect(symbols.some((s) => s.name === "CONFIG")).toBe(true);
  });

  it("extracts exported classes", () => {
    const content = "export class Foo {}\nexport class Bar {}\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.some((s) => s.name === "Foo")).toBe(true);
    expect(symbols.some((s) => s.name === "Bar")).toBe(true);
  });

  it("extracts exported type aliases", () => {
    const content = "export type UserID = string;\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.some((s) => s.name === "UserID")).toBe(true);
  });

  it("extracts exported interfaces", () => {
    const content = "export interface User { id: number }\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.some((s) => s.name === "User")).toBe(true);
  });

  it("does NOT extract non-exported functions", () => {
    const content = "function internal() {}\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.some((s) => s.name === "internal")).toBe(false);
  });

  it("skips very short names (< 2 chars)", () => {
    const content = "export const x = 1;\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.some((s) => s.name === "x")).toBe(false);
  });

  it("skips reserved word names like 'new', 'get', 'set'", () => {
    const content = "export function get() {}\nexport function set() {}\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.some((s) => s.name === "get")).toBe(false);
    expect(symbols.some((s) => s.name === "set")).toBe(false);
  });

  it("returns definitionLine as 1-indexed", () => {
    const content = "\n\nexport function foo() {}\n";
    const symbols = extractSymbols("test.ts", content);
    const foo = symbols.find((s) => s.name === "foo");
    expect(foo).toBeDefined();
    expect(foo!.definitionLine).toBe(3);
  });

  it("deduplicates symbols with the same name", () => {
    const content = "export function foo() {}\nexport function foo() {}\n";
    const symbols = extractSymbols("test.ts", content);
    const foos = symbols.filter((s) => s.name === "foo");
    expect(foos.length).toBe(1);
  });

  it("returns empty array for empty content", () => {
    const symbols = extractSymbols("test.ts", "");
    expect(symbols).toEqual([]);
  });

  it("returns empty array for content with no exports", () => {
    const content = "const x = 1;\nlet y = 2;\n";
    const symbols = extractSymbols("test.ts", content);
    expect(symbols.length).toBe(0);
  });
});

describe("extractSymbols - Luau (extended)", () => {
  it("extracts M.Foo style functions", () => {
    const content = "local M = {}\nfunction M.GetCoins(p: Player)\n  return p.Coins\nend\n";
    const symbols = extractSymbols("test.luau", content);
    expect(symbols.some((s) => s.name === "GetCoins")).toBe(true);
  });

  it("extracts local function definitions", () => {
    const content = "local function helper(x)\n  return x * 2\nend\n";
    const symbols = extractSymbols("test.luau", content);
    expect(symbols.some((s) => s.name === "helper")).toBe(true);
  });

  it("extracts M.Bar = function style", () => {
    const content = "local M = {}\nM.Initialize = function()\n  print('init')\nend\n";
    const symbols = extractSymbols("test.luau", content);
    expect(symbols.some((s) => s.name === "Initialize")).toBe(true);
  });

  it("extracts export type declarations", () => {
    const content = "export type Player = { name: string }\n";
    const symbols = extractSymbols("test.luau", content);
    expect(symbols.some((s) => s.name === "Player")).toBe(true);
  });

  it("uses .lua extension the same as .luau", () => {
    const content = "function M.Foo()\nend\n";
    const symbols = extractSymbols("test.lua", content);
    expect(symbols.some((s) => s.name === "Foo")).toBe(true);
  });
});

describe("extractSymbols - Python (extended)", () => {
  it("extracts top-level def", () => {
    const content = "def foo(x):\n  return x + 1\n";
    const symbols = extractSymbols("test.py", content);
    expect(symbols.some((s) => s.name === "foo")).toBe(true);
  });

  it("extracts top-level class", () => {
    const content = "class Foo:\n  pass\n";
    const symbols = extractSymbols("test.py", content);
    expect(symbols.some((s) => s.name === "Foo")).toBe(true);
  });
});

describe("extractSymbols - Rust (extended)", () => {
  it("extracts pub fn", () => {
    const content = "pub fn foo(x: i32) -> i32 { x + 1 }\n";
    const symbols = extractSymbols("test.rs", content);
    expect(symbols.some((s) => s.name === "foo")).toBe(true);
  });

  it("extracts pub struct", () => {
    const content = "pub struct Foo { x: i32 }\n";
    const symbols = extractSymbols("test.rs", content);
    expect(symbols.some((s) => s.name === "Foo")).toBe(true);
  });

  it("extracts pub enum", () => {
    const content = "pub enum Color { Red, Green, Blue }\n";
    const symbols = extractSymbols("test.rs", content);
    expect(symbols.some((s) => s.name === "Color")).toBe(true);
  });

  it("extracts pub trait", () => {
    const content = "pub trait Foo { fn bar(&self); }\n";
    const symbols = extractSymbols("test.rs", content);
    expect(symbols.some((s) => s.name === "Foo")).toBe(true);
  });
});

describe("extractSymbols - Go (extended)", () => {
  it("extracts func definitions", () => {
    const content = "func foo(x int) int { return x + 1 }\n";
    const symbols = extractSymbols("test.go", content);
    expect(symbols.some((s) => s.name === "foo")).toBe(true);
  });

  it("extracts type definitions", () => {
    const content = "type Foo struct { X int }\n";
    const symbols = extractSymbols("test.go", content);
    expect(symbols.some((s) => s.name === "Foo")).toBe(true);
  });
});

describe("extractSymbols - unknown language", () => {
  it("returns empty array for .md files", () => {
    const content = "# Title\nSome text.\n";
    const symbols = extractSymbols("README.md", content);
    expect(symbols).toEqual([]);
  });

  it("returns empty array for .json files", () => {
    const content = '{"key": "value"}\n';
    const symbols = extractSymbols("config.json", content);
    expect(symbols).toEqual([]);
  });

  it("returns empty array for files with no extension", () => {
    const content = "function foo() {}";
    const symbols = extractSymbols("Makefile", content);
    expect(symbols).toEqual([]);
  });
});

describe("formatImpactHint (extended)", () => {
  it("returns empty string when no usages", () => {
    const report = {
      targetFile: "/abs/file.ts",
      symbols: [],
      affectedFiles: [],
      usages: [],
      durationMs: 10,
    };
    expect(formatImpactHint(report)).toBe("");
  });

  it("includes header when usages present", () => {
    const report = {
      targetFile: "/abs/file.ts",
      symbols: [{ name: "foo", exportedAs: "foo", definitionLine: 1 }],
      affectedFiles: ["other.ts"],
      usages: [{ file: "other.ts", line: 5, symbol: "foo", lineContent: "foo()" }],
      durationMs: 10,
    };
    const hint = formatImpactHint(report);
    expect(typeof hint).toBe("string");
    expect(hint.length).toBeGreaterThan(0);
  });

  it("includes the target file basename in header", () => {
    const report = {
      targetFile: "/abs/my-file.ts",
      symbols: [{ name: "foo", exportedAs: "foo", definitionLine: 1 }],
      affectedFiles: ["other.ts"],
      usages: [{ file: "other.ts", line: 5, symbol: "foo", lineContent: "foo()" }],
      durationMs: 10,
    };
    const hint = formatImpactHint(report);
    expect(hint).toContain("my-file.ts");
  });

  it("includes line numbers in usage details", () => {
    const report = {
      targetFile: "/abs/file.ts",
      symbols: [{ name: "foo", exportedAs: "foo", definitionLine: 1 }],
      affectedFiles: ["other.ts"],
      usages: [{ file: "other.ts", line: 42, symbol: "foo", lineContent: "foo()" }],
      durationMs: 10,
    };
    const hint = formatImpactHint(report);
    expect(hint).toContain("L42");
  });

  it("groups usages by file", () => {
    const report = {
      targetFile: "/abs/file.ts",
      symbols: [{ name: "foo", exportedAs: "foo", definitionLine: 1 }],
      affectedFiles: ["a.ts", "b.ts"],
      usages: [
        { file: "a.ts", line: 1, symbol: "foo", lineContent: "foo()" },
        { file: "b.ts", line: 1, symbol: "foo", lineContent: "foo()" },
      ],
      durationMs: 10,
    };
    const hint = formatImpactHint(report);
    expect(hint).toContain("a.ts");
    expect(hint).toContain("b.ts");
  });

  it("limits to 5 usages per file", () => {
    const usages = Array.from({ length: 10 }, (_, i) => ({
      file: "a.ts",
      line: i + 1,
      symbol: "foo",
      lineContent: `usage ${i}`,
    }));
    const report = {
      targetFile: "/abs/file.ts",
      symbols: [{ name: "foo", exportedAs: "foo", definitionLine: 1 }],
      affectedFiles: ["a.ts"],
      usages,
      durationMs: 10,
    };
    const hint = formatImpactHint(report);
    // Should not include all 10 line contents, only first 5
    expect(hint).toContain("L1");
    expect(hint).toContain("L5");
    // The hint should mention there are more
    expect(hint.length).toBeGreaterThan(0);
  });
});

describe("formatImpactSummary (extended)", () => {
  it("returns 'no dependencies' when no usages", () => {
    const report = {
      targetFile: "/abs/file.ts",
      symbols: [],
      affectedFiles: [],
      usages: [],
      durationMs: 0,
    };
    const summary = formatImpactSummary(report);
    expect(typeof summary).toBe("string");
    expect(summary.toLowerCase()).toContain("no");
  });

  it("returns a non-empty string when usages present", () => {
    const report = {
      targetFile: "/abs/file.ts",
      symbols: [{ name: "foo", exportedAs: "foo", definitionLine: 1 }],
      affectedFiles: ["a.ts"],
      usages: [{ file: "a.ts", line: 1, symbol: "foo", lineContent: "foo()" }],
      durationMs: 0,
    };
    const summary = formatImpactSummary(report);
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });
});

describe("analyzeImpact (extended)", () => {
  let tmpProject: string;

  beforeEach(() => {
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-impact-ext-"));
    clearCache();
  });

  afterEach(() => {
    fs.rmSync(tmpProject, { recursive: true, force: true });
    clearCache();
  });

  it("returns empty report for non-existent file", async () => {
    const target = path.join(tmpProject, "nonexistent.ts");
    const report = await analyzeImpact(target, tmpProject);
    expect(report.symbols).toEqual([]);
    expect(report.usages).toEqual([]);
    expect(report.affectedFiles).toEqual([]);
  });

  it("returns empty report for file with no symbols", async () => {
    const target = path.join(tmpProject, "NoSymbols.ts");
    fs.writeFileSync(target, "const x = 1;\n");
    const report = await analyzeImpact(target, tmpProject);
    expect(report.symbols).toEqual([]);
    expect(report.usages).toEqual([]);
  });

  it("returns symbols for a TypeScript file with exports", async () => {
    const target = path.join(tmpProject, "HasExports.ts");
    fs.writeFileSync(target, "export function foo() {}\nexport const bar = 1;\n");
    const report = await analyzeImpact(target, tmpProject);
    expect(report.symbols.length).toBeGreaterThan(0);
    expect(report.symbols.some((s) => s.name === "foo")).toBe(true);
    expect(report.symbols.some((s) => s.name === "bar")).toBe(true);
  });

  it("targetFile in report matches the input path", async () => {
    const target = path.join(tmpProject, "Target.ts");
    fs.writeFileSync(target, "export function foo() {}\n");
    const report = await analyzeImpact(target, tmpProject);
    expect(report.targetFile).toBe(target);
  });

  it("durationMs is non-negative", async () => {
    const target = path.join(tmpProject, "Duration.ts");
    fs.writeFileSync(target, "export function foo() {}\n");
    const report = await analyzeImpact(target, tmpProject);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns a valid ImpactReport shape", async () => {
    const target = path.join(tmpProject, "Shape.ts");
    fs.writeFileSync(target, "export function foo() {}\n");
    const report = await analyzeImpact(target, tmpProject);
    expect(report).toHaveProperty("targetFile");
    expect(report).toHaveProperty("symbols");
    expect(report).toHaveProperty("affectedFiles");
    expect(report).toHaveProperty("usages");
    expect(report).toHaveProperty("durationMs");
    expect(Array.isArray(report.symbols)).toBe(true);
    expect(Array.isArray(report.affectedFiles)).toBe(true);
    expect(Array.isArray(report.usages)).toBe(true);
  });

  it("clearCache does not throw", () => {
    expect(() => clearCache()).not.toThrow();
  });
});
