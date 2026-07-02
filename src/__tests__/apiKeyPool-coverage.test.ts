/**
 * apiKeyPool-coverage.test.ts — Testes de cobertura do apiKeyPool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import {
  getPoolSize,
  getAvailableKeyCount,
  getTotalKeyCount,
  formatPoolStats,
  resetPoolStats,
} from "../apiKeyPool.js";

describe("apiKeyPool — coverage", () => {
  describe("getPoolSize", () => {
    it("retorna number", () => {
      const result = getPoolSize();
      expect(typeof result).toBe("number");
    });
  });

  describe("getAvailableKeyCount", () => {
    it("retorna number", () => {
      const result = getAvailableKeyCount();
      expect(typeof result).toBe("number");
    });
  });

  describe("getTotalKeyCount", () => {
    it("retorna number", () => {
      const result = getTotalKeyCount();
      expect(typeof result).toBe("number");
    });
  });

  describe("formatPoolStats", () => {
    it("retorna string", () => {
      const result = formatPoolStats();
      expect(typeof result).toBe("string");
    });
  });

  describe("resetPoolStats", () => {
    it("não lança exceção", () => {
      expect(() => resetPoolStats()).not.toThrow();
    });
  });
});
