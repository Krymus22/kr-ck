/**
 * searxManager.test.ts — Testes do gerenciador de Searx (Docker + Python)
 *
 * Mocka spawnSync e existsSync para testar deteccao de Docker/Python
 * sem depender do estado real da maquina.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";

// Mock node:child_process e node:fs
const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

const { existsSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: spawnSyncMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: vi.fn(),
}));

// Mock fetch para isSearxRunning
global.fetch = vi.fn() as any;

import { isSearxInstalled, isSearxRunning, getSearxStatus, autoStopSearx } from "../searxManager.js";

describe("searxManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isSearxInstalled", () => {
    it("retorna false quando Docker nao existe e Python nao existe", () => {
      // spawnSync para docker inspect retorna status != 0 (container nao existe)
      spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "no such container" });
      existsSyncMock.mockReturnValue(false);
      expect(isSearxInstalled()).toBe(false);
    });

    it("retorna true quando Docker container existe", () => {
      // docker inspect retorna status 0 (container existe)
      spawnSyncMock.mockReturnValue({ status: 0, stdout: "true", stderr: "" });
      expect(isSearxInstalled()).toBe(true);
    });

    it("retorna true quando Python venv existe (sem Docker)", () => {
      // Docker nao disponivel
      spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }); // docker --version
      // existsSync retorna true para SEARX_VENV_PYTHON e SEARX_SETTINGS
      existsSyncMock.mockReturnValue(true);
      expect(isSearxInstalled()).toBe(true);
    });
  });

  describe("isSearxRunning", () => {
    it("retorna true quando fetch retorna 200 com results", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ title: "test" }] }),
      });

      const result = await isSearxRunning();
      expect(result).toBe(true);
    });

    it("retorna false quando fetch retorna erro", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        json: async () => ({}),
      });

      const result = await isSearxRunning();
      expect(result).toBe(false);
    });

    it("retorna false quando fetch lanca excecao (conexao recusada)", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await isSearxRunning();
      expect(result).toBe(false);
    });

    it("retorna false quando resposta nao tem campo results", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ error: "no results" }),
      });

      const result = await isSearxRunning();
      expect(result).toBe(false);
    });
  });

  describe("getSearxStatus", () => {
    it("retorna status com installed=false quando nada existe", () => {
      spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
      existsSyncMock.mockReturnValue(false);

      const status = getSearxStatus();
      expect(status.installed).toBe(false);
      expect(status.running).toBe(false);
      expect(status.method).toBeNull();
      expect(status.url).toContain("8888");
      expect(status.dockerAvailable).toBeDefined();
    });

    it("retorna method=docker quando container existe", () => {
      // docker inspect retorna 0 (existe)
      spawnSyncMock.mockReturnValue({ status: 0, stdout: "true", stderr: "" });

      const status = getSearxStatus();
      expect(status.method).toBe("docker");
    });

    it("retorna method=python quando venv existe (sem Docker)", () => {
      // Docker nao disponivel
      spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }); // docker --version falha
      existsSyncMock.mockReturnValue(true);

      const status = getSearxStatus();
      expect(status.method).toBe("python");
    });

    it("retorna dockerAvailable=false quando docker nao esta no PATH", () => {
      spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });

      const status = getSearxStatus();
      expect(status.dockerAvailable).toBe(false);
    });

    it("retorna dockerAvailable=true quando docker --version funciona", () => {
      spawnSyncMock.mockReturnValue({ status: 0, stdout: "Docker version 24.0", stderr: "" });

      const status = getSearxStatus();
      expect(status.dockerAvailable).toBe(true);
    });
  });

  describe("autoStopSearx", () => {
    it("nao faz nada quando weStartedSearx é false", () => {
      // autoStopSearx so para se a CLI iniciou o Searx
      // Como nao chamamos autoStartSearx, weStartedSearx é false
      expect(() => autoStopSearx()).not.toThrow();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });

  describe("autoStartSearx", () => {
    it("retorna true quando Searx ja esta rodando", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ title: "test" }] }),
      });

      const { autoStartSearx } = await import("../searxManager.js");
      const result = await autoStartSearx();
      expect(result).toBe(true);
    });

    it("retorna false quando nada esta instalado", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
      spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
      existsSyncMock.mockReturnValue(false);

      const { autoStartSearx } = await import("../searxManager.js");
      const result = await autoStartSearx();
      expect(result).toBe(false);
    });
  });
});
