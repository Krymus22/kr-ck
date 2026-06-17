/**
 * extensionCenter.test.ts — Tests for the Extension Hub core module.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock fs to avoid touching real filesystem
vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ isDirectory: () => false, size: 100 })),
  },
}));

// Mock logger
vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

const { mockGetRegistry, mockGetActiveMCPServers } = vi.hoisted(() => ({
  mockGetRegistry: vi.fn(),
  mockGetActiveMCPServers: vi.fn(),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: (...args: any[]) => mockGetRegistry(...args),
}));

vi.mock("../extensions.js", () => ({
  getActiveMCPServers: (...args: any[]) => mockGetActiveMCPServers(...args),
}));

import {
  getAllExtensions,
  getExtensionsByCategory,
  getEnabledExtensions,
  getExtensionsForTrigger,
  getExtension,
  syncExtensions,
  toggleExtension,
  setTriggerMode,
  cycleTriggerMode,
  enableAllInCategory,
  disableAll,
  executeTrigger,
  registerExecutor,
  getHubSummary,
  getTriggerLabel,
  getTriggerModes,
  getCategoryIcon,
  getCategoryColor,
  discoverExtensions,
  type ExtensionEntry,
  type TriggerMode,
} from "../extensionCenter.js";

function makeExt(overrides: Partial<ExtensionEntry> = {}): Omit<ExtensionEntry, "enabled" | "triggerMode"> {
  return {
    id: overrides.id ?? "test:ext1",
    name: overrides.name ?? "Test Extension",
    category: overrides.category ?? "skill",
    description: overrides.description ?? "A test extension",
    installed: overrides.installed ?? true,
    ...overrides,
  } as Omit<ExtensionEntry, "enabled" | "triggerMode">;
}

describe("extensionCenter", () => {
  beforeEach(() => {
    // Reset state by syncing empty list
    syncExtensions([]);
  });

  describe("syncExtensions", () => {
    it("should register new extensions as disabled by default if not installed", () => {
      syncExtensions([makeExt({ id: "test:1", installed: false })]);
      const ext = getExtension("test:1");
      expect(ext).toBeDefined();
      expect(ext!.enabled).toBe(false);
      expect(ext!.triggerMode).toBe("disabled");
    });

    it("should register new extensions as enabled if installed", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      const ext = getExtension("test:1");
      expect(ext).toBeDefined();
      expect(ext!.enabled).toBe(true);
      expect(ext!.triggerMode).toBe("disabled");
    });

    it("should preserve existing state on re-sync", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      toggleExtension("test:1"); // disable it
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      const ext = getExtension("test:1");
      expect(ext!.enabled).toBe(false); // preserved
    });
  });

  describe("toggleExtension", () => {
    it("should toggle enabled state", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      expect(toggleExtension("test:1")).toBe(false);
      expect(toggleExtension("test:1")).toBe(true);
    });

    it("should return null for non-existent extension", () => {
      expect(toggleExtension("nonexistent")).toBeNull();
    });

    it("should reset trigger mode when disabling", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "on_file");
      toggleExtension("test:1"); // disable
      const ext = getExtension("test:1");
      expect(ext!.triggerMode).toBe("disabled");
    });
  });

  describe("setTriggerMode", () => {
    it("should set trigger mode and enable extension", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "on_task");
      const ext = getExtension("test:1");
      expect(ext!.triggerMode).toBe("on_task");
      expect(ext!.enabled).toBe(true);
    });

    it("should disable extension when setting to disabled", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "disabled");
      const ext = getExtension("test:1");
      expect(ext!.enabled).toBe(false);
    });

    it("should return null for non-existent extension", () => {
      expect(setTriggerMode("nonexistent", "always")).toBeNull();
    });
  });

  describe("cycleTriggerMode", () => {
    it("should cycle through all modes", () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      const modes = getTriggerModes();
      let mode = cycleTriggerMode("test:1");
      expect(mode).toBe(modes[1]); // on_file

      mode = cycleTriggerMode("test:1");
      expect(mode).toBe(modes[2]); // on_task

      mode = cycleTriggerMode("test:1");
      expect(mode).toBe(modes[3]); // always

      mode = cycleTriggerMode("test:1");
      expect(mode).toBe(modes[0]); // disabled
    });

    it("should return null for non-existent extension", () => {
      expect(cycleTriggerMode("nonexistent")).toBeNull();
    });
  });

  describe("getExtensionsByCategory", () => {
    it("should filter by category", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill" }),
        makeExt({ id: "tool:1", category: "tool" }),
        makeExt({ id: "skill:2", category: "skill" }),
      ]);
      const skills = getExtensionsByCategory("skill");
      expect(skills).toHaveLength(2);
    });
  });

  describe("getEnabledExtensions", () => {
    it("should return only enabled extensions with non-disabled trigger", () => {
      syncExtensions([
        makeExt({ id: "test:1", installed: true }),
        makeExt({ id: "test:2", installed: true }),
      ]);
      setTriggerMode("test:1", "disabled"); // disable
      setTriggerMode("test:2", "on_task"); // enable with trigger
      const enabled = getEnabledExtensions();
      expect(enabled).toHaveLength(1);
      expect(enabled[0]!.id).toBe("test:2");
    });
  });

  describe("getExtensionsForTrigger", () => {
    it("should return extensions matching trigger mode", () => {
      syncExtensions([
        makeExt({ id: "test:1", installed: true }),
        makeExt({ id: "test:2", installed: true }),
        makeExt({ id: "test:3", installed: true }),
      ]);
      setTriggerMode("test:1", "on_file");
      setTriggerMode("test:2", "on_task");
      setTriggerMode("test:3", "on_file");

      const onFile = getExtensionsForTrigger("on_file");
      expect(onFile).toHaveLength(2);
    });
  });

  describe("enableAllInCategory", () => {
    it("should enable all installed extensions in category", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill", installed: true }),
        makeExt({ id: "skill:2", category: "skill", installed: true }),
        makeExt({ id: "tool:1", category: "tool", installed: true }),
      ]);
      const count = enableAllInCategory("skill", "always");
      expect(count).toBe(2);
      const skills = getExtensionsByCategory("skill");
      expect(skills.every((s) => s.triggerMode === "always")).toBe(true);
    });
  });

  describe("disableAll", () => {
    it("should disable all extensions", () => {
      syncExtensions([
        makeExt({ id: "test:1", installed: true }),
        makeExt({ id: "test:2", installed: true }),
      ]);
      setTriggerMode("test:1", "always");
      setTriggerMode("test:2", "on_task");
      disableAll();
      expect(getEnabledExtensions()).toHaveLength(0);
    });
  });

  describe("executeTrigger", () => {
    it("should call executor for matching extensions", async () => {
      syncExtensions([
        makeExt({ id: "test:1", installed: true }),
        makeExt({ id: "test:2", installed: true }),
      ]);
      setTriggerMode("test:1", "on_task");
      setTriggerMode("test:2", "on_file");

      const executor = vi.fn().mockResolvedValue("output");
      registerExecutor(executor);

      const results = await executeTrigger("on_task", { cwd: "/tmp" });
      expect(results).toHaveLength(1);
      expect(results[0]!.extensionId).toBe("test:1");
      expect(executor).toHaveBeenCalledTimes(1);
    });

    it("should handle executor errors gracefully", async () => {
      syncExtensions([makeExt({ id: "test:1", installed: true })]);
      setTriggerMode("test:1", "always");

      registerExecutor(async () => {
        throw new Error("test error");
      });

      const results = await executeTrigger("always", { cwd: "/tmp" });
      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(false);
    });

    it("should return empty if no executor registered", async () => {
      registerExecutor(null as never);
      const results = await executeTrigger("always", { cwd: "/tmp" });
      expect(results).toHaveLength(0);
    });
  });

  describe("getHubSummary", () => {
    it("should return correct counts", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill", installed: true }),
        makeExt({ id: "tool:1", category: "tool", installed: true }),
      ]);
      setTriggerMode("skill:1", "on_file");
      // Tools default to OFF, so toggle it ON then back OFF to test
      toggleExtension("tool:1"); // enable (was OFF by default for tools)
      toggleExtension("tool:1"); // disable again

      const summary = getHubSummary();
      expect(summary.total).toBe(2);
      expect(summary.enabled).toBe(1); // only skill:1 is enabled
      expect(summary.byCategory.skill.enabled).toBe(1);
      expect(summary.byCategory.tool.enabled).toBe(0);
      expect(summary.byTrigger.on_file).toBe(1);
    });
  });

  describe("UI helpers", () => {
    it("getTriggerLabel returns correct labels", () => {
      expect(getTriggerLabel("disabled")).toBe("OFF");
      expect(getTriggerLabel("on_file")).toBe("FILE");
      expect(getTriggerLabel("on_task")).toBe("TASK");
      expect(getTriggerLabel("always")).toBe("EVERY");
    });

    it("getCategoryIcon returns emoji for each category", () => {
      expect(getCategoryIcon("skill")).toBeTruthy();
      expect(getCategoryIcon("tool")).toBeTruthy();
      expect(getCategoryIcon("mcp")).toBeTruthy();
      expect(getCategoryIcon("plugin")).toBeTruthy();
    });

    it("getCategoryColor returns correct hex color for each category", () => {
      expect(getCategoryColor("skill")).toBe("#6EE7F7");
      expect(getCategoryColor("tool")).toBe("#FBBF24");
      expect(getCategoryColor("mcp")).toBe("#A78BFA");
      expect(getCategoryColor("plugin")).toBe("#34D399");
    });

    it("getTriggerModes returns all four modes in order", () => {
      expect(getTriggerModes()).toEqual(["disabled", "on_file", "on_task", "always"]);
    });
  });

  describe("discoverExtensions", () => {
    beforeEach(() => {
      vi.mocked(fs.existsSync).mockReset().mockReturnValue(false);
      vi.mocked(fs.readdirSync).mockReset().mockReturnValue([]);
      mockGetRegistry.mockReset();
      mockGetActiveMCPServers.mockReset();
      syncExtensions([]);
    });

    it("should discover skills from home directory", () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        return s.includes("claude-killer") && s.includes("skills");
      });
      vi.mocked(fs.readdirSync)
        .mockReturnValueOnce(["mySkill.md", "another.yaml", "readme.txt"] as any)
        .mockReturnValueOnce(["extra.yml"] as any);

      discoverExtensions();

      const skills = getAllExtensions().filter((e) => e.category === "skill");
      expect(skills).toHaveLength(3);
      expect(skills.some((e) => e.id === "skill:mySkill")).toBe(true);
      expect(skills.some((e) => e.id === "skill:another")).toBe(true);
      expect(skills.some((e) => e.id === "skill:extra")).toBe(true);
      expect(skills.some((e) => e.id === "skill:readme")).toBe(false);
    });

    it("should discover skills from both home and cwd directories", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync)
        .mockReturnValueOnce(["homeSkill.md"] as any)
        .mockReturnValueOnce(["cwdSkill.yaml"] as any);

      discoverExtensions();

      expect(vi.mocked(fs.readdirSync)).toHaveBeenCalledTimes(2);
      const skills = getAllExtensions().filter((e) => e.category === "skill");
      expect(skills).toHaveLength(2);
      expect(skills.some((e) => e.id === "skill:homeSkill")).toBe(true);
      expect(skills.some((e) => e.id === "skill:cwdSkill")).toBe(true);
    });

    it("should skip non-existent skill directories", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      discoverExtensions();

      expect(vi.mocked(fs.readdirSync)).not.toHaveBeenCalled();
      expect(getAllExtensions().filter((e) => e.category === "skill")).toHaveLength(0);
    });

    it("should handle unreadable skill directories gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error("EACCES");
      });

      // Should not throw
      discoverExtensions();
      expect(getAllExtensions().filter((e) => e.category === "skill")).toHaveLength(0);
    });

    it("should handle missing external tools module gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockGetRegistry.mockImplementation(() => { throw new Error("Module not found"); });

      discoverExtensions();
      expect(getAllExtensions().filter((e) => e.category === "tool")).toHaveLength(0);
    });

    it("should handle missing extensions module gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockGetActiveMCPServers.mockImplementation(() => { throw new Error("Module not found"); });

      discoverExtensions();
      expect(getAllExtensions().filter((e) => e.category === "mcp")).toHaveLength(0);
    });

    it("should handle getRegistry returning null", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockGetRegistry.mockReturnValue(null);

      discoverExtensions();
      expect(getAllExtensions().filter((e) => e.category === "tool")).toHaveLength(0);
    });

    it("should handle getActiveMCPServers returning empty array", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockGetActiveMCPServers.mockReturnValue([]);

      discoverExtensions();
      expect(getAllExtensions().filter((e) => e.category === "mcp")).toHaveLength(0);
    });

    it("should combine discovered skill extensions", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue(["skillA.md"] as any);

      discoverExtensions();

      const all = getAllExtensions();
      // 1 skill from home dir + 1 skill from cwd dir
      expect(all.filter((e) => e.category === "skill")).toHaveLength(2);
    });

    it("should set meta.path on discovered skills", () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        return String(p).includes("claude-killer") && String(p).includes("skills");
      });
      vi.mocked(fs.readdirSync)
        .mockReturnValueOnce(["testSkill.md"] as any)
        .mockReturnValueOnce([]);

      discoverExtensions();

      const skill = getAllExtensions().find((e) => e.id === "skill:testSkill");
      expect(skill).toBeDefined();
      expect(skill!.meta?.path).toContain("testSkill.md");
    });

    it("should handle getAll returning undefined gracefully", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockGetRegistry.mockReturnValue({
        getAll: () => undefined,
        isInstalled: () => false,
      });

      discoverExtensions();
      expect(getAllExtensions().filter((e) => e.category === "tool")).toHaveLength(0);
    });

    it("regression: should discover Roblox tools from registry (require -> static import)", () => {
      // Previously, discoverTools used require() which throws in ESM mode,
      // silently swallowing the error and producing zero tool entries.
      // With static imports, the registry is consulted directly.
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockGetRegistry.mockReturnValue({
        getAll: () => [
          {
            name: "rojo_build",
            description: "Build .rbxl place file from Rojo project",
            category: "roblox",
            command: "rojo",
            args: ["build"],
            flags: [],
            detection: { method: "binary", check: "rojo --version" },
            context: { whenToUse: ["build roblox project"], examples: [] },
            outputParser: "raw",
          },
          {
            name: "wally_install",
            description: "Install Wally packages",
            category: "roblox",
            command: "wally",
            args: ["install"],
            flags: [],
            detection: { method: "binary", check: "wally --version" },
            context: { whenToUse: ["install packages"], examples: [] },
            outputParser: "raw",
          },
        ],
        isInstalled: () => true,
      });

      discoverExtensions();

      const tools = getAllExtensions().filter((e) => e.category === "tool");
      expect(tools).toHaveLength(2);
      expect(tools.some((t) => t.id === "tool:rojo_build")).toBe(true);
      expect(tools.some((t) => t.id === "tool:wally_install")).toBe(true);
      expect(tools.every((t) => t.installed)).toBe(true);
    });

    it("regression: tools should default to OFF (external things off by default)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockGetRegistry.mockReturnValue({
        getAll: () => [{
          name: "rojo_build",
          description: "Build .rbxl place file",
          category: "roblox",
          command: "rojo",
          args: [], flags: [],
          detection: { method: "binary", check: "rojo --version" },
          context: { whenToUse: [], examples: [] },
          outputParser: "raw",
        }],
        isInstalled: () => true,
      });

      discoverExtensions();

      const tool = getExtension("tool:rojo_build");
      expect(tool).toBeDefined();
      // External tools must default to OFF (user requested this)
      expect(tool!.enabled).toBe(false);
      expect(tool!.triggerMode).toBe("disabled");
    });

    it("regression: features should default to ON (internal features on by default)", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockGetRegistry.mockReturnValue(null);

      discoverExtensions();

      const features = getAllExtensions().filter((e) => e.category === "feature");
      expect(features.length).toBeGreaterThan(0);
      // Every internal feature must default to ON
      for (const f of features) {
        expect(f.enabled).toBe(true);
        expect(f.triggerMode).toBe("always");
      }
    });
  });

  describe("getHubSummary - comprehensive", () => {
    it("should return zero counts when empty", () => {
      syncExtensions([]);
      const summary = getHubSummary();
      expect(summary.total).toBe(0);
      expect(summary.enabled).toBe(0);
      Object.values(summary.byCategory).forEach((cat) => {
        expect(cat.total).toBe(0);
        expect(cat.enabled).toBe(0);
      });
      Object.values(summary.byTrigger).forEach((count) => {
        expect(count).toBe(0);
      });
    });

    it("should count all categories and trigger modes", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill", installed: true }),
        makeExt({ id: "tool:1", category: "tool", installed: true }),
        makeExt({ id: "mcp:1", category: "mcp", installed: true }),
        makeExt({ id: "plugin:1", category: "plugin", installed: true }),
      ]);
      setTriggerMode("skill:1", "always");
      setTriggerMode("tool:1", "on_file");
      setTriggerMode("mcp:1", "on_task");
      setTriggerMode("plugin:1", "disabled");

      const summary = getHubSummary();
      expect(summary.total).toBe(4);
      expect(summary.enabled).toBe(3);
      expect(summary.byCategory.skill).toEqual({ total: 1, enabled: 1 });
      expect(summary.byCategory.tool).toEqual({ total: 1, enabled: 1 });
      expect(summary.byCategory.mcp).toEqual({ total: 1, enabled: 1 });
      expect(summary.byCategory.plugin).toEqual({ total: 1, enabled: 0 });
      expect(summary.byTrigger).toEqual({ disabled: 1, on_file: 1, on_task: 1, always: 1 });
    });

    it("should handle multiple extensions per category", () => {
      syncExtensions([
        makeExt({ id: "skill:1", category: "skill", installed: true }),
        makeExt({ id: "skill:2", category: "skill", installed: true }),
        makeExt({ id: "skill:3", category: "skill", installed: true }),
      ]);
      setTriggerMode("skill:1", "always");
      setTriggerMode("skill:2", "on_file");
      setTriggerMode("skill:3", "disabled");

      const summary = getHubSummary();
      expect(summary.byCategory.skill).toEqual({ total: 3, enabled: 2 });
      expect(summary.byTrigger.always).toBe(1);
      expect(summary.byTrigger.on_file).toBe(1);
      expect(summary.byTrigger.disabled).toBe(1);
    });
  });
});
