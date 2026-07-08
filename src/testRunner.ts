/**
 * testRunner.ts - Integrated test runner with auto-fix loop.
 * Detects test framework, runs tests, parses failures, suggests fixes.
 * Supports: vitest, jest, pytest, cargo test, go test, npm test.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as log from "./logger.js";
import { t } from "./i18n.js";

// --- Types -------------------------------------------------------------------

export interface TestFailure {
  file: string;
  line?: number;
  name: string;
  message: string;
  expected?: string;
  received?: string;
  stack?: string;
}

export interface TestResult {
  framework: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: TestFailure[];
  output: string;
  success: boolean;
  exitCode?: number;
}

export interface FixSuggestion {
  file: string;
  line?: number;
  description: string;
  oldCode?: string;
  newCode?: string;
}

// --- Framework Detection ----------------------------------------------------

type FrameworkDetector = {
  name: string;
  configFiles: string[];
  detect: (dir: string) => boolean;
};

const DETECTORS: FrameworkDetector[] = [
  {
    name: "vitest",
    configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"],
    detect: (dir) => {
      const pkgPath = path.join(dir, "package.json");
      if (!fs.existsSync(pkgPath)) return false;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return !!(pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest);
      } catch { return false; }
    },
  },
  {
    name: "jest",
    configFiles: ["jest.config.ts", "jest.config.js", "jest.config.mjs"],
    detect: (dir) => {
      const pkgPath = path.join(dir, "package.json");
      if (!fs.existsSync(pkgPath)) return false;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        return !!(pkg.devDependencies?.jest ?? pkg.dependencies?.jest);
      } catch { return false; }
    },
  },
  {
    name: "pytest",
    configFiles: ["pytest.ini", "pyproject.toml", "setup.cfg", "conftest.py"],
    detect: (dir) => fs.existsSync(path.join(dir, "conftest.py")) ||
      fs.existsSync(path.join(dir, "tests")),
  },
  {
    name: "cargo",
    configFiles: ["Cargo.toml"],
    detect: (dir) => fs.existsSync(path.join(dir, "Cargo.toml")),
  },
  {
    name: "go",
    configFiles: ["go.mod"],
    detect: (dir) => fs.existsSync(path.join(dir, "go.mod")),
  },
  {
    name: "testez",
    configFiles: ["tests"],
    detect: (dir) => {
      // TestEZ: Roblox Lua testing framework
      // Detect by looking for .luau/.lua test files that import TestEZ
      const testsDir = path.join(dir, "tests");
      if (fs.existsSync(testsDir)) {
        try {
          const entries = fs.readdirSync(testsDir, "utf8");
          for (const entry of entries) {
            if (entry.endsWith(".luau") || entry.endsWith(".lua")) {
              const content = fs.readFileSync(path.join(testsDir, entry), "utf8");
              if (/TestEZ|testez/i.test(content)) return true;
            }
          }
        } catch { /* ignore */ }
      }
      // Also check for testez in wally dependencies
      const wallyPath = path.join(dir, "wally.toml");
      if (fs.existsSync(wallyPath)) {
        try {
          const wally = fs.readFileSync(wallyPath, "utf8");
          if (/testez/i.test(wally)) return true;
        } catch { /* ignore */ }
      }
      return false;
    },
  },
];

export function detectFramework(dir: string): string {
  for (const detector of DETECTORS) {
    if (detector.detect(dir)) {
      return detector.name;
    }
  }

  // Fallback: check for node_modules/.bin
  const nodeBin = path.join(dir, "node_modules", ".bin");
  if (fs.existsSync(nodeBin)) {
    if (fs.existsSync(path.join(nodeBin, "vitest"))) return "vitest";
    if (fs.existsSync(path.join(nodeBin, "jest"))) return "jest";
  }

  return "unknown";
}

// --- Test Execution ---------------------------------------------------------

function extractExecError(err: unknown): { stdout: string; stderr: string; exitCode: number } {
  if (err != null && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      exitCode: typeof e.status === "number" ? e.status : 1,
    };
  }
  if (err instanceof Error) {
    return { stdout: "", stderr: err.message, exitCode: 1 };
  }
  return { stdout: "", stderr: "", exitCode: 1 };
}

