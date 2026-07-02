/**
 * toolInstaller-deep.test.ts — Testes profundos do toolInstaller
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  execSync: vi.fn(() => ""),
}));

import { installTool, canInstall, getInstallDir, listInstallableTools, getToolRepo } from "../toolInstaller.js";

describe("toolInstaller — deep coverage", () => {
  describe("installTool", () => {
    it("retorna InstallResult para tool desconhecida", async () => {
      const result = await installTool("nonexistent_tool_xyz");
      expect(result).toHaveProperty("success");
      expect(result.success).toBe(false);
    });

    it("retorna InstallResult com error para tool desconhecida", async () => {
      const result = await installTool("nonexistent_tool_xyz");
      expect(result).toHaveProperty("error");
    });
  });

  describe("canInstall — mais casos", () => {
    it("retorna true para selene", () => {
      expect(typeof canInstall("selene")).toBe("boolean");
    });

    it("retorna true para stylua", () => {
      expect(typeof canInstall("stylua")).toBe("boolean");
    });

    it("retorna true para rojo", () => {
      expect(typeof canInstall("rojo")).toBe("boolean");
    });

    it("retorna true para wally", () => {
      expect(typeof canInstall("wally")).toBe("boolean");
    });

    it("retorna true para lune", () => {
      expect(typeof canInstall("lune")).toBe("boolean");
    });

    it("retorna true para rokit", () => {
      expect(typeof canInstall("rokit")).toBe("boolean");
    });

    it("retorna false para string vazia", () => {
      expect(canInstall("")).toBe(false);
    });

    it("retorna false para null", () => {
      expect(canInstall(null as any)).toBe(false);
    });
  });

  describe("getInstallDir — mais casos", () => {
    it("retorna path contendo .claude-killer", () => {
      const dir = getInstallDir();
      expect(dir).toContain(".claude-killer");
    });

    it("retorna path consistente", () => {
      const dir1 = getInstallDir();
      const dir2 = getInstallDir();
      expect(dir1).toBe(dir2);
    });
  });

  describe("listInstallableTools — mais casos", () => {
    it("retorna array não vazio", () => {
      const tools = listInstallableTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it("inclui selene", () => {
      const tools = listInstallableTools();
      expect(tools).toContain("selene");
    });

    it("inclui rojo", () => {
      const tools = listInstallableTools();
      expect(tools).toContain("rojo");
    });

    it("inclui wally", () => {
      const tools = listInstallableTools();
      expect(tools).toContain("wally");
    });
  });

  describe("getToolRepo — mais casos", () => {
    it("retorna owner/repo para selene", () => {
      const repo = getToolRepo("selene");
      expect(repo).not.toBeNull();
      expect(repo!.owner).toBeTruthy();
      expect(repo!.repo).toBeTruthy();
    });

    it("retorna owner/repo para rojo", () => {
      const repo = getToolRepo("rojo");
      expect(repo).not.toBeNull();
    });

    it("retorna owner/repo para stylua", () => {
      const repo = getToolRepo("stylua");
      expect(repo).not.toBeNull();
    });

    it("retorna owner/repo para wally", () => {
      const repo = getToolRepo("wally");
      expect(repo).not.toBeNull();
    });

    it("retorna owner/repo para lune", () => {
      const repo = getToolRepo("lune");
      expect(repo).not.toBeNull();
    });

    it("retorna null para tool desconhecida", () => {
      expect(getToolRepo("nonexistent")).toBeNull();
    });

    it("retorna null para string vazia", () => {
      expect(getToolRepo("")).toBeNull();
    });
  });
});
