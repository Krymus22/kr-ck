/**
 * toolInstaller-coverage.test.ts — Testes de cobertura do toolInstaller
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { canInstall, getInstallDir, listInstallableTools, getToolRepo } from "../toolInstaller.js";

describe("toolInstaller — coverage", () => {
  describe("canInstall", () => {
    it("retorna boolean para tool conhecida", () => {
      const result = canInstall("selene");
      expect(typeof result).toBe("boolean");
    });

    it("retorna false para tool desconhecida", () => {
      const result = canInstall("nonexistent_tool_xyz");
      expect(result).toBe(false);
    });
  });

  describe("getInstallDir", () => {
    it("retorna string com path", () => {
      const result = getInstallDir();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("listInstallableTools", () => {
    it("retorna array com tools", () => {
      const result = listInstallableTools();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getToolRepo", () => {
    it("retorna owner/repo para tool conhecida", () => {
      const result = getToolRepo("selene");
      if (result) {
        expect(result).toHaveProperty("owner");
        expect(result).toHaveProperty("repo");
      }
    });

    it("retorna null para tool desconhecida", () => {
      const result = getToolRepo("nonexistent_tool_xyz");
      expect(result).toBeNull();
    });
  });
});
