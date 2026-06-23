/**
 * modes.test.ts - Tests for the project-mode system.
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

describe("modes", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-modes-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("getBuiltInModes", () => {
    it("should find bundled roblox mode from defaults/modes/", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const modes = getBuiltInModes();
      // Sprint B: getBuiltInModes carrega SÓ <mode>/config.json quando o dir
      // existe (não carrega <mode>.json legacy para evitar duplicata).
      // O config.json novo usa 'tools'/'validators' (não enableTools/luauValidation).
      const robloxMode = modes.find((m) => m.name === "roblox");
      expect(robloxMode).toBeDefined();
      expect(robloxMode!.builtIn).toBe(true);
      expect(robloxMode!.label).toContain("Roblox");
      // Novo formato usa 'tools' (ou legacy 'enableTools' se for legacy)
      const toolsArr = (robloxMode as any).tools ?? robloxMode!.enableTools;
      expect(toolsArr?.length).toBeGreaterThan(0);
      const skillsArr = (robloxMode as any).skills ?? robloxMode!.enableSkills;
      expect(skillsArr?.length).toBeGreaterThan(0);
      const validatorsArr = (robloxMode as any).validators ?? robloxMode!.luauValidation;
      expect(validatorsArr).toBeDefined();
      expect(validatorsArr?.length).toBeGreaterThan(0);
    });

    it("roblox mode should include selene as blocking validation rule", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const modes = getBuiltInModes();
      const roblox = modes.find((m) => m.name === "roblox")!;
      const validators = (roblox as any).validators ?? roblox.luauValidation ?? [];
      const seleneRule = validators.find(
        (r: any) => r.tool === "selene_lint" && r.blocking
      );
      expect(seleneRule).toBeDefined();
      expect(seleneRule!.filePattern).toBe("*.luau");
    });

    it("roblox mode should activate all Roblox CLI tools", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const roblox = getBuiltInModes().find((m) => m.name === "roblox")!;
      const tools = (roblox as any).tools ?? roblox.enableTools;
      // Should include rojo, wally, lune, selene, rokit, wally-package-types, stylua
      expect(tools).toContain("tool:rojo_build");
      expect(tools).toContain("tool:wally_install");
      expect(tools).toContain("tool:lune_run");
      expect(tools).toContain("tool:selene_lint");
      expect(tools).toContain("tool:rokit_install");
      expect(tools).toContain("tool:stylua_format");
      expect(tools).not.toContain("tool:darklua_process");
    });

    it("roblox mode should enable strict mode + advanced thinking + high effort", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const roblox = getBuiltInModes().find((m) => m.name === "roblox")!;
      expect(roblox.strictMode).toBe(true);
      expect(roblox.advancedThinking).toBe(true);
      expect(roblox.readBeforeWrite).toBe(true);
      expect(roblox.effortLevel).toBe("high");
    });
  });

  describe("user mode persistence", () => {
    it("should save and load a user mode", async () => {
      const { saveUserMode, getUserModes, getMode } = await import("./../modes.js");
      const testMode = {
        name: "test-mode",
        label: "Test Mode",
        description: "A test mode",
        builtIn: false,
        enableTools: ["tool:foo"],
        enableSkills: [],
        enableFeatures: ["feature:bar"],
        effortLevel: "medium" as const,
        strictMode: true,
        readBeforeWrite: true,
        advancedThinking: false,
      };
      saveUserMode(testMode);

      const users = getUserModes();
      expect(users.find((m) => m.name === "test-mode")).toBeDefined();

      const loaded = getMode("test-mode");
      expect(loaded).toBeDefined();
      expect(loaded!.label).toBe("Test Mode");
      expect(loaded!.enableTools).toContain("tool:foo");
    });

    it("should delete a user mode", async () => {
      const { saveUserMode, deleteUserMode, getMode } = await import("./../modes.js");
      saveUserMode({
        name: "to-delete",
        label: "Delete Me",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      });
      expect(getMode("to-delete")).toBeDefined();

      const deleted = deleteUserMode("to-delete");
      expect(deleted).toBe(true);
      expect(getMode("to-delete")).toBeNull();
    });

    it("should return false when deleting non-existent mode", async () => {
      const { deleteUserMode } = await import("./../modes.js");
      const result = deleteUserMode("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("active mode", () => {
    it("should never return null when no active mode set (BUG FIX Sprint 12)", async () => {
      const { getActiveModeName, getActiveMode } = await import("./../modes.js");
      // getActiveModeName ainda retorna null quando nenhum modo está setado.
      expect(getActiveModeName()).toBeNull();
      // BUG FIX (Sprint 12): getActiveMode NUNCA retorna null — retorna o
      // modo "normal" (built-in) ou um minimal default ModeDefinition.
      const active = getActiveMode();
      expect(active).not.toBeNull();
      expect(active!.name).toBe("normal");
    });

    it("should persist active mode across calls", async () => {
      const { setActiveMode, getActiveModeName, saveUserMode, getMode } = await import("./../modes.js");
      saveUserMode({
        name: "active-test",
        label: "Active Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      });
      expect(getMode("active-test")).toBeDefined();

      setActiveMode("active-test");
      expect(getActiveModeName()).toBe("active-test");
    });

    it("should clear active mode when null passed", async () => {
      const { setActiveMode, getActiveModeName, deactivateMode } = await import("./../modes.js");
      setActiveMode("temp");
      expect(getActiveModeName()).toBe("temp");

      deactivateMode();
      expect(getActiveModeName()).toBeNull();
    });
  });

  describe("suggestMode", () => {
    it("should suggest Roblox mode when prompt mentions roblox", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "I want to build a Roblox game with Luau",
        availableTools: ["tool:rojo_build", "tool:selene_lint", "tool:stylua_format"],
        availableSkills: [],
        availableFeatures: ["feature:strict_gate", "feature:read_before_write"],
      });

      expect(suggestion.name).toMatch(/roblox/);
      expect(suggestion.enableTools).toContain("tool:rojo_build");
      expect(suggestion.enableTools).toContain("tool:selene_lint");
      expect(suggestion.effortLevel).toBe("high");
      expect(suggestion.strictMode).toBe(true);
      expect(suggestion.luauValidation).toBeDefined();
    });

    it("should suggest Rust mode when prompt mentions rust", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "I'm writing a CLI in Rust with cargo",
        availableTools: [],
        availableSkills: [],
        availableFeatures: ["feature:strict_gate"],
      });

      expect(suggestion.name).toMatch(/rust/);
      expect(suggestion.strictMode).toBe(true);
    });

    it("should filter suggested tools to only those available", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "roblox game",
        availableTools: ["tool:rojo_build"],  // only one available
        availableSkills: [],
        availableFeatures: [],
      });

      // Should only include tools that are in availableTools
      expect(suggestion.enableTools).toContain("tool:rojo_build");
      expect(suggestion.enableTools).not.toContain("tool:wally_install");
    });

    it("should fallback to generic mode when no keyword matches", async () => {
      const { suggestMode } = await import("./../modes.js");
      const suggestion = suggestMode({
        prompt: "write a script that sorts files",
        availableTools: [],
        availableSkills: [],
        availableFeatures: [],
      });

      expect(suggestion.name).toBe("custom");
      expect(suggestion.effortLevel).toBe("high");
      expect(suggestion.strictMode).toBe(true);
    });
  });

  describe("confirmAndSaveMode", () => {
    it("should save a suggested mode with proper metadata", async () => {
      const { confirmAndSaveMode, getMode } = await import("./../modes.js");
      const mode = confirmAndSaveMode({
        name: "my-custom",
        label: "My Custom",
        description: "user prompt here",
        enableTools: ["tool:foo"],
        enableSkills: [],
        enableFeatures: ["feature:bar"],
        effortLevel: "max",
        strictMode: true,
        readBeforeWrite: true,
        advancedThinking: true,
        reasoning: "because...",
      });

      expect(mode.name).toBe("my-custom");
      expect(mode.builtIn).toBe(false);
      expect(mode.userPrompt).toBe("user prompt here");
      expect(mode.createdAt).toBeDefined();

      // Verify it was actually saved
      const loaded = getMode("my-custom");
      expect(loaded).toBeDefined();
      expect(loaded!.enableTools).toContain("tool:foo");
    });
  });

  describe("getAllModes", () => {
    it("should include built-in and user modes", async () => {
      const { getAllModes, saveUserMode } = await import("./../modes.js");
      saveUserMode({
        name: "user-custom",
        label: "User Custom",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      });

      const all = getAllModes();
      // Should include built-in roblox + user-custom
      const names = all.map((m) => m.name);
      expect(names).toContain("roblox");
      expect(names).toContain("user-custom");
    });

    it("user mode with same name as built-in should override", async () => {
      const { getAllModes, saveUserMode } = await import("./../modes.js");
      saveUserMode({
        name: "roblox",
        label: "Custom Roblox Override",
        description: "user override",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      });

      const all = getAllModes();
      const robloxMode = all.find((m) => m.name === "roblox");
      expect(robloxMode).toBeDefined();
      // The user's override should win
      expect(robloxMode!.label).toBe("Custom Roblox Override");
    });
  });

  describe("seedBuiltInModes", () => {
    it("should copy built-in modes to user dir on first call", async () => {
      const { seedBuiltInModes } = await import("./../modes.js");
      const count = seedBuiltInModes();
      expect(count).toBeGreaterThan(0);

      // Verify the file exists in user dir
      const userModesDir = path.join(tmpHome, ".claude-killer", "modes");
      const files = fs.readdirSync(userModesDir);
      expect(files).toContain("roblox.json");
    });

    it("should not overwrite existing user modes (idempotent)", async () => {
      const { seedBuiltInModes } = await import("./../modes.js");
      const first = seedBuiltInModes();
      const second = seedBuiltInModes();
      // Second call should not copy anything
      expect(second).toBe(0);
      expect(first).toBeGreaterThan(0);
    });
  });
});
