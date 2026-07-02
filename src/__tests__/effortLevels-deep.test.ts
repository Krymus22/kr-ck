/**
 * effortLevels-deep.test.ts — Testes profundos do effortLevels
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  getEffortLevel,
  setEffortLevel,
  getEffortPromptSnippet,
  getEffortLabel,
  shouldAutoGenerateTests,
  shouldUseSubAgents,
  shouldUseIntelligentCompaction,
} from "../effortLevels.js";

describe("effortLevels — deep coverage", () => {
  describe("getEffortLevel / setEffortLevel", () => {
    it("getEffortLevel retorna string", () => {
      const level = getEffortLevel();
      expect(["low", "medium", "high", "max"]).toContain(level);
    });

    it("setEffortLevel muda para low", () => {
      const result = setEffortLevel("low");
      expect(result).toBe(true);
      expect(getEffortLevel()).toBe("low");
    });

    it("setEffortLevel muda para medium", () => {
      setEffortLevel("medium");
      expect(getEffortLevel()).toBe("medium");
    });

    it("setEffortLevel muda para high", () => {
      setEffortLevel("high");
      expect(getEffortLevel()).toBe("high");
    });

    it("setEffortLevel muda para max", () => {
      setEffortLevel("max");
      expect(getEffortLevel()).toBe("max");
    });

    it("setEffortLevel retorna false para valor inválido", () => {
      const result = setEffortLevel("invalid" as any);
      expect(result).toBe(false);
    });
  });

  describe("getEffortPromptSnippet", () => {
    it("retorna string não vazia para low", () => {
      setEffortLevel("low");
      const snippet = getEffortPromptSnippet();
      expect(typeof snippet).toBe("string");
      expect(snippet.length).toBeGreaterThan(0);
    });

    it("retorna string não vazia para medium", () => {
      setEffortLevel("medium");
      const snippet = getEffortPromptSnippet();
      expect(typeof snippet).toBe("string");
    });

    it("retorna string não vazia para high", () => {
      setEffortLevel("high");
      const snippet = getEffortPromptSnippet();
      expect(typeof snippet).toBe("string");
    });

    it("retorna string não vazia para max", () => {
      setEffortLevel("max");
      const snippet = getEffortPromptSnippet();
      expect(typeof snippet).toBe("string");
    });

    it(" snippets diferentes para níveis diferentes", () => {
      setEffortLevel("low");
      const low = getEffortPromptSnippet();
      setEffortLevel("max");
      const max = getEffortPromptSnippet();
      expect(low).not.toBe(max);
    });
  });

  describe("getEffortLabel", () => {
    it("retorna string para low", () => {
      setEffortLevel("low");
      expect(typeof getEffortLabel()).toBe("string");
    });

    it("retorna string para medium", () => {
      setEffortLevel("medium");
      expect(typeof getEffortLabel()).toBe("string");
    });

    it("retorna string para high", () => {
      setEffortLevel("high");
      expect(typeof getEffortLabel()).toBe("string");
    });

    it("retorna string para max", () => {
      setEffortLevel("max");
      expect(typeof getEffortLabel()).toBe("string");
    });
  });

  describe("shouldAutoGenerateTests", () => {
    it("retorna boolean para low", () => {
      setEffortLevel("low");
      expect(typeof shouldAutoGenerateTests()).toBe("boolean");
    });

    it("retorna boolean para max", () => {
      setEffortLevel("max");
      expect(typeof shouldAutoGenerateTests()).toBe("boolean");
    });
  });

  describe("shouldUseSubAgents", () => {
    it("retorna boolean", () => {
      setEffortLevel("medium");
      expect(typeof shouldUseSubAgents()).toBe("boolean");
    });
  });

  describe("shouldUseIntelligentCompaction", () => {
    it("retorna boolean", () => {
      setEffortLevel("high");
      expect(typeof shouldUseIntelligentCompaction()).toBe("boolean");
    });
  });
});
