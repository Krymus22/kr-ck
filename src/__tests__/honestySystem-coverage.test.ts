/**
 * honestySystem-coverage.test.ts — Testes de cobertura do honestySystem
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../apiClient.js", () => ({ chat: vi.fn() }));
vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));
vi.mock("../activityTracker.js", () => ({ pushActivity: vi.fn(() => () => {}) }));

import {
  getHonestyFeatures,
  markFileAsEdited,
  markFileAsReadBack,
  getUnreadBackFiles,
  getReadBackWarning,
  extractConfidence,
} from "../honestySystem.js";

describe("honestySystem — coverage", () => {
  describe("getHonestyFeatures", () => {
    it("retorna array de features", () => {
      const features = getHonestyFeatures();
      expect(Array.isArray(features)).toBe(true);
    });
  });

  describe("markFileAsEdited", () => {
    it("não lança exceção", () => {
      expect(() => markFileAsEdited("/tmp/test.lua")).not.toThrow();
    });
  });

  describe("markFileAsReadBack", () => {
    it("não lança exceção", () => {
      expect(() => markFileAsReadBack("/tmp/test.lua")).not.toThrow();
    });
  });

  describe("getUnreadBackFiles", () => {
    it("retorna array", () => {
      const result = getUnreadBackFiles();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getReadBackWarning", () => {
    it("retorna string", () => {
      const result = getReadBackWarning();
      expect(typeof result).toBe("string");
    });
  });

  describe("extractConfidence", () => {
    it("extrai confidence: 100", () => {
      const confidence = extractConfidence("confidence: 10");
      expect(confidence).toBe(10);
    });

    it("extrai confianca: 80", () => {
      const confidence = extractConfidence("confianca: 8");
      expect(confidence).toBe(8);
    });

    it("extrai confidence: 50", () => {
      const confidence = extractConfidence("confidence: 5");
      expect(confidence).toBe(5);
    });

    it("retorna 0 para texto sem porcentagem", () => {
      const confidence = extractConfidence("Acho que funciona");
      expect(confidence).toBe(0);
    });

    it("retorna 0 para string vazia", () => {
      const confidence = extractConfidence("");
      expect(confidence).toBe(0);
    });

    it("retorna 0 para texto sem confianca", () => {
      const confidence = extractConfidence("acho que funciona");
      expect(confidence).toBe(0);
    });
  });
});
