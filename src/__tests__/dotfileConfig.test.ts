/**
 * dotfileConfig.test.ts — Tests for dotfile config module.
 */

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, saveConfig, updateConfig, getConfigValue, getConfigPath } from "../dotfileConfig.js";

const CONFIG_PATH = getConfigPath();

afterAll(() => {
  // Clean up test config
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
});

describe("saveConfig", () => {
  it("should save config to disk", () => {
    const config = { model: "test-model", debug: true };
    saveConfig(config);
    expect(fs.existsSync(CONFIG_PATH)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    expect(saved.model).toBe("test-model");
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
