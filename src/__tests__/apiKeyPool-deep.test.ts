/**
 * apiKeyPool-deep.test.ts — Testes profundos do apiKeyPool
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
  getPoolStats,
  formatPoolStats,
  resetPoolStats,
  resetPool,
  resetPrewarm,
  tryAcquireKeyImmediate,
  loadApiKeys,
} from "../apiKeyPool.js";

describe("apiKeyPool — deep coverage", () => {
  describe("loadApiKeys", () => {
    it("retorna array", () => {
      const keys = loadApiKeys();
      expect(Array.isArray(keys)).toBe(true);
    });
  });

  describe("getPoolSize", () => {
    it("retorna number >= 0", () => {
      const size = getPoolSize();
      expect(size).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getAvailableKeyCount", () => {
    it("retorna number >= 0", () => {
      const count = getAvailableKeyCount();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getTotalKeyCount", () => {
    it("retorna number >= 0", () => {
      const count = getTotalKeyCount();
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });

  describe("getPoolStats", () => {
    it("retorna array", () => {
      const stats = getPoolStats();
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe("formatPoolStats", () => {
    it("retorna string", () => {
      const result = formatPoolStats();
      expect(typeof result).toBe("string");
    });

    it("não lança exceção quando pool está vazio", () => {
      resetPool();
      expect(() => formatPoolStats()).not.toThrow();
    });
  });

  describe("tryAcquireKeyImmediate", () => {
    it("retorna objeto ou null", () => {
      const key = tryAcquireKeyImmediate();
      expect(key === null || typeof key === "object").toBe(true);
    });
  });

  describe("resetPoolStats", () => {
    it("não lança exceção", () => {
      expect(() => resetPoolStats()).not.toThrow();
    });
  });

  describe("resetPool", () => {
    it("não lança exceção", () => {
      expect(() => resetPool()).not.toThrow();
    });
  });

  describe("resetPrewarm", () => {
    it("não lança exceção", () => {
      expect(() => resetPrewarm()).not.toThrow();
    });
  });
});
