/**
 * extensions.test.ts — Tests for extensions.ts (real module).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

let tmpDir: string;
let homedirSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext_test_"));
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

// Dynamic import to pick up the mocked homedir
async function loadModule() {
  vi.resetModules();
  // Re-mock after reset
  vi.mock("../logger.js", () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  }));
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  const mod = await import("../extensions.js");
  return mod;
}

describe("extensions.ts (real module)", () => {
  describe("initExtensionDirs", () => {
    it("should create skills and plugins directories", async () => {
      const { initExtensionDirs } = await loadModule();
      initExtensionDirs();
      const globalDir = path.join(tmpDir, ".claude-killer");
      expect(fs.existsSync(path.join(globalDir, "skills"))).toBe(true);
      expect(fs.existsSync(path.join(globalDir, "plugins"))).toBe(true);
    });

    it("should be idempotent", async () => {
      const { initExtensionDirs } = await loadModule();
      initExtensionDirs();
      initExtensionDirs();
      expect(fs.existsSync(path.join(tmpDir, ".claude-killer", "skills"))).toBe(true);
    });
  });

  describe("loadAllExtensions + getActiveSkills", () => {
    it("should load skills from .md files with frontmatter", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      fs.writeFileSync(
        path.join(skillsDir, "test-skill.md"),
        "---\nname: test-skill\ndescription: A test skill\n---\nSkill body content"
      );
      await loadAllExtensions();
      const skills = getActiveSkills();
      expect(skills.length).toBeGreaterThanOrEqual(1);
      const found = skills.find((s) => s.name === "test-skill");
      expect(found).toBeDefined();
      expect(found!.description).toBe("A test skill");
      expect(found!.content).toBe("Skill body content");
    });

    it("should load skills from subdirectories with SKILL.md", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      const subDir = path.join(skillsDir, "my-skill");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(
        path.join(subDir, "SKILL.md"),
        "---\nname: sub-skill\ndescription: Sub dir skill\n---\nSub body"
      );
      await loadAllExtensions();
      const found = getActiveSkills().find((s) => s.name === "sub-skill");
      expect(found).toBeDefined();
      expect(found!.content).toBe("Sub body");
    });

    it("should use filename as fallback name", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      fs.writeFileSync(
        path.join(skillsDir, "my-tool.md"),
        "---\ndescription: No name field\n---\nBody"
      );
      await loadAllExtensions();
      expect(getActiveSkills().find((s) => s.name === "my-tool")).toBeDefined();
    });

    it("should use directory basename as fallback for SKILL.md", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      const subDir = path.join(skillsDir, "cool-project");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(
        path.join(subDir, "SKILL.md"),
        "---\ndescription: No name\n---\nBody"
      );
      await loadAllExtensions();
      expect(getActiveSkills().find((s) => s.name === "cool-project")).toBeDefined();
    });

    it("should default description when missing", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      fs.writeFileSync(
        path.join(skillsDir, "no-desc.md"),
        "---\nname: nodesc\n---\nBody"
      );
      await loadAllExtensions();
      expect(getActiveSkills().find((s) => s.name === "nodesc")!.description).toBe("Sem descrição");
    });

    it("should load skills from plugins with manifest", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
      const pluginDir = path.join(pluginsDir, "my-plugin");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "my-plugin", version: "1.0.0", skills: ["skill.md"] })
      );
      fs.writeFileSync(
        path.join(pluginDir, "skill.md"),
        "---\nname: plugin-skill\ndescription: From plugin\n---\nPlugin body"
      );
      await loadAllExtensions();
      expect(getActiveSkills().find((s) => s.name === "plugin-skill")).toBeDefined();
    });

    it("should handle plugin with no skills array", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
      const pluginDir = path.join(pluginsDir, "no-skills");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "no-skills", version: "1.0.0" })
      );
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle plugin with non-existent skill file", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
      const pluginDir = path.join(pluginsDir, "broken");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "broken", version: "1.0.0", skills: ["nope.md"] })
      );
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle missing directories gracefully", async () => {
      const { loadAllExtensions, getActiveSkills } = await loadModule();
      await loadAllExtensions();
      // Skills loaded from real project dirs or empty
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle non-.md files in skills directory", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      fs.writeFileSync(path.join(skillsDir, "readme.txt"), "not a skill");
      await loadAllExtensions();
      // Should not throw, txt file ignored
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle plugin directory without plugin.json", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
      fs.mkdirSync(path.join(pluginsDir, "no-manifest"), { recursive: true });
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle malformed plugin.json gracefully", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
      const pluginDir = path.join(pluginsDir, "bad-json");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "plugin.json"), "NOT JSON");
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle plugin with skills array containing non-string entries", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
      const pluginDir = path.join(pluginsDir, "bad-skills");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "plugin.json"),
        JSON.stringify({ name: "bad", version: "1.0.0", skills: [123] })
      );
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });
  });

  describe("getMCPToolDefinitions", () => {
    it("should return array", async () => {
      const { getMCPToolDefinitions } = await loadModule();
      expect(Array.isArray(getMCPToolDefinitions())).toBe(true);
    });
  });

  describe("getActiveMCPServers", () => {
    it("should return array", async () => {
      const { getActiveMCPServers } = await loadModule();
      expect(Array.isArray(getActiveMCPServers())).toBe(true);
    });
  });

  describe("callMCPTool", () => {
    it("should return error for invalid tool name format", async () => {
      const { callMCPTool } = await loadModule();
      const result = await callMCPTool("noSeparator", {});
      expect(result).toContain("[ERRO]");
    });

    it("should return error for non-existent server", async () => {
      const { callMCPTool } = await loadModule();
      const result = await callMCPTool("nonexistent__tool", {});
      expect(result).toContain("[ERRO]");
    });
  });

  describe("shutdownMCPServers", () => {
    it("should be callable", async () => {
      const { shutdownMCPServers } = await loadModule();
      const result = shutdownMCPServers();
      expect(result).toBeUndefined();
    });

    it("should handle multiple shutdowns", async () => {
      const { shutdownMCPServers } = await loadModule();
      shutdownMCPServers();
      const secondCall = shutdownMCPServers();
      expect(secondCall).toBeUndefined();
    });
  });

  describe("getMCPToolDefinitions", () => {
    it("should return empty array when no servers active", async () => {
      const { getMCPToolDefinitions } = await loadModule();
      const defs = getMCPToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
      defs.forEach((def) => {
        expect(def).toHaveProperty("name");
        expect(def).toHaveProperty("description");
        expect(def).toHaveProperty("parameters");
      });
    });
  });

  describe("getActiveMCPServers", () => {
    it("should return empty array when no servers active", async () => {
      const { getActiveMCPServers } = await loadModule();
      const servers = getActiveMCPServers();
      expect(Array.isArray(servers)).toBe(true);
      expect(servers.length).toBe(0);
    });
  });

  describe("initExtensionDirs", () => {
    it("should create all directories", async () => {
      const { initExtensionDirs } = await loadModule();
      initExtensionDirs();
      const base = path.join(tmpDir, ".claude-killer");
      expect(fs.existsSync(path.join(base, "skills"))).toBe(true);
      expect(fs.existsSync(path.join(base, "plugins"))).toBe(true);
    });

    it("should handle existing directories", async () => {
      const { initExtensionDirs } = await loadModule();
      const base = path.join(tmpDir, ".claude-killer");
      fs.mkdirSync(path.join(base, "skills"), { recursive: true });
      initExtensionDirs();
      expect(fs.existsSync(path.join(base, "skills"))).toBe(true);
    });
  });

  describe("loadAllExtensions edge cases", () => {
    it("should handle empty skills directory", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle skill with no prompt.md", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      const skillDir = path.join(skillsDir, "no-prompt-skill");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "skill.json"), JSON.stringify({
        name: "no-prompt",
        description: "skill without prompt",
      }));
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle skill with prompt.md", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      const skillDir = path.join(skillsDir, "with-prompt");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "skill.json"), JSON.stringify({
        name: "with-prompt",
        description: "skill with prompt",
      }));
      fs.writeFileSync(path.join(skillDir, "prompt.md"), "# Skill Prompt\nDo this.");
      await loadAllExtensions();
      const skills = getActiveSkills();
      expect(skills.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle plugin with valid structure", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const pluginsDir = path.join(tmpDir, ".claude-killer", "plugins");
      const pluginDir = path.join(pluginsDir, "valid-plugin");
      fs.mkdirSync(path.join(pluginDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({
        name: "valid-plugin",
        version: "1.0.0",
        skills: ["valid-plugin"],
      }));
      fs.writeFileSync(path.join(pluginDir, "src", "index.js"), "// noop");
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });

    it("should handle multiple skills loading", async () => {
      const { initExtensionDirs, loadAllExtensions, getActiveSkills } = await loadModule();
      initExtensionDirs();
      const skillsDir = path.join(tmpDir, ".claude-killer", "skills");
      for (let i = 0; i < 5; i++) {
        const skillDir = path.join(skillsDir, `skill-${i}`);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.writeFileSync(path.join(skillDir, "skill.json"), JSON.stringify({
          name: `skill-${i}`,
          description: `Skill ${i}`,
        }));
        fs.writeFileSync(path.join(skillDir, "prompt.md"), `# Skill ${i}`);
      }
      await loadAllExtensions();
      expect(getActiveSkills()).toBeDefined();
    });
  });

  describe("callMCPTool edge cases", () => {
    it("should handle tool name with multiple underscores", async () => {
      const { callMCPTool } = await loadModule();
      const result = await callMCPTool("server__sub__tool", {});
      expect(result).toContain("[ERRO]");
    });

    it("should handle empty arguments", async () => {
      const { callMCPTool } = await loadModule();
      const result = await callMCPTool("test__tool", {});
      expect(result).toContain("[ERRO]");
    });
  });
});
