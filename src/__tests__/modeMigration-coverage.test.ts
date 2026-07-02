/**
 * modeMigration-coverage.test.ts — Testes de cobertura do modeMigration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { needsMigration } from "../modeMigration.js";

describe("modeMigration — coverage", () => {
  describe("needsMigration", () => {
    it("retorna boolean", () => {
      const result = needsMigration();
      expect(typeof result).toBe("boolean");
    });
  });
});
