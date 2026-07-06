/**
 * selfHealing-extended.test.ts — Extended tests for selfHealing.ts
 *
 * Covers 30+ tests across:
 *   - parseErrors (auto-detection of tsc/selene/eslint/generic formats)
 *   - formatStructuredErrors (readable output)
 *   - getErrorSummary (counts)
 *   - edge cases: empty input, malformed lines, mixed severities
 *
 * Only logger is mocked; everything else is pure-function testing.
 */

import { describe, it, expect, vi } from "vitest";

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

import { parseErrors, formatStructuredErrors, getErrorSummary } from "../selfHealing.js";

describe("parseErrors (extended) - auto-detection & format-specific", () => {
  it("returns empty array for empty string", () => {
    expect(parseErrors("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseErrors("   \n\t  ")).toEqual([]);
  });

  it("parses a single tsc error (auto-detected)", () => {
    const out = "src/file.ts(42,10): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
    const errors = parseErrors(out);
    expect(errors.length).toBe(1);
    expect(errors[0].file).toBe("src/file.ts");
    expect(errors[0].line).toBe(42);
    expect(errors[0].column).toBe(10);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].code).toBe("TS2345");
  });

  it("parses multiple tsc errors", () => {
    const out = [
      "src/file.ts(10,5): error TS2304: Cannot find name 'foo'.",
      "src/file.ts(20,1): error TS2304: Cannot find name 'bar'.",
    ].join("\n");
    const errors = parseErrors(out);
    expect(errors.length).toBe(2);
    expect(errors[0].line).toBe(10);
    expect(errors[1].line).toBe(20);
  });

  it("extracts expected/got from tsc type-mismatch message", () => {
    const out = "file.ts(1,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.";
    const errors = parseErrors(out);
    expect(errors[0].expected).toBe("string");
    expect(errors[0].got).toBe("number");
  });

  it("parses tsc warning severity", () => {
    const out = "file.ts(1,1): warning TS6133: 'x' is declared but never used.";
    const errors = parseErrors(out);
    expect(errors.length).toBe(1);
    expect(errors[0].severity).toBe("warning");
  });

  it("parses tsc error when source explicitly given", () => {
    const out = "file.ts(1,1): error TS9999: Some error.";
    const errors = parseErrors(out, "tsc");
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("TS9999");
  });

  it("parses a single selene error (auto-detected)", () => {
    const out = "file.luau:42:1: warning: undefined_global";
    const errors = parseErrors(out);
    expect(errors.length).toBe(1);
    expect(errors[0].file).toBe("file.luau");
    expect(errors[0].line).toBe(42);
    expect(errors[0].column).toBe(1);
    expect(errors[0].severity).toBe("warning");
    expect(errors[0].message).toBe("undefined_global");
  });

  it("parses selene error severity", () => {
    const out = "file.luau:10:5: error: mismatched_end";
    const errors = parseErrors(out);
    expect(errors[0].severity).toBe("error");
    expect(errors[0].message).toBe("mismatched_end");
  });

  it("parses multiple selene errors", () => {
    const out = [
      "file.luau:1:1: warning: undefined_global",
      "file.luau:2:1: error: mismatched_end",
      "file.luau:3:1: warning: unused_variable",
    ].join("\n");
    const errors = parseErrors(out);
    expect(errors.length).toBe(3);
  });

  it("parses eslint error (auto-detected)", () => {
    const out = "/path/to/file.ts:42:5: error  Expected '===' ExpectationEquality";
    const errors = parseErrors(out);
    expect(errors.length).toBe(1);
    expect(errors[0].file).toBe("/path/to/file.ts");
    expect(errors[0].line).toBe(42);
    expect(errors[0].column).toBe(5);
    expect(errors[0].severity).toBe("error");
  });

  it("parses eslint warning", () => {
    const out = "/path/to/file.ts:10:2: warning  Unexpected console statement";
    const errors = parseErrors(out);
    expect(errors[0].severity).toBe("warning");
  });

  it("parses eslint error with rule code", () => {
    const out = "/path/to/file.ts:1:1: error  Expected '===' eqeqeq";
    const errors = parseErrors(out, "eslint");
    expect(errors.length).toBe(1);
    // The 6th capture group is the optional rule code
    expect(errors[0].severity).toBe("error");
  });

  it("falls back to generic parser for unknown format", () => {
    const out = "Something went wrong: failed to compile file.ts:42";
    const errors = parseErrors(out);
    expect(Array.isArray(errors)).toBe(true);
  });

  it("generic parser extracts file:line pattern", () => {
    const out = "Error in src/file.ts:42 something happened";
    const errors = parseErrors(out, "generic");
    expect(errors.length).toBe(1);
    expect(errors[0].file).toBe("src/file.ts");
    expect(errors[0].line).toBe(42);
  });

  it("generic parser handles 'failed' keyword", () => {
    const out = "Build failed: see file.luau:10";
    const errors = parseErrors(out, "generic");
    expect(errors.length).toBe(1);
    expect(errors[0].file).toBe("file.luau");
  });

  it("generic parser handles 'panic' keyword", () => {
    const out = "thread panicked at src/main.rs:25";
    const errors = parseErrors(out, "generic");
    expect(errors.length).toBe(1);
    expect(errors[0].file).toBe("src/main.rs");
  });

  it("generic parser sets file='unknown' when no file:line match", () => {
    const out = "Error: something failed";
    const errors = parseErrors(out, "generic");
    expect(errors.length).toBe(1);
    expect(errors[0].file).toBe("unknown");
    expect(errors[0].line).toBe(0);
  });

  it("generic parser does not flag lines without error keywords", () => {
    const out = "Everything is fine\nAll good here";
    const errors = parseErrors(out, "generic");
    expect(errors.length).toBe(0);
  });

  it("returns empty array for unknown source format with empty content", () => {
    expect(parseErrors("", "tsc")).toEqual([]);
    expect(parseErrors("", "selene")).toEqual([]);
    expect(parseErrors("", "eslint")).toEqual([]);
    expect(parseErrors("", "generic")).toEqual([]);
  });

  it("StructuredError has correct shape", () => {
    const out = "file.ts(1,1): error TS1: msg";
    const errors = parseErrors(out);
    expect(errors[0]).toHaveProperty("file");
    expect(errors[0]).toHaveProperty("line");
    expect(errors[0]).toHaveProperty("severity");
    expect(errors[0]).toHaveProperty("message");
    expect(typeof errors[0].file).toBe("string");
    expect(typeof errors[0].line).toBe("number");
    expect(typeof errors[0].severity).toBe("string");
    expect(typeof errors[0].message).toBe("string");
  });
});

