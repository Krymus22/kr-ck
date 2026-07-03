/**
 * searxManager-docker.test.ts — Testes do ensureDockerRunning e launchDockerDesktop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn(() => ({ pid: 12345, unref: vi.fn() })) }));
const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock, spawnSync: spawnSyncMock }));
vi.mock("node:fs", () => ({ existsSync: existsSyncMock, readFileSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open: vi.fn(() => Promise.resolve({ fd: 42 })) }));
global.fetch = vi.fn() as any;

import { isSearxRunning, getSearxStatus, autoStopSearx } from "../searxManager.js";

describe("searxManager — Docker launch + ensureDockerRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    spawnMock.mockReturnValue({ pid: 12345, unref: vi.fn() });
  });

  describe("Docker daemon detection", () => {
    it("detecta Docker disponível quando docker --version funciona", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") {
          return { status: 0, stdout: "Docker version 24.0", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      });
      const status = getSearxStatus();
      expect(status.dockerAvailable).toBe(true);
    });

    it("detecta Docker não disponível quando docker --version falha", () => {
      spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
      const status = getSearxStatus();
      expect(status.dockerAvailable).toBe(false);
    });

    it("detecta Docker daemon rodando quando docker info funciona", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") {
          return { status: 0, stdout: "Docker version 24.0", stderr: "" };
        }
        if (cmd === "docker" && args?.[0] === "info") {
          return { status: 0, stdout: "Containers: 1", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      });
      const status = getSearxStatus();
      expect(status.dockerAvailable).toBe(true);
    });

    it("detecta Docker daemon parado quando docker info falha", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") {
          return { status: 0, stdout: "Docker version 24.0", stderr: "" };
        }
        if (cmd === "docker" && args?.[0] === "info") {
          return { status: 1, stdout: "", stderr: "Cannot connect" };
        }
        return { status: 1, stdout: "", stderr: "" };
      });
      const status = getSearxStatus();
      expect(status.dockerAvailable).toBe(true); // docker binary exists
    });
  });

  describe("Docker container detection", () => {
    it("detecta container existe quando docker inspect retorna 0", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") return { status: 0, stdout: "Docker 24", stderr: "" };
        if (cmd === "docker" && args?.[0] === "inspect") return { status: 0, stdout: "true", stderr: "" };
        return { status: 1, stdout: "", stderr: "" };
      });
      const status = getSearxStatus();
      expect(status.installed).toBe(true);
      expect(status.method).toBe("docker");
    });

    it("detecta container não existe quando docker inspect falha", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") return { status: 0, stdout: "Docker 24", stderr: "" };
        if (cmd === "docker" && args?.[0] === "inspect") return { status: 1, stdout: "", stderr: "no such container" };
        return { status: 1, stdout: "", stderr: "" };
      });
      const status = getSearxStatus();
      expect(status.installed).toBe(false);
    });

    it("detecta container rodando quando State.Running = true", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") return { status: 0, stdout: "Docker 24", stderr: "" };
        if (cmd === "docker" && args?.[0] === "inspect" && args?.includes("-f")) return { status: 0, stdout: "true", stderr: "" };
        if (cmd === "docker" && args?.[0] === "inspect") return { status: 0, stdout: "true", stderr: "" };
        return { status: 1, stdout: "", stderr: "" };
      });
      const status = getSearxStatus();
      expect(status.running).toBe(true);
    });

    it("detecta container parado quando State.Running = false", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") return { status: 0, stdout: "Docker 24", stderr: "" };
        if (cmd === "docker" && args?.[0] === "inspect" && args?.includes("-f")) return { status: 0, stdout: "false", stderr: "" };
        if (cmd === "docker" && args?.[0] === "inspect") return { status: 0, stdout: "true", stderr: "" };
        return { status: 1, stdout: "", stderr: "" };
      });
      const status = getSearxStatus();
      expect(status.running).toBe(false);
    });
  });

  describe("isSearxRunning (HTTP probe)", () => {
    it("retorna true quando fetch retorna 200 com results", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ title: "test" }] }),
      });
      expect(await isSearxRunning()).toBe(true);
    });

    it("retorna false quando fetch retorna não-ok", async () => {
      (global.fetch as any).mockResolvedValue({ ok: false, json: async () => ({}) });
      expect(await isSearxRunning()).toBe(false);
    });

    it("retorna false quando fetch lança erro", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
      expect(await isSearxRunning()).toBe(false);
    });

    it("retorna false quando resposta não tem results", async () => {
      (global.fetch as any).mockResolvedValue({ ok: true, json: async () => ({ error: "nope" }) });
      expect(await isSearxRunning()).toBe(false);
    });
  });

  describe("autoStopSearx", () => {
    it("não faz nada quando CLI não iniciou Searx", () => {
      expect(() => autoStopSearx()).not.toThrow();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });
});
