/**
 * bugHunter-test-verification.test.ts — Testes para verificação de testes no Bug Hunter.
 *
 * Cobre as funções:
 *   - runTestsForFindings: roda testes para findings com testFile
 *   - allCriticalHighTestsPass: verifica se todos critical/high têm testes passando
 *   - BugFinding.testStatus: campo novo para tracking de testes
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
  runTestsForFindings,
  allCriticalHighTestsPass,
  type BugFinding,
} from "../bugHunter.js";

// ─── allCriticalHighTestsPass ─────────────────────────────────────────────

describe("bugHunter: allCriticalHighTestsPass", () => {
  it("retorna true quando não há critical/high findings", () => {
    const findings: BugFinding[] = [
      { severity: "medium", file: "f.ts", description: "d", suggestion: "s" },
      { severity: "low", file: "f.ts", description: "d", suggestion: "s" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(true);
  });

  it("retorna true quando critical/high têm testes passando", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "d", suggestion: "s", testStatus: "passed" },
      { severity: "high", file: "f.ts", description: "d", suggestion: "s", testStatus: "passed" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(true);
  });

  it("retorna false quando algum critical/high tem teste falhando", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "d", suggestion: "s", testStatus: "passed" },
      { severity: "high", file: "f.ts", description: "d", suggestion: "s", testStatus: "failed" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(false);
  });

  it("retorna true quando critical/high não têm testes (testStatus undefined)", () => {
    // Sem teste = não pode verificar, mas não bloqueia
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "d", suggestion: "s" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(true);
  });

  it("retorna true quando critical/high têm testes skipped", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "f.ts", description: "d", suggestion: "s", testStatus: "skipped" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(true);
  });

  it("ignora medium/low mesmo com teste falhando", () => {
    const findings: BugFinding[] = [
      { severity: "medium", file: "f.ts", description: "d", suggestion: "s", testStatus: "failed" },
      { severity: "low", file: "f.ts", description: "d", suggestion: "s", testStatus: "failed" },
    ];
    expect(allCriticalHighTestsPass(findings)).toBe(true);
  });
});

// ─── runTestsForFindings ──────────────────────────────────────────────────

describe("bugHunter: runTestsForFindings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-test-verify-"));
    // Create src/__tests__ structure
    fs.mkdirSync(path.join(tmpDir, "src", "__tests__"), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("não testa medium/low findings", () => {
    const findings: BugFinding[] = [
      { severity: "medium", file: "src/file.ts", description: "d", suggestion: "s" },
      { severity: "low", file: "src/file.ts", description: "d", suggestion: "s" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBeUndefined();
    expect(result[1].testStatus).toBeUndefined();
  });

  it("marca como skipped quando não há test runner", () => {
    // .txt não tem test runner
    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.txt", description: "d", suggestion: "s" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBe("skipped");
  });

  it("não marca status quando não há arquivo de teste", () => {
    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.ts", description: "d", suggestion: "s" },
    ];
    // Não cria arquivo de teste
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBeUndefined();
  });

  it("roda teste que passa e marca testStatus = passed", () => {
    // Cria arquivo source .js (não .ts para evitar vitest auto-config)
    fs.writeFileSync(path.join(tmpDir, "src", "file.js"), "module.exports = {};");
    // Cria arquivo de teste que passa
    const testFile = path.join(tmpDir, "src", "__tests__", "file.bughunt.test.js");
    fs.writeFileSync(testFile, "process.exit(0);");

    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.js", description: "d", suggestion: "s" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBe("passed");
    expect(result[0].testFile).toContain("file.bughunt.test.js");
  });

  it("roda teste que falha e marca testStatus = failed", () => {
    fs.writeFileSync(path.join(tmpDir, "src", "file.js"), "module.exports = {};");
    const testFile = path.join(tmpDir, "src", "__tests__", "file.bughunt.test.js");
    fs.writeFileSync(testFile, "process.exit(1);");

    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.js", description: "d", suggestion: "s" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBe("failed");
  });

  it("processa múltiplos findings", () => {
    fs.writeFileSync(path.join(tmpDir, "src", "file1.js"), "module.exports = {};");
    fs.writeFileSync(path.join(tmpDir, "src", "file2.js"), "module.exports = {};");

    // Teste que passa para file1
    fs.writeFileSync(
      path.join(tmpDir, "src", "__tests__", "file1.bughunt.test.js"),
      "process.exit(0);"
    );
    // Teste que falha para file2
    fs.writeFileSync(
      path.join(tmpDir, "src", "__tests__", "file2.bughunt.test.js"),
      "process.exit(1);"
    );

    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file1.js", description: "d1", suggestion: "s" },
      { severity: "high", file: "src/file2.js", description: "d2", suggestion: "s" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBe("passed");
    expect(result[1].testStatus).toBe("failed");
  });

  it("funciona com JavaScript (.js)", () => {
    fs.writeFileSync(path.join(tmpDir, "src", "file.js"), "module.exports = {};");
    fs.writeFileSync(
      path.join(tmpDir, "src", "__tests__", "file.bughunt.test.js"),
      "process.exit(0);"
    );

    const findings: BugFinding[] = [
      { severity: "critical", file: "src/file.js", description: "d", suggestion: "s" },
    ];
    const result = runTestsForFindings(findings, tmpDir);
    expect(result[0].testStatus).toBe("passed");
  });
});

// ─── BugFinding.testStatus field ──────────────────────────────────────────

describe("bugHunter: BugFinding.testStatus field", () => {
  it("testStatus é opcional", () => {
    const finding: BugFinding = {
      severity: "critical",
      file: "f.ts",
      description: "d",
      suggestion: "s",
    };
    expect(finding.testStatus).toBeUndefined();
  });

  it("testStatus aceita 'passed'", () => {
    const finding: BugFinding = {
      severity: "critical",
      file: "f.ts",
      description: "d",
      suggestion: "s",
      testStatus: "passed",
    };
    expect(finding.testStatus).toBe("passed");
  });

  it("testStatus aceita 'failed'", () => {
    const finding: BugFinding = {
      severity: "critical",
      file: "f.ts",
      description: "d",
      suggestion: "s",
      testStatus: "failed",
    };
    expect(finding.testStatus).toBe("failed");
  });

  it("testStatus aceita 'skipped'", () => {
    const finding: BugFinding = {
      severity: "critical",
      file: "f.ts",
      description: "d",
      suggestion: "s",
      testStatus: "skipped",
    };
    expect(finding.testStatus).toBe("skipped");
  });

  it("testFile armazena caminho do teste", () => {
    const finding: BugFinding = {
      severity: "critical",
      file: "f.ts",
      description: "d",
      suggestion: "s",
      testStatus: "passed",
      testFile: "/project/src/__tests__/f.bughunt.test.ts",
    };
    expect(finding.testFile).toContain("f.bughunt.test.ts");
  });
});
