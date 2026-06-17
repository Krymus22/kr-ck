/** patternExtractor.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

describe("patternExtractor", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("should return unknown patterns when no source files", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.filesAnalyzed).toBe(0);
    expect(patterns.namingConvention).toBe("unknown");
  });

  it("should detect camelCase naming", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "const myVariable = 1;\nfunction doSomething() {}\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.namingConvention).toBe("camelCase");
  });

  it("should detect snake_case naming", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "test.py"), "my_variable = 1\ndef do_something():\n    pass\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.namingConvention).toBe("snake_case");
  });

  it("should detect 2-space indentation", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "function foo() {\n  return 1;\n}\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.indentation).toBe("2-space");
  });

  it("should detect 4-space indentation", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "test.py"), "def foo():\n    return 1\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.indentation).toBe("4-space");
  });

  it("should detect // comment style", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "// comment\nconst x = 1;\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.commentStyle).toBe("//");
  });

  it("should detect -- comment style (Luau)", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "test.luau"), "-- comment\nlocal x = 1\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.commentStyle).toBe("--");
  });

  it("should detect try-catch error handling", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "try {\n  doStuff();\n} catch (e) {\n  console.error(e);\n}\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.errorHandling).toBe("try-catch");
  });

  it("should format patterns as string", async () => {
    const { extractPatterns, formatPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "const x = 1;\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    const formatted = formatPatterns(patterns);
    expect(formatted).toContain("Project Code Patterns");
    expect(formatted).toContain("Naming:");
    expect(formatted).toContain("Indentation:");
  });

  it("should cache results", async () => {
    const { getPatternsCached, clearPatternCache } = await import("./../patternExtractor.js");
    clearPatternCache();
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "const x = 1;\n", "utf8");
    const p1 = getPatternsCached(tmpDir);
    // Delete files - if cached, should still return same result
    fs.unlinkSync(path.join(tmpDir, "test.ts"));
    const p2 = getPatternsCached(tmpDir);
    expect(p2.filesAnalyzed).toBe(p1.filesAnalyzed);
  });

  it("should skip test files", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "foo.test.ts"), "const x = 1;\n", "utf8");
    const patterns = extractPatterns(tmpDir);
    expect(patterns.filesAnalyzed).toBe(0); // Should skip .test.ts
  });
});
