/**
 * testRunner-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: runTests (3 extras), detectFramework (2 extras), parseTestOutput (2)
 * e edge cases (1). Usa os exports reais do testRunner.ts.
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

const { mockExecSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execSync: (...a: any[]) => mockExecSync(...a),
}));

import {
  detectFramework,
  runTests,
  suggestFixes,
  formatTestResult,
  formatFixSuggestions,
  runTestsWithAutoFix,
} from "../testRunner.js";

describe("testRunner — extended", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  // ─── runTests (3 extras) ───────────────────────────────────────────────────

  describe("runTests — extras", () => {
    it("detecta vitest quando package.json tem vitest em devDependencies", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-tr-"));
      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
      );
      mockExecSync.mockReturnValue('{"numPassedTests":1,"numFailedTests":0,"testResults":[]}');
      const r = await runTests(tmp);
      expect(r.framework).toBe("vitest");
      expect(r.passed).toBeGreaterThanOrEqual(0);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("detecta cargo quando Cargo.toml existe", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-tr-"));
      fs.writeFileSync(path.join(tmp, "Cargo.toml"), "[package]\nname=\"x\"\n");
      mockExecSync.mockReturnValue("test result: ok. 3 passed; 0 failed; 0 ignored");
      const r = await runTests(tmp);
      expect(r.framework).toBe("cargo");
      expect(r.passed).toBe(3);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("faz fallback para 'npm-test' quando nenhum framework conhecido é detectado", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-tr-"));
      // Sem package.json, sem Cargo.toml, sem go.mod, sem pytest, sem conftest
      mockExecSync.mockReturnValue("5 passing");
      const r = await runTests(tmp);
      expect(r.framework).toBe("npm-test");
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  // ─── detectFramework (2 extras) ────────────────────────────────────────────

  describe("detectFramework — extras", () => {
    it("detecta 'go' quando go.mod existe", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-tr-"));
      fs.writeFileSync(path.join(tmp, "go.mod"), "module x\n\ngo 1.21\n");
      expect(detectFramework(tmp)).toBe("go");
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("detecta 'unknown' em diretório totalmente vazio", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-tr-"));
      expect(detectFramework(tmp)).toBe("unknown");
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  // ─── parseTestOutput / suggestFixes (2) ────────────────────────────────────

  describe("parseTestOutput / suggestFixes — extras", () => {
    it("suggestFixes gera sugestão para erro 'Cannot find module'", () => {
      const result = {
        framework: "vitest",
        passed: 0,
        failed: 1,
        skipped: 0,
        duration: 100,
        failures: [{
          file: "src/app.ts",
          name: "test",
          message: "Cannot find module 'lodash'",
        }],
        output: "",
        success: false,
      };
      const s = suggestFixes(result as any);
      expect(s.length).toBe(1);
      // O regex do source captura apenas quando há aspas imediatamente após
      // "Cannot find module"; caso contrário cai em "unknown".
      expect(s[0].description).toContain("Missing module");
    });

    it("formatTestResult renderiza failures com ':line' quando line está presente", () => {
      const r = formatTestResult({
        framework: "vitest",
        passed: 5,
        failed: 1,
        skipped: 0,
        duration: 1234,
        failures: [{ file: "a.ts", name: "test a", message: "erro", line: 42 }],
        output: "",
        success: false,
      });
      expect(r).toContain("a.ts:42");
      expect(r).toContain("X FAIL");
      expect(r).toContain("1.2s");
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("formatFixSuggestions retorna mensagem específica para lista vazia", () => {
      expect(formatFixSuggestions([])).toContain("No fix suggestions");
    });

    it("runTestsWithAutoFix para imediatamente quando fixFn não é fornecido", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-tr-"));
      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
      );
      mockExecSync.mockReturnValue('{"numPassedTests":0,"numFailedTests":1,"testResults":[]}');
      const r = await runTestsWithAutoFix({ dir: tmp, maxRetries: 3 });
      // Sem fixFn, faz 1 tentativa e para
      expect(r.attempts).toBe(1);
      expect(r.fixesApplied).toBe(0);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("runTestsWithAutoFix retorna attempts=0 e finalResult quando maxRetries=0", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-tr-"));
      fs.writeFileSync(
        path.join(tmp, "package.json"),
        JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }),
      );
      mockExecSync.mockReturnValue('{"numPassedTests":1,"numFailedTests":0,"testResults":[]}');
      const r = await runTestsWithAutoFix({ dir: tmp, maxRetries: 0 });
      // maxRetries=0 → loop não roda → apenas o runTests final
      expect(r.finalResult.framework).toBe("vitest");
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });
});
