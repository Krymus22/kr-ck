/**
 * toolUpdater-deep.test.ts — Testes profundos do toolUpdater
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "v1.0.0", stderr: "" })),
  execSync: vi.fn(() => "v1.0.0"),
}));

import {
  shouldCheckNow,
  forceCheckOnNextRun,
  checkToolUpdate,
  checkAllToolUpdates,
  updateSingleTool,
  performUpdateCheck,
} from "../toolUpdater.js";

describe("toolUpdater — deep coverage", () => {
  describe("shouldCheckNow", () => {
    it("retorna boolean", () => {
      expect(typeof shouldCheckNow()).toBe("boolean");
    });
  });

  describe("forceCheckOnNextRun", () => {
    it("não lança exceção", () => {
      expect(() => forceCheckOnNextRun()).not.toThrow();
    });
  });

  describe("checkToolUpdate", () => {
    it("retorna UpdateCheckResult para tool conhecida", async () => {
      const result = await checkToolUpdate("selene");
      expect(result).toHaveProperty("tool");
      expect(result).toHaveProperty("currentVersion");
      expect(result).toHaveProperty("latestVersion");
      expect(result).toHaveProperty("updateAvailable");
    });

    it("retorna UpdateCheckResult para tool inexistente", async () => {
      const result = await checkToolUpdate("nonexistent_tool");
      expect(result).toHaveProperty("tool");
    });
  });

  describe("checkAllToolUpdates", () => {
    it("retorna array", async () => {
      const results = await checkAllToolUpdates();
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("updateSingleTool", () => {
    it("retorna boolean", async () => {
      const result = await updateSingleTool("selene");
      expect(typeof result).toBe("boolean");
    });

    it("retorna false para tool inexistente", async () => {
      const result = await updateSingleTool("nonexistent_tool");
      expect(result).toBe(false);
    });
  });

  describe("performUpdateCheck", () => {
    it("retorna array", async () => {
      const results = await performUpdateCheck();
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
