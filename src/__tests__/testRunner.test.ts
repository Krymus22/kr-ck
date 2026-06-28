/**
 * testRunner.test.ts — Testes para o módulo testRunner.
 *
 * Cobre:
 *   - detectLanguage: detecta linguagem por extensão
 *   - isTestRunnerAvailable: verifica se runner está instalado
 *   - getTestFilePath: gera path do arquivo de teste
 *   - getTestCommand: gera comando de teste por linguagem
 *   - runBugTest: executa teste e retorna resultado
 *   - getTestTemplate: gera template de teste por linguagem
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  detectLanguage,
  isTestRunnerAvailable,
  getTestFilePath,
  getTestCommand,
  runBugTest,
  getTestTemplate,
  type BugTestLanguage,
} from "../testRunner.js";

// ─── detectLanguage ───────────────────────────────────────────────────────

describe("testRunner: detectLanguage", () => {
  it("detecta TypeScript (.ts)", () => {
    expect(detectLanguage("src/file.ts")).toBe("typescript");
  });

  it("detecta TypeScript JSX (.tsx)", () => {
    expect(detectLanguage("src/component.tsx")).toBe("typescript");
  });

  it("detecta JavaScript (.js)", () => {
    expect(detectLanguage("src/file.js")).toBe("javascript");
  });

  it("detecta Python (.py)", () => {
    expect(detectLanguage("src/file.py")).toBe("python");
  });

  it("detecta Luau (.luau)", () => {
    expect(detectLanguage("src/module.luau")).toBe("luau");
  });

  it("detecta Lua (.lua)", () => {
    expect(detectLanguage("src/script.lua")).toBe("lua");
  });

  it("retorna unknown para extensão desconhecida", () => {
    expect(detectLanguage("src/file.txt")).toBe("unknown");
    expect(detectLanguage("src/file.rs")).toBe("unknown");
    expect(detectLanguage("src/file")).toBe("unknown");
  });

  it("é case-insensitive", () => {
    expect(detectLanguage("src/file.TS")).toBe("typescript");
    expect(detectLanguage("src/file.PY")).toBe("python");
  });
});

// ─── isTestRunnerAvailable ────────────────────────────────────────────────

describe("testRunner: isTestRunnerAvailable", () => {
  it("retorna boolean", () => {
    const result = isTestRunnerAvailable("typescript");
    expect(typeof result).toBe("boolean");
  });

  it("retorna false para unknown", () => {
    expect(isTestRunnerAvailable("unknown")).toBe(false);
  });

  it("node está disponível para typescript/javascript (ambiente de teste)", () => {
    // Node sempre está disponível em testes
    expect(isTestRunnerAvailable("typescript")).toBe(true);
    expect(isTestRunnerAvailable("javascript")).toBe(true);
  });
});

// ─── getTestFilePath ──────────────────────────────────────────────────────

describe("testRunner: getTestFilePath", () => {
  it("gera path em __tests__ com sufixo .bughunt.test", () => {
    const result = getTestFilePath("/project/src/ComboSystem.luau");
    expect(result).toContain("__tests__");
    expect(result).toContain("ComboSystem.bughunt.test.luau");
  });

  it("preserva extensão do arquivo original", () => {
    expect(getTestFilePath("/project/src/file.ts")).toMatch(/\.ts$/);
    expect(getTestFilePath("/project/src/file.py")).toMatch(/\.py$/);
    expect(getTestFilePath("/project/src/file.luau")).toMatch(/\.luau$/);
  });

  it("usa __tests__ como subdiretório", () => {
    const result = getTestFilePath("/project/src/file.ts");
    expect(result).toContain("__tests__");
  });
});

// ─── getTestCommand ───────────────────────────────────────────────────────

describe("testRunner: getTestCommand", () => {
  it("gera comando para TypeScript (vitest ou tsx)", () => {
    const cmd = getTestCommand("typescript", "test.ts", "/project");
    expect(cmd).toMatch(/vitest|tsx/);
    expect(cmd).toContain("test.ts");
  });

  it("gera comando para JavaScript (node)", () => {
    const cmd = getTestCommand("javascript", "test.js", "/project");
    expect(cmd).toContain("node");
    expect(cmd).toContain("test.js");
  });

  it("gera comando para Python (python3)", () => {
    const cmd = getTestCommand("python", "test.py", "/project");
    expect(cmd).toContain("python3");
    expect(cmd).toContain("test.py");
  });

  it("gera comando para Luau (luau)", () => {
    const cmd = getTestCommand("luau", "test.luau", "/project");
    expect(cmd).toContain("luau");
    expect(cmd).toContain("test.luau");
  });

  it("gera comando para Lua (lua)", () => {
    const cmd = getTestCommand("lua", "test.lua", "/project");
    expect(cmd).toContain("lua");
    expect(cmd).toContain("test.lua");
  });

  it("retorna string vazia para unknown", () => {
    expect(getTestCommand("unknown", "test.txt", "/project")).toBe("");
  });
});

// ─── runBugTest ──────────────────────────────────────────────────────────────

describe("testRunner: runBugTest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "testrunner-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("retorna skipped para arquivo inexistente", () => {
    const result = runBugTest("/nonexistent/test.ts", tmpDir);
    expect(result.passed).toBe(false);
    expect(result.ran).toBe(false);
    expect(result.skipReason).toContain("does not exist");
  });

  it("retorna skipped para linguagem unknown", () => {
    const testFile = path.join(tmpDir, "test.txt");
    fs.writeFileSync(testFile, "hello");
    const result = runBugTest(testFile, tmpDir);
    expect(result.passed).toBe(false);
    expect(result.ran).toBe(false);
    expect(result.skipReason).toContain("Unknown language");
  });

  it("roda teste JavaScript que passa", () => {
    const testFile = path.join(tmpDir, "test.js");
    fs.writeFileSync(testFile, "console.log('PASS'); process.exit(0);");
    const result = runBugTest(testFile, tmpDir);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.output).toContain("PASS");
  });

  it("roda teste JavaScript que falha", () => {
    const testFile = path.join(tmpDir, "test.js");
    fs.writeFileSync(testFile, "console.error('FAIL'); process.exit(1);");
    const result = runBugTest(testFile, tmpDir);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("FAIL");
  });

  it("detecta timeout", () => {
    const testFile = path.join(tmpDir, "test.js");
    fs.writeFileSync(testFile, "setTimeout(() => {}, 10000);"); // hangs
    const result = runBugTest(testFile, tmpDir, 1000); // 1s timeout
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
  }, 5000);
});

// ─── getTestTemplate ──────────────────────────────────────────────────────

describe("testRunner: getTestTemplate", () => {
  const bugDesc = "Nil access in registerHit when playerId is nil";

  it("gera template TypeScript com vitest", () => {
    const template = getTestTemplate("typescript", "ComboSystem.ts", bugDesc);
    expect(template).toContain("vitest");
    expect(template).toContain("describe");
    expect(template).toContain("it(");
    expect(template).toContain(bugDesc);
  });

  it("gera template JavaScript com assert", () => {
    const template = getTestTemplate("javascript", "file.js", bugDesc);
    expect(template).toContain("assert");
    expect(template).toContain(bugDesc);
  });

  it("gera template Python com def test_bug", () => {
    const template = getTestTemplate("python", "file.py", bugDesc);
    expect(template).toContain("def test_bug");
    expect(template).toContain(bugDesc);
  });

  it("gera template Luau com pcall", () => {
    const template = getTestTemplate("luau", "module.luau", bugDesc);
    expect(template).toContain("pcall");
    expect(template).toContain(bugDesc);
  });

  it("gera template Lua com pcall", () => {
    const template = getTestTemplate("lua", "script.lua", bugDesc);
    expect(template).toContain("pcall");
    expect(template).toContain(bugDesc);
  });

  it("gera template genérico para unknown", () => {
    const template = getTestTemplate("unknown", "file.txt", bugDesc);
    expect(template).toContain(bugDesc);
    expect(template).toContain("Unknown language");
  });

  it("inclui nome do módulo no template", () => {
    const template = getTestTemplate("typescript", "ComboSystem.ts", bugDesc);
    expect(template).toContain("ComboSystem");
  });
});
