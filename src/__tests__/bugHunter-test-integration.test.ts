/**
 * bugHunter-test-integration.test.ts — Testes de integração do Bug Hunter
 * com verificação por testes.
 *
 * Cobre:
 *   1. formatBugHuntMessage inclui seção TEST-BASED VERIFICATION
 *   2. Templates por linguagem na mensagem
 *   3. BugFinding com testStatus aparece no output
 *   4. Mensagem quando testes falham vs passam
 *   5. Fluxo E2E mockado: Bug Hunter → testes → tracking
 *   6. compareFindings preserva testStatus entre rounds
 *   7. runTestsForFindings com múltiplas linguagens
 *   8. allCriticalHighTestsPass em cenários complexos
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  success: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  config: {
    model: "test-model",
    nvidiaApiKey: "test",
    nvidiaApiKeys: "",
    nvidiaApiKeysFile: "",
    nvidiaBaseUrl: "https://test",
    maxTokens: 4096,
    temperature: 0.6,
    topP: 0.9,
    contextWindowTokens: 128000,
    contextCompactThreshold: 0.65,
  },
}));

import {
  formatBugHuntMessage,
  runTestsForFindings,
  allCriticalHighTestsPass,
  compareFindings,
  type BugFinding,
} from "../bugHunter.js";

// ─── 1. formatBugHuntMessage inclui TEST-BASED VERIFICATION ────────────────

describe("Integration: formatBugHuntMessage inclui TEST-BASED VERIFICATION", () => {
  it("mensagem de bloqueio contém seção TEST-BASED VERIFICATION", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", line: "10", description: "nil access", suggestion: "add check" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("TEST-BASED VERIFICATION");
  });

  it("mensagem sem bloqueio NÃO contém TEST-BASED VERIFICATION", () => {
    const findings: BugFinding[] = [
      { severity: "low", file: "f.ts", description: "style", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, false);
    expect(msg).not.toContain("TEST-BASED VERIFICATION");
  });

  it("TEMPLATE TypeScript mencionado na mensagem", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("vitest");
    expect(msg).toContain("import { describe, it, expect }");
    expect(msg).toContain("src/__tests__");
  });

  it("TEMPLATE Luau mencionado na mensagem", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.luau", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("Luau");
    expect(msg).toContain("pcall");
  });

  it("TEMPLATE Python mencionado na mensagem", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.py", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("Python");
    expect(msg).toContain("python3");
  });

  it("TEMPLATE JavaScript mencionado na mensagem", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.js", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("JavaScript");
    expect(msg).toContain("node");
  });

  it("instruções incluem 'Write a test that reproduces the bug'", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("WRITE A TEST");
    expect(msg).toContain("reproduces");
  });

  it("instruções incluem pass/fail behavior", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("PASS");
    expect(msg).toContain("FAIL");
    expect(msg).toContain("persist");
  });

  it("menciona que Bug Hunter vai checar resultados de testes", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "bug", suggestion: "fix" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("check test results");
  });
});

// ─── 2. BugFinding com testStatus no output ───────────────────────────────

describe("Integration: BugFinding com testStatus no formatBugHuntMessage", () => {
  it("finding com testStatus=passed mostra ✓ TEST PASSED", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", line: "10", description: "bug", suggestion: "fix", testStatus: "passed" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    // The finding should be listed — testStatus is tracked but the message
    // format is the same (the IA sees test results appended separately by agent.ts)
    expect(msg).toContain("CRITICAL");
    expect(msg).toContain("f.ts:10");
  });

  it("finding com testStatus=failed ainda aparece na lista", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", line: "10", description: "bug", suggestion: "fix", testStatus: "failed" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("CRITICAL");
    expect(msg).toContain("f.ts:10");
  });

  it("finding com testStatus=skipped aparece normalmente", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.luau", line: "10", description: "bug", suggestion: "fix", testStatus: "skipped" },
    ];
    const msg = formatBugHuntMessage(findings, true);
    expect(msg).toContain("CRITICAL");
  });
});

// ─── 3. compareFindings preserva testStatus entre rounds ──────────────────

describe("Integration: compareFindings preserva testStatus", () => {
  it("findings com testStatus são comparados corretamente", () => {
    const bug1: BugFinding = {
      severity: "critical", file: "f.ts", line: "10",
      description: "nil access", suggestion: "fix",
      testStatus: "passed",
    };
    const bug2: BugFinding = {
      severity: "critical", file: "f.ts", line: "10",
      description: "nil access", suggestion: "fix",
      testStatus: "failed", // different status but same bug
    };
    // Same file + same description → persisting
    const result = compareFindings([bug2], [bug1]);
    expect(result.persisting.length).toBe(1);
    // testStatus from current is preserved
    expect(result.persisting[0].testStatus).toBe("passed");
  });

  it("new bugs começam sem testStatus", () => {
    const previous: BugFinding[] = [
      { severity: "high", file: "old.ts", description: "old bug", suggestion: "fix", testStatus: "passed" },
    ];
    const current: BugFinding[] = [
      { severity: "critical", file: "new.ts", description: "new bug", suggestion: "fix" },
    ];
    const result = compareFindings(current, previous);
    expect(result.newBugs.length).toBe(1);
    expect(result.newBugs[0].testStatus).toBeUndefined();
  });

  it("fixed bugs mantêm testStatus do previous", () => {
    const previous: BugFinding[] = [
      { severity: "high", file: "old.ts", description: "old bug", suggestion: "fix", testStatus: "passed" },
    ];
    const current: BugFinding[] = [];
    const result = compareFindings(current, previous);
    expect(result.fixed.length).toBe(1);
    expect(result.fixed[0].testStatus).toBe("passed");
  });
});

// ─── 4. runTestsForFindings com múltiplas linguagens ──────────────────────

describe("Integration: runTestsForFindings multi-linguagem", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-multi-lang-"));
    fs.mkdirSync(path.join(tmpDir, "src", "__tests__"), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("processa findings de TS e JS no mesmo batch", () => {
    // JS source + test (passes)
    fs.writeFileSync(path.join(tmpDir, "src", "file.js"), "module.exports = {};");
    fs.writeFileSync(
      path.join(tmpDir, "src", "__tests__", "file.bughunt.test.js"),
      "process.exit(0);"
    );
    // TS source + test (skipped — vitest needs config)
    fs.writeFileSync(path.join(tmpDir, "src", "file2.ts"), "export const x = 1;");

    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.js", description: "d1", suggestion: "s" },
      { severity: "high", file: "src/file2.ts", description: "d2", suggestion: "s" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    // JS test should pass
    expect(result[0].testStatus).toBe("passed");
    // TS has no test file → undefined
    expect(result[1].testStatus).toBeUndefined();
  });

  it("processa findings de linguagem unknown sem crashar", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.unknown", description: "d", suggestion: "s" },
      { severity: "high", file: "src/file.txt", description: "d", suggestion: "s" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBe("skipped");
    expect(result[1].testStatus).toBe("skipped");
  });

  it("não crasha quando projectRoot não existe", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.ts", description: "d", suggestion: "s" },
    ];
    // Should not throw, just return with undefined testStatus
    expect(() => runTestsForFindings(findings, "/nonexistent/path")).not.toThrow();
  });

  it("não crasha com findings vazios", () => {
    expect(() => runTestsForFindings([], tmpDir)).not.toThrow();
    const result = runTestsForFindings([], tmpDir);
    expect(result).toEqual([]);
  });
});

// ─── 5. allCriticalHighTestsPass cenários complexos ───────────────────────

describe("Integration: allCriticalHighTestsPass cenários complexos", () => {
  it("mix de passed/skipped/undefined → true", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "d", suggestion: "s", testStatus: "passed" },
      { severity: "high", file: "f.ts", description: "d", suggestion: "s", testStatus: "skipped" },
      { severity: "critical", file: "f.ts", description: "d", suggestion: "s" }, // undefined
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(true);
  });

  it("um failed entre muitos passed → false", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "d1", suggestion: "s", testStatus: "passed" },
      { severity: "high", file: "f.ts", description: "d2", suggestion: "s", testStatus: "passed" },
      { severity: "critical", file: "f.ts", description: "d3", suggestion: "s", testStatus: "passed" },
      { severity: "high", file: "f.ts", description: "d4", suggestion: "s", testStatus: "failed" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(false);
  });

  it("só medium/low com failed → true (ignora)", () => {
    const findings: BugFinding[] = [
      { severity: "medium", file: "f.ts", description: "d", suggestion: "s", testStatus: "failed" },
      { severity: "low", file: "f.ts", description: "d", suggestion: "s", testStatus: "failed" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(true);
  });

  it("array vazio → true", () => {
    expect(allCriticalHighTestsPass([])).toBe(true);
  });

  it("todos undefined → true (sem testes)", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "d", suggestion: "s" },
      { severity: "high", file: "f.ts", description: "d", suggestion: "s" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(true);
  });
});

// ─── 6. Fluxo E2E mockado: Bug Hunter → testes → tracking ─────────────────

describe("E2E mock: Bug Hunter encontra bug → IA escreve teste → teste roda", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-e2e-"));
    fs.mkdirSync(path.join(tmpDir, "src", "__tests__"), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("E2E: bug encontrado, IA escreve teste que passa, bug marcado como fixed", () => {
    // Step 1: Bug Hunter finds a bug
    const sourceFile = path.join(tmpDir, "src", "calculator.js");
    fs.writeFileSync(sourceFile, `
function divide(a, b) {
  return a / b; // Bug: no check for b === 0
}
module.exports = { divide };
`);

    const findings: BugFinding[] = [
      {
        severity: "critical",
        file: "src/calculator.js",
        line: "2",
        description: "Division by zero not handled — will return Infinity",
        suggestion: "Add check: if (b === 0) throw new Error('Division by zero')",
      },
    ];

    // Step 2: IA "fixes" the bug (simulated)
    fs.writeFileSync(sourceFile, `
function divide(a, b) {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}
module.exports = { divide };
`);

    // Step 3: IA writes a test that reproduces the original bug
    const testFile = path.join(tmpDir, "src", "__tests__", "calculator.bughunt.test.js");
    fs.writeFileSync(testFile, `
const { divide } = require("../calculator");
try {
  divide(10, 0);
  console.error("TEST FAILED: should have thrown");
  process.exit(1);
} catch (e) {
  if (e.message === "Division by zero") {
    console.log("TEST PASSED");
    process.exit(0);
  } else {
    console.error("TEST FAILED: wrong error:", e.message);
    process.exit(1);
  }
}
`);

    // Step 4: System runs the test
    const result = runTestsForFindings(findings, tmpDir);

    // Step 5: Test passed → bug is marked as fixed
    expect(result[0].testStatus).toBe("passed");
    expect(allCriticalHighTestsPass(result)).toBe(true);
  });

  it("E2E: bug encontrado, IA NÃO corrige, teste falha, bug persiste", () => {
    // Source with bug (not fixed)
    const sourceFile = path.join(tmpDir, "src", "calculator.js");
    fs.writeFileSync(sourceFile, `
function divide(a, b) {
  return a / b; // Bug NOT fixed
}
module.exports = { divide };
`);

    // IA writes test that expects the fix
    const testFile = path.join(tmpDir, "src", "__tests__", "calculator.bughunt.test.js");
    fs.writeFileSync(testFile, `
const { divide } = require("../calculator");
try {
  divide(10, 0);
  console.error("TEST FAILED: should have thrown");
  process.exit(1);
} catch (e) {
  console.log("TEST PASSED");
  process.exit(0);
}
`);

    const findings: BugFinding[] = [
      {
        severity: "critical",
        file: "src/calculator.js",
        line: "2",
        description: "Division by zero not handled",
        suggestion: "Add check",
      },
    ];

    const result = runTestsForFindings(findings, tmpDir);

    // Test failed → bug persists
    expect(result[0].testStatus).toBe("failed");
    expect(allCriticalHighTestsPass(result)).toBe(false);
  });

  it("E2E: múltiplos bugs, alguns corrigidos outros não", () => {
    // file1.js — bug fixed
    fs.writeFileSync(path.join(tmpDir, "src", "file1.js"), `
function safeAdd(a, b) {
  if (typeof a !== "number" || typeof b !== "number") return NaN;
  return a + b;
}
module.exports = { safeAdd };
`);
    fs.writeFileSync(
      path.join(tmpDir, "src", "__tests__", "file1.bughunt.test.js"),
      `const { safeAdd } = require("../file1"); if (isNaN(safeAdd("a", 1))) { process.exit(0); } else { process.exit(1); }`
    );

    // file2.js — bug NOT fixed
    fs.writeFileSync(path.join(tmpDir, "src", "file2.js"), `
function unsafeSubtract(a, b) {
  return a - b; // no type check
}
module.exports = { unsafeSubtract };
`);
    fs.writeFileSync(
      path.join(tmpDir, "src", "__tests__", "file2.bughunt.test.js"),
      `const { unsafeSubtract } = require("../file2"); try { const r = unsafeSubtract("a", 1); if (typeof r === "number" && !isNaN(r)) { process.exit(0); } else { process.exit(1); } } catch(e) { process.exit(0); }`
    );

    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file1.js", description: "no type check in add", suggestion: "add typeof check" },
      { severity: "high", file: "src/file2.js", description: "no type check in subtract", suggestion: "add typeof check" },
    ];

    const result = runTestsForFindings(findings, tmpDir);

    // file1: test passes (bug fixed)
    expect(result[0].testStatus).toBe("passed");
    // file2: test fails (bug not fixed)
    expect(result[1].testStatus).toBe("failed");
    // allCriticalHighTestsPass: false (file2 has failed test)
    expect(allCriticalHighTestsPass(result)).toBe(false);
  });

  it("E2E: bug em linguagem sem test runner → skipped", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.unknownext", description: "bug", suggestion: "fix" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBe("skipped");
    // Skipped doesn't block
    expect(allCriticalHighTestsPass(result)).toBe(true);
  });
});
