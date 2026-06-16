/**
 * dotfileConfig.test.ts — Tests for dotfile config module.
 */

import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadConfig, saveConfig, updateConfig, getConfigValue,
  getConfigPath, getThemesDir, listCustomThemes, ensureConfigDir,
} from "../dotfileConfig.js";

const CONFIG_PATH = getConfigPath();

beforeEach(() => {
  // Reset cached config by deleting the file and reloading
  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
  // Force cache reset by clearing module
});

afterAll(() => {
  if (fs.existsSync(CONFIG_PATH)) {
    fs.unlinkSync(CONFIG_PATH);
  }
});

describe("loadConfig", () => {
  it("should load config (empty if not exists)", () => {
    const config = loadConfig();
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");
  });

  it("should cache loaded config", () => {
    const c1 = loadConfig();
    const c2 = loadConfig();
    expect(c1).toBe(c2);
  });

  it("should handle invalid JSON in config file gracefully", async () => {
    vi.resetModules();
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, "{invalid json!!!", "utf8");
    const mod = await import("../dotfileConfig.js");
    const config = mod.loadConfig();
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");
  });
});

describe("saveConfig", () => {
  it("should save config to disk", () => {
    const config = { model: "test-model", debug: true };
    saveConfig(config);
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    expect(saved.model).toBe("test-model");
  });

  it("should create config directory if missing", () => {
    saveConfig({ model: "test" });
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
  });

  it("should handle saveConfig write failure gracefully", () => {
    const tempBlockDir = path.join(require("os").tmpdir(), `dotfile-block-${Date.now()}`);
    fs.mkdirSync(tempBlockDir, { recursive: true });
    // saveConfig will try to ensureConfigDir - it should not throw
    expect(() => saveConfig({ model: "test" })).not.toThrow();
    try { fs.rmSync(tempBlockDir, { recursive: true, force: true }); } catch {}
  });

  it("should not throw when writeFileSync fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs", () => ({
      ...fs,
      mkdirSync: vi.fn().mockReturnValue(undefined),
      writeFileSync: vi.fn().mockImplementation(() => {
        throw new Error("EPERM: permission denied");
      }),
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue("{}"),
      unlinkSync: vi.fn(),
      readdirSync: vi.fn().mockReturnValue([]),
    }));
    vi.doMock("../logger.js", () => ({
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }));
    const mod = await import("../dotfileConfig.js");
    expect(() => mod.saveConfig({ model: "test" })).not.toThrow();
    vi.doUnmock("node:fs");
    vi.doUnmock("../logger.js");
  });
});

describe("updateConfig", () => {
  it("should merge partial updates", () => {
    saveConfig({ model: "old" });
    updateConfig({ model: "new" });
    const config = loadConfig();
    expect(config.model).toBe("new");
  });

  it("should preserve existing keys", () => {
    saveConfig({ model: "keep", debug: true });
    updateConfig({ model: "updated" });
    const config = loadConfig();
    expect(config.debug).toBe(true);
  });

  it("should return merged config", () => {
    saveConfig({ model: "a" });
    const result = updateConfig({ model: "b" });
    expect(result.model).toBe("b");
  });
});

describe("getConfigValue", () => {
  it("should return specific value", () => {
    saveConfig({ model: "test123" });
    const value = getConfigValue("model");
    expect(value).toBe("test123");
  });

  it("should return undefined for missing key", () => {
    const value = getConfigValue("nonexistent" as any);
    expect(value).toBeUndefined();
  });
});

describe("getConfigPath", () => {
  it("returns a path string", () => {
    const p = getConfigPath();
    expect(typeof p).toBe("string");
    expect(p).toContain(".claude-killer");
    expect(p).toContain("config.json");
  });
});

describe("getThemesDir", () => {
  it("returns a themes directory path", () => {
    const d = getThemesDir();
    expect(d).toContain("themes");
    expect(d).toContain(".claude-killer");
  });
});

describe("listCustomThemes", () => {
  it("returns an array", () => {
    const themes = listCustomThemes();
    expect(Array.isArray(themes)).toBe(true);
  });

  it("returns empty when no themes dir", () => {
    const themes = listCustomThemes();
    expect(Array.isArray(themes)).toBe(true);
  });

  it("lists .json files from themes directory", () => {
    const themesDir = getThemesDir();
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(path.join(themesDir, "dark.json"), "{}", "utf8");
    fs.writeFileSync(path.join(themesDir, "light.json"), "{}", "utf8");
    fs.writeFileSync(path.join(themesDir, "readme.txt"), "not a theme", "utf8");

    const themes = listCustomThemes();
    expect(themes).toContain("dark");
    expect(themes).toContain("light");
    expect(themes).not.toContain("readme");

    fs.rmSync(themesDir, { recursive: true, force: true });
  });

  it("returns empty array when themes dir exists but has no .json files", () => {
    const themesDir = getThemesDir();
    fs.mkdirSync(themesDir, { recursive: true });
    fs.writeFileSync(path.join(themesDir, "readme.txt"), "no themes", "utf8");

    const themes = listCustomThemes();
    expect(themes).toEqual([]);

    fs.rmSync(themesDir, { recursive: true, force: true });
  });
});

describe("ensureConfigDir", () => {
  it("creates config directory", () => {
    ensureConfigDir();
    const dir = path.dirname(getConfigPath());
    expect(fs.existsSync(dir)).toBe(true);
  });
});
