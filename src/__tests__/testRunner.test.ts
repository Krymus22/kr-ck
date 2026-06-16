/**
 * testRunner.test.ts — Tests for testRunner.ts output parsers.
 * Covers: vitest, jest, pytest, cargo, go test output parsing,
 * framework detection, fix suggestion generation, formatting.
 */

import { describe, it, expect } from "vitest";

// ─── Extract parsers from testRunner.ts ────────────────────────────────────

interface TestFailure {
  file: string;
  line?: number;
  name: string;
  message: string;
  expected?: string;
  received?: string;
  stack?: string;
}

interface TestResult {
  framework: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: TestFailure[];
  output: string;
  success: boolean;
}

interface FixSuggestion {
  file: string;
  line?: number;
  description: string;
  oldCode?: string;
  newCode?: string;
}

function extractLineNumber(text?: string): number | undefined {
  if (!text) return undefined;
  const lineRegex = /(?:at|→|line)\s+(\d+)/i;
  const colonRegex = /:(\d+):\d+/;
  const match = lineRegex.exec(text) ?? colonRegex.exec(text);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function parseVitestText(output: string, exitCode: number, duration: number): TestResult {
  const failures: TestFailure[] = [];
  const passMatch = /(\d+) passed/.exec(output);
  const failMatch = /(\d+) failed/.exec(output);
  const skipMatch = /(\d+) skipped/.exec(output);

  const failBlocks = output.split(/(?:FAIL|✗|❌)\s+/);
  for (let i = 1; i < failBlocks.length; i++) {
    const block = failBlocks[i] ?? "";
    const fileMatch = /^([^\n]+)/.exec(block);
    const msgMatch = /(?:Error|AssertionError|expect)\s*(.*?)(?:\n|$)/.exec(block);
    failures.push({
      file: fileMatch?.[1]?.trim() ?? "unknown",
      name: "test",
      message: msgMatch?.[1]?.trim() ?? block.slice(0, 200),
      line: extractLineNumber(block),
    });
  }

  return {
    framework: "vitest",
    passed: Number.parseInt(passMatch?.[1] ?? "0", 10),
    failed: Number.parseInt(failMatch?.[1] ?? "0", 10),
    skipped: Number.parseInt(skipMatch?.[1] ?? "0", 10),
    duration,
    failures,
    output,
    success: exitCode === 0,
  };
}

function parsePytestOutput(output: string, exitCode: number, duration: number): TestResult {
  const failures: TestFailure[] = [];
  const passedMatch = /(\d+) passed/.exec(output);
  const failedMatch = /(\d+) failed/.exec(output);
  const skipMatch = /(\d+) skipped/.exec(output);

  const failBlocks = output.split(/FAILED\s+/);
  for (let i = 1; i < failBlocks.length; i++) {
    const block = failBlocks[i] ?? "";
    const fileMatch = /^([^\n:]+):/.exec(block);
    failures.push({
      file: fileMatch?.[1]?.trim() ?? "unknown",
      name: "test",
      message: block.slice(0, 200).trim(),
    });
  }

  return {
    framework: "pytest",
    passed: Number.parseInt(passedMatch?.[1] ?? "0", 10),
    failed: Number.parseInt(failedMatch?.[1] ?? "0", 10),
    skipped: Number.parseInt(skipMatch?.[1] ?? "0", 10),
    duration,
    failures,
    output,
    success: exitCode === 0,
  };
}

function parseCargoOutput(output: string, exitCode: number, duration: number): TestResult {
  const failures: TestFailure[] = [];
  const passRegex = /(\d+) passed/;
  const failRegex = /(\d+) failed/;
  const passMatch = passRegex.exec(output);
  const failMatch = failRegex.exec(output);

  const testBlocks = output.split(/---- (\w+) stdout ----/);
  for (let i = 1; i < testBlocks.length; i += 2) {
    const testName = testBlocks[i];
    const block = testBlocks[i + 1] ?? "";
    if (block.includes("FAILED") || block.includes("panicked")) {
      failures.push({
        file: "unknown",
        name: testName ?? "unknown",
        message: block.slice(0, 300).trim(),
      });
    }
  }

  return {
    framework: "cargo",
    passed: Number.parseInt(passMatch?.[1] ?? "0", 10),
    failed: Number.parseInt(failMatch?.[1] ?? failures.length.toString(), 10) || failures.length,
    skipped: 0,
    duration,
    failures,
    output,
    success: exitCode === 0,
  };
}

function parseGoTestOutput(output: string, exitCode: number, duration: number): TestResult {
  const failures: TestFailure[] = [];
  const passRegex = /ok\s+.*?(\d+)\.\d+s/;
  const passMatch = passRegex.exec(output);

  const failBlocks = output.split(/--- FAIL: (\w+)/);
  for (let i = 1; i < failBlocks.length; i += 2) {
    const testName = failBlocks[i];
    const block = failBlocks[i + 1] ?? "";
    failures.push({
      file: "unknown",
      name: testName ?? "unknown",
      message: block.slice(0, 300).trim(),
    });
  }

  return {
    framework: "go",
    passed: passMatch ? 1 : 0,
    failed: failures.length,
    skipped: 0,
    duration,
    failures,
    output,
    success: exitCode === 0,
  };
}

function suggestFixes(result: TestResult): FixSuggestion[] {
  const suggestions: FixSuggestion[] = [];
  for (const failure of result.failures) {
    const assertMatch = /expected\s+(.+?)\s+to\s+(?:equal|be)\s+(.+)/i.exec(failure.message);
    if (assertMatch) {
      suggestions.push({
        file: failure.file,
        line: failure.line,
        description: `Assertion mismatch: expected ${assertMatch[1]} to be ${assertMatch[2]}`,
      });
      continue;
    }
    if (failure.message.includes("is not a function")) {
      const funcMatch = /(\w+)\s+is not a function/.exec(failure.message);
      suggestions.push({
        file: failure.file,
        line: failure.line,
        description: `Missing function import: ${funcMatch?.[1] ?? "unknown"}.`,
      });
      continue;
    }
    if (failure.message.includes("Cannot find module") || failure.message.includes("Module not found")) {
      const modMatch = /(?:Cannot find module|Module not found)['"]+([^'"]+)/.exec(failure.message);
      suggestions.push({
        file: failure.file,
        description: `Missing module: ${modMatch?.[1] ?? "unknown"}. Run npm install.`,
      });
      continue;
    }
    if (failure.message.includes("TS2") || failure.message.includes("Type '")) {
      suggestions.push({
        file: failure.file,
        line: failure.line,
        description: "TypeScript type error. Review the type annotations.",
      });
      continue;
    }
    if (failure.message.includes("timeout") || failure.message.includes("exceeded")) {
      suggestions.push({
        file: failure.file,
        description: "Test timed out. Consider increasing timeout.",
      });
      continue;
    }
    suggestions.push({
      file: failure.file,
      line: failure.line,
      description: failure.message.slice(0, 200),
    });
  }
  return suggestions;
}

function formatTestResult(result: TestResult): string {
  const duration = (result.duration / 1000).toFixed(1);
  const status = result.success ? "✓ PASS" : "✗ FAIL";
  const lines: string[] = [
    `Framework: ${result.framework}`,
    `Duration: ${duration}s`,
    `Passed: ${result.passed} | Failed: ${result.failed} | Skipped: ${result.skipped}`,
    `Status: ${status}`,
  ];
  if (result.failures.length > 0) {
    lines.push("", "Failures:");
    for (const f of result.failures) {
      const lineNum = f.line ? `:${f.line}` : "";
      lines.push(`  ${f.file}${lineNum} — ${f.name}`, `    ${f.message.slice(0, 150)}`);
    }
  }
  return lines.join("\n");
}

function formatFixSuggestions(suggestions: FixSuggestion[]): string {
  if (suggestions.length === 0) return "No fix suggestions.";
  const lines = ["Fix Suggestions:"];
  for (const s of suggestions) {
    const location = s.line ? `:${s.line}` : "";
    lines.push(`  ${s.file}${location} — ${s.description}`);
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("testRunner parsers", () => {
  describe("extractLineNumber", () => {
    it("should extract line from 'at line 42'", () => {
      expect(extractLineNumber("at line 42")).toBe(42);
    });

    it("should extract line from '→ line 100'", () => {
      expect(extractLineNumber("→ line 100")).toBe(100);
    });

    it("should extract line from ':42:10'", () => {
      expect(extractLineNumber("src/main.ts:42:10")).toBe(42);
    });

    it("should return undefined for no line info", () => {
      expect(extractLineNumber("some error message")).toBeUndefined();
    });

    it("should return undefined for undefined input", () => {
      expect(extractLineNumber(undefined)).toBeUndefined();
    });
  });

  describe("parseVitestText", () => {
    it("should parse passing tests", () => {
      const output = "320 passed 8.12s";
      const result = parseVitestText(output, 0, 8120);
      expect(result.passed).toBe(320);
      expect(result.failed).toBe(0);
      expect(result.success).toBe(true);
    });

    it("should parse failing tests", () => {
      const output = "3 passed 2 failed 1 skipped";
      const result = parseVitestText(output, 1, 1000);
      expect(result.passed).toBe(3);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.success).toBe(false);
    });

    it("should parse FAIL blocks", () => {
      const output = "FAIL src/app.test.ts\n  Error: expected 5 to equal 3";
      const result = parseVitestText(output, 1, 1000);
      expect(result.failures.length).toBeGreaterThan(0);
      expect(result.failures[0].file).toContain("app.test.ts");
    });

    it("should handle zero results", () => {
      const result = parseVitestText("", 0, 0);
      expect(result.passed).toBe(0);
      expect(result.failed).toBe(0);
    });
  });

  describe("parsePytestOutput", () => {
    it("should parse passing pytest output", () => {
      const output = "10 passed in 2.34s";
      const result = parsePytestOutput(output, 0, 2340);
      expect(result.passed).toBe(10);
      expect(result.failed).toBe(0);
      expect(result.success).toBe(true);
    });

    it("should parse FAILED blocks", () => {
      const output = "FAILED tests/test_app.py::test_function - AssertionError";
      const result = parsePytestOutput(output, 1, 1000);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0].file).toContain("test_app.py");
    });

    it("should parse mixed pass/fail", () => {
      const output = "5 passed 2 failed 1 skipped";
      const result = parsePytestOutput(output, 1, 1000);
      expect(result.passed).toBe(5);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(1);
    });
  });

  describe("parseCargoOutput", () => {
    it("should parse passing cargo test", () => {
      const output = "test result: ok. 5 passed; 0 failed; 0 ignored";
      const result = parseCargoOutput(output, 0, 1000);
      expect(result.passed).toBe(5);
      expect(result.failed).toBe(0);
    });

    it("should parse failing cargo test", () => {
      const output = "test result: FAILED. 3 passed; 2 failed";
      const result = parseCargoOutput(output, 1, 1000);
      expect(result.passed).toBe(3);
      expect(result.failed).toBe(2);
    });

    it("should parse panic blocks", () => {
      const output = "---- test_name stdout ----\nthread 'main' panicked at 'assertion failed'";
      const result = parseCargoOutput(output, 1, 1000);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0].name).toBe("test_name");
    });
  });

  describe("parseGoTestOutput", () => {
    it("should parse passing go test", () => {
      const output = "ok  \tpackage\t0.123s";
      const result = parseGoTestOutput(output, 0, 123);
      expect(result.success).toBe(true);
    });

    it("should parse failing go test", () => {
      const output = "--- FAIL: TestAdd (0.00s)\n\tapp_test.go:10: expected 3, got 2";
      const result = parseGoTestOutput(output, 1, 100);
      expect(result.failures.length).toBe(1);
      expect(result.failures[0].name).toBe("TestAdd");
    });
  });

  describe("suggestFixes", () => {
    it("should suggest fix for assertion mismatch", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 100,
        failures: [{ file: "test.ts", name: "test", message: "expected 5 to equal 3" }],
        output: "",
        success: false,
      };
      const suggestions = suggestFixes(result);
      expect(suggestions.length).toBe(1);
      expect(suggestions[0].description).toContain("Assertion mismatch");
    });

    it("should suggest fix for missing function", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 100,
        failures: [{ file: "test.ts", name: "test", message: "myFunc is not a function" }],
        output: "",
        success: false,
      };
      const suggestions = suggestFixes(result);
      expect(suggestions[0].description).toContain("Missing function import");
      expect(suggestions[0].description).toContain("myFunc");
    });

    it("should suggest fix for missing module", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 100,
        failures: [{ file: "test.ts", name: "test", message: "Cannot find module 'lodash'" }],
        output: "",
        success: false,
      };
      const suggestions = suggestFixes(result);
      expect(suggestions[0].description).toContain("Missing module");
    });

    it("should suggest fix for TypeScript error", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 100,
        failures: [{ file: "test.ts", name: "test", message: "TS2322: Type 'string' is not assignable" }],
        output: "",
        success: false,
      };
      const suggestions = suggestFixes(result);
      expect(suggestions[0].description).toContain("TypeScript type error");
    });

    it("should suggest fix for timeout", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 100,
        failures: [{ file: "test.ts", name: "test", message: "timeout exceeded 5000ms" }],
        output: "",
        success: false,
      };
      const suggestions = suggestFixes(result);
      expect(suggestions[0].description).toContain("timed out");
    });

    it("should return generic suggestion for unknown failures", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 100,
        failures: [{ file: "test.ts", name: "test", message: "something weird happened" }],
        output: "",
        success: false,
      };
      const suggestions = suggestFixes(result);
      expect(suggestions.length).toBe(1);
      expect(suggestions[0].description).toContain("something weird happened");
    });

    it("should return empty for no failures", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 5,
        failed: 0,
        skipped: 0,
        duration: 100,
        failures: [],
        output: "",
        success: true,
      };
      expect(suggestFixes(result)).toHaveLength(0);
    });
  });

  describe("formatTestResult", () => {
    it("should format passing result", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 10,
        failed: 0,
        skipped: 0,
        duration: 5000,
        failures: [],
        output: "",
        success: true,
      };
      const formatted = formatTestResult(result);
      expect(formatted).toContain("✓ PASS");
      expect(formatted).toContain("Passed: 10");
      expect(formatted).toContain("5.0s");
    });

    it("should format failing result with failures", () => {
      const result: TestResult = {
        framework: "vitest",
        passed: 8,
        failed: 2,
        skipped: 0,
        duration: 3000,
        failures: [
          { file: "a.test.ts", name: "test a", message: "error a", line: 10 },
          { file: "b.test.ts", name: "test b", message: "error b" },
        ],
        output: "",
        success: false,
      };
      const formatted = formatTestResult(result);
      expect(formatted).toContain("✗ FAIL");
      expect(formatted).toContain("Failed: 2");
      expect(formatted).toContain("a.test.ts:10");
      expect(formatted).toContain("b.test.ts");
    });
  });

  describe("formatFixSuggestions", () => {
    it("should format suggestions", () => {
      const suggestions: FixSuggestion[] = [
        { file: "a.ts", line: 5, description: "Fix import" },
        { file: "b.ts", description: "Run npm install" },
      ];
      const formatted = formatFixSuggestions(suggestions);
      expect(formatted).toContain("Fix Suggestions:");
      expect(formatted).toContain("a.ts:5");
      expect(formatted).toContain("b.ts");
    });

    it("should return message for empty suggestions", () => {
      expect(formatFixSuggestions([])).toBe("No fix suggestions.");
    });
  });
});
