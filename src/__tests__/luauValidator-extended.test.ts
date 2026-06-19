/**
 * luauValidator-extended.test.ts - Expansão de cobertura de src/luauValidator.ts.
 *
 * Cobre cenários não testados em luauValidator.test.ts:
 *   - shouldValidateFile() para .luau, .lua, .ts, .py, .js, e arquivo sem modo ativo
 *   - validateLuauBeforeWrite() com código válido, sintaxe inválida, vazio, grande
 *   - Regras blocking (selene) vs non-blocking (stylua)
 *   - getActiveValidationRules() retorna regras do modo ativo (legacy + novo campo)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

// Mock logger
vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// --- Mock toolDetector para controlar se uma ferramenta está "instalada" ---
// Permite que cada teste defina quais tools aparecem como working/missing.
const toolDetectorState = vi.hoisted(() => ({
  // Mapa toolName -> status ("working" | "found" | "missing")
  statuses: {} as Record<string, string>,
  reset() {
    this.statuses = {};
  },
  set(tool: string, status: string) {
    this.statuses[tool] = status;
  },
}));

vi.mock("./../toolDetector.js", () => ({
  detectTool: vi.fn((toolName: string) => {
    const status = toolDetectorState.statuses[toolName] ?? "missing";
    return {
      status,
      binaryPath: status === "missing" ? null : `/fake/bin/${toolName}`,
      version: status === "missing" ? null : "1.0.0",
      error: null,
      searchedPaths: [],
    };
  }),
  detectAndVerify: vi.fn(async (toolName: string) => ({
    status: toolDetectorState.statuses[toolName] ?? "missing",
    binaryPath: toolDetectorState.statuses[toolName]
      ? `/fake/bin/${toolName}`
      : null,
    version: toolDetectorState.statuses[toolName] ? "1.0.0" : null,
    error: null,
    searchedPaths: [],
    verified: toolDetectorState.statuses[toolName] === "working",
  })),
}));

// --- Mock node:child_process spawn para controlar output de cada tool ---
// Permite configurar por teste: qual comando retorna exit code 0 com stdout,
// qual retorna exit code 1 com stderr, etc.
const spawnState = vi.hoisted(() => ({
  // Mapa "cmd-firstArg" -> { code, stdout, stderr, error }
  responses: {} as Record<string, { code: number; stdout: string; stderr: string; error?: string }>,
  defaultResponse: { code: 0, stdout: "", stderr: "" },
  reset() {
    this.responses = {};
    this.defaultResponse = { code: 0, stdout: "", stderr: "" };
  },
  set(key: string, resp: { code: number; stdout?: string; stderr?: string }) {
    this.responses[key] = {
      code: resp.code,
      stdout: resp.stdout ?? "",
      stderr: resp.stderr ?? "",
    };
  },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((cmd: string, args: string[]) => {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    // Lookup: chave = "cmd firstArg" (ex: "selene /tmp/...")
    // Para simplificar, usamos só o cmd como chave
    const resp = spawnState.responses[cmd] ?? spawnState.defaultResponse;

    setImmediate(() => {
      if (resp.stdout) child.stdout.emit("data", resp.stdout);
      if (resp.stderr) child.stderr.emit("data", resp.stderr);
      if (resp.error) {
        child.emit("error", new Error(resp.error));
      } else {
        child.emit("close", resp.code);
      }
    });

    return child;
  }),
}));

describe("luauValidator (extended)", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ck-luau-ext-home-"));
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "ck-luau-ext-proj-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.cwd = () => tmpProject;
    toolDetectorState.reset();
    spawnState.reset();
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
    vi.resetModules();
  });

  // --- shouldValidateFile ---------------------------------------------------

  describe("shouldValidateFile", () => {
    it("retorna true para .luau quando modo ativo tem regra *.luau", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "luau-mode",
        label: "Luau",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
      });
      setActiveMode("luau-mode");

      const { shouldValidateFile } = await import("./../luauValidator.js");
      const should = await shouldValidateFile("/proj/foo.luau");
      expect(should).toBe(true);
    });

    it("retorna true para .lua quando modo ativo tem regra *.lua", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "lua-mode",
        label: "Lua",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [{ tool: "selene_lint", filePattern: "*.lua", blocking: true }],
      });
      setActiveMode("lua-mode");

      const { shouldValidateFile } = await import("./../luauValidator.js");
      const should = await shouldValidateFile("/proj/foo.lua");
      expect(should).toBe(true);
    });

    it("retorna false para .ts mesmo com regra *.luau ativa", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "luau-only",
        label: "Luau Only",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
      });
      setActiveMode("luau-only");

      const { shouldValidateFile } = await import("./../luauValidator.js");
      const should = await shouldValidateFile("/proj/foo.ts");
      expect(should).toBe(false);
    });

    it("retorna false para .py mesmo com regra *.luau ativa", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "luau-only-2",
        label: "Luau Only",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
      });
      setActiveMode("luau-only-2");

      const { shouldValidateFile } = await import("./../luauValidator.js");
      const should = await shouldValidateFile("/proj/foo.py");
      expect(should).toBe(false);
    });

    it("retorna false quando não há modo ativo (sem regras)", async () => {
      const { deactivateMode } = await import("./../modes.js");
      deactivateMode();

      const { shouldValidateFile } = await import("./../luauValidator.js");
      // Mesmo um .luau não é validado quando não há regra ativa
      const should = await shouldValidateFile("/proj/inexistente.luau");
      expect(should).toBe(false);
    });

    it("retorna true para .tf quando modo ativo tem regra genérica *.tf", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "tf-mode",
        label: "Terraform",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        validation: [
          {
            tool: "terraform_validate",
            filePattern: "*.tf",
            blocking: true,
            command: "terraform validate {file}",
          },
        ],
      });
      setActiveMode("tf-mode");

      const { shouldValidateFile } = await import("./../luauValidator.js");
      const should = await shouldValidateFile("/proj/main.tf");
      expect(should).toBe(true);
    });
  });

  // --- validateLuauBeforeWrite ---------------------------------------------

  describe("validateLuauBeforeWrite", () => {
    it("retorna ok=true para código válido (selene exit 0)", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      toolDetectorState.set("selene", "working");
      spawnState.set("selene", { code: 0, stdout: "" });

      const result = await validateLuauBeforeWrite(
        "/proj/clean.luau",
        "local x = 1\nprint(x)\n",
        [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
        tmpProject
      );
      expect(result.ok).toBe(true);
      expect(result.blockingError).toBeUndefined();
      expect(result.rulesApplied).toContain("selene_lint");
    });

    it("retorna ok=false para código com erro de sintaxe (selene exit != 0 com stdout)", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      toolDetectorState.set("selene", "working");
      spawnState.set("selene", {
        code: 1,
        stdout: "error.lua:1:1: syntax error: unexpected symbol near 'local'",
      });

      const result = await validateLuauBeforeWrite(
        "/proj/broken.luau",
        "local x = \n", // sintaxe quebrada
        [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
        tmpProject
      );
      expect(result.ok).toBe(false);
      expect(result.blockingError).toBeTruthy();
      expect(result.blockingError).toContain("Selene lint failed");
    });

    it("regra blocking (selene) retorna ok=false quando há erro", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      toolDetectorState.set("selene", "working");
      spawnState.set("selene", { code: 1, stdout: "undefined_variable: foo" });

      const result = await validateLuauBeforeWrite(
        "/proj/block.luau",
        "foo()\n",
        [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
        tmpProject
      );
      expect(result.ok).toBe(false);
      expect(result.warnings).toHaveLength(0); // blocking => não vai pra warnings
    });

    it("regra non-blocking (stylua) adiciona warning mas não bloqueia", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      toolDetectorState.set("stylua", "working");
      spawnState.set("stylua", { code: 1, stdout: "" });

      const result = await validateLuauBeforeWrite(
        "/proj/ugly.luau",
        "local x=1\n",
        [{ tool: "stylua_format", filePattern: "*.luau", blocking: false }],
        tmpProject
      );
      expect(result.ok).toBe(true); // non-blocking => não bloqueia
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("StyLua format check failed");
    });

    it("lida com arquivo vazio (sem erros)", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      toolDetectorState.set("selene", "working");
      spawnState.set("selene", { code: 0, stdout: "" });

      const result = await validateLuauBeforeWrite(
        "/proj/empty.luau",
        "",
        [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
        tmpProject
      );
      expect(result.ok).toBe(true);
      expect(result.rulesApplied).toContain("selene_lint");
    });

    it("lida com arquivo muito grande sem crashar", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      toolDetectorState.set("selene", "working");
      spawnState.set("selene", { code: 0, stdout: "" });

      // 100k linhas — deve apenas escrever no temp file e validar
      const bigContent = "local x = 1\n".repeat(100_000);
      const result = await validateLuauBeforeWrite(
        "/proj/huge.luau",
        bigContent,
        [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
        tmpProject
      );
      expect(result.ok).toBe(true);
    });

    it("pula regra quando tool não está instalada", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      // selene marcado como missing (default)
      const result = await validateLuauBeforeWrite(
        "/proj/no-tool.luau",
        "local x = 1\n",
        [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
        tmpProject
      );
      expect(result.ok).toBe(true);
      expect(result.rulesSkipped.length).toBeGreaterThan(0);
      expect(result.rulesSkipped[0]).toContain("não instalado");
    });

    it("aplica comando custom (rule.command) para validação genérica", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      // toolDetector detectTool("terraform_validate") — funciona com qualquer nome,
      // contanto que o status seja != missing
      toolDetectorState.set("terraform_validate", "working");
      spawnState.set("terraform", { code: 1, stdout: "Error: invalid config" });

      const result = await validateLuauBeforeWrite(
        "/proj/main.tf",
        "resource \"test\" \"foo\" {}\n",
        [
          {
            tool: "terraform_validate",
            filePattern: "*.tf",
            blocking: true,
            command: "terraform validate {file}",
          },
        ],
        tmpProject
      );
      expect(result.ok).toBe(false);
      expect(result.blockingError).toContain("terraform_validate");
    });
  });

  // --- getActiveValidationRules --------------------------------------------

  describe("getActiveValidationRules", () => {
    it("retorna regras do modo ativo (campo legacy luauValidation)", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "legacy-mode",
        label: "Legacy",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [
          { tool: "selene_lint", filePattern: "*.luau", blocking: true },
          { tool: "stylua_format", filePattern: "*.luau", blocking: false },
        ],
      });
      setActiveMode("legacy-mode");

      const { getActiveValidationRules } = await import("./../luauValidator.js");
      const rules = await getActiveValidationRules();
      expect(rules.length).toBe(2);
      expect(rules.map((r) => r.tool)).toContain("selene_lint");
      expect(rules.map((r) => r.tool)).toContain("stylua_format");
    });

    it("mescla luauValidation (legacy) com validation (novo campo)", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "merge-mode",
        label: "Merge",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],
        validation: [
          {
            tool: "terraform_validate",
            filePattern: "*.tf",
            blocking: true,
            command: "terraform validate {file}",
          },
        ],
      });
      setActiveMode("merge-mode");

      const { getActiveValidationRules } = await import("./../luauValidator.js");
      const rules = await getActiveValidationRules();
      expect(rules.length).toBe(2);
      const tools = rules.map((r) => r.tool);
      expect(tools).toContain("selene_lint");
      expect(tools).toContain("terraform_validate");
    });

    it("retorna vazio quando nenhum modo está ativo", async () => {
      const { deactivateMode } = await import("./../modes.js");
      deactivateMode();

      const { getActiveValidationRules } = await import("./../luauValidator.js");
      const rules = await getActiveValidationRules();
      expect(rules).toEqual([]);
    });
  });
});
