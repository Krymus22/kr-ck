/**
 * modeMigration-deep.test.ts — Testes profundos do modeMigration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { needsMigration, migrateToModeStructure, runMigrationIfNeeded } from "../modeMigration.js";

describe("modeMigration — deep coverage", () => {
  describe("needsMigration", () => {
    it("retorna boolean", () => {
      expect(typeof needsMigration()).toBe("boolean");
    });
  });

  describe("migrateToModeStructure", () => {
    it("retorna MigrationResult", () => {
      const result = migrateToModeStructure();
      expect(result).toHaveProperty("migrated");
      expect(result).toHaveProperty("errors");
      expect(Array.isArray(result.errors)).toBe(true);
    });
  });

  describe("runMigrationIfNeeded", () => {
    it("retorna boolean", () => {
      const result = runMigrationIfNeeded();
      expect(typeof result).toBe("boolean");
    });

    it("não lança exceção quando chamado múltiplas vezes", () => {
      expect(() => {
        runMigrationIfNeeded();
        runMigrationIfNeeded();
      }).not.toThrow();
    });
  });
});
