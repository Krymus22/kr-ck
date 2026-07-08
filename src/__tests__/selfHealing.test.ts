/**
 * selfHealing.test.ts - Tests for structured compiler feedback.
 */
import { describe, it, expect } from "vitest";

vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
import { vi } from "vitest";

describe("selfHealing", () => {
  describe("parseErrors - tsc", () => {
    it("should parse TypeScript compiler errors", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      const output = `src/apiClient.ts(42,10): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
      const errors = parseErrors(output, "tsc");
      expect(errors.length).toBe(1);
      expect(errors[0]!.file).toBe("src/apiClient.ts");
      expect(errors[0]!.line).toBe(42);
      expect(errors[0]!.column).toBe(10);
      expect(errors[0]!.code).toBe("TS2345");
      expect(errors[0]!.severity).toBe("error");
      expect(errors[0]!.message).toContain("not assignable");
    });

    it("should extract expected/got from type mismatch errors", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      const output = `file.ts(1,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
      const errors = parseErrors(output, "tsc");
      expect(errors[0]!.expected).toBe("string");
      expect(errors[0]!.got).toBe("number");
    });

    it("should parse multiple errors", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      const output = `a.ts(1,1): error TS1: msg1\nb.ts(2,3): warning TS2: msg2`;
      const errors = parseErrors(output, "tsc");
      expect(errors.length).toBe(2);
      expect(errors[0]!.severity).toBe("error");
      expect(errors[1]!.severity).toBe("warning");
    });
  });

  describe("parseErrors - selene", () => {
    it("should parse selene errors", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      const output = `file.luau:42:1: warning: undefined_global\nfile.luau:10:5: error: mismatched_end`;
      const errors = parseErrors(output, "selene");
      expect(errors.length).toBe(2);
      expect(errors[0]!.file).toBe("file.luau");
      expect(errors[0]!.line).toBe(42);
      expect(errors[0]!.severity).toBe("warning");
    });
  });

  describe("parseErrors - auto-detect", () => {
    it("should auto-detect tsc format", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      const errors = parseErrors(`f.ts(1,1): error TS1000: msg`);
      expect(errors.length).toBe(1);
      expect(errors[0]!.code).toBe("TS1000");
    });

    it("should auto-detect selene format", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      const errors = parseErrors(`f.luau:1:1: error: undefined_global`);
      expect(errors.length).toBe(1);
    });

    it("should return empty for empty output", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      expect(parseErrors("")).toEqual([]);
      expect(parseErrors("  ")).toEqual([]);
    });

    // ─── Kills L150 || → && crash-on-undefined mutation ─────────────────────
    //
    // Mutation: changing `||` to `&&` on L150 of selfHealing.ts:
    //   `if (!output || output.trim().length === 0) return [];`
    //   → `if (!output && output.trim().length === 0) return [];`
    //
    // When `output` is undefined/null, the original `||` short-circuits on
    // `!output === true` and returns `[]` without evaluating `.trim()`. The
    // mutated `&&` evaluates the right side `output.trim()` on undefined →
    // TypeError: Cannot read properties of undefined.
    //
    // The existing "should return empty for empty output" test only passes
    // empty/whitespace strings, where both `||` and `&&` behave identically
    // (both reach the `return []`). These tests pass `undefined`/`null` (cast
    // to any to bypass the string type) to force the short-circuit path.

    it("should return [] for undefined output (short-circuit, no crash)", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      expect(parseErrors(undefined as unknown as string)).toEqual([]);
    });

    it("should return [] for null output (short-circuit, no crash)", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      expect(parseErrors(null as unknown as string)).toEqual([]);
    });
  });

  describe("parseErrors - generic", () => {
    it("should parse generic errors with file:line", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      const output = `Error: something went wrong in src/main.ts:42`;
      const errors = parseErrors(output, "generic");
      expect(errors.length).toBe(1);
      expect(errors[0]!.file).toContain("main.ts");
      expect(errors[0]!.line).toBe(42);
    });

    it("should parse errors without file:line", async () => {
      const { parseErrors } = await import("./../selfHealing.js");
      const errors = parseErrors("Error: compilation failed", "generic");
      expect(errors.length).toBe(1);
      expect(errors[0]!.file).toBe("unknown");
    });
  });

  describe("formatStructuredErrors", () => {
    it("should format errors with location, code, and message", async () => {
      const { formatStructuredErrors } = await import("./../selfHealing.js");
      const errors = [
        { file: "src/test.ts", line: 42, column: 10, code: "TS2345", severity: "error" as const, message: "Type mismatch" },
      ];
      const result = formatStructuredErrors(errors);
      expect(result).toContain("STRUCTURED ERRORS");
      expect(result).toContain("src/test.ts:42:10");
      expect(result).toContain("TS2345");
      expect(result).toContain("Type mismatch");
    });

    it("should include expected/got when available", async () => {
      const { formatStructuredErrors } = await import("./../selfHealing.js");
      const errors = [
        { file: "f.ts", line: 1, severity: "error" as const, message: "mismatch", expected: "number", got: "string" },
      ];
      const result = formatStructuredErrors(errors);
      expect(result).toContain("Expected: number");
      expect(result).toContain("Got: string");
    });

    it("should return empty string for no errors", async () => {
      const { formatStructuredErrors } = await import("./../selfHealing.js");
      expect(formatStructuredErrors([])).toBe("");
    });
  });

  describe("getErrorSummary", () => {
    it("should count errors and warnings", async () => {
      const { getErrorSummary } = await import("./../selfHealing.js");
      const errors = [
        { file: "a", line: 1, severity: "error" as const, message: "" },
        { file: "b", line: 2, severity: "error" as const, message: "" },
        { file: "c", line: 3, severity: "warning" as const, message: "" },
      ];
      expect(getErrorSummary(errors)).toBe("2 error(s), 1 warning(s)");
    });

    it("should handle empty array", async () => {
      const { getErrorSummary } = await import("./../selfHealing.js");
      expect(getErrorSummary([])).toBe("0 error(s), 0 warning(s)");
    });
  });
});
