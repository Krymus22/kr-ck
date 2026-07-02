/**
 * toolDetector-coverage.test.ts — Testes de cobertura do toolDetector
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { execSync, spawnSync } from "node:child_process";
import {
  isAutoDetectEnabled,
  extractToolBinaryName,
  getModeToolNames,
  getModeToolsDir,
  listModeTools,
  findToolBinary,
} from "../toolDetector.js";

const mockedExecSync = vi.mocked(execSync);
const mockedSpawnSync = vi.mocked(spawnSync);

describe("toolDetector — coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isAutoDetectEnabled", () => {
    it("retorna boolean", () => {
      const result = isAutoDetectEnabled();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("extractToolBinaryName", () => {
    it("extrai nome do binary de tool ID", () => {
      const result = extractToolBinaryName("selene_lint");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("extrai nome para stylua_format", () => {
      const result = extractToolBinaryName("stylua_format");
      expect(typeof result).toBe("string");
    });

    it("extrai nome para rojo_build", () => {
      const result = extractToolBinaryName("rojo_build");
      expect(typeof result).toBe("string");
    });
  });

  describe("getModeToolNames", () => {
    it("retorna array para tool IDs vazios", () => {
      const result = getModeToolNames([]);
      expect(Array.isArray(result)).toBe(true);
    });

    it("retorna array com nomes para tool IDs", () => {
      const result = getModeToolNames(["tool:selene_lint", "tool:rojo_build"]);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("getModeToolsDir", () => {
    it("retorna path contendo o mode name", () => {
      const result = getModeToolsDir("roblox");
      expect(typeof result).toBe("string");
      expect(result).toContain("roblox");
    });

    it("retorna path para mode devops", () => {
      const result = getModeToolsDir("devops");
      expect(result).toContain("devops");
    });
  });

  describe("listModeTools", () => {
    it("retorna array (pode ser vazio se diretório não existe)", () => {
      const result = listModeTools("nonexistent_mode");
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("findToolBinary", () => {
    it("retorna null para tool inexistente sem mode", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = findToolBinary("nonexistent_tool_xyz", null);
      expect(result).toBeNull();
    });

    it("retorna null para tool inexistente com mode", () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error("not found");
      });
      const result = findToolBinary("nonexistent_tool_xyz", "roblox");
      expect(result).toBeNull();
    });
  });
});