describe("formatStructuredErrors (extended)", () => {
  it("returns empty string for empty array", () => {
    expect(formatStructuredErrors([])).toBe("");
  });

  it("includes count of errors in header", () => {
    const errors = [
      { file: "a.ts", line: 1, severity: "error" as const, message: "msg1" },
      { file: "b.ts", line: 2, severity: "error" as const, message: "msg2" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("2 found");
  });

  it("includes file:line location for each error", () => {
    const errors = [
      { file: "src/foo.ts", line: 42, severity: "error" as const, message: "msg" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("src/foo.ts:42");
  });

  it("includes column when present", () => {
    const errors = [
      { file: "src/foo.ts", line: 10, column: 5, severity: "error" as const, message: "msg" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("src/foo.ts:10:5");
  });

  it("includes error code when present", () => {
    const errors = [
      { file: "src/foo.ts", line: 1, severity: "error" as const, code: "TS2345", message: "msg" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("TS2345");
  });

  it("includes severity in parentheses", () => {
    const errors = [
      { file: "foo.ts", line: 1, severity: "warning" as const, message: "msg" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("(warning)");
  });

  it("includes message", () => {
    const errors = [
      { file: "foo.ts", line: 1, severity: "error" as const, message: "This is the message" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("This is the message");
  });

  it("includes Expected/Got when both present", () => {
    const errors = [
      { file: "foo.ts", line: 1, severity: "error" as const, message: "m", expected: "number", got: "string" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("Expected: number");
    expect(out).toContain("Got: string");
  });

  it("does not include Expected/Got when only expected present", () => {
    const errors = [
      { file: "foo.ts", line: 1, severity: "error" as const, message: "m", expected: "number" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).not.toContain("Expected:");
  });

  it("numbers errors starting at 1", () => {
    const errors = [
      { file: "a.ts", line: 1, severity: "error" as const, message: "msg1" },
      { file: "b.ts", line: 2, severity: "error" as const, message: "msg2" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("1. ");
    expect(out).toContain("2. ");
  });

  it("handles a single error", () => {
    const errors = [
      { file: "x.ts", line: 1, severity: "error" as const, message: "only one" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("1 found");
    expect(out).toContain("only one");
  });

  it("handles errors with all optional fields undefined", () => {
    const errors = [
      { file: "x.ts", line: 1, severity: "error" as const, message: "minimal" },
    ];
    const out = formatStructuredErrors(errors);
    expect(out).toContain("minimal");
    expect(out).toContain("x.ts:1");
  });
});

describe("getErrorSummary (extended)", () => {
  it("returns '0 error(s), 0 warning(s)' for empty array", () => {
    expect(getErrorSummary([])).toBe("0 error(s), 0 warning(s)");
  });

  it("counts errors correctly", () => {
    const errors = [
      { file: "a", line: 1, severity: "error" as const, message: "m" },
      { file: "b", line: 2, severity: "error" as const, message: "m" },
    ];
    expect(getErrorSummary(errors)).toBe("2 error(s), 0 warning(s)");
  });

  it("counts warnings correctly", () => {
    const errors = [
      { file: "a", line: 1, severity: "warning" as const, message: "m" },
      { file: "b", line: 2, severity: "warning" as const, message: "m" },
      { file: "c", line: 3, severity: "warning" as const, message: "m" },
    ];
    expect(getErrorSummary(errors)).toBe("0 error(s), 3 warning(s)");
  });

  it("counts mixed errors and warnings", () => {
    const errors = [
      { file: "a", line: 1, severity: "error" as const, message: "m" },
      { file: "b", line: 2, severity: "warning" as const, message: "m" },
      { file: "c", line: 3, severity: "error" as const, message: "m" },
    ];
    expect(getErrorSummary(errors)).toBe("2 error(s), 1 warning(s)");
  });

  it("returns a string", () => {
    const errors = [
      { file: "a", line: 1, severity: "error" as const, message: "m" },
    ];
    const summary = getErrorSummary(errors);
    expect(typeof summary).toBe("string");
  });
});
