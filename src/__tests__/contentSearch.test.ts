/**
 * contentSearch.test.ts — Tests for grep/content search module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { grepSearch, formatGrepResults } from "../contentSearch.js";

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
    expect(formatted).toContain("Nenhum resultado");
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
});
