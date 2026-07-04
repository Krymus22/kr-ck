/**
 * modelRegistry-extended.test.ts — Casos edge que NÃO estão no teste básico.
 * Foco em: getModelInfo (3 extras), getModelContextWindow (2 extras),
 * getModelCost (2 extras), listKnownModels (1) e edge cases.
 *
 * PT-BR nos comentários.
 */

import { describe, it, expect } from "vitest";
import {
  MODEL_REGISTRY,
  FALLBACK_MODEL_INFO,
  getModelInfo,
  getModelContextWindow,
  getModelMaxOutputTokens,
  getModelCost,
  modelSupportsTools,
  modelSupportsParallelTools,
  listKnownModels,
  formatContextWindow,
} from "../modelRegistry.js";

describe("modelRegistry — extended", () => {
  // ─── getModelInfo — extras (3) ──────────────────────────────────────────────

  describe("getModelInfo — extras", () => {
    it("retorna info para um modelo ZenMux específico", () => {
      const info = getModelInfo("z-ai/glm-5.2-free");
      expect(info.id).toBe("z-ai/glm-5.2-free");
      expect(info.provider).toBe("zenmux");
      expect(info.hasThinking).toBe(true);
    });

    it("para modelo desconhecido, retorna FALLBACK_MODEL_INFO (mesma ref)", () => {
      const info = getModelInfo("foo/bar-inexistente");
      expect(info).toBe(FALLBACK_MODEL_INFO);
      expect(info.provider).toBe("both");
    });

    it("retorna info consistente para kimi-k2.7-code (paid)", () => {
      const info = getModelInfo("moonshotai/kimi-k2.7-code");
      expect(info.id).toBe("moonshotai/kimi-k2.7-code");
      expect(info.supportsParallelTools).toBe(true);
      expect(info.hasThinking).toBe(false); // paid kimi code não tem thinking
    });
  });

  // ─── getModelContextWindow — extras (2) ────────────────────────────────────

  describe("getModelContextWindow — extras", () => {
    it("retorna >= 128000 para todos os modelos ZenMux", () => {
      const zenmuxModels = MODEL_REGISTRY.filter((m) => m.provider === "zenmux" || m.provider === "both");
      expect(zenmuxModels.length).toBeGreaterThan(0);
      for (const m of zenmuxModels) {
        expect(getModelContextWindow(m.id)).toBeGreaterThanOrEqual(128_000);
      }
    });

    it("retorna >= 128000 para qualquer modelo conhecido ou fallback", () => {
      for (const m of MODEL_REGISTRY) {
        expect(getModelContextWindow(m.id)).toBeGreaterThanOrEqual(128_000);
      }
      expect(getModelContextWindow("desconhecido")).toBe(128_000);
    });
  });

  // ─── getModelCost — extras (2) ─────────────────────────────────────────────

  describe("getModelCost — extras", () => {
    it("retorna prompt=0 e completion=0 para todos os modelos conhecidos (free tier)", () => {
      for (const m of MODEL_REGISTRY) {
        const cost = getModelCost(m.id);
        expect(cost.prompt).toBe(0);
        expect(cost.completion).toBe(0);
      }
    });

    it("retorna {prompt:0, completion:0} para modelo desconhecido", () => {
      const cost = getModelCost("nonexistent/model-xyz");
      expect(cost).toEqual({ prompt: 0, completion: 0 });
    });
  });

  // ─── listKnownModels (1) + edge cases ──────────────────────────────────────

  describe("listKnownModels + edge cases", () => {
    it("listKnownModels retorna cópia — mutar uma instância não afeta a registry", () => {
      const a = listKnownModels();
      const originalLen = a.length;
      a.push({
        id: "fake",
        name: "fake",
        contextWindow: 1,
        maxOutputTokens: 1,
        costPer1MPrompt: 0,
        costPer1MCompletion: 0,
        supportsTools: false,
        supportsParallelTools: false,
        hasThinking: false,
        provider: "both",
      });
      const b = listKnownModels();
      expect(b.length).toBe(originalLen);
      expect(b.find((m) => m.id === "fake")).toBeUndefined();
    });

    it("todos modelos da registry têm provider válido ('nvidia' | 'zenmux' | 'both')", () => {
      for (const m of MODEL_REGISTRY) {
        expect(["nvidia", "zenmux", "both"]).toContain(m.provider);
      }
    });

    it("modelSupportsTools e modelSupportsParallelTools retornam booleanos para fallback", () => {
      expect(typeof modelSupportsTools("foo")).toBe("boolean");
      expect(typeof modelSupportsParallelTools("foo")).toBe("boolean");
      // Fallback é otimista para tools, pessimista para parallel
      expect(modelSupportsTools("foo")).toBe(true);
      expect(modelSupportsParallelTools("foo")).toBe(false);
    });

    it("formatContextWindow lida com valores decimais intermediários", () => {
      // 128500 → '128.5k' (Math.floor division)
      expect(formatContextWindow(128_500)).toBe("128.5k");
      // 500000 → '500k'
      expect(formatContextWindow(500_000)).toBe("500k");
    });
  });
});
