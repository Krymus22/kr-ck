/**
 * dataGuard-extended.test.ts — Testes estendidos do DataGuard
 *
 * Testa runDataGuard com mocks, quickScanForDataPatterns (via export),
 * resetDataGuardState, e fluxos de bloqueio/liberação.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock apiClient
const { chatMock } = vi.hoisted(() => ({
  chatMock: vi.fn(),
}));

vi.mock("../apiClient.js", () => ({ chat: chatMock }));

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  throttle: vi.fn(),
}));

vi.mock("../activityTracker.js", () => ({
  pushActivity: vi.fn(() => () => {}),
}));

// Mock do bugHunter para formatBugHuntMessage
vi.mock("../bugHunter.js", () => ({
  formatBugHuntMessage: vi.fn((findings: any[]) => `Formatted: ${findings.length} findings`),
}));

import { runDataGuard, resetDataGuardState } from "../dataGuard.js";

describe("dataGuard (extended)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDataGuardState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runDataGuard", () => {
    it("retorna shouldBlock=false quando nenhum arquivo foi modificado", async () => {
      const result = await runDataGuard([], "user request", "agent response");
      expect(result.shouldBlock).toBe(false);
      expect(result.findings).toEqual([]);
      expect(result.completed).toBe(false);
      expect(chatMock).not.toHaveBeenCalled();
    });

    it("retorna shouldBlock=false quando LLM retorna sem findings", async () => {
      // Criar arquivo temporário
      const tmpFile = path.join(os.tmpdir(), `dg-test-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "local x = 1\nprint(x)\n");

      try {
        chatMock.mockResolvedValue({
          choices: [{
            message: { content: "NO_FINDINGS: No data protection issues found.", tool_calls: undefined },
            finish_reason: "stop",
          }],
        });

        const result = await runDataGuard([tmpFile], "create variable", "created x");
        expect(result.shouldBlock).toBe(false);
        expect(result.completed).toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("retorna shouldBlock=true quando LLM encontra CRITICAL findings", async () => {
      const tmpFile = path.join(os.tmpdir(), `dg-test-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "local store = DataStoreService:GetDataStore('Player')\nstore:SetAsync('key', data)\n");

      try {
        chatMock.mockResolvedValue({
          choices: [{
            message: {
              content: `FINDINGS:
1. [CRITICAL] SetAsync without GetAsync at line 2 — overwrites data without reading first
SEVERITY: CRITICAL
COUNT: 1`,
              tool_calls: undefined,
            },
            finish_reason: "stop",
          }],
        });

        const result = await runDataGuard([tmpFile], "save player data", "implemented save");
        expect(result.shouldBlock).toBe(true);
        expect(result.findings.length).toBeGreaterThan(0);
        expect(result.completed).toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("retorna shouldBlock=false quando API falha após retries", async () => {
      const tmpFile = path.join(os.tmpdir(), `dg-test-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "print('hello')\n");

      try {
        chatMock.mockRejectedValue(new Error("API timeout"));

        const result = await runDataGuard([tmpFile], "test", "test");
        expect(result.shouldBlock).toBe(false);
        expect(result.completed).toBe(false);
        expect(result.message).toContain("skipped");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("quickScanForDataPatterns (via runDataGuard)", () => {
    it("detecta SetAsync em arquivo Lua", async () => {
      const tmpFile = path.join(os.tmpdir(), `dg-scan-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "store:SetAsync('key', data)\n");

      try {
        chatMock.mockResolvedValue({
          choices: [{
            message: { content: "NO_FINDINGS: No issues.", tool_calls: undefined },
            finish_reason: "stop",
          }],
        });

        await runDataGuard([tmpFile], "save data", "saved");

        // Verificar que o chat foi chamado com contexto que menciona SetAsync
        const callArgs = chatMock.mock.calls[0]?.[0];
        if (callArgs) {
          const userContent = callArgs.find((m: any) => m.role === "user")?.content;
          // O scan deve ter detectado SetAsync
          expect(userContent).toContain("SetAsync");
        }
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("detecta DROP TABLE em arquivo SQL", async () => {
      const tmpFile = path.join(os.tmpdir(), `dg-scan-${Date.now()}.sql`);
      fs.writeFileSync(tmpFile, "DROP TABLE users;\n");

      try {
        chatMock.mockResolvedValue({
          choices: [{
            message: { content: "NO_FINDINGS: No issues.", tool_calls: undefined },
            finish_reason: "stop",
          }],
        });

        await runDataGuard([tmpFile], "drop table", "dropped");

        const callArgs = chatMock.mock.calls[0]?.[0];
        if (callArgs) {
          const userContent = callArgs.find((m: any) => m.role === "user")?.content;
          expect(userContent).toContain("DROP TABLE");
        }
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("detecta RemoveAsync em arquivo Lua", async () => {
      const tmpFile = path.join(os.tmpdir(), `dg-scan-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "store:RemoveAsync('key')\n");

      try {
        chatMock.mockResolvedValue({
          choices: [{
            message: { content: "NO_FINDINGS: No issues.", tool_calls: undefined },
            finish_reason: "stop",
          }],
        });

        await runDataGuard([tmpFile], "remove data", "removed");

        const callArgs = chatMock.mock.calls[0]?.[0];
        if (callArgs) {
          const userContent = callArgs.find((m: any) => m.role === "user")?.content;
          expect(userContent).toContain("RemoveAsync");
        }
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("não quebra quando arquivo não existe", async () => {
      chatMock.mockResolvedValue({
        choices: [{
          message: { content: "NO_FINDINGS: No issues.", tool_calls: undefined },
          finish_reason: "stop",
        }],
      });

      const result = await runDataGuard(["/nonexistent/file.lua"], "test", "test");
      expect(result.shouldBlock).toBe(false);
    });
  });

  describe("resetDataGuardState", () => {
    it("não lança exceção", () => {
      expect(() => resetDataGuardState()).not.toThrow();
    });

    it("permite re-execução após reset", async () => {
      const tmpFile = path.join(os.tmpdir(), `dg-reset-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "print('test')\n");

      try {
        chatMock.mockResolvedValue({
          choices: [{
            message: { content: "NO_FINDINGS: No issues.", tool_calls: undefined },
            finish_reason: "stop",
          }],
        });

        // Primeira execução
        const r1 = await runDataGuard([tmpFile], "test", "test");
        expect(r1.completed).toBe(true);

        // Reset
        resetDataGuardState();

        // Segunda execução deve funcionar
        const r2 = await runDataGuard([tmpFile], "test", "test");
        expect(r2.completed).toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });
});
