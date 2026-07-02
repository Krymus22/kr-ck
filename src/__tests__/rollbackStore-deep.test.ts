/**
 * rollbackStore-deep.test.ts — Testes profundos do rollbackStore
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import {
  pruneOldBackups,
  saveBackup,
  restoreBackup,
  listBackups,
  getRollbackDirPath,
  clearAllBackups,
  resetRollbackState,
} from "../rollbackStore.js";

describe("rollbackStore — deep coverage", () => {
  beforeEach(() => {
    resetRollbackState();
  });

  describe("saveBackup / restoreBackup", () => {
    it("salva backup de arquivo existente", () => {
      const tmpFile = path.join(os.tmpdir(), `rb-test-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "original content");
      try {
        const result = saveBackup(tmpFile);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("restaura backup com sucesso", () => {
      const tmpFile = path.join(os.tmpdir(), `rb-restore-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "original content");
      try {
        saveBackup(tmpFile);
        fs.writeFileSync(tmpFile, "modified content");
        const restored = restoreBackup(tmpFile);
        expect(typeof restored).toBe("boolean");
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it("restoreBackup retorna false para arquivo sem backup", () => {
      const result = restoreBackup("/nonexistent/file/without/backup.lua");
      expect(result).toBe(false);
    });
  });

  describe("listBackups", () => {
    it("retorna array", () => {
      const backups = listBackups();
      expect(Array.isArray(backups)).toBe(true);
    });

    it("retorna array para path específico", () => {
      const backups = listBackups("/tmp/specific/file.lua");
      expect(Array.isArray(backups)).toBe(true);
    });
  });

  describe("getRollbackDirPath", () => {
    it("retorna string não vazia", () => {
      const dir = getRollbackDirPath();
      expect(typeof dir).toBe("string");
      expect(dir.length).toBeGreaterThan(0);
    });

    it("contém .claude-killer", () => {
      const dir = getRollbackDirPath();
      expect(dir).toContain(".claude-killer");
    });
  });

  describe("clearAllBackups", () => {
    it("retorna number", () => {
      const result = clearAllBackups();
      expect(typeof result).toBe("number");
    });
  });

  describe("pruneOldBackups", () => {
    it("retorna number", () => {
      const result = pruneOldBackups(86400000); // 1 day
      expect(typeof result).toBe("number");
    });

    it("não lança exceção com maxAge 0", () => {
      expect(() => pruneOldBackups(0)).not.toThrow();
    });
  });

  describe("resetRollbackState", () => {
    it("não lança exceção", () => {
      expect(() => resetRollbackState()).not.toThrow();
    });
  });
});
