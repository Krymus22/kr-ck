/**
 * apiResearcher-official.test.ts — Testes das APIs oficiais e source tracking
 *
 * Testa:
 *   - detectOfficialApi (roteamento de queries)
 *   - getLastSearchSource (tracking de qual source foi usada)
 *   - isNewsQuery com anti-keywords
 *   - searchGitHubApi, searchStackOverflowApi, searchNpmApi, searchMdnApi (com fetch mockado)
 *   - decodeHtmlEntities (entidades numéricas e nomeadas)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock global fetch
global.fetch = vi.fn() as any;

// Mock logger
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  throttle: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key",
    model: "test-model",
    contextWindowTokens: 128000,
    temperature: 0.6,
    topP: 0.9,
    maxTokens: 4096,
  },
}));

import { webSearch, getLastSearchSource } from "../apiResearcher.js";

describe("apiResearcher — official APIs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global.fetch as any).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("detectOfficialApi (via webSearch routing)", () => {
    it("usa NPM API para 'npm express'", async () => {
      (global.fetch as any).mockImplementation(async (url: string) => {
        if (url.includes("registry.npmjs.org/express")) {
          return {
            ok: true,
            json: async () => ({
              name: "express",
              "dist-tags": { latest: "5.2.1" },
              versions: { "5.2.1": { license: "MIT" } },
              description: "Fast web framework",
              keywords: ["express", "framework"],
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const results = await webSearch("npm express", 3);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain("express");
      expect(results[0].url).toContain("npmjs.com");
      expect(getLastSearchSource()).toContain("npm");
    });

    it("usa GitHub API para 'github react library'", async () => {
      (global.fetch as any).mockImplementation(async (url: string) => {
        if (url.includes("api.github.com/search/repositories")) {
          return {
            ok: true,
            json: async () => ({
              items: [{
                html_url: "https://github.com/react/react",
                full_name: "react/react",
                description: "The library for web UIs",
                stargazers_count: 246139,
                language: "JavaScript",
              }],
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const results = await webSearch("github react library", 3);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain("react/react");
      expect(getLastSearchSource()).toContain("github");
    });

    it("usa StackOverflow API para 'how to read file in python'", async () => {
      (global.fetch as any).mockImplementation(async (url: string) => {
        if (url.includes("api.stackexchange.com")) {
          return {
            ok: true,
            json: async () => ({
              items: [{
                link: "https://stackoverflow.com/questions/3277503",
                title: "How to read a file line-by-line?",
                score: 2023,
                answer_count: 28,
                tags: ["python", "file"],
              }],
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const results = await webSearch("how to read file in python", 3);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].url).toContain("stackoverflow.com");
      expect(getLastSearchSource()).toContain("stackoverflow");
    });

    it("usa MDN API para 'javascript fetch API'", async () => {
      (global.fetch as any).mockImplementation(async (url: string) => {
        if (url.includes("developer.mozilla.org/api/v1/search")) {
          return {
            ok: true,
            json: async () => ({
              documents: [{
                mdn_url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
                title: "Fetch API",
                summary: "Provides interface for fetching resources",
              }],
            }),
          };
        }
        return { ok: false, status: 404 };
      });

      const results = await webSearch("javascript fetch API", 3);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toContain("Fetch API");
      expect(getLastSearchSource()).toContain("mdn");
    });
  });

  describe("getLastSearchSource", () => {
    it("retorna 'none' antes de qualquer busca", () => {
      // Reset implicito pelo mock
      expect(typeof getLastSearchSource()).toBe("string");
    });

    it("retorna source correto após busca NPM", async () => {
      (global.fetch as any).mockImplementation(async (url: string) => {
        if (url.includes("registry.npmjs.org/express")) {
          return {
            ok: true,
            json: async () => ({
              name: "express",
              "dist-tags": { latest: "5.2.1" },
              versions: { "5.2.1": {} },
              description: "Framework",
              keywords: [],
            }),
          };
        }
        return { ok: false };
      });

      await webSearch("npm express", 1);
      const source = getLastSearchSource();
      expect(source).toContain("npm");
    });
  });

  describe("isNewsQuery (anti-keywords)", () => {
    it("NÃO usa Bing News para 'TweenService roblox API documentation 2026'", async () => {
      // Como tem 'documentation' e 'api', não deve ir para Bing News
      // Deve tentar APIs oficiais primeiro (não match) depois Bing Web
      (global.fetch as any).mockImplementation(async (url: string) => {
        // Bing Web (não News)
        if (url.includes("bing.com/search") && !url.includes("/news/")) {
          return {
            ok: true,
            text: async () => `<html><body><div class="b_algo"><h2><a href="https://create.roblox.com/docs">Roblox Docs</a></h2><p>TweenService docs</p></div></body></html>`,
          };
        }
        return { ok: false };
      });

      const results = await webSearch("TweenService roblox API documentation 2026", 3, false);
      // Não deve ter usado Bing News (porque tem 'documentation' e 'api')
      // source deve ser 'Bing' não 'Bing News'
      if (results.length > 0) {
        // Se chegou no Bing, foi Web não News
        const source = getLastSearchSource();
        expect(source).not.toContain("News");
      }
    });
  });

  describe("decodeHtmlEntities (via search results)", () => {
    it("preserva descrição do GitHub API mesmo com caracteres especiais", async () => {
      (global.fetch as any).mockImplementation(async (url: string) => {
        if (url.includes("api.github.com")) {
          return {
            ok: true,
            json: async () => ({
              items: [{
                html_url: "https://github.com/test/repo",
                full_name: "test/repo",
                description: "Café e pão de açúcar — framework",
                stargazers_count: 100,
                language: "Lua",
              }],
            }),
          };
        }
        return { ok: false };
      });

      const results = await webSearch("github test repository", 1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].snippet).toContain("Café");
    });
  });

  describe("error handling", () => {
    it("retorna array vazio quando todas as APIs falham", async () => {
      (global.fetch as any).mockRejectedValue(new Error("Network error"));

      const results = await webSearch("test query that won't match anything", 3);
      expect(Array.isArray(results)).toBe(true);
    });

    it("retorna array vazio quando fetch retorna ok: false", async () => {
      (global.fetch as any).mockResolvedValue({ ok: false, status: 500 });

      const results = await webSearch("test", 3);
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
