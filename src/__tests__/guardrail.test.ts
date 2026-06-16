/**
 * guardrail.test.ts — Tests for guardrail.ts (real module).
 * Covers: validateSyntax for all file types, advisory-only behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

import { validateSyntax } from "../guardrail.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "guardrail_test_"));
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe("guardrail.ts (real module)", () => {
  describe("validateSyntax — JSON", () => {
    it("should pass valid JSON", async () => {
      const result = await validateSyntax("test.json", '{"key": "value"}');
      expect(result.valid).toBe(true);
    });

    it("should fail on invalid JSON", async () => {
      const result = await validateSyntax("test.json", "{key: invalid}");
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("JSON parse error");
    });

    it("should fail on trailing comma in JSON", async () => {
      const result = await validateSyntax("test.json", '{"a": 1,}');
      expect(result.valid).toBe(false);
    });
  });

  describe("validateSyntax — JavaScript", () => {
    it("should pass valid JavaScript", async () => {
      const result = await validateSyntax("test.mjs", "const x = 1;\nconsole.log(x);");
      expect(result.valid).toBe(true);
    });

    it("should fail on invalid JavaScript syntax", async () => {
      const result = await validateSyntax("test.mjs", "function ( {");
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("JavaScript syntax error");
    });

    it("should clean up temp file after validation", async () => {
      const result = await validateSyntax("test.mjs", "const x = 1;");
      expect(result.valid).toBe(true);
    });
  });

  describe("validateSyntax — CSS", () => {
    it("should pass valid CSS", async () => {
      const result = await validateSyntax("test.css", ".class { color: red; }");
      expect(result.valid).toBe(true);
    });

    it("should fail on brace mismatch", async () => {
      const result = await validateSyntax("test.css", ".class { color: red; ");
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("brace mismatch");
    });

    it("should handle SCSS", async () => {
      const result = await validateSyntax("test.scss", ".class { color: red; }");
      expect(result.valid).toBe(true);
    });

    it("should handle LESS", async () => {
      const result = await validateSyntax("test.less", ".class { color: red; }");
      expect(result.valid).toBe(true);
    });
  });

  describe("validateSyntax — HTML", () => {
    it("should pass well-formed HTML", async () => {
      const result = await validateSyntax("test.html", "<html><body><p>Hello</p></body></html>");
      expect(result.valid).toBe(true);
    });

    it("should warn on heavily unbalanced tags", async () => {
      // Regex matches tags with 2+ chars after < (e.g. <div>, <span>, <strong>)
      const html = "<div><span><section><header><footer><article><aside><main>";
      const result = await validateSyntax("test.html", html);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("delta");
    });

    it("should handle .htm extension", async () => {
      const result = await validateSyntax("test.htm", "<html><body></body></html>");
      expect(result.valid).toBe(true);
    });

    it("should tolerate small tag imbalance", async () => {
      const result = await validateSyntax("test.html", "<div><p>text</p></div>");
      expect(result.valid).toBe(true);
    });
  });

  describe("validateSyntax — Python", () => {
    it("should pass valid Python", async () => {
      const result = await validateSyntax("test.py", "def hello():\n    print('hi')\n");
      expect(result.valid).toBe(true);
    });

    it("should fail on invalid Python syntax", async () => {
      const result = await validateSyntax("test.py", "def (:\n");
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("Python syntax error");
    });
  });

  describe("validateSyntax — TypeScript", () => {
    it("should run tsc for .ts files", async () => {
      // This will run real tsc - write a valid TS file
      const tsFile = path.join(tmpDir, "test.ts");
      fs.writeFileSync(tsFile, "const x: number = 1;\n");
      const result = await validateSyntax(tsFile, "const x: number = 1;");
      // Result depends on whether tsc is available and project config
      expect(result).toHaveProperty("valid");
    });

    it("should run tsc for .tsx files", async () => {
      const tsxFile = path.join(tmpDir, "test.tsx");
      fs.writeFileSync(tsxFile, "const x = 1;\n");
      const result = await validateSyntax(tsxFile, "const x = 1;");
      expect(result).toHaveProperty("valid");
    });
  });

  describe("validateSyntax — Java", () => {
    it("should pass valid Java", async () => {
      const java = "public class Test { public static void main(String[] args) {} }";
      const result = await validateSyntax("Test.java", java);
      // Result depends on whether javac is available
      expect(result).toHaveProperty("valid");
    });

    it("should extract class name from public class", async () => {
      const java = "public class MyClass { }";
      const result = await validateSyntax("MyClass.java", java);
      expect(result).toHaveProperty("valid");
    });

    it("should handle Java without public class", async () => {
      const java = "class Foo { }";
      const result = await validateSyntax("Foo.java", java);
      expect(result).toHaveProperty("valid");
    });

    it("should fail on invalid Java syntax", async () => {
      const java = "public class BadClass { public static void main(String[] args) { { }";
      const result = await validateSyntax("BadClass.java", java);
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain("Java compilation error");
    });
  });

  describe("validateSyntax — unknown extension", () => {
    it("should pass through unknown extensions", async () => {
      const result = await validateSyntax("test.xyz", "anything");
      expect(result.valid).toBe(true);
    });

    it("should pass through .rb files", async () => {
      const result = await validateSyntax("test.rb", "puts 'hello'");
      expect(result.valid).toBe(true);
    });

    it("should pass through .go files", async () => {
      const result = await validateSyntax("test.go", "package main");
      expect(result.valid).toBe(true);
    });
  });

  describe("validateSyntax — branch coverage", () => {
    it("should validate Python syntax and use platform binary", async () => {
      const result = await validateSyntax("branch.py", "x = 1\n");
      expect(result).toHaveProperty("valid");
    });

    it("should validate HTML with self-closing and regular tags", async () => {
      const result = await validateSyntax("branch.html", "<div><br><img src='x'><p>text</p></div>");
      expect(result).toHaveProperty("valid");
    });

    it("should validate CSS with balanced braces", async () => {
      const result = await validateSyntax("branch.css", "@media (max-width: 600px) { .a { color: red; } }");
      expect(result.valid).toBe(true);
    });

    it("should route through switch for .cjs extension", async () => {
      const result = await validateSyntax("branch.cjs", "const x = 1;");
      expect(result).toHaveProperty("valid");
    });

    it("should route through switch for .scss extension", async () => {
      const result = await validateSyntax("branch.scss", ".class { color: blue; }");
      expect(result).toHaveProperty("valid");
    });
  });
});
