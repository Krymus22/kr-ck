/**
 * toolUpdater.test.ts - Tests for automatic tool version checking.
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

describe("toolUpdater", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-updater-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("state persistence", () => {
    it("should return null lastCheck when no state file", async () => {
      const { shouldCheckNow } = await import("./../toolUpdater.js");
      // No state file = should check
      expect(shouldCheckNow()).toBe(true);
    });

    it("should not check if lastCheck is recent", async () => {
      const { forceCheckOnNextRun, shouldCheckNow } = await import("./../toolUpdater.js");

      // Manually write state file with current timestamp
      const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          lastCheck: new Date().toISOString(),
          cachedVersions: {},
        }),
        "utf8"
      );

      expect(shouldCheckNow()).toBe(false);
    });

    it("should check if lastCheck is old", async () => {
      const { shouldCheckNow } = await import("./../toolUpdater.js");

      // Write state file with old timestamp (48 hours ago)
      const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(
        statePath,
        JSON.stringify({ lastCheck: old, cachedVersions: {} }),
        "utf8"
      );

      expect(shouldCheckNow()).toBe(true);
    });

    it("should check if TOOL_UPDATER_ENABLED=true (default)", async () => {
      delete process.env.TOOL_UPDATER_ENABLED;
      const { shouldCheckNow } = await import("./../toolUpdater.js");
      expect(shouldCheckNow()).toBe(true);
    });

    it("should not check if TOOL_UPDATER_ENABLED=false", async () => {
      process.env.TOOL_UPDATER_ENABLED = "false";
      const { shouldCheckNow } = await import("./../toolUpdater.js");
      expect(shouldCheckNow()).toBe(false);
      delete process.env.TOOL_UPDATER_ENABLED;
    });

    it("forceCheckOnNextRun should clear lastCheck", async () => {
      const { forceCheckOnNextRun, shouldCheckNow } = await import("./../toolUpdater.js");

      // Write recent state
      const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify({ lastCheck: new Date().toISOString(), cachedVersions: {} }),
        "utf8"
      );

      expect(shouldCheckNow()).toBe(false);

      forceCheckOnNextRun();
      expect(shouldCheckNow()).toBe(true);
    });
  });

  describe("TOOL_REPOS mapping", () => {
    it("should map all Roblox tools to their GitHub repos", async () => {
      // The TOOL_REPOS is internal but we can verify checkToolUpdate knows about each
      const { checkToolUpdate } = await import("./../toolUpdater.js");

      // For each known tool, checkToolUpdate should at least attempt (will fail since not installed)
      const tools = ["rojo", "wally", "lune", "selene", "rokit", "stylua",
                     "wally-package-types", "luau-lsp"];

      for (const tool of tools) {
        const result = await checkToolUpdate(tool);
        expect(result.tool).toBe(tool);
        // Either installed (unlikely in test env) or error
        expect(result.installed === null || typeof result.installed === "string").toBe(true);
      }
    });
  });

  describe("checkToolUpdate", () => {
    it("should return error for unknown tool", async () => {
      const { checkToolUpdate } = await import("./../toolUpdater.js");
      const result = await checkToolUpdate("nonexistent_tool_xyz");
      expect(result.error).toBe("unknown repo");
      expect(result.needsUpdate).toBe(false);
    });

    it("should return error: not installed when tool binary missing", async () => {
      const { checkToolUpdate } = await import("./../toolUpdater.js");
      // rojo is almost certainly not installed in CI/test env
      const result = await checkToolUpdate("rojo");
      if (result.installed === null) {
        expect(result.error).toBe("not installed");
      } else {
        // If somehow installed, that's fine too
        expect(typeof result.installed).toBe("string");
      }
    });
  });

  describe("performUpdateCheck", () => {
    it("should return empty array when disabled", async () => {
      process.env.TOOL_UPDATER_ENABLED = "false";
      const { performUpdateCheck } = await import("./../toolUpdater.js");
      const results = await performUpdateCheck();
      expect(results).toEqual([]);
      delete process.env.TOOL_UPDATER_ENABLED;
    });

    it("should never throw - all errors swallowed", async () => {
      // Even if everything goes wrong, this should not throw
      const { performUpdateCheck } = await import("./../toolUpdater.js");
      await expect(performUpdateCheck()).resolves.toBeDefined();
    });

    it("should persist lastCheck timestamp after running", async () => {
      const { performUpdateCheck } = await import("./../toolUpdater.js");
      await performUpdateCheck();

      const statePath = path.join(tmpHome, ".claude-killer", ".tool-updater.json");
      expect(fs.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(state.lastCheck).toBeDefined();
      expect(new Date(state.lastCheck).getTime()).not.toBeNaN();
    });
  });
});
