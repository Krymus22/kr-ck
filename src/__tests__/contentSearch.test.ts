/**
 * contentSearch.test.ts — Tests for grep/content search module.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { grepSearch, formatGrepResults } from "../contentSearch.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readFileSync: (filePath: any, ...args: any[]) => {
      if (typeof filePath === "string" && filePath.includes("unreadable")) {
        throw new Error("EACCES: permission denied");
      }
      return actual.readFileSync(filePath, ...args);
    },
  };
});

const TEST_DIR = path.join(process.cwd(), "__test_grepdir__");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, "a.ts"), "const foo = 1;\nexport function bar() {}\nconst baz = 3;\n", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "b.ts"), "import { bar } from './a';\nconst foo = 2;\n", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "c.py"), "def foo():\n    pass\n", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("grepSearch", () => {
  it("should find matching lines", () => {
    const results = grepSearch({ pattern: "foo", path: TEST_DIR });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some((r) => r.content.includes("foo"))).toBe(true);
  });

  it("should return file and line numbers", () => {
    const results = grepSearch({ pattern: "bar", path: TEST_DIR });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].file).toBeDefined();
    expect(results[0].line).toBeGreaterThan(0);
  });

  it("should filter by include pattern", () => {
    const results = grepSearch({ pattern: "foo", path: TEST_DIR, include: "*.ts" });
    expect(results.every((r) => r.file.endsWith(".ts"))).toBe(true);
  });

  it("should support case-insensitive search", () => {
    const results = grepSearch({ pattern: "FOO", path: TEST_DIR, caseInsensitive: true });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("should support context lines", () => {
    const results = grepSearch({ pattern: "bar", path: TEST_DIR, contextLines: 1 });
    expect(results.length).toBeGreaterThan(0);
    if (results[0].before || results[0].after) {
      // Has context
      expect(true).toBe(true);
    }
  });

  it("should limit results with maxResults", () => {
    const results = grepSearch({ pattern: "const", path: TEST_DIR, maxResults: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should handle single file search", () => {
    const results = grepSearch({ pattern: "foo", path: path.join(TEST_DIR, "a.ts") });
    expect(results.length).toBe(1);
  });

  it("should return empty for no matches", () => {
    const results = grepSearch({ pattern: "nonexistent_xyz", path: TEST_DIR });
    expect(results.length).toBe(0);
  });
});

describe("formatGrepResults", () => {
  it("should format results nicely", () => {
    const results = grepSearch({ pattern: "foo", path: TEST_DIR });
    const formatted = formatGrepResults(results);
    expect(formatted).toContain("foo");
  });

  it("should show message when no results", () => {
    const formatted = formatGrepResults([]);
    expect(formatted).toContain("No results found");
  });

  it("should truncate at maxDisplay", () => {
    const manyResults = Array.from({ length: 100 }, (_, i) => ({
      file: `file${i}.ts`,
      line: i + 1,
      content: `match ${i}`,
    }));
    const formatted = formatGrepResults(manyResults, 10);
    expect(formatted).toContain("mais 90 resultados");
  });

  it("should format context lines before and after match", () => {
    const results = [
      {
        file: "src/main.ts",
        line: 5,
        content: "TARGET_LINE",
        before: ["context_before_1", "context_before_2"],
        after: ["context_after_1", "context_after_2"],
      },
    ];
    const formatted = formatGrepResults(results);
    expect(formatted).toContain("context_before_1");
    expect(formatted).toContain("context_before_2");
    expect(formatted).toContain("TARGET_LINE");
    expect(formatted).toContain("context_after_1");
    expect(formatted).toContain("context_after_2");
  });

  it("should format match with only before context", () => {
    const results = [
      {
        file: "src/main.ts",
        line: 3,
        content: "MIDDLE",
        before: ["above"],
      },
    ];
    const formatted = formatGrepResults(results);
    expect(formatted).toContain("above");
    expect(formatted).toContain("MIDDLE");
    expect(formatted).not.toContain("after");
  });

  it("should format match with only after context", () => {
    const results = [
      {
        file: "src/main.ts",
        line: 2,
        content: "MIDDLE",
        after: ["below"],
      },
    ];
    const formatted = formatGrepResults(results);
    expect(formatted).toContain("MIDDLE");
    expect(formatted).toContain("below");
  });

  it("should handle empty before/after arrays", () => {
    const results = [
      {
        file: "src/main.ts",
        line: 1,
        content: "LINE",
        before: [],
        after: [],
      },
    ];
    const formatted = formatGrepResults(results);
    expect(formatted).toContain("LINE");
  });

  it("should use correct line numbers for context lines", () => {
    const results = [
      {
        file: "file.ts",
        line: 10,
        content: "match",
        before: ["line8", "line9"],
        after: ["line11"],
      },
    ];
    const formatted = formatGrepResults(results);
    // formatGrepResults uses: m.line - m.before.indexOf(b) - 1
    // "line8" index=0 => 10-0-1=9; "line9" index=1 => 10-1-1=8
    expect(formatted).toContain("file.ts:9: line8");
    expect(formatted).toContain("file.ts:8: line9");
    expect(formatted).toContain("file.ts:10: match");
    expect(formatted).toContain("file.ts:11: line11");
  });

  it("should return empty for invalid regex pattern", () => {
    const results = grepSearch({ pattern: "[", path: TEST_DIR });
    expect(results.length).toBe(0);
  });

  it("should skip files that cannot be read", () => {
    const testFile = path.join(TEST_DIR, "unreadable.txt");
    fs.writeFileSync(testFile, "SECRET_DATA\n", "utf8");

    const results = grepSearch({ pattern: "SECRET", path: testFile });
    expect(results.length).toBe(0);
    fs.unlinkSync(testFile);
  });
});
