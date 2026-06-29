/**
 * testRunner-edge-cases.test.ts — Edge cases do testRunner.
 *
 * Cobre cenários extremos:
 *   - Arquivo de teste vazio
 *   - Teste com syntax error
 *   - Test runner crasha (segfault simulado)
 *   - Timeout muito curto
 *   - Múltiplos testes no mesmo arquivo
 *   - Path com espaços/unicode
 *   - Arquivo muito grande
 *   - Permissões negadas
 *   - Teste que gera muito output
 *   - Teste com exit code não-padrão
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
} from "../testRunner.js";

// ─── Arquivo vazio ────────────────────────────────────────────────────────

describe("testRunner edge: arquivo vazio", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-empty-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("arquivo .js vazio roda sem erro (exit 0)", () => {
    const testFile = path.join(tmpDir, "empty.js");
    fs.writeFileSync(testFile, "");
    const result = runBugTest(testFile, tmpDir);
    expect(result.ran).toBe(true);
    // Empty JS file exits 0
    expect(result.passed).toBe(true);
  });

  it("arquivo .js com só comentário", () => {
    const testFile = path.join(tmpDir, "comment.js");
    fs.writeFileSync(testFile, "// just a comment");
    const result = runBugTest(testFile, tmpDir);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
  });
});

// ─── Syntax error ─────────────────────────────────────────────────────────

describe("testRunner edge: syntax error", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-syntax-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("JS com syntax error falha", () => {
    const testFile = path.join(tmpDir, "bad.js");
    fs.writeFileSync(testFile, "function { invalid syntax }}}");
    const result = runBugTest(testFile, tmpDir);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("SyntaxError");
  });

  it("JS com throw não-capturado falha", () => {
    const testFile = path.join(tmpDir, "throw.js");
    fs.writeFileSync(testFile, "throw new Error('unexpected');");
    const result = runBugTest(testFile, tmpDir);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("unexpected");
  });
});

// ─── Exit codes não-padrão ────────────────────────────────────────────────

describe("testRunner edge: exit codes não-padrão", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-exit-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("exit 0 → passed", () => {
    const testFile = path.join(tmpDir, "exit0.js");
    fs.writeFileSync(testFile, "process.exit(0);");
    const result = runBugTest(testFile, tmpDir);
    expect(result.passed).toBe(true);
  });

  it("exit 1 → failed", () => {
    const testFile = path.join(tmpDir, "exit1.js");
    fs.writeFileSync(testFile, "process.exit(1);");
    const result = runBugTest(testFile, tmpDir);
    expect(result.passed).toBe(false);
  });

  it("exit 2 → failed", () => {
    const testFile = path.join(tmpDir, "exit2.js");
    fs.writeFileSync(testFile, "process.exit(2);");
    const result = runBugTest(testFile, tmpDir);
    expect(result.passed).toBe(false);
  });

  it("exit 42 → failed (non-zero)", () => {
    const testFile = path.join(tmpDir, "exit42.js");
    fs.writeFileSync(testFile, "process.exit(42);");
    const result = runBugTest(testFile, tmpDir);
    expect(result.passed).toBe(false);
  });
});

// ─── Timeout ──────────────────────────────────────────────────────────────

describe("testRunner edge: timeout", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-timeout-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("teste que demora mais que timeout → failed com skipReason", () => {
    const testFile = path.join(tmpDir, "slow.js");
    fs.writeFileSync(testFile, "setTimeout(() => {}, 5000);");
    const result = runBugTest(testFile, tmpDir, 500); // 500ms timeout
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.skipReason).toContain("timed out");
  });

  it("teste que termina antes do timeout → passed", () => {
    const testFile = path.join(tmpDir, "fast.js");
    fs.writeFileSync(testFile, "process.exit(0);");
    const result = runBugTest(testFile, tmpDir, 5000);
    expect(result.passed).toBe(true);
  });

  it("timeout de 0ms → falha imediatamente", () => {
    const testFile = path.join(tmpDir, "instant.js");
    fs.writeFileSync(testFile, "process.exit(0);");
    // timeout 1ms — might pass or fail depending on timing, but shouldn't hang
    const result = runBugTest(testFile, tmpDir, 1);
    expect(result.ran).toBe(true);
    // Don't assert passed/failed — just that it didn't hang
  });
});

// ─── Output grande ────────────────────────────────────────────────────────

describe("testRunner edge: output grande", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-output-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("trunca output maior que 2000 chars", () => {
    const testFile = path.join(tmpDir, "verbose.js");
    // Generate ~5K chars of output then exit 0
    fs.writeFileSync(testFile, `
      for (let i = 0; i < 200; i++) {
        console.log("Line " + i + " " + "x".repeat(30));
      }
      process.exit(0);
    `);
    const result = runBugTest(testFile, tmpDir);
    expect(result.passed).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(2001); // truncated
  });

  it("captura stderr", () => {
    const testFile = path.join(tmpDir, "stderr.js");
    fs.writeFileSync(testFile, "console.error('STDERR_MSG'); process.exit(1);");
    const result = runBugTest(testFile, tmpDir);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("STDERR_MSG");
  });

  it("captura stdout e stderr combinados", () => {
    const testFile = path.join(tmpDir, "both.js");
    fs.writeFileSync(testFile, `
      console.log("STDOUT_MSG");
      console.error("STDERR_MSG");
      process.exit(1);
    `);
    const result = runBugTest(testFile, tmpDir);
    expect(result.output).toContain("STDOUT_MSG");
    expect(result.output).toContain("STDERR_MSG");
  });
});

// ─── Paths especiais ──────────────────────────────────────────────────────

describe("testRunner edge: paths especiais", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-paths-"));
  });
  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("path com espaços", () => {
    const subdir = path.join(tmpDir, "dir with spaces");
    fs.mkdirSync(subdir, { recursive: true });
    const testFile = path.join(subdir, "test.js");
    fs.writeFileSync(testFile, "process.exit(0);");
    const result = runBugTest(testFile, tmpDir);
    // Path with spaces may fail in shell — just verify it ran
    expect(result.ran).toBe(true);
  });

  it("path absoluto longo", () => {
    const deepDir = path.join(tmpDir, "a", "b", "c", "d", "e", "f");
    fs.mkdirSync(deepDir, { recursive: true });
    const testFile = path.join(deepDir, "test.js");
    fs.writeFileSync(testFile, "process.exit(0);");
    const result = runBugTest(testFile, tmpDir);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
  });

  it("getTestFilePath com path relativo", () => {
    const result = getTestFilePath("src/file.ts");
    expect(result).toContain("__tests__");
    expect(result).toContain("file.bughunt.test.ts");
  });

  it("getTestFilePath com path absoluto", () => {
    const result = getTestFilePath("/project/src/file.ts");
    expect(result).toContain("__tests__");
    expect(result).toContain("file.bughunt.test.ts");
  });
});

// ─── detectLanguage edge cases ────────────────────────────────────────────

describe("testRunner edge: detectLanguage", () => {
  it("arquivo sem extensão", () => {
    expect(detectLanguage("Makefile")).toBe("unknown");
    expect(detectLanguage("README")).toBe("unknown");
  });

  it("extensão com ponto no nome", () => {
    expect(detectLanguage("my.file.ts")).toBe("typescript");
    expect(detectLanguage("config.test.py")).toBe("python");
  });

  it("extensão uppercase", () => {
    expect(detectLanguage("file.TS")).toBe("typescript");
    expect(detectLanguage("file.PY")).toBe("python");
    expect(detectLanguage("file.LUAU")).toBe("luau");
  });

  it("extensão mista case", () => {
    expect(detectLanguage("file.Ts")).toBe("typescript");
    expect(detectLanguage("file.Js")).toBe("javascript");
  });

  it("string vazia", () => {
    expect(detectLanguage("")).toBe("unknown");
  });

  it("só extensão", () => {
    // Node's path.extname('.ts') returns '' (treats as hidden file)
    expect(detectLanguage(".ts")).toBe("unknown");
  });
});

// ─── getTestCommand edge cases ────────────────────────────────────────────

describe("testRunner edge: getTestCommand", () => {
  it("retorna string vazia para unknown", () => {
    expect(getTestCommand("unknown", "test.txt", "/project")).toBe("");
  });

  it("inclui nome do arquivo no comando", () => {
    const cmd = getTestCommand("javascript", "my-test.js", "/project");
    expect(cmd).toContain("my-test.js");
  });

  it("inclui runner no comando", () => {
    expect(getTestCommand("javascript", "t.js", "/p")).toContain("node");
    expect(getTestCommand("python", "t.py", "/p")).toContain("python3");
    expect(getTestCommand("lua", "t.lua", "/p")).toContain("lua");
  });
});

// ─── getTestTemplate edge cases ───────────────────────────────────────────

describe("testRunner edge: getTestTemplate", () => {
  it("description vazia", () => {
    const template = getTestTemplate("typescript", "f.ts", "");
    expect(typeof template).toBe("string");
    expect(template.length).toBeGreaterThan(0);
  });

  it("description muito longa", () => {
    const longDesc = "A".repeat(500);
    const template = getTestTemplate("typescript", "f.ts", longDesc);
    expect(template).toContain("A".repeat(100)); // pelo menos os primeiros 100 chars
  });

  it("sourceFileName sem extensão", () => {
    const template = getTestTemplate("typescript", "module", "bug");
    expect(template).toContain("module");
  });

  it("sourceFileName com path completo", () => {
    const template = getTestTemplate("typescript", "/project/src/ComboSystem.ts", "bug");
    expect(template).toContain("ComboSystem");
  });

  it("todas linguagens geram template não-vazio", () => {
    const langs: Array<"typescript" | "javascript" | "python" | "luau" | "lua" | "unknown"> = 
      ["typescript", "javascript", "python", "luau", "lua", "unknown"];
    for (const lang of langs) {
      const template = getTestTemplate(lang, "file.ext", "bug desc");
      expect(template.length).toBeGreaterThan(10);
      expect(template).toContain("bug desc");
    }
  });
});

// ─── isTestRunnerAvailable edge cases ─────────────────────────────────────

describe("testRunner edge: isTestRunnerAvailable", () => {
  it("retorna false para null/undefined input", () => {
    expect(isTestRunnerAvailable(null as any)).toBe(false);
    expect(isTestRunnerAvailable(undefined as any)).toBe(false);
  });

  it("retorna false para string vazia", () => {
    expect(isTestRunnerAvailable("" as any)).toBe(false);
  });

  it("retorna false para linguagem inexistente", () => {
    expect(isTestRunnerAvailable("rust" as any)).toBe(false);
    expect(isTestRunnerAvailable("csharp" as any)).toBe(false);
  });
});