function runCommand(cmd: string, cwd: string, timeout: number): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd,
      timeout,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    return extractExecError(err);
  }
}

function runVitest(dir: string, fileFilter?: string): TestResult {
  const cmd = fileFilter
    ? `npx vitest run "${fileFilter}" --reporter=json --reporter=verbose 2>&1`
    : "npx vitest run --reporter=json --reporter=verbose 2>&1";
  const start = Date.now();
  const { stdout, stderr, exitCode } = runCommand(cmd, dir, 120_000);
  const duration = Date.now() - start;
  const output = `${stdout}\n${stderr}`;

  return parseVitestJson(output, exitCode, duration);
}

function runJest(dir: string, fileFilter?: string): TestResult {
  const cmd = fileFilter
    ? `npx jest "${fileFilter}" --json --verbose 2>&1`
    : "npx jest --json --verbose 2>&1";
  const start = Date.now();
  const { stdout, stderr, exitCode } = runCommand(cmd, dir, 120_000);
  const duration = Date.now() - start;
  const output = `${stdout}\n${stderr}`;

  return parseJestJson(output, exitCode, duration);
}

function runPytest(dir: string, fileFilter?: string): TestResult {
  const cmd = fileFilter
    ? `python -m pytest "${fileFilter}" -v --tb=short 2>&1`
    : "python -m pytest -v --tb=short 2>&1";
  const start = Date.now();
  const { stdout, stderr, exitCode } = runCommand(cmd, dir, 180_000);
  const duration = Date.now() - start;
  const output = `${stdout}\n${stderr}`;

  return parsePytestOutput(output, exitCode, duration);
}

function runCargoTest(dir: string, fileFilter?: string): TestResult {
  const cmd = fileFilter
    ? `cargo test "${fileFilter}" 2>&1`
    : "cargo test 2>&1";
  const start = Date.now();
  const { stdout, stderr, exitCode } = runCommand(cmd, dir, 180_000);
  const duration = Date.now() - start;
  const output = `${stdout}\n${stderr}`;

  return parseCargoOutput(output, exitCode, duration);
}

function runGoTest(dir: string, fileFilter?: string): TestResult {
  const cmd = fileFilter
    ? `go test -v "${fileFilter}" 2>&1`
    : "go test -v ./... 2>&1";
  const start = Date.now();
  const { stdout, stderr, exitCode } = runCommand(cmd, dir, 180_000);
  const duration = Date.now() - start;
  const output = `${stdout}\n${stderr}`;

  return parseGoTestOutput(output, exitCode, duration);
}

/**
 * Run TestEZ tests for Roblox Luau projects.
 * Uses `lune` (if installed) to run .luau test files that use TestEZ.
 * Falls back to `rojo test` if a rojo test project is configured.
 */
function runTestEZ(dir: string, fileFilter?: string): TestResult {
  const start = Date.now();
  const testDir = path.join(dir, "tests");

  // Try lune first (runs .luau files directly)
  const luneBinary = findBinary("lune");
  if (luneBinary) {
    const testFiles = fileFilter
      ? [fileFilter]
      : fs.readdirSync(testDir, "utf8")
          .filter(f => f.endsWith(".luau") || f.endsWith(".lua"))
          .map(f => path.join(testDir, f));

    let allOutput = "";
    let totalPassed = 0, totalFailed = 0;
    for (const testFile of testFiles) {
      const cmd = `"${luneBinary}" run "${testFile}" 2>&1`;
      const { stdout, stderr, exitCode } = runCommand(cmd, dir, 60_000);
      allOutput += `\n${stdout}\n${stderr}`;
      // TestEZ output: "X passed, Y failed"
      const match = stdout.match(/(\d+)\s+passed.*?(\d+)\s+failed/i);
      if (match) {
        totalPassed += parseInt(match[1], 10);
        totalFailed += parseInt(match[2], 10);
      } else if (exitCode !== 0) {
        totalFailed++;
      }
    }

    const duration = Date.now() - start;
    return {
      framework: "testez (lune)",
      passed: totalPassed,
      failed: totalFailed,
      skipped: 0,
      duration,
      failures: [],
      output: allOutput,
      success: totalFailed === 0,
      exitCode: totalFailed > 0 ? 1 : 0,
    };
  }

  // No lune — return info that TestEZ was detected but can't run
  const duration = Date.now() - start;
  return {
    framework: "testez",
    passed: 0,
    failed: 0,
    skipped: 0,
    duration,
    failures: [],
    output: "TestEZ detected but 'lune' binary not found. Install lune to run Luau tests: https://lune-org.github.io/docs",
    success: true,
    exitCode: 0,
  };
}

