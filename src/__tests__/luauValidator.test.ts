/**
 * luauValidator.test.ts - Tests for pre-write Luau validation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("luauValidator", () => {
  let tmpHome: string;
  let tmpProject: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-luau-home-"));
    tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-luau-proj-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.cwd = () => tmpProject;
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("matchesPattern (via shouldValidateFile)", () => {
    it("should not validate when active mode is 'normal' (no rules)", async () => {
      // BUG FIX (Sprint 12): getActiveMode NUNCA retorna null — quando nenhum
      // modo está setado, retorna o modo "normal" (built-in, sem regras).
      // Usamos setActiveMode(null) para garantir estado limpo (deactivateMode
      // chamaria getActiveMode que pode falhar com o modo "normal" novo formato).
      const { shouldValidateFile, getActiveValidationRules } = await import("./../luauValidator.js");
      const { setActiveMode } = await import("./../modes.js");
      setActiveMode(null);

      const rules = await getActiveValidationRules();
      expect(rules).toEqual([]);

      const should = await shouldValidateFile("/path/to/test.luau");
      expect(should).toBe(false);
    });

    it("should not validate .ts files even with rules", async () => {
      const { shouldValidateFile } = await import("./../luauValidator.js");
      const should = await shouldValidateFile("/path/to/test.ts");
      expect(should).toBe(false);
    });

    it("should not validate .py files", async () => {
      const { shouldValidateFile } = await import("./../luauValidator.js");
      const should = await shouldValidateFile("/path/to/test.py");
      expect(should).toBe(false);
    });

    it("should not validate .js files", async () => {
      const { shouldValidateFile } = await import("./../luauValidator.js");
      const should = await shouldValidateFile("/path/to/test.js");
      expect(should).toBe(false);
    });
  });

  describe("validateLuauBeforeWrite", () => {
    it("should return ok=true when no rules apply", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      const result = await validateLuauBeforeWrite(
        "/path/to/test.luau",
        "local x = 1",
        [],
        tmpProject
      );
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(result.rulesApplied).toEqual([]);
    });

    it("should skip rules for non-matching file patterns", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      const result = await validateLuauBeforeWrite(
        "/path/to/test.lua",  // .lua file
        "local x = 1",
        [{ tool: "selene_lint", filePattern: "*.luau", blocking: true }],  // only .luau
        tmpProject
      );
      expect(result.ok).toBe(true);
      expect(result.rulesApplied).toEqual([]);
    });

    it("should skip rules when tool is not installed", async () => {
      const { validateLuauBeforeWrite } = await import("./../luauValidator.js");
      // Use a tool name that definitely isn't installed
      const result = await validateLuauBeforeWrite(
        "/path/to/test.luau",
        "local x = 1",
        [{ tool: "nonexistent_tool_xyz", filePattern: "*.luau", blocking: true }],
        tmpProject
      );
      expect(result.ok).toBe(true);
      expect(result.rulesSkipped.length).toBeGreaterThan(0);
      expect(result.rulesSkipped[0]).toContain("não instalado");
    });
  });

  describe("integration with modes", () => {
    it("should pick up rules from active mode", async () => {
      // Save a user mode with validation rules and activate it
      const { saveUserMode, setActiveMode, getActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-luau-mode",
        label: "Test Luau",
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
      setActiveMode("test-luau-mode");

      const active = getActiveMode();
      expect(active).toBeDefined();
      expect(active!.luauValidation).toBeDefined();
      expect(active!.luauValidation!.length).toBe(2);

      const { getActiveValidationRules, shouldValidateFile } = await import("./../luauValidator.js");
      const rules = await getActiveValidationRules();
      expect(rules.length).toBe(2);

      // .luau file should be validated
      const shouldLuau = await shouldValidateFile("/path/to/test.luau");
      expect(shouldLuau).toBe(true);

      // .ts file should not
      const shouldTs = await shouldValidateFile("/path/to/test.ts");
      expect(shouldTs).toBe(false);
    });

    it("should return no rules when active mode is 'normal'", async () => {
      // BUG FIX (Sprint 12): getActiveMode nunca retorna null. Quando nenhum
      // modo está setado, retorna o modo "normal" (sem regras).
      // Usamos setActiveMode(null) para garantir estado limpo.
      const { setActiveMode } = await import("./../modes.js");
      setActiveMode(null);

      const { getActiveValidationRules } = await import("./../luauValidator.js");
      const rules = await getActiveValidationRules();
      expect(rules).toEqual([]);
    });
  });
});
