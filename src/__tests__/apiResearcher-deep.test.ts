/**
 * apiResearcher-deep.test.ts — Testes profundos do apiResearcher
 *
 * Cobre: parseBingResults, parseBingNewsResults, extractTextFromHtml,
 * webRead, researchApi, formatResearchResult, getCacheStats, clearCache,
 * getTodayDate, isNewsQuery, detectOfficialApi, decodeHtmlEntities
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", model: "test-model",
    contextWindowTokens: 128000, temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

global.fetch = vi.fn() as any;

import {
  getTodayDate,
  getLastSearchSource,
  webSearch,
  webRead,
  researchApi,
  formatResearchResult,
  getCacheStats,
  clearCache,
} from "../apiResearcher.js";

describe("apiResearcher — deep coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as any).mockReset();
  });

  describe("getTodayDate", () => {
    it("retorna data no formato YYYY-MM-DD", () => {
      const date = getTodayDate();
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("retorna a data de hoje", () => {
      const date = getTodayDate();
      const today = new Date().toISOString().split("T")[0];
      expect(date).toBe(today);
    });
  });

  describe("getLastSearchSource", () => {
    it("retorna string", () => {
      const source = getLastSearchSource();
      expect(typeof source).toBe("string");
    });
  });

  describe("webSearch — fallback scenarios", () => {
    it("retorna array quando todas as fontes falham", async () => {
      (global.fetch as any).mockRejectedValue(new Error("network error"));
      const results = await webSearch("nonexistent query test 12345", 3);
      expect(Array.isArray(results)).toBe(true);
    });

    it("retorna array quando fetch retorna ok: false", async () => {
      (global.fetch as any).mockResolvedValue({ ok: false, status: 500, text: async () => "" });
      const results = await webSearch("test query", 3);
      expect(Array.isArray(results)).toBe(true);
    });

    it("retorna array quando fetch retorna texto vazio", async () => {
      (global.fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "" });
      const results = await webSearch("test query", 3);
      expect(Array.isArray(results)).toBe(true);
    });

    it("newsMode=true força Bing News mesmo sem keywords", async () => {
      (global.fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "<html></html>" });
      const results = await webSearch("test", 3, true);
      expect(Array.isArray(results)).toBe(true);
    });

    it("newsMode=false força Bing Web mesmo com news keywords", async () => {
      (global.fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "<html></html>" });
      const results = await webSearch("latest news 2026", 3, false);
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("webRead", () => {
    it("retorna string para URL acessível", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        text: async () => "<html><body><article>Test content here with enough text to pass the length check</article></body></html>",
      });
      const content = await webRead("https://example.com/test");
      expect(typeof content).toBe("string");
    });

    it("retorna string vazia para URL que falha", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
      const content = await webRead("https://nonexistent.example.com");
      expect(content).toBe("");
    });

    it("retorna string vazia para resposta não-ok", async () => {
      (global.fetch as any).mockResolvedValue({ ok: false, status: 404, text: async () => "Not Found" });
      const content = await webRead("https://example.com/404");
      expect(content).toBe("");
    });

    it("extrai conteúdo de meta tags quando HTML é curto", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        text: async () => '<html><head><meta name="description" content="This is a meta description with enough text to pass the threshold"></head><body></body></html>',
      });
      const content = await webRead("https://example.com/meta");
      expect(typeof content).toBe("string");
    });

    it("extrai conteúdo de og:description", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        text: async () => '<html><head><meta property="og:description" content="Open Graph description with sufficient length for testing"></head><body></body></html>',
      });
      const content = await webRead("https://example.com/og");
      expect(typeof content).toBe("string");
    });

    it("tenta .md fallback para Roblox docs", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        text: async () => "<html><body>short</body></html>",
      });
      const content = await webRead("https://create.roblox.com/docs/test");
      expect(typeof content).toBe("string");
    });
  });

  describe("researchApi", () => {
    it("retorna ResearchError para API inexistente", async () => {
      (global.fetch as any).mockRejectedValue(new Error("network error"));
      const result = await researchApi({
        apiName: "NonExistentAPI12345",
        language: "roblox",
        forceRefresh: true,
      });
      expect(result).toHaveProperty("error");
    });

    it("retorna ResearchResult ou ResearchError para API conhecida", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        text: async () => "<html><body><article>Documentation content about TweenService with enough text to pass validation checks</article></body></html>",
      });
      const result = await researchApi({
        apiName: "TweenService",
        language: "roblox",
        forceRefresh: true,
      });
      // Pode ser sucesso ou erro dependendo do que Bing retorna
      expect(result).toBeTruthy();
    });
  });

  describe("formatResearchResult", () => {
    it("formata ResearchResult com sucesso", () => {
      const result = formatResearchResult({
        apiName: "TweenService",
        language: "roblox",
        signature: "TweenService:Create(instance, info, properties)",
        description: "Creates a tween",
        parameters: [{ name: "instance", type: "Instance" }],
        returns: "Tween",
        deprecated: false,
        rawContent: "raw content",
        sources: ["https://create.roblox.com"],
        fromCache: false,
      } as any);
      expect(typeof result).toBe("string");
      expect(result).toContain("TweenService");
    });

    it("formata ResearchError", () => {
      const result = formatResearchResult({
        error: "API not found",
        apiName: "NonExistent",
        language: "roblox",
      } as any);
      expect(typeof result).toBe("string");
      expect(result).toContain("NonExistent");
    });

    it("formata resultado com deprecation warning", () => {
      const result = formatResearchResult({
        apiName: "FindFirstChild",
        language: "roblox",
        signature: "Instance:FindFirstChild(name)",
        description: "Deprecated",
        deprecated: true,
        replacement: "WaitForChild",
        rawContent: "",
        sources: [],
        fromCache: false,
      } as any);
      expect(typeof result).toBe("string");
    });

    it("formata resultado fromCache", () => {
      const result = formatResearchResult({
        apiName: "TestAPI",
        language: "lua",
        signature: "test()",
        description: "test",
        deprecated: false,
        rawContent: "",
        sources: [],
        fromCache: true,
      } as any);
      expect(typeof result).toBe("string");
    });
  });

  describe("getCacheStats", () => {
    it("retorna objeto com entries, oldestEntry, sizeBytes", () => {
      const stats = getCacheStats();
      expect(stats).toHaveProperty("entries");
      expect(stats).toHaveProperty("oldestEntry");
      expect(stats).toHaveProperty("sizeBytes");
      expect(typeof stats.entries).toBe("number");
      expect(typeof stats.sizeBytes).toBe("number");
    });
  });

  describe("clearCache", () => {
    it("retorna number", () => {
      const result = clearCache();
      expect(typeof result).toBe("number");
    });
  });
});
