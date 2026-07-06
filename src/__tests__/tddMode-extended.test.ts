/**
 * tddMode-extended.test.ts — Extended tests for tddMode.ts
 *
 * Covers 30+ tests across:
 *   - isTestable (extension detection)
 *   - registerTDD / getTDD / hasTDD / clearTDD (state management)
 *   - testFileExists (disk check)
 *   - formatTDD (string formatting)
 *   - getTestFilePath (path generation)
 *
 * Uses a tmp dir for filesystem tests and resets TDD state between tests.
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

import {
  isTestable,
  registerTDD,
  getTDD,
  hasTDD,
  testFileExists,
  clearTDD,
  formatTDD,
  getTestFilePath,
} from "../tddMode.js";

describe("isTestable (extended)", () => {
  it("returns true for .ts", () => {
    expect(isTestable("foo.ts")).toBe(true);
  });

  it("returns true for .tsx", () => {
    expect(isTestable("foo.tsx")).toBe(true);
  });

  it("returns true for .js", () => {
    expect(isTestable("foo.js")).toBe(true);
  });

  it("returns true for .py", () => {
    expect(isTestable("foo.py")).toBe(true);
  });

  it("returns true for .rs", () => {
    expect(isTestable("foo.rs")).toBe(true);
  });

  it("returns true for .go", () => {
    expect(isTestable("foo.go")).toBe(true);
  });

  it("returns true for .luau", () => {
    expect(isTestable("foo.luau")).toBe(true);
  });

  it("returns true for .lua", () => {
    expect(isTestable("foo.lua")).toBe(true);
  });

  it("returns false for .md", () => {
    expect(isTestable("README.md")).toBe(false);
  });

  it("returns false for .json", () => {
    expect(isTestable("config.json")).toBe(false);
  });

  it("returns false for .txt", () => {
    expect(isTestable("notes.txt")).toBe(false);
  });

  it("returns false for files with no extension", () => {
    expect(isTestable("Makefile")).toBe(false);
  });

  it("is case-insensitive for extension", () => {
    expect(isTestable("foo.TS")).toBe(true);
    expect(isTestable("foo.PY")).toBe(true);
  });

  it("handles paths with directories", () => {
    expect(isTestable("src/lib/file.ts")).toBe(true);
    expect(isTestable("/abs/path/to/file.luau")).toBe(true);
  });

  it("handles empty string", () => {
    expect(isTestable("")).toBe(false);
  });
});

describe("TDD state management (extended)", () => {
  beforeEach(() => {
    clearTDD();
  });

  afterEach(() => {
    clearTDD();
  });

  it("hasTDD returns false initially", () => {
    expect(hasTDD()).toBe(false);
  });

  it("getTDD returns null initially", () => {
    expect(getTDD()).toBeNull();
  });

  it("registerTDD sets the current TDD spec", () => {
    const spec = registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", ["case1"]);
    expect(spec).toBeDefined();
    expect(spec.testFile).toBe("/tmp/test.spec.ts");
    expect(spec.implFile).toBe("/tmp/impl.ts");
    expect(spec.language).toBe("typescript");
    expect(spec.testCases).toEqual(["case1"]);
  });

  it("hasTDD returns true after registerTDD", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", []);
    expect(hasTDD()).toBe(true);
  });

  it("getTDD returns the registered spec", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", ["case1", "case2"]);
    const spec = getTDD();
    expect(spec).not.toBeNull();
    expect(spec!.testCases.length).toBe(2);
  });

  it("clearTDD resets state to null", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", ["case1"]);
    clearTDD();
    expect(hasTDD()).toBe(false);
    expect(getTDD()).toBeNull();
  });

  it("registerTDD sets createdAt to current time", () => {
    const before = Date.now();
    const spec = registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", []);
    const after = Date.now();
    expect(spec.createdAt).toBeGreaterThanOrEqual(before);
    expect(spec.createdAt).toBeLessThanOrEqual(after);
  });

  it("registerTDD with empty testCases array is allowed", () => {
    const spec = registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", []);
    expect(spec.testCases).toEqual([]);
    expect(hasTDD()).toBe(true);
  });

  it("registerTDD overwrites previous spec", () => {
    registerTDD("/tmp/test1.spec.ts", "/tmp/impl1.ts", "typescript", ["a"]);
    registerTDD("/tmp/test2.spec.ts", "/tmp/impl2.ts", "python", ["b"]);
    const spec = getTDD();
    expect(spec!.testFile).toBe("/tmp/test2.spec.ts");
    expect(spec!.implFile).toBe("/tmp/impl2.ts");
    expect(spec!.language).toBe("python");
  });
});

describe("testFileExists (extended)", () => {
  let tmpDir: string;

  beforeEach(() => {
    clearTDD();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tdd-ext-"));
  });

  afterEach(() => {
    clearTDD();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when no TDD is registered", () => {
    expect(testFileExists()).toBe(false);
  });

  it("returns false when the test file does not exist on disk", () => {
    registerTDD("/nonexistent/path/test.spec.ts", "/tmp/impl.ts", "typescript", []);
    expect(testFileExists()).toBe(false);
  });

  it("returns true when the test file exists on disk", () => {
    const testFile = path.join(tmpDir, "test.spec.ts");
    fs.writeFileSync(testFile, "describe('x', () => it('y', () => {}));");
    registerTDD(testFile, "/tmp/impl.ts", "typescript", []);
    expect(testFileExists()).toBe(true);
  });
});

describe("formatTDD (extended)", () => {
  beforeEach(() => {
    clearTDD();
  });

  afterEach(() => {
    clearTDD();
  });

  it("returns empty string when no TDD registered", () => {
    expect(formatTDD()).toBe("");
  });

  it("returns a non-empty string when TDD is registered", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", ["case1"]);
    const out = formatTDD();
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("includes the test file path", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", []);
    expect(formatTDD()).toContain("/tmp/test.spec.ts");
  });

  it("includes the implementation file path", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", []);
    expect(formatTDD()).toContain("/tmp/impl.ts");
  });

  it("includes the language", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "python", []);
    expect(formatTDD()).toContain("python");
  });

  it("includes '[TDD ACTIVE]' marker", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", []);
    expect(formatTDD()).toContain("[TDD ACTIVE]");
  });

  it("lists test cases when present", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", ["first", "second"]);
    const out = formatTDD();
    expect(out).toContain("first");
    expect(out).toContain("second");
  });

  it("numbers test cases starting at 1", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", ["alpha", "beta"]);
    const out = formatTDD();
    expect(out).toContain("1. alpha");
    expect(out).toContain("2. beta");
  });

  it("includes instruction not to modify tests", () => {
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", []);
    const out = formatTDD();
    expect(out.toLowerCase()).toContain("do not modify");
  });

  it("handles large number of test cases", () => {
    const cases = Array.from({ length: 50 }, (_, i) => `case_${i}`);
    registerTDD("/tmp/test.spec.ts", "/tmp/impl.ts", "typescript", cases);
    const out = formatTDD();
    expect(out).toContain("case_0");
    expect(out).toContain("case_49");
  });
});

describe("getTestFilePath (extended)", () => {
  it("generates __tests__/name.spec.ext for a simple file", () => {
    const result = getTestFilePath("src/Inventory.luau");
    expect(result).toContain("__tests__");
    expect(result).toContain("Inventory.spec.luau");
  });

  it("preserves the directory of the input file", () => {
    const result = getTestFilePath("src/foo/bar.ts");
    expect(result).toContain("src");
    expect(result).toContain("foo");
    expect(result).toContain("__tests__");
  });

  it("handles .ts extension", () => {
    const result = getTestFilePath("src/file.ts");
    expect(result).toMatch(/file\.spec\.ts$/);
  });

  it("handles .py extension", () => {
    const result = getTestFilePath("src/file.py");
    expect(result).toMatch(/file\.spec\.py$/);
  });

  it("handles .rs extension", () => {
    const result = getTestFilePath("src/file.rs");
    expect(result).toMatch(/file\.spec\.rs$/);
  });

  it("handles .go extension", () => {
    const result = getTestFilePath("src/file.go");
    expect(result).toMatch(/file\.spec\.go$/);
  });

  it("handles .lua extension", () => {
    const result = getTestFilePath("src/file.lua");
    expect(result).toMatch(/file\.spec\.lua$/);
  });

  it("handles absolute paths", () => {
    const result = getTestFilePath("/abs/path/file.ts");
    expect(result).toContain("__tests__");
    expect(result).toContain("file.spec.ts");
  });

  it("handles files in root directory (no path separator)", () => {
    const result = getTestFilePath("file.ts");
    expect(result).toContain("__tests__");
    expect(result).toContain("file.spec.ts");
  });

  it("handles files with multiple dots in name", () => {
    const result = getTestFilePath("src/my.file.ts");
    // The extension is .ts, base name is "my.file"
    expect(result).toContain("my.file.spec.ts");
  });
});
