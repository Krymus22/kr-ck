/**
 * history-coverage.test.ts — Testes de cobertura estendidos do history
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../extensions.js", () => ({ getActiveSkills: vi.fn(() => []) }));
vi.mock("../effortLevels.js", () => ({ getEffortPromptSnippet: vi.fn(() => "") }));
vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));
vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", model: "test-model",
    contextWindowTokens: 128000, contextCompactThreshold: 0.75,
    temperature: 0.6, topP: 0.9, maxTokens: 4096, effortLevel: "medium",
  },
}));

import {
  addUserMessage, addSystemMessage, addRawAssistantMessage,
  getHistory, historyLength, historySummary, estimateTokens,
  resetHistory, isPlanMode, setPlanMode, getCavemanLevel, setCavemanLevel,
} from "../history.js";

describe("history — coverage", () => {
  beforeEach(() => {
    resetHistory();
  });

  describe("historyLength", () => {
    it("retorna 1 após reset (system prompt)", () => {
      resetHistory();
      // history has at least the system prompt
      expect(historyLength()).toBeGreaterThanOrEqual(1);
    });

    it("aumenta ao adicionar mensagens", () => {
      const before = historyLength();
      addUserMessage("test message");
      expect(historyLength()).toBe(before + 1);
    });
  });

  describe("historySummary", () => {
    it("retorna string não vazia", () => {
      const summary = historySummary();
      expect(typeof summary).toBe("string");
      expect(summary.length).toBeGreaterThan(0);
    });
  });

  describe("estimateTokens", () => {
    it("retorna número positivo", () => {
      const tokens = estimateTokens();
      expect(typeof tokens).toBe("number");
      expect(tokens).toBeGreaterThan(0);
    });

    it("estima tokens para array custom", () => {
      const tokens = estimateTokens([
        { role: "user", content: "hello world this is a test" },
      ]);
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe("planMode", () => {
    it("isPlanMode retorna boolean", () => {
      expect(typeof isPlanMode()).toBe("boolean");
    });

    it("setPlanMode alterna estado", () => {
      setPlanMode(true);
      expect(isPlanMode()).toBe(true);
      setPlanMode(false);
      expect(isPlanMode()).toBe(false);
    });
  });

  describe("cavemanLevel", () => {
    it("getCavemanLevel retorna null ou string", () => {
      const level = getCavemanLevel();
      expect(level === null || typeof level === "string").toBe(true);
    });

    it("setCavemanLevel define nível", () => {
      setCavemanLevel("lite");
      expect(getCavemanLevel()).toBe("lite");
    });

    it("setCavemanLevel(null) reseta", () => {
      setCavemanLevel(null);
      expect(getCavemanLevel()).toBeNull();
    });
  });

  describe("addSystemMessage", () => {
    it("adiciona mensagem de sistema", () => {
      const before = historyLength();
      addSystemMessage("[TEST] test system message");
      expect(historyLength()).toBe(before + 1);
    });
  });

  describe("addRawAssistantMessage", () => {
    it("adiciona mensagem de assistente", () => {
      const before = historyLength();
      addRawAssistantMessage({
        role: "assistant",
        content: "test response",
      });
      expect(historyLength()).toBe(before + 1);
    });
  });
});
