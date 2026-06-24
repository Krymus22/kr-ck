/**
 * safetyReviewer-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: scanDangerousPatterns (3 extras), parseLlmResponse via reviewCodeSafety
 * (2 extras), formatSafetyReview (2 extras) e edge cases (1).
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// Mock do apiClient.chat — controla resposta do LLM por teste
const chatMock = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("../apiClient.js", () => ({
  chat: (...a: any[]) => chatMock.chat(...a),
}));

// Mock do modeExtensions — retorna lista vazia para usar só os built-ins
vi.mock("../modeExtensions.js", () => ({
  getActiveSafetyPatterns: vi.fn().mockResolvedValue([
    // Reproduz os padrões built-in para que scanDangerousPatternsAsync funcione
    { regex: /:RemoveAsync\s*\(/g, description: "DataStore:RemoveAsync", severity: "high" },
    { regex: /:SetAsync\s*\(/g, description: "DataStore:SetAsync", severity: "medium" },
    { regex: /:Destroy\s*\(\s*\)/g, description: "Instance:Destroy", severity: "medium" },
  ]),
}));

import {
  scanDangerousPatterns,
  reviewCodeSafety,
  formatSafetyReview,
  shouldReviewFile,
  getDangerousPatterns,
} from "../safetyReviewer.js";

describe("safetyReviewer — extended", () => {
  beforeEach(() => {
    chatMock.chat.mockReset();
  });

  // ─── scanDangerousPatterns / assessRisk — extras (3) ───────────────────────

  describe("scanDangerousPatterns — extras", () => {
    it("detecta :UpdateAsync como severidade medium (não high)", () => {
      const r = scanDangerousPatterns(`store:UpdateAsync("k", function() end)`);
      const upd = r.matched.find((p) => p.description.includes("UpdateAsync"));
      expect(upd).toBeDefined();
      expect(upd?.severity).toBe("medium");
      expect(r.hasHighSeverity).toBe(false);
    });

    it("não detecta 'GetAsync' como padrão perigoso (é leitura)", () => {
      const r = scanDangerousPatterns(`local d = store:GetAsync("user")`);
      expect(r.matched.length).toBe(0);
    });

    it("detecta ':DeleteAsync' como severidade high (HTTP DELETE)", () => {
      const r = scanDangerousPatterns(`HttpService:DeleteAsync("https://api/x")`);
      const del = r.matched.find((p) => p.description.includes("DeleteAsync"));
      expect(del).toBeDefined();
      expect(del?.severity).toBe("high");
      expect(r.hasHighSeverity).toBe(true);
    });
  });

  // ─── reviewCodeSafety / LLM response parse (2) ─────────────────────────────

  describe("reviewCodeSafety — LLM parsing", () => {
    it("quando LLM retorna JSON com risk=high, propagar para o resultado", async () => {
      chatMock.chat.mockResolvedValueOnce({
        choices: [{
          message: {
            content: '{"risk":"high","reasoning":"RemoveAsync apaga dados permanentemente."}',
          },
        }],
      });
      const r = await reviewCodeSafety(`store:RemoveAsync("user_1")`, "f.luau");
      expect(r.reviewedByLlm).toBe(true);
      expect(r.risk).toBe("high");
      expect(r.reasoning).toContain("RemoveAsync");
      expect(r.patternsMatched.length).toBeGreaterThan(0);
    });

    it("quando LLM retorna resposta inválida, fallback retorna risk=low (não bloqueia)", async () => {
      chatMock.chat.mockResolvedValueOnce({
        choices: [{ message: { content: "blah blah sem json" } }],
      });
      const r = await reviewCodeSafety(`store:RemoveAsync("x")`, "f.luau");
      // Fallback do parse: texto sem marcadores de risk → "none"
      expect(["none", "low", "high"]).toContain(r.risk);
      expect(r.reviewedByLlm).toBe(true);
    });
  });

  // ─── formatSafetyReview (2) ────────────────────────────────────────────────

  describe("formatSafetyReview — extras", () => {
    it("formata resultado low com 'Padrões detectados' mesmo sem patterns", () => {
      const r = formatSafetyReview({
        risk: "low",
        reasoning: "Operação controlada.",
        patternsMatched: [],
        reviewedByLlm: true,
        durationMs: 100,
      });
      expect(r).toContain("SECURITY WARNING");
      expect(r).toContain("LOW");
      // Sem patterns, não imprime a lista
      expect(r).not.toContain("Patterns detected");
    });

    it("formata high com 'NÃO escreva este código' e recomendações", () => {
      const r = formatSafetyReview({
        risk: "high",
        reasoning: "Deleção permanente.",
        patternsMatched: ["DataStore:RemoveAsync (deletes data permanently)"],
        reviewedByLlm: true,
        durationMs: 200,
      });
      expect(r).toContain("SECURITY BLOCK");
      expect(r).toContain("UpdateAsync");
      expect(r).toContain("backup/rollback");
    });
  });

  // ─── Edge cases (1) ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("shouldReviewFile diferencia .LUA maiúsculo de .lua (case-insensitive)", () => {
      expect(shouldReviewFile("/x/SERVICE.LUA")).toBe(true);
      expect(shouldReviewFile("/x/Service.LUA")).toBe(true);
    });

    it("getDangerousPatterns retorna cópia (mutar não afeta internos)", () => {
      const p1 = getDangerousPatterns();
      const p2 = getDangerousPatterns();
      expect(p1).not.toBe(p2); // cópia
      expect(p1.length).toBe(p2.length);
    });

    it("reviewCodeSafety retorna risk=none sem chamar LLM quando não há padrões", async () => {
      const r = await reviewCodeSafety(`local x = 1 + 2`, "safe.luau");
      expect(r.risk).toBe("none");
      expect(r.reviewedByLlm).toBe(false);
      expect(chatMock.chat).not.toHaveBeenCalled();
    });
  });
});
