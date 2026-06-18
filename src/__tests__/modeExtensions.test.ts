/**
 * modeExtensions.test.ts - Tests for the mode extension bridge.
 *
 * Verifies that custom patterns/sources/symbols/hooks defined in a mode JSON
 * are correctly merged with built-in defaults. This is the core of the
 * "fully externalizable modes" feature.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("modeExtensions", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-modeext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("getActiveSafetyPatterns", () => {
    it("should return only built-in patterns when no mode active", async () => {
      const { getActiveSafetyPatterns } = await import("./../modeExtensions.js");
      const patterns = await getActiveSafetyPatterns();
      // Built-in DANGEROUS_PATTERNS has 20 entries
      expect(patterns.length).toBeGreaterThanOrEqual(20);
    });

    it("should merge built-in + custom patterns when mode has safetyPatterns", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-safety",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        safetyPatterns: [
          {
            regex: "terraform\\s+destroy",
            description: "terraform destroy",
            severity: "high",
          },
          {
            regex: "kubectl\\s+delete",
            description: "kubectl delete",
            severity: "medium",
          },
        ],
      });
      setActiveMode("test-safety");

      const { getActiveSafetyPatterns } = await import("./../modeExtensions.js");
      const patterns = await getActiveSafetyPatterns();
      // 20 built-in + 2 custom = 22
      expect(patterns.length).toBeGreaterThanOrEqual(22);
      expect(patterns.some((p) => p.description.includes("terraform destroy"))).toBe(true);
      expect(patterns.some((p) => p.description.includes("kubectl delete"))).toBe(true);
    });

    it("should skip invalid regex in custom patterns", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-invalid-regex",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        safetyPatterns: [
          {
            regex: "[invalid regex",  // invalid - unclosed bracket
            description: "invalid",
            severity: "low",
          },
        ],
      });
      setActiveMode("test-invalid-regex");

      const { getActiveSafetyPatterns } = await import("./../modeExtensions.js");
      const patterns = await getActiveSafetyPatterns();
      // Should still return built-in patterns (invalid one skipped)
      expect(patterns.length).toBeGreaterThanOrEqual(20);
      expect(patterns.some((p) => p.description === "invalid")).toBe(false);
    });
  });

  describe("getActiveResearchSources", () => {
    it("should return empty object when no mode active", async () => {
      const { getActiveResearchSources } = await import("./../modeExtensions.js");
      const sources = await getActiveResearchSources();
      expect(sources).toEqual({});
    });

    it("should return mode-specific research sources", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-research",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        researchSources: {
          terraform: ["terraform.io/docs", "registry.terraform.io"],
          kubernetes: ["kubernetes.io/docs"],
        },
      });
      setActiveMode("test-research");

      const { getActiveResearchSources } = await import("./../modeExtensions.js");
      const sources = await getActiveResearchSources();
      expect(sources.terraform).toContain("terraform.io/docs");
      expect(sources.kubernetes).toContain("kubernetes.io/docs");
    });
  });

  describe("getActiveSymbolPatterns", () => {
    it("should return empty array when no mode active", async () => {
      const { getActiveSymbolPatterns } = await import("./../modeExtensions.js");
      const patterns = await getActiveSymbolPatterns();
      expect(patterns).toEqual([]);
    });

    it("should return mode-specific symbol patterns", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-symbols",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        symbolPatterns: [
          {
            language: "hcl",
            extensions: [".tf", ".hcl"],
            patterns: ['^\\s*resource\\s+"([\\w_-]+)"'],
          },
        ],
      });
      setActiveMode("test-symbols");

      const { getActiveSymbolPatterns } = await import("./../modeExtensions.js");
      const patterns = await getActiveSymbolPatterns();
      expect(patterns.length).toBe(1);
      expect(patterns[0]!.language).toBe("hcl");
      expect(patterns[0]!.extensions).toContain(".tf");
    });
  });

  describe("getActiveValidationRules", () => {
    it("should return empty array when no mode active", async () => {
      const { getActiveValidationRules } = await import("./../modeExtensions.js");
      const rules = await getActiveValidationRules();
      expect(rules).toEqual([]);
    });

    it("should return luauValidation rules (legacy field)", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-luau",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [
          { tool: "selene_lint", filePattern: "*.luau", blocking: true },
        ],
      });
      setActiveMode("test-luau");

      const { getActiveValidationRules } = await import("./../modeExtensions.js");
      const rules = await getActiveValidationRules();
      expect(rules.length).toBe(1);
      expect(rules[0]!.tool).toBe("selene_lint");
    });

    it("should return validation rules (new generic field)", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-generic",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        validation: [
          { tool: "terraform_validate", filePattern: "*.tf", blocking: true, command: "terraform validate {file}" },
        ],
      });
      setActiveMode("test-generic");

      const { getActiveValidationRules } = await import("./../modeExtensions.js");
      const rules = await getActiveValidationRules();
      expect(rules.length).toBe(1);
      expect(rules[0]!.tool).toBe("terraform_validate");
      expect(rules[0]!.command).toBe("terraform validate {file}");
    });

    it("should merge luauValidation + validation when both set", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-both",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        luauValidation: [
          { tool: "selene_lint", filePattern: "*.luau", blocking: true },
        ],
        validation: [
          { tool: "terraform_validate", filePattern: "*.tf", blocking: true, command: "terraform validate {file}" },
        ],
      });
      setActiveMode("test-both");

      const { getActiveValidationRules } = await import("./../modeExtensions.js");
      const rules = await getActiveValidationRules();
      expect(rules.length).toBe(2);
      expect(rules.some((r) => r.tool === "selene_lint")).toBe(true);
      expect(rules.some((r) => r.tool === "terraform_validate")).toBe(true);
    });
  });

  describe("getActivePostEditHooks", () => {
    it("should return empty array when no mode active", async () => {
      const { getActivePostEditHooks } = await import("./../modeExtensions.js");
      const hooks = await getActivePostEditHooks();
      expect(hooks).toEqual([]);
    });

    it("should return post-edit hooks from active mode", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-hooks",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        hooks: {
          postEdit: [
            { filePattern: "*.tf", command: "terraform fmt {file}" },
            { filePattern: "*.py", command: "black {file}" },
          ],
        },
      });
      setActiveMode("test-hooks");

      const { getActivePostEditHooks } = await import("./../modeExtensions.js");
      const hooks = await getActivePostEditHooks();
      expect(hooks.length).toBe(2);
      expect(hooks[0]!.command).toContain("terraform fmt");
    });
  });

  describe("getActivePreCommitHooks", () => {
    it("should return empty array when no mode active", async () => {
      const { getActivePreCommitHooks } = await import("./../modeExtensions.js");
      const hooks = await getActivePreCommitHooks();
      expect(hooks).toEqual([]);
    });

    it("should return pre-commit hooks from active mode", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-precommit",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        hooks: {
          preCommit: [
            { filePattern: "*.tf", command: "tflint", blocking: true },
          ],
        },
      });
      setActiveMode("test-precommit");

      const { getActivePreCommitHooks } = await import("./../modeExtensions.js");
      const hooks = await getActivePreCommitHooks();
      expect(hooks.length).toBe(1);
      expect(hooks[0]!.command).toBe("tflint");
    });
  });

  describe("runPostEditHooks", () => {
    it("should return empty string when no hooks", async () => {
      const { runPostEditHooks } = await import("./../modeExtensions.js");
      const result = await runPostEditHooks("/test/file.tf");
      expect(result).toBe("");
    });

    it("should return empty string when no matching file pattern", async () => {
      const { saveUserMode, setActiveMode } = await import("./../modes.js");
      saveUserMode({
        name: "test-no-match",
        label: "Test",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
        hooks: {
          postEdit: [
            { filePattern: "*.tf", command: "terraform fmt {file}" },
          ],
        },
      });
      setActiveMode("test-no-match");

      const { runPostEditHooks } = await import("./../modeExtensions.js");
      const result = await runPostEditHooks("/test/file.py");
      expect(result).toBe("");
    });
  });

  describe("DevOps built-in mode (integration)", () => {
    it("devops mode should have custom safetyPatterns", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const devops = getBuiltInModes().find((m) => m.name === "devops");
      expect(devops).toBeDefined();
      expect(devops!.safetyPatterns).toBeDefined();
      expect(devops!.safetyPatterns!.length).toBeGreaterThan(0);
      expect(devops!.safetyPatterns!.some((p) => p.description.includes("terraform destroy"))).toBe(true);
    });

    it("devops mode should have custom validation with commands", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const devops = getBuiltInModes().find((m) => m.name === "devops");
      expect(devops!.validation).toBeDefined();
      expect(devops!.validation!.some((r) => r.command)).toBe(true);
    });

    it("devops mode should have custom researchSources", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const devops = getBuiltInModes().find((m) => m.name === "devops");
      expect(devops!.researchSources).toBeDefined();
      expect(devops!.researchSources!.terraform).toContain("terraform.io/docs");
    });

    it("devops mode should have custom symbolPatterns", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const devops = getBuiltInModes().find((m) => m.name === "devops");
      expect(devops!.symbolPatterns).toBeDefined();
      expect(devops!.symbolPatterns!.some((s) => s.language === "hcl")).toBe(true);
    });

    it("devops mode should have hooks (postEdit + preCommit)", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const devops = getBuiltInModes().find((m) => m.name === "devops");
      expect(devops!.hooks).toBeDefined();
      expect(devops!.hooks!.postEdit).toBeDefined();
      expect(devops!.hooks!.preCommit).toBeDefined();
      expect(devops!.hooks!.postEdit!.length).toBeGreaterThan(0);
    });

    it("roblox mode should still have all original fields (no regression)", async () => {
      const { getBuiltInModes } = await import("./../modes.js");
      const roblox = getBuiltInModes().find((m) => m.name === "roblox");
      expect(roblox).toBeDefined();
      // All original fields must still be present
      expect(roblox!.enableTools.length).toBe(12);  // 13 - darklua (removed)
      expect(roblox!.enableSkills.length).toBe(16);
      expect(roblox!.enableFeatures.length).toBe(14);
      expect(roblox!.effortLevel).toBe("high");
      expect(roblox!.strictMode).toBe(true);
      // autoResearch defaults to true (not set explicitly in roblox.json anymore)
      expect(roblox!.autoResearch).not.toBe(false);
      expect(roblox!.safetyReview).toBe(true);
      expect(roblox!.luauValidation).toBeDefined();
      expect(roblox!.luauValidation!.length).toBe(4);
    });
  });
});
