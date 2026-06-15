/**
 * syntaxHighlight.test.ts — Tests for syntax highlighting module.
 */

import { describe, it, expect } from "vitest";
import { highlightSyntax, detectLanguageFromExt } from "../syntaxHighlight.js";

describe("highlightSyntax", () => {
  it("should highlight TypeScript keywords", () => {
    const code = 'const x = "hello";';
    const highlighted = highlightSyntax(code, "typescript");
    expect(highlighted).toContain("\x1b[32m"); // green for strings
    expect(highlighted).toContain("\x1b[36m"); // cyan for keywords
  });

  it("should highlight Python keywords", () => {
    const code = "def hello():\n    return True";
    const highlighted = highlightSyntax(code, "python");
    expect(highlighted).toContain("def");
  });

  it("should highlight Rust keywords", () => {
    const code = "fn main() { let x = 42; }";
    const highlighted = highlightSyntax(code, "rust");
    expect(highlighted).toContain("fn");
  });

  it("should highlight Go keywords", () => {
    const code = 'func main() { fmt.Println("hello") }';
    const highlighted = highlightSyntax(code, "go");
    expect(highlighted).toContain("func");
  });

  it("should highlight Java keywords", () => {
    const code = "public class Main { }";
    const highlighted = highlightSyntax(code, "java");
    expect(highlighted).toContain("class");
  });

  it("should handle empty input", () => {
    const highlighted = highlightSyntax("", "typescript");
    expect(highlighted).toBe("");
  });

  it("should highlight numbers", () => {
    const code = "const x = 42;";
    const highlighted = highlightSyntax(code, "typescript");
    expect(highlighted).toContain("\x1b[33m"); // yellow for numbers
  });

  it("should highlight comments", () => {
    const code = "// this is a comment\nconst x = 1;";
    const highlighted = highlightSyntax(code, "typescript");
    expect(highlighted).toContain("\x1b[90m"); // gray for comments
  });

  it("should handle multi-line code", () => {
    const code = "function foo() {\n  return 42;\n}";
    const highlighted = highlightSyntax(code, "typescript");
    expect(highlighted.split("\n").length).toBe(3);
  });
});

describe("detectLanguageFromExt", () => {
  it("should detect TypeScript", () => {
    expect(detectLanguageFromExt(".ts")).toBe("typescript");
    expect(detectLanguageFromExt(".tsx")).toBe("typescript");
  });

  it("should detect Python", () => {
    expect(detectLanguageFromExt(".py")).toBe("python");
  });

  it("should detect Rust", () => {
    expect(detectLanguageFromExt(".rs")).toBe("rust");
  });

  it("should detect Go", () => {
    expect(detectLanguageFromExt(".go")).toBe("go");
  });

  it("should detect Java", () => {
    expect(detectLanguageFromExt(".java")).toBe("java");
  });

  it("should default to typescript for unknown", () => {
    expect(detectLanguageFromExt(".xyz")).toBe("typescript");
  });
});
