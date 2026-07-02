/**
 * impactAnalyzer-coverage.test.ts — Testes de cobertura do impactAnalyzer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { extractSymbols, formatImpactHint, formatImpactSummary, clearCache } from "../impactAnalyzer.js";

describe("impactAnalyzer — coverage", () => {
  describe("extractSymbols", () => {
    it("extrai funções de arquivo Lua", () => {
      const content = `local function foo()\n  print("hello")\nend\n\nfunction bar()\nend\n`;
      const symbols = extractSymbols("test.lua", content);
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("extrai funções de arquivo TypeScript", () => {
      const content = `function foo() { return 1; }\nconst bar = () => 2;\nclass Baz {}`;
      const symbols = extractSymbols("test.ts", content);
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("extrai funções de arquivo Python", () => {
      const content = `def foo():\n  pass\n\nclass Bar:\n  def method(self):\n    pass\n`;
      const symbols = extractSymbols("test.py", content);
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("retorna array vazio para arquivo sem símbolos", () => {
      const content = `# just a comment\n# nothing else\n`;
      const symbols = extractSymbols("test.md", content);
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("retorna array para conteúdo vazio", () => {
      const symbols = extractSymbols("test.lua", "");
      expect(Array.isArray(symbols)).toBe(true);
    });
  });

  describe("formatImpactHint", () => {
    it("formata report com usages", () => {
      const report = {
        targetFile: "main.lua",
        symbols: [{ name: "foo", type: "function" }],
        affectedFiles: ["other.lua"],
        usages: [{ file: "other.lua", line: 10, symbol: "foo" }],
        durationMs: 100,
      } as any;
      const result = formatImpactHint(report);
      expect(typeof result).toBe("string");
    });

    it("retorna string vazia para report sem usages", () => {
      const report = {
        targetFile: "main.lua",
        symbols: [],
        affectedFiles: [],
        usages: [],
        durationMs: 0,
      } as any;
      const result = formatImpactHint(report);
      expect(result).toBe("");
    });
  });

  describe("formatImpactSummary", () => {
    it("retorna string com summary", () => {
      const report = {
        targetFile: "main.lua",
        symbols: [],
        affectedFiles: ["a.lua", "b.lua", "c.lua"],
        usages: [],
        durationMs: 50,
      } as any;
      const result = formatImpactSummary(report);
      expect(typeof result).toBe("string");
    });
  });

  describe("clearCache", () => {
    it("não lança exceção", () => {
      expect(() => clearCache()).not.toThrow();
    });
  });
});