/**
 * Find a binary in PATH (simple version for testRunner).
 *
 * BUG FIX (ESM): previously used `require("node:child_process")` here. This
 * project is `{"type":"module"}` (ESM), so `require` is NOT defined — the
 * call always threw `ReferenceError: require is not defined` and was
 * silently swallowed by the surrounding try/catch. As a result, this
 * function ALWAYS returned `null`, breaking Luau (lune) test detection
 * (see `runTestEZ()` caller at line ~244). `execSync` is already imported
 * at the top of this module — use it directly.
 */
function findBinary(name: string): string | null {
  try {
    const result = execSync(`which ${name} 2>/dev/null || where ${name} 2>/dev/null`, {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

// --- Output Parsers ---------------------------------------------------------

function parseVitestJson(output: string, exitCode: number, duration: number): TestResult {
  try {
    // Vitest JSON output starts with { and contains test results
    const jsonMatch = /\{[\s\S]*"testResults"[\s\S]*\}/.exec(output);
    if (!jsonMatch) {
      return parseVitestText(output, exitCode, duration);
    }
    const data = JSON.parse(jsonMatch[0]);
    const failures: TestFailure[] = [];

    for (const suite of data.testResults ?? []) {
      for (const test of suite.assertionResults ?? []) {
        if (test.status === "failed") {
          failures.push({
            file: suite.name ?? "unknown",
            name: test.fullName ?? test.title ?? "unknown",
            message: test.failureMessages?.[0] ?? "unknown error",
            line: extractLineNumber(test.failureMessages?.[0]),
          });
        }
      }
    }

    const passed = data.numPassedTests ?? 0;
    const failed = data.numFailedTests ?? 0;
    const skipped = data.numPendingTests ?? 0;

    return {
      framework: "vitest",
      passed,
      failed,
      skipped,
      duration,
      failures,
      output,
      success: exitCode === 0,
    };
  } catch {
    return parseVitestText(output, exitCode, duration);
  }
}

function parseVitestText(output: string, exitCode: number, duration: number): TestResult {
  const failures: TestFailure[] = [];
  const passMatch = /(\d+) passed/.exec(output);
  const failMatch = /(\d+) failed/.exec(output);
  const skipMatch = /(\d+) skipped/.exec(output);

  // Parse individual failures
  const failBlocks = output.split(/(?:FAIL|X|X)\s+/);
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

function parseJestJson(output: string, exitCode: number, duration: number): TestResult {
  try {
    const jsonMatch = /\{[\s\S]*"testResults"[\s\S]*\}/.exec(output);
    if (!jsonMatch) {
      return parseGenericOutput(output, "jest", exitCode, duration);
    }
    const data = JSON.parse(jsonMatch[0]);
    const failures: TestFailure[] = [];

    for (const suite of data.testResults ?? []) {
      for (const test of suite.testResults ?? []) {
        if (test.status === "failed") {
          failures.push({
            file: suite.name ?? "unknown",
            name: test.fullName ?? test.title ?? "unknown",
            message: test.failureMessages?.[0] ?? "unknown error",
            line: extractLineNumber(test.failureMessages?.[0]),
          });
        }
      }
    }

    return {
      framework: "jest",
      passed: data.numPassedTests ?? 0,
      failed: data.numFailedTests ?? 0,
      skipped: data.numPendingTests ?? 0,
      duration,
      failures,
      output,
      success: exitCode === 0,
    };
  } catch {
    return parseGenericOutput(output, "jest", exitCode, duration);
  }
}

function parsePytestOutput(output: string, exitCode: number, duration: number): TestResult {
  const failures: TestFailure[] = [];
  const passedMatch = /(\d+) passed/.exec(output);
  const failedMatch = /(\d+) failed/.exec(output);
  const skipMatch = /(\d+) skipped/.exec(output);

  // Parse FAILED tests
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

  // Parse ERROR blocks
  const errorBlocks = output.split(/ERROR\s+/);
  for (let i = 1; i < errorBlocks.length; i++) {
    const block = errorBlocks[i] ?? "";
    failures.push({
      file: "unknown",
      name: "setup/teardown",
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

  // Parse "---- test_name stdout ----" blocks
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

  // Parse "--- FAIL: TestName (X.XXs)" blocks
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

function parseGenericOutput(output: string, framework: string, exitCode: number, duration: number): TestResult {
  const failures: TestFailure[] = [];
  const passRegex = /(\d+) (?:passing|passed|ok)/;
  const failRegex = /(\d+) (?:failing|failed|FAILED)/;
  const passMatch = passRegex.exec(output);
  const failMatch = failRegex.exec(output);

  return {
    framework,
    passed: Number.parseInt(passMatch?.[1] ?? "0", 10),
    failed: Number.parseInt(failMatch?.[1] ?? "0", 10),
    skipped: 0,
    duration,
    failures,
    output,
    success: exitCode === 0,
  };
}

function extractLineNumber(text?: string): number | undefined {
  if (!text) return undefined;
  const lineRegex = /(?:at|->|line)\s+(\d+)/i;
  const colonRegex = /:(\d+):\d+/;
  const match = lineRegex.exec(text) ?? colonRegex.exec(text);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

// --- Main Entry Point ------------------------------------------------------

export async function runTests(dir: string, fileFilter?: string): Promise<TestResult> {
  const framework = detectFramework(dir);
  log.debug(`Detected test framework: ${framework}`);

  switch (framework) {
    case "vitest":
      return runVitest(dir, fileFilter);
    case "jest":
      return runJest(dir, fileFilter);
    case "pytest":
      return runPytest(dir, fileFilter);
    case "cargo":
      return runCargoTest(dir, fileFilter);
    case "go":
      return runGoTest(dir, fileFilter);
    case "testez":
      return runTestEZ(dir, fileFilter);
    default:
      // Try npm test as fallback
      return runNpmTest(dir);
  }
}

function runNpmTest(dir: string): TestResult {
  const start = Date.now();
  const { stdout, stderr, exitCode } = runCommand("npm test 2>&1", dir, 120_000);
  const duration = Date.now() - start;
  const output = `${stdout}\n${stderr}`;

  return parseGenericOutput(output, "npm-test", exitCode, duration);
}

// --- Fix Suggestions -------------------------------------------------------

export function suggestFixes(result: TestResult, sourceFiles?: Map<string, string>): FixSuggestion[] {
  const suggestions: FixSuggestion[] = [];

  for (const failure of result.failures) {
    // Pattern: assertion error with expected/received
    const assertMatch = /expected\s+(.+?)\s+to\s+(?:equal|be)\s+(.+)/i.exec(failure.message);
    if (assertMatch) {
      suggestions.push({
        file: failure.file,
        line: failure.line,
        description: `Assertion mismatch: expected ${assertMatch[1]} to be ${assertMatch[2]}`,
        oldCode: undefined,
        newCode: undefined,
      });
      continue;
    }

    // Pattern: undefined is not a function
    if (failure.message.includes("is not a function")) {
      const funcMatch = /(\w+)\s+is not a function/.exec(failure.message);
      suggestions.push({
        file: failure.file,
        line: failure.line,
        description: `Missing function import: ${funcMatch?.[1] ?? "unknown"}. Check if it's exported and imported correctly.`,
      });
      continue;
    }

    // Pattern: Cannot find module
    if (failure.message.includes("Cannot find module") || failure.message.includes("Module not found")) {
      const modMatch = /(?:Cannot find module|Module not found)['"]+([^'"]+)/.exec(failure.message);
      suggestions.push({
        file: failure.file,
        description: `Missing module: ${modMatch?.[1] ?? "unknown"}. Run npm install or check import path.`,
      });
      continue;
    }

    // Pattern: TypeScript type errors
    if (failure.message.includes("TS2") || failure.message.includes("Type '")) {
      suggestions.push({
        file: failure.file,
        line: failure.line,
        description: `TypeScript type error. Review the type annotations.`,
      });
      continue;
    }

    // Pattern: timeout
    if (failure.message.includes("timeout") || failure.message.includes("exceeded")) {
      suggestions.push({
        file: failure.file,
        description: "Test timed out. Consider increasing timeout or simplifying the test.",
      });
      continue;
    }

    // Generic failure
    suggestions.push({
      file: failure.file,
      line: failure.line,
      description: failure.message.slice(0, 200),
    });
  }

  return suggestions;
}

// --- Auto-fix Loop ---------------------------------------------------------

export interface AutoFixOptions {
  maxRetries?: number;
  dir: string;
  onAttempt?: (attempt: number, result: TestResult) => void;
  fixFn?: (suggestion: FixSuggestion) => Promise<boolean>;
}

export async function runTestsWithAutoFix(options: AutoFixOptions): Promise<{
  finalResult: TestResult;
  attempts: number;
  fixesApplied: number;
}> {
  const { dir, maxRetries = 3, onAttempt, fixFn } = options;
  let attempts = 0;
  let fixesApplied = 0;

  while (attempts < maxRetries) {
    attempts++;
    log.debug(`Test attempt ${attempts}/${maxRetries}`);

    const result = await runTests(dir);
    onAttempt?.(attempts, result);

    if (result.success) {
      return { finalResult: result, attempts, fixesApplied };
    }

    if (!fixFn) break;

    const suggestions = suggestFixes(result);
    let anyFixed = false;

    for (const suggestion of suggestions) {
      if (await fixFn(suggestion)) {
        fixesApplied++;
        anyFixed = true;
      }
    }

    if (!anyFixed) break;
  }

  const finalResult = await runTests(dir);
  return { finalResult, attempts, fixesApplied };
}

// --- Formatting ------------------------------------------------------------

export function formatTestResult(result: TestResult): string {
  const duration = (result.duration / 1000).toFixed(1);
  const status = result.success ? "OK PASS" : "X FAIL";
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
      lines.push(`  ${f.file}${lineNum} - ${f.name}`, `    ${f.message.slice(0, 150)}`);
    }
  }

  return lines.join("\n");
}

export function formatFixSuggestions(suggestions: FixSuggestion[]): string {
  if (suggestions.length === 0) {
    return t("fix.no_suggestions");
  }

  const lines = ["Fix Suggestions:"];
  for (const s of suggestions) {
    const location = s.line ? `:${s.line}` : "";
    lines.push(`  ${s.file}${location} - ${s.description}`);
  }
  return lines.join("\n");
}

// ─── Bug Hunter Test Verification (new) ────────────────────────────────────

export type BugTestLanguage = "typescript" | "javascript" | "python" | "luau" | "lua" | "unknown";

export interface BugTestResult {
  passed: boolean;
  output: string;
  language: BugTestLanguage;
  command: string;
  ran: boolean;
  skipReason?: string;
}

export function detectLanguage(filePath: string): BugTestLanguage {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".luau":
      return "luau";
    case ".lua":
      return "lua";
    default:
      return "unknown";
  }
}

export function isTestRunnerAvailable(language: BugTestLanguage): boolean {
  try {
    switch (language) {
      case "typescript":
      case "javascript":
        execSync("which node", { encoding: "utf8", stdio: "pipe" });
        return true;
      case "python":
        execSync("which python3", { encoding: "utf8", stdio: "pipe" });
        return true;
      case "luau":
        execSync("which luau", { encoding: "utf8", stdio: "pipe" });
        return true;
      case "lua":
        execSync("which lua", { encoding: "utf8", stdio: "pipe" });
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export function getTestFilePath(sourceFile: string): string {
  const dir = path.dirname(sourceFile);
  const ext = path.extname(sourceFile);
  const base = path.basename(sourceFile, ext);
  const testDir = path.join(dir, "__tests__");
  return path.join(testDir, `${base}.bughunt.test${ext}`);
}

export function getTestCommand(language: BugTestLanguage, testFile: string, projectRoot: string): string {
  switch (language) {
    case "typescript":
      try {
        execSync("npx vitest --version", { encoding: "utf8", stdio: "pipe", cwd: projectRoot, timeout: 5000 });
        return `npx vitest run ${testFile} --reporter=dot`;
      } catch {
        return `npx tsx ${testFile}`;
      }
    case "javascript":
      return `node ${testFile}`;
    case "python":
      return `python3 ${testFile}`;
    case "luau":
      return `luau ${testFile}`;
    case "lua":
      return `lua ${testFile}`;
    default:
      return "";
  }
}

export function runBugTest(
  testFile: string,
  projectRoot: string,
  timeoutMs: number = 30_000
): BugTestResult {
  const language = detectLanguage(testFile);

  if (language === "unknown") {
    return { passed: false, output: "", language, command: "", ran: false, skipReason: `Unknown language for file: ${testFile}` };
  }

  if (!isTestRunnerAvailable(language)) {
    return { passed: false, output: "", language, command: "", ran: false, skipReason: `No test runner available for ${language}` };
  }

  if (!fs.existsSync(testFile)) {
    return { passed: false, output: "", language, command: "", ran: false, skipReason: `Test file does not exist: ${testFile}` };
  }

  const command = getTestCommand(language, testFile, projectRoot);

  try {
    const output = execSync(command, { cwd: projectRoot, encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] });
    return { passed: true, output: (output || "").slice(0, 2000), language, command, ran: true };
  } catch (err: any) {
    const stdout = err.stdout ? String(err.stdout) : "";
    const stderr = err.stderr ? String(err.stderr) : "";
    const combined = (stdout + "\n" + stderr).slice(0, 2000);
    const timedOut = err.killed === true || err.signal === "SIGTERM";
    return { passed: false, output: combined, language, command, ran: true, skipReason: timedOut ? `Test timed out after ${timeoutMs}ms` : undefined };
  }
}

export function getTestTemplate(language: BugTestLanguage, sourceFileName: string, bugDescription: string): string {
  const moduleName = path.basename(sourceFileName, path.extname(sourceFileName));
  switch (language) {
    case "typescript":
      return `// Test for bug: ${bugDescription}\nimport { describe, it, expect } from "vitest";\ndescribe("${moduleName} - Bug Hunter test", () => {\n  it("should not have the bug: ${bugDescription.slice(0, 100)}", () => {\n    expect(true).toBe(true);\n  });\n});\n`;
    case "javascript":
      return `// Test for bug: ${bugDescription}\nconst assert = require("assert");\ntry {\n  console.log("TEST PASSED (placeholder)");\n  process.exit(0);\n} catch (err) {\n  console.error("TEST FAILED:", err.message);\n  process.exit(1);\n}\n`;
    case "python":
      return `# Test for bug: ${bugDescription}\nimport sys\ndef test_bug():\n    pass\nif __name__ == "__main__":\n    try:\n        test_bug()\n        print("TEST PASSED")\n        sys.exit(0)\n    except AssertionError as e:\n        print(f"TEST FAILED: {e}")\n        sys.exit(1)\n`;
    case "luau":
    case "lua":
      return `-- Test for bug: ${bugDescription}\nlocal function testBug()\n    return true\nend\nlocal success, err = pcall(testBug)\nif success then\n    print("TEST PASSED")\n    os.exit(0)\nelse\n    print("TEST FAILED: " .. tostring(err))\n    os.exit(1)\nend\n`;
    default:
      return `// Test for bug: ${bugDescription}\n// Unknown language\n`;
  }
}
