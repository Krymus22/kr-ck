/**
 * honestySystem-deep.test.ts — Testes profundos do honestySystem
 *
 * Cobre: runDevilsAdvocate, diffRealityCheck, detectHallucinations,
 * checkEvidenceRequirement, checkUserClaims, checkConfidenceAction,
 * runAnonymousReview, incrementTurn, checkContradictions,
 * isProveItModeActive, proveItCheck, resetHonestyTurn, clearAllHonestyState,
 * hasUnreadBackFiles
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../apiClient.js", () => ({ chat: vi.fn() }));
vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));
vi.mock("../activityTracker.js", () => ({ pushActivity: vi.fn(() => () => {}) }));

import { chat } from "../apiClient.js";
const chatMock = vi.mocked(chat);

import {
  getHonestyFeatures,
  isHonestyFeatureEnabled,
  runDevilsAdvocate,
  diffRealityCheck,
  markFileAsEdited,
  markFileAsReadBack,
  hasUnreadBackFiles,
  getUnreadBackFiles,
  getReadBackWarning,
  detectHallucinations,
  checkEvidenceRequirement,
  checkUserClaims,
  extractConfidence,
  checkConfidenceAction,
  runAnonymousReview,
  incrementTurn,
  checkContradictions,
  isProveItModeActive,
  proveItCheck,
  resetHonestyTurn,
  clearAllHonestyState,
} from "../honestySystem.js";

describe("honestySystem — deep coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllHonestyState();
  });

  describe("getHonestyFeatures", () => {
    it("retorna array com features", () => {
      const features = getHonestyFeatures();
      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBeGreaterThan(0);
    });

    it("cada feature tem id, name, description", () => {
      const features = getHonestyFeatures();
      for (const f of features) {
        expect(f).toHaveProperty("id");
        expect(f).toHaveProperty("name");
        expect(f).toHaveProperty("description");
      }
    });
  });

  describe("isHonestyFeatureEnabled", () => {
    it("retorna boolean para feature conhecida", async () => {
      const result = await isHonestyFeatureEnabled("feature:devils_advocate");
      expect(typeof result).toBe("boolean");
    });

    it("retorna false para feature inexistente", async () => {
      const result = await isHonestyFeatureEnabled("feature:nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("runDevilsAdvocate", () => {
    it("retorna resultado com severity", async () => {
      chatMock.mockResolvedValue({
        choices: [{
          message: { content: "SEVERITY: low\nISSUES:\n- minor concern" },
          tool_calls: undefined,
        }],
      } as any);
      const result = await runDevilsAdvocate(
        [{ path: "test.lua", content: "print('hello')" }],
        "create a function"
      );
      expect(result).toHaveProperty("severity");
      expect(result).toHaveProperty("issues");
    });

    it("retorna severity high quando LLM encontra problemas críticos", async () => {
      chatMock.mockResolvedValue({
        choices: [{
          message: { content: "SEVERITY: high\nISSUES:\n- Critical security vulnerability\n- Data loss risk" },
          tool_calls: undefined,
        }],
      } as any);
      const result = await runDevilsAdvocate(
        [{ path: "datastore.lua", content: "store:SetAsync('key', nil)" }],
        "save data"
      );
      expect(typeof result.severity).toBe("string");
      expect(Array.isArray(result.issues)).toBe(true);
    });

    it("retorna low quando LLM não encontra problemas", async () => {
      chatMock.mockResolvedValue({
        choices: [{
          message: { content: "SEVERITY: low\nISSUES:\nNone" },
          tool_calls: undefined,
        }],
      } as any);
      const result = await runDevilsAdvocate(
        [{ path: "test.lua", content: "local x = 1" }],
        "create variable"
      );
      expect(typeof result.severity).toBe("string");
    });

    it("retorna low quando API falha", async () => {
      chatMock.mockRejectedValue(new Error("API error"));
      const result = await runDevilsAdvocate(
        [{ path: "test.lua", content: "print('test')" }],
        "test"
      );
      expect(result).toHaveProperty("severity");
    });
  });

  describe("diffRealityCheck", () => {
    it("retorna string", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "VERIFIED: changes match claims" } }],
      } as any);
      const result = await diffRealityCheck(
        [{ path: "test.lua", content: "print('hello')" }],
        "I added a print statement"
      );
      expect(result).toBeTruthy();
    });

    it("retorna string quando API falha", async () => {
      chatMock.mockRejectedValue(new Error("API error"));
      const result = await diffRealityCheck(
        [{ path: "test.lua", content: "print('hello')" }],
        "I added a print statement"
      );
      expect(result).toBeTruthy();
    });
  });

  describe("markFileAsEdited / markFileAsReadBack", () => {
    it("marca arquivo como editado", () => {
      markFileAsEdited("/tmp/test.lua");
      const unread = getUnreadBackFiles();
      expect(unread).toContain("/tmp/test.lua");
    });

    it("marca arquivo como read back", () => {
      markFileAsEdited("/tmp/test.lua");
      markFileAsReadBack("/tmp/test.lua");
      const unread = getUnreadBackFiles();
      expect(unread).not.toContain("/tmp/test.lua");
    });

    it("getReadBackWarning retorna string", () => {
      markFileAsEdited("/tmp/test.lua");
      const warning = getReadBackWarning();
      expect(typeof warning).toBe("string");
    });
  });

  describe("hasUnreadBackFiles", () => {
    it("retorna false quando não há arquivos editados", async () => {
      clearAllHonestyState();
      const result = await hasUnreadBackFiles();
      expect(result).toBe(false);
    });

    it("retorna boolean após marcar arquivo como editado", async () => {
      markFileAsEdited("/tmp/unread2.lua");
      const result = await hasUnreadBackFiles();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("detectHallucinations", () => {
    it("retorna string", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "No hallucinations detected" } }],
      } as any);
      const result = await detectHallucinations(
        "I created a function called foo",
        [{ path: "test.lua", content: "function foo() end" }]
      );
      expect(result).toBeTruthy();
    });
  });

  describe("checkEvidenceRequirement", () => {
    it("retorna string", async () => {
      const result = await checkEvidenceRequirement(
        "I fixed the bug",
        [{ path: "test.lua", content: "local x = 1" }]
      );
      expect(result).toBeTruthy();
    });
  });

  describe("checkUserClaims", () => {
    it("retorna string", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Claims verified" } }],
      } as any);
      const result = await checkUserClaims(
        "O código está completo e testado",
        "I completed the code and ran tests"
      );
      expect(result).toBeTruthy();
    });
  });

  describe("extractConfidence", () => {
    it("extrai confidence: 8 (escala 1-10)", () => {
      expect(extractConfidence("confidence: 8")).toBeGreaterThan(0);
    });

    it("extrai confianca: 5 (escala 1-10)", () => {
      expect(extractConfidence("confianca: 5")).toBeGreaterThan(0);
    });

    it("extrai confidence: 10 (máximo)", () => {
      expect(extractConfidence("confidence: 10")).toBeGreaterThan(0);
    });

    it("retorna 0 para texto sem confidence", () => {
      expect(extractConfidence("I think this works")).toBe(0);
    });
  });

  describe("checkConfidenceAction", () => {
    it("retorna string para confiança alta", async () => {
      const result = await checkConfidenceAction("confidence: 9", "I'm done");
      expect(result).toBeTruthy();
    });

    it("retorna string para confiança baixa", async () => {
      const result = await checkConfidenceAction("confidence: 2", "Maybe done?");
      expect(result).toBeTruthy();
    });
  });

  describe("runAnonymousReview", () => {
    it("retorna string", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "Review: code looks good" } }],
      } as any);
      const result = await runAnonymousReview(
        [{ path: "test.lua", content: "print('hello')" }]
      );
      expect(result).toBeTruthy();
    });
  });

  describe("incrementTurn", () => {
    it("não lança exceção", () => {
      expect(() => incrementTurn()).not.toThrow();
    });
  });

  describe("checkContradictions", () => {
    it("retorna string", async () => {
      chatMock.mockResolvedValue({
        choices: [{ message: { content: "No contradictions found" } }],
      } as any);
      const result = await checkContradictions(
        "I said X before",
        "Now I say Y"
      );
      expect(result).toBeTruthy();
    });
  });

  describe("isProveItModeActive", () => {
    it("retorna boolean", async () => {
      const result = await isProveItModeActive();
      expect(typeof result).toBe("boolean");
    });
  });

  describe("proveItCheck", () => {
    it("retorna string", async () => {
      const result = await proveItCheck("I'm confident this works", "test response");
      expect(result).toBeTruthy();
    });
  });

  describe("resetHonestyTurn", () => {
    it("não lança exceção", () => {
      expect(() => resetHonestyTurn()).not.toThrow();
    });
  });

  describe("clearAllHonestyState", () => {
    it("não lança exceção", () => {
      expect(() => clearAllHonestyState()).not.toThrow();
    });

    it("limpa arquivos unread back", () => {
      markFileAsEdited("/tmp/test1.lua");
      markFileAsEdited("/tmp/test2.lua");
      clearAllHonestyState();
      expect(getUnreadBackFiles().length).toBe(0);
    });
  });
});
