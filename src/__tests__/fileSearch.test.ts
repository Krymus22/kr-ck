/**
 * fileSearch.test.ts — Tests for glob file search module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { globSearch, matchesGlob, findFilesByExtension, findFilesByName } from "../fileSearch.js";

const TEST_DIR = path.join(process.cwd(), "__test_globdir__");

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_DIR, "src"), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, "src", "utils"), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, "index.ts"), "export {};", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "src", "app.ts"), "export {};", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "src", "utils", "helper.ts"), "export {};", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "README.md"), "# Test", "utf8");
  fs.mkdirSync(path.join(TEST_DIR, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, "node_modules", "pkg", "index.js"), "module.exports={}", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("matchesGlob", () => {
  it("should match simple patterns", () => {
    expect(matchesGlob("index.ts", "*.ts")).toBe(true);
    expect(matchesGlob("index.js", "*.ts")).toBe(false);
  });

  it("should match ** patterns", () => {
    expect(matchesGlob("src/app.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/utils/helper.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("README.md", "**/*.ts")).toBe(false);
  });

  it("should match ? single char wildcard", () => {
    expect(matchesGlob("file1.ts", "file?.ts")).toBe(true);
    expect(matchesGlob("file12.ts", "file?.ts")).toBe(false);
  });

  it("should match {a,b} brace expansion", () => {
    expect(matchesGlob("app.ts", "*.{ts,js}")).toBe(true);
    expect(matchesGlob("app.js", "*.{ts,js}")).toBe(true);
    expect(matchesGlob("app.py", "*.{ts,js}")).toBe(false);
  });

  it("should handle nested ** patterns", () => {
    expect(matchesGlob("src/utils/helper.ts", "src/**/helper.ts")).toBe(true);
  });
});

describe("globSearch", () => {
  it("should find files by pattern", () => {
    const results = globSearch({ pattern: "**/*.ts", cwd: TEST_DIR });
    expect(results).toContain("index.ts");
    expect(results).toContain("src/app.ts");
    expect(results).toContain("src/utils/helper.ts");
    expect(results).not.toContain("README.md");
  });

  it("should ignore node_modules by default", () => {
    const results = globSearch({ pattern: "**/*.js", cwd: TEST_DIR });
    expect(results.some((r) => r.includes("node_modules"))).toBe(false);
  });

  it("should respect custom ignore list", () => {
    const results = globSearch({ pattern: "**/*.ts", cwd: TEST_DIR, ignore: ["src"] });
    expect(results).toContain("index.ts");
    expect(results).not.toContain("src/app.ts");
  });

  it("should return empty for no matches", () => {
    const results = globSearch({ pattern: "**/*.py", cwd: TEST_DIR });
    expect(results).toHaveLength(0);
  });
});

describe("findFilesByExtension", () => {
  it("should find files by extension", () => {
    const results = findFilesByExtension(".ts", TEST_DIR);
    expect(results.length).toBeGreaterThanOrEqual(3);
  });
});

describe("findFilesByName", () => {
  it("should find files by name", () => {
    const results = findFilesByName("helper.ts", TEST_DIR);
    expect(results.length).toBe(1);
  });
});
