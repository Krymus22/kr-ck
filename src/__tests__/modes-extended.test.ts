/**
 * modes-extended.test.ts - Expansão da cobertura de src/modes.ts.
 *
 * Foca em cenários edge não cobertos por modes.test.ts:
 *   - suggestMode() detecção de contexto por linguagem (Python/TS/Roblox/Rust)
 *   - suggestMode() fallback para modo "custom"
 *   - confirmAndSaveMode() validação e persistência
 *   - saveUserMode() formato JSON + flag builtIn=false
 *   - deleteUserMode() erro e sucesso
 *   - applyMode() aplica esforço, strictMode via env var
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger para evitar ruído no output
vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// Mock contornável para extensionCenter (applyMode faz import dinâmico)
const extState = vi.hoisted(() => ({
  setEffortLevel: vi.fn(),
  toggleExtension: vi.fn(() => true),
  setTriggerMode: vi.fn(() => "always"),
  getAllExtensions: vi.fn(() => []),
}));

vi.mock("./../extensionCenter.js", () => ({
  toggleExtension: extState.toggleExtension,
  setTriggerMode: extState.setTriggerMode,
  getAllExtensions: extState.getAllExtensions,
}));

// Mock para effortLevels (applyMode faz import dinâmico)
vi.mock("./../effortLevels.js", () => ({
  setEffortLevel: extState.setEffortLevel,
}));

describe("modes (extended)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-modes-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    // Limpa env vars que applyMode pode ter setado em testes anteriores
    delete process.env.STRICT_MODE;
    delete process.env.READ_BEFORE_WRITE;
    delete process.env.ADVANCED_THINKING;
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  // --- suggestMode: detecção de contexto por linguagem ---------------------

  describe("suggestMode - detecção de contexto", () => {
    it("detecta contexto Python (prompt menciona .py files / python)", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "Quero criar scripts Python com pytest e pip",
        availableTools: [],
        availableSkills: [],
        availableFeatures: ["feature:strict_gate", "feature:read_before_write"],
      });
      // Nome deve refletir python-custom (heurística do módulo)
      expect(suggestion.name).toBe("python-custom");
      expect(suggestion.label).toBe("Python");
      // Por padrão esforço alto + strict mode
      expect(suggestion.effortLevel).toBe("high");
      expect(suggestion.strictMode).toBe(true);
      // Não deve sugerir ferramentas roblox
      expect(suggestion.enableTools).not.toContain("tool:rojo_build");
      expect(suggestion.enableTools).not.toContain("tool:selene_lint");
    });

    it("detecta contexto TypeScript (prompt menciona typescript/node/vitest)", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "Projeto em TypeScript usando vitest e node",
        availableTools: [],
        availableSkills: [],
        availableFeatures: ["feature:strict_gate"],
      });
      expect(suggestion.name).toBe("ts-custom");
      expect(suggestion.label).toBe("TypeScript/Node");
      expect(suggestion.strictMode).toBe(true);
      // Não sugere luauValidation para TS
      expect(suggestion.luauValidation).toBeUndefined();
    });

    it("detecta contexto Roblox (prompt menciona .luau/roblox)", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "Vou programar um jogo Roblox em .luau usando Rojo",
        availableTools: [
          "tool:rojo_build",
          "tool:rojo_serve",
          "tool:selene_lint",
          "tool:stylua_format",
          "tool:lune_run",
          "tool:rokit_install",
        ],
        availableSkills: [],
        availableFeatures: [
          "feature:strict_gate",
          "feature:read_before_write",
          "feature:think_tool",
        ],
      });
      expect(suggestion.name).toBe("roblox-custom");
      expect(suggestion.label).toBe("Roblox (External)");
      // Ferramentas filtradas para as disponíveis
      expect(suggestion.enableTools).toContain("tool:rojo_build");
      expect(suggestion.enableTools).toContain("tool:selene_lint");
      // Deve sugerir regras luau (selene blocking, stylua non-blocking)
      expect(suggestion.luauValidation).toBeDefined();
      const seleneRule = suggestion.luauValidation!.find(
        (r) => r.tool === "selene_lint" && r.blocking
      );
      expect(seleneRule).toBeDefined();
      expect(seleneRule!.filePattern).toBe("*.luau");
      const styluaRule = suggestion.luauValidation!.find(
        (r) => r.tool === "stylua_format" && !r.blocking
      );
      expect(styluaRule).toBeDefined();
    });

    it("retorna fallback 'custom' quando contexto é desconhecido", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "Escreva um script que organiza arquivos por data",
        availableTools: [],
        availableSkills: [],
        availableFeatures: [],
      });
      expect(suggestion.name).toBe("custom");
      expect(suggestion.label).toBe("Custom");
      expect(suggestion.reasoning).toMatch(/conservative/i);
      // Não sugere luau validation
      expect(suggestion.luauValidation).toBeUndefined();
    });

    it("filtra features sugeridas conforme availability", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "roblox game",
        availableTools: [],
        availableSkills: [],
        // Não passar feature:strict_gate — não deve aparecer
        availableFeatures: ["feature:read_before_write"],
      });
      expect(suggestion.enableFeatures).toContain("feature:read_before_write");
      expect(suggestion.enableFeatures).not.toContain("feature:strict_gate");
    });
  });

  // --- confirmAndSaveMode ---------------------------------------------------

  describe("confirmAndSaveMode", () => {
    it("valida sugestão e salva em arquivo com metadata correta", async () => {
      const { confirmAndSaveMode, getMode } = await import("./../modes.js");
      const mode = confirmAndSaveMode({
        name: "valid-mode",
        label: "Valid Mode",
        description: "prompt do usuário",
        enableTools: ["tool:foo"],
        enableSkills: ["skill:bar"],
        enableFeatures: ["feature:baz"],
        effortLevel: "max",
        strictMode: true,
        readBeforeWrite: true,
        advancedThinking: false,
        reasoning: "razão...",
      });
      expect(mode.name).toBe("valid-mode");
      expect(mode.builtIn).toBe(false);
      expect(mode.userPrompt).toBe("prompt do usuário");
      expect(mode.createdAt).toBeTruthy();

      // Verifica persistência no disco
      const loaded = getMode("valid-mode");
      expect(loaded).not.toBeNull();
      expect(loaded!.enableTools).toEqual(["tool:foo"]);
      expect(loaded!.effortLevel).toBe("max");

      // Verifica formato JSON no arquivo físico
      const filePath = path.join(tmpHome, ".claude-killer", "modes", "valid-mode.json");
      expect(fs.existsSync(filePath)).toBe(true);
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.name).toBe("valid-mode");
      expect(parsed.builtIn).toBe(false);
      // JSON deve estar formatado com indentação 2 espaços
      expect(raw).toContain('\n  "name"');
    });

    it("rejeita sugestão sem nome (throw via saveUserMode)", async () => {
      const { confirmAndSaveMode } = await import("./../modes.js");
      expect(() =>
        confirmAndSaveMode({
          name: "",
          label: "Sem Nome",
          description: "",
          enableTools: [],
          enableSkills: [],
          enableFeatures: [],
          effortLevel: "medium",
          strictMode: false,
          readBeforeWrite: false,
          advancedThinking: false,
          reasoning: "",
        })
      ).toThrow(/Mode name is required/);
    });
  });

  // --- saveUserMode ---------------------------------------------------------

  describe("saveUserMode", () => {
    it("cria arquivo físico com formato JSON correto", async () => {
      const { saveUserMode } = await import("./../modes.js");
      saveUserMode({
        name: "json-test",
        label: "JSON Test",
        description: "verificar formato",
        builtIn: true, // deve ser sobrescrito para false
        enableTools: ["tool:a"],
        enableSkills: [],
        enableFeatures: [],
        effortLevel: "low",
      });
      const filePath = path.join(tmpHome, ".claude-killer", "modes", "json-test.json");
      expect(fs.existsSync(filePath)).toBe(true);
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed.name).toBe("json-test");
      expect(parsed.label).toBe("JSON Test");
      expect(parsed.enableTools).toEqual(["tool:a"]);
      expect(parsed.effortLevel).toBe("low");
      // Arquivo deve conter createdAt
      expect(parsed.createdAt).toBeTruthy();
    });

    it("sempre marca builtIn=false ao salvar (mesmo se entrada disser true)", async () => {
      const { saveUserMode, getUserModes } = await import("./../modes.js");
      saveUserMode({
        name: "force-builtin",
        label: "Force",
        description: "",
        builtIn: true,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      });
      const users = getUserModes();
      const m = users.find((u) => u.name === "force-builtin");
      expect(m).toBeDefined();
      expect(m!.builtIn).toBe(false);
    });

    it("preserva createdAt quando já fornecido", async () => {
      const { saveUserMode, getMode } = await import("./../modes.js");
      const customDate = "2024-01-01T00:00:00.000Z";
      saveUserMode({
        name: "preserve-date",
        label: "Preserve",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        createdAt: customDate,
      });
      const loaded = getMode("preserve-date");
      expect(loaded!.createdAt).toBe(customDate);
    });
  });

  // --- deleteUserMode -------------------------------------------------------

  describe("deleteUserMode", () => {
    it("remove arquivo físico do disco", async () => {
      const { saveUserMode, deleteUserMode } = await import("./../modes.js");
      saveUserMode({
        name: "to-remove",
        label: "Remove Me",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      });
      const filePath = path.join(tmpHome, ".claude-killer", "modes", "to-remove.json");
      expect(fs.existsSync(filePath)).toBe(true);

      const result = deleteUserMode("to-remove");
      expect(result).toBe(true);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it("retorna false quando o modo não existe", async () => {
      const { deleteUserMode } = await import("./../modes.js");
      const result = deleteUserMode("modo-inexistente-xyz");
      expect(result).toBe(false);
    });
  });

  // --- applyMode ------------------------------------------------------------

  describe("applyMode", () => {
    it("aplica esforço do modo chamando setEffortLevel", async () => {
      const { saveUserMode, applyMode } = await import("./../modes.js");
      saveUserMode({
        name: "effort-test",
        label: "Effort",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        effortLevel: "max",
      });

      const result = await applyMode("effort-test");
      expect(result.success).toBe(true);
      expect(extState.setEffortLevel).toHaveBeenCalledWith("max");
    });

    it("aplica strictMode=true via env var STRICT_MODE", async () => {
      const { saveUserMode, applyMode } = await import("./../modes.js");
      saveUserMode({
        name: "strict-on",
        label: "Strict On",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        strictMode: true,
      });

      const result = await applyMode("strict-on");
      expect(result.success).toBe(true);
      expect(process.env.STRICT_MODE).toBe("true");
    });

    it("aplica strictMode=false via env var STRICT_MODE", async () => {
      const { saveUserMode, applyMode } = await import("./../modes.js");
      saveUserMode({
        name: "strict-off",
        label: "Strict Off",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        strictMode: false,
      });

      const result = await applyMode("strict-off");
      expect(result.success).toBe(true);
      expect(process.env.STRICT_MODE).toBe("false");
    });

    it("aplica readBeforeWrite e advancedThinking via env vars", async () => {
      const { saveUserMode, applyMode } = await import("./../modes.js");
      saveUserMode({
        name: "env-vars",
        label: "Env Vars",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        readBeforeWrite: true,
        advancedThinking: true,
      });

      const result = await applyMode("env-vars");
      expect(result.success).toBe(true);
      expect(process.env.READ_BEFORE_WRITE).toBe("true");
      expect(process.env.ADVANCED_THINKING).toBe("true");
    });

    it("retorna erro quando modo não existe", async () => {
      const { applyMode } = await import("./../modes.js");
      const result = await applyMode("nao-existe-modo");
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/not found/);
    });
  });
});
