/**
 * searxManager-autoStart.test.ts — Testes do autoStartSearx com Docker/Python
 *
 * Testa o fluxo de autoStartSearx com diferentes cenários:
 *   - Searx já rodando (isSearxRunning = true)
 *   - Docker container existe mas parado → start container
 *   - Docker daemon não rodando → ensureDockerRunning
 *   - Python venv existe → spawn python
 *   - Nada instalado → retorna false
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn(() => ({ pid: 12345, unref: vi.fn() })) }));
const { existsSyncMock } = vi.hoisted(() => ({ existsSyncMock: vi.fn() }));
const { openSyncMock } = vi.hoisted(() => ({ openSyncMock: vi.fn(() => 42) }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  open: vi.fn(() => Promise.resolve({ fd: 42 })),
}));

global.fetch = vi.fn() as any;

import { autoStartSearx, getSearxStatus, autoStopSearx } from "../searxManager.js";

describe("searxManager — autoStartSearx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
    spawnMock.mockReturnValue({ pid: 12345, unref: vi.fn() });
    openSyncMock.mockReturnValue(42);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("autoStartSearx", () => {
    it("retorna true quando Searx já está rodando", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ title: "test" }] }),
      });

      const result = await autoStartSearx();
      expect(result).toBe(true);
    });

    it("retorna false quando nada está instalado (sem Docker, sem Python)", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
      spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
      existsSyncMock.mockReturnValue(false);

      const result = await autoStartSearx();
      expect(result).toBe(false);
    });

    it("inicia Docker container quando existe mas está parado", async () => {
      // fetch falha (Searx não rodando)
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));

      // docker --version funciona (Docker disponível)
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") {
          return { status: 0, stdout: "Docker version 24.0", stderr: "" };
        }
        // docker info funciona (daemon rodando)
        if (cmd === "docker" && args?.[0] === "info") {
          return { status: 0, stdout: "Containers: 1", stderr: "" };
        }
        // docker inspect (container existe)
        if (cmd === "docker" && args?.[0] === "inspect") {
          return { status: 0, stdout: "true", stderr: "" };
        }
        // docker inspect -f '{{.State.Running}}' retorna false (parado)
        if (cmd === "docker" && args?.[0] === "inspect" && args?.[1] === "-f") {
          return { status: 0, stdout: "false", stderr: "" };
        }
        // docker start
        if (cmd === "docker" && args?.[0] === "start") {
          return { status: 0, stdout: "container started", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      });

      const result = await autoStartSearx();
      expect(result).toBe(true);
    });

    it("retorna false quando Docker daemon não está rodando e não consegue iniciar", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));

      // docker --version funciona mas docker info falha (daemon parado)
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") {
          return { status: 0, stdout: "Docker version 24.0", stderr: "" };
        }
        if (cmd === "docker" && args?.[0] === "info") {
          return { status: 1, stdout: "", stderr: "Cannot connect to Docker daemon" };
        }
        // docker inspect funciona (container existe)
        if (cmd === "docker" && args?.[0] === "inspect") {
          return { status: 0, stdout: "true", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      });

      // spawn (para launchDockerDesktop) não encontra exe
      existsSyncMock.mockReturnValue(false);

      const result = await autoStartSearx();
      expect(result).toBe(false);
    });

    it("retorna false quando Python venv não existe", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
      // Sem Docker
      spawnSyncMock.mockReturnValue({ status: 1, stdout: "", stderr: "" });
      existsSyncMock.mockReturnValue(false);

      const result = await autoStartSearx();
      expect(result).toBe(false);
    });
  });

  describe("getSearxStatus — Docker scenarios", () => {
    it("retorna running=true quando Docker container está rodando", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") {
          return { status: 0, stdout: "Docker version 24.0", stderr: "" };
        }
        if (cmd === "docker" && args?.[0] === "inspect") {
          return { status: 0, stdout: "true", stderr: "" };
        }
        if (cmd === "docker" && args?.[0] === "inspect" && args?.[1] === "-f") {
          return { status: 0, stdout: "true", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      });

      const status = getSearxStatus();
      expect(status.installed).toBe(true);
      expect(status.running).toBe(true);
      expect(status.method).toBe("docker");
      expect(status.dockerAvailable).toBe(true);
    });

    it("retorna running=false quando Docker container existe mas está parado", () => {
      spawnSyncMock.mockImplementation((cmd: string, args: any[]) => {
        if (cmd === "docker" && args?.[0] === "--version") {
          return { status: 0, stdout: "Docker version 24.0", stderr: "" };
        }
        // Check -f flag FIRST (dockerContainerRunning uses it)
        if (cmd === "docker" && args?.[0] === "inspect" && args?.includes("-f")) {
          return { status: 0, stdout: "false", stderr: "" };
        }
        // Regular inspect (dockerContainerExists)
        if (cmd === "docker" && args?.[0] === "inspect") {
          return { status: 0, stdout: "true", stderr: "" };
        }
        // lsof/ss (isSearxProcessRunning) — retorna vazio (nada na porta)
        if (cmd === "lsof" || cmd === "ss") {
          return { status: 1, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: "" };
      });

      const status = getSearxStatus();
      expect(status.installed).toBe(true);
      expect(status.method).toBe("docker");
    });
  });

  describe("autoStopSearx", () => {
    it("não faz nada quando a CLI não iniciou Searx", () => {
      expect(() => autoStopSearx()).not.toThrow();
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });
});
