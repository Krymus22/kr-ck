/**
 * modelRegistry.test.ts — tests for the model registry.
 *
 * The model registry maps NVIDIA NIM model IDs to their actual context
 * window sizes, max output tokens, costs, and capabilities. This fixes
 * the bug where the StatusBar always showed "128k" context regardless of
 * the active model (kimi-k2.6 has 256k, minimax-m3 has 1M, etc.).
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

describe("modelRegistry", () => {
  describe("MODEL_REGISTRY contents", () => {
    it("has at least 10 models registered", () => {
      expect(MODEL_REGISTRY.length).toBeGreaterThanOrEqual(10);
    });

    it("kimi-k2.6 is registered with 256k context", () => {
      const kimi = MODEL_REGISTRY.find((m) => m.id === "moonshotai/kimi-k2.6");
      expect(kimi).toBeDefined();
      expect(kimi?.contextWindow).toBe(256_000);
      expect(kimi?.supportsTools).toBe(true);
      expect(kimi?.supportsParallelTools).toBe(true);
    });

    it("minimax-m3 is registered with 1M context", () => {
      const minimax = MODEL_REGISTRY.find((m) => m.id === "minimaxai/minimax-m3");
      expect(minimax).toBeDefined();
      expect(minimax?.contextWindow).toBe(1_000_000);
      expect(minimax?.maxOutputTokens).toBe(16_384);
    });

    it("all models have contextWindow >= 32000", () => {
      for (const m of MODEL_REGISTRY) {
        expect(m.contextWindow).toBeGreaterThanOrEqual(32_000);
      }
    });

    it("all models have maxOutputTokens >= 4096", () => {
      for (const m of MODEL_REGISTRY) {
        expect(m.maxOutputTokens).toBeGreaterThanOrEqual(4_096);
      }
    });

    it("all models have unique IDs", () => {
      const ids = MODEL_REGISTRY.map((m) => m.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe("getModelInfo", () => {
    it("returns correct info for kimi-k2.6", () => {
      const info = getModelInfo("moonshotai/kimi-k2.6");
      expect(info.id).toBe("moonshotai/kimi-k2.6");
      expect(info.name).toContain("Kimi");
      expect(info.contextWindow).toBe(256_000);
    });

    it("returns correct info for minimax-m3", () => {
      const info = getModelInfo("minimaxai/minimax-m3");
      expect(info.id).toBe("minimaxai/minimax-m3");
      expect(info.contextWindow).toBe(1_000_000);
    });

    it("returns FALLBACK for unknown model", () => {
      const info = getModelInfo("unknown/model-xyz");
      expect(info).toBe(FALLBACK_MODEL_INFO);
      expect(info.contextWindow).toBe(128_000);
    });

    it("returns FALLBACK for empty string", () => {
      const info = getModelInfo("");
      expect(info).toBe(FALLBACK_MODEL_INFO);
    });
  });

  describe("getModelContextWindow", () => {
    it("returns 256000 for kimi-k2.6", () => {
      expect(getModelContextWindow("moonshotai/kimi-k2.6")).toBe(256_000);
    });

    it("returns 1000000 for minimax-m3", () => {
      expect(getModelContextWindow("minimaxai/minimax-m3")).toBe(1_000_000);
    });

    it("returns 128000 for unknown model (fallback)", () => {
      expect(getModelContextWindow("unknown/model")).toBe(128_000);
    });

    it("returns >= 32000 for all known models", () => {
      for (const m of MODEL_REGISTRY) {
        expect(getModelContextWindow(m.id)).toBeGreaterThanOrEqual(32_000);
      }
    });
  });

  describe("getModelMaxOutputTokens", () => {
    it("returns 8192 for kimi-k2.6", () => {
      expect(getModelMaxOutputTokens("moonshotai/kimi-k2.6")).toBe(8_192);
    });

    it("returns 16384 for minimax-m3", () => {
      expect(getModelMaxOutputTokens("minimaxai/minimax-m3")).toBe(16_384);
    });

    it("returns 8192 for unknown model (fallback)", () => {
      expect(getModelMaxOutputTokens("unknown/model")).toBe(8_192);
    });
  });

  describe("getModelCost", () => {
    it("returns {prompt: 0, completion: 0} for kimi-k2.6 (free tier)", () => {
      const cost = getModelCost("moonshotai/kimi-k2.6");
      expect(cost.prompt).toBe(0);
      expect(cost.completion).toBe(0);
    });

    it("returns {prompt: 0, completion: 0} for minimax-m3 (free tier)", () => {
      const cost = getModelCost("minimaxai/minimax-m3");
      expect(cost.prompt).toBe(0);
      expect(cost.completion).toBe(0);
    });

    it("returns {prompt: 0, completion: 0} for unknown model (fallback)", () => {
      const cost = getModelCost("unknown/model");
      expect(cost.prompt).toBe(0);
      expect(cost.completion).toBe(0);
    });
  });

  describe("modelSupportsTools", () => {
    it("returns true for kimi-k2.6", () => {
      expect(modelSupportsTools("moonshotai/kimi-k2.6")).toBe(true);
    });

    it("returns false for deepseek-r1 (no tool support)", () => {
      expect(modelSupportsTools("deepseek-ai/deepseek-r1")).toBe(false);
    });

    it("returns true for unknown model (fallback, optimistic)", () => {
      expect(modelSupportsTools("unknown/model")).toBe(true);
    });
  });

  describe("modelSupportsParallelTools", () => {
    it("returns true for kimi-k2.6", () => {
      expect(modelSupportsParallelTools("moonshotai/kimi-k2.6")).toBe(true);
    });

    it("returns true for minimax-m3", () => {
      expect(modelSupportsParallelTools("minimaxai/minimax-m3")).toBe(true);
    });

    it("returns false for qwen2.5-coder-32b", () => {
      expect(modelSupportsParallelTools("qwen/qwen2.5-coder-32b-instruct")).toBe(false);
    });
  });

  describe("listKnownModels", () => {
    it("returns all models from registry", () => {
      const models = listKnownModels();
      expect(models.length).toBe(MODEL_REGISTRY.length);
    });

    it("returns a copy (not the original array)", () => {
      const models1 = listKnownModels();
      const models2 = listKnownModels();
      expect(models1).not.toBe(models2);
      expect(models1).toEqual(models2);
    });
  });

  describe("formatContextWindow", () => {
    it("formats 256000 as '256k'", () => {
      expect(formatContextWindow(256_000)).toBe("256k");
    });

    it("formats 128000 as '128k'", () => {
      expect(formatContextWindow(128_000)).toBe("128k");
    });

    it("formats 1000000 as '1M'", () => {
      expect(formatContextWindow(1_000_000)).toBe("1M");
    });

    it("formats 1500000 as '1.5M'", () => {
      expect(formatContextWindow(1_500_000)).toBe("1.5M");
    });

    it("formats 2000000 as '2M'", () => {
      expect(formatContextWindow(2_000_000)).toBe("2M");
    });

    it("formats 1000 as '1k'", () => {
      expect(formatContextWindow(1000)).toBe("1k");
    });

    it("formats 1500 as '1.5k'", () => {
      expect(formatContextWindow(1500)).toBe("1.5k");
    });

    it("formats 500 as '500' (no suffix)", () => {
      expect(formatContextWindow(500)).toBe("500");
    });

    it("formats 0 as '0'", () => {
      expect(formatContextWindow(0)).toBe("0");
    });

    it("does NOT format 1000 as '1.0k'", () => {
      expect(formatContextWindow(1000)).not.toBe("1.0k");
    });

    it("does NOT format 1000000 as '1000k'", () => {
      expect(formatContextWindow(1_000_000)).not.toBe("1000k");
    });
  });

  describe("regression: StatusBar shows correct context for active model", () => {
    // This is the bug the user reported: "barra de contexto não marca
    // o contexto total do modelo selecionado". Previously, config.ts
    // hardcoded contextWindowTokens=128000 regardless of MODEL env var.
    // Now config.ts uses getModelContextWindow(MODEL).

    it("kimi-k2.6 should report 256k context (not 128k)", () => {
      const ctx = getModelContextWindow("moonshotai/kimi-k2.6");
      expect(ctx).toBe(256_000);
      expect(formatContextWindow(ctx)).toBe("256k");
    });

    it("minimax-m3 should report 1M context (not 128k)", () => {
      const ctx = getModelContextWindow("minimaxai/minimax-m3");
      expect(ctx).toBe(1_000_000);
      expect(formatContextWindow(ctx)).toBe("1M");
    });

    it("deepseek-r1 should report 128k context", () => {
      const ctx = getModelContextWindow("deepseek-ai/deepseek-r1");
      expect(ctx).toBe(128_000);
      expect(formatContextWindow(ctx)).toBe("128k");
    });

    it("llama-4-maverick should report 1M context", () => {
      const ctx = getModelContextWindow("meta/llama-4-maverick-17b-128e-instruct");
      expect(ctx).toBe(1_000_000);
      expect(formatContextWindow(ctx)).toBe("1M");
    });
  });
});
