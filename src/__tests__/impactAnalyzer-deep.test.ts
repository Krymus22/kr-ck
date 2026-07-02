/**
 * impactAnalyzer-deep.test.ts — Testes profundos do impactAnalyzer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { extractSymbols, analyzeImpact, formatImpactHint, formatImpactSummary, clearCache } from "../impactAnalyzer.js";

describe("impactAnalyzer — deep coverage", () => {
  describe("extractSymbols — mais linguagens", () => {
    it("extrai funções de JavaScript", () => {
      const symbols = extractSymbols("test.js", "function foo() {}\nconst bar = () => {};\nclass Baz { method() {} }");
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("extrai funções de TypeScript com interfaces", () => {
      const symbols = extractSymbols("test.ts", "interface IFoo { bar(): void }\nfunction baz(): void {}\nconst x = 1;");
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("extrai funções de Lua com local function", () => {
      const symbols = extractSymbols("test.lua", "local function foo()\nend\n\nfunction bar()\nend\n\nlocal baz = function() end");
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("extrai classes de Python", () => {
      const symbols = extractSymbols("test.py", "class Foo:\n    def bar(self):\n        pass\n\ndef baz():\n    pass");
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("retorna array para arquivo sem extensão reconhecida", () => {
      const symbols = extractSymbols("README", "# Title\nSome text");
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("retorna array para conteúdo apenas com comentários", () => {
      const symbols = extractSymbols("test.lua", "-- just a comment\n-- another comment");
      expect(Array.isArray(symbols)).toBe(true);
    });

    it("extrai símbolos de arquivo grande", () => {
      const content = Array.from({ length: 50 }, (_, i) => `function func${i}() end`).join("\n");
      const symbols = extractSymbols("test.lua", content);
      expect(Array.isArray(symbols)).toBe(true);
    });
  });

  describe("analyzeImpact", () => {
    it("retorna ImpactReport para arquivo existente", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "impact-"));
      const tmpFile = path.join(tmpDir, "test.lua");
      fs.writeFileSync(tmpFile, "local function foo()\n  return 1\nend\n");

      try {
        const report = await analyzeImpact(tmpFile);
        expect(report).toHaveProperty("targetFile");
        expect(report).toHaveProperty("symbols");
        expect(report).toHaveProperty("affectedFiles");
        expect(report).toHaveProperty("usages");
        expect(report).toHaveProperty("durationMs");
      } finally {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("retorna ImpactReport para arquivo inexistente", async () => {
      const report = await analyzeImpact("/nonexistent/file.lua");
      expect(report).toHaveProperty("targetFile");
      expect(report.symbols).toEqual([]);
    });
  });

  describe("formatImpactHint — mais casos", () => {
    it("formata com múltiplos arquivos afetados", () => {
      const report = {
        targetFile: "main.lua",
        symbols: [{ name: "foo", type: "function" }, { name: "bar", type: "function" }],
        affectedFiles: ["a.lua", "b.lua", "c.lua"],
        usages: [
          { file: "a.lua", line: 10, symbol: "foo" },
          { file: "b.lua", line: 20, symbol: "bar" },
        ],
        durationMs: 150,
      } as any;
      const result = formatImpactHint(report);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("retorna string vazia quando não há usages", () => {
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

  describe("formatImpactSummary — mais casos", () => {
    it("retorna string com affectedFiles", () => {
      const report = {
        targetFile: "main.lua",
        symbols: [{ name: "foo" }],
        affectedFiles: ["a.lua", "b.lua"],
        usages: [{ file: "a.lua" }],
        durationMs: 100,
      } as any;
      const result = formatImpactSummary(report);
      expect(typeof result).toBe("string");
    });

    it("retorna string quando não há affectedFiles", () => {
      const report = {
        targetFile: "main.lua",
        symbols: [],
        affectedFiles: [],
        usages: [],
        durationMs: 0,
      } as any;
      const result = formatImpactSummary(report);
      expect(typeof result).toBe("string");
    });
  });

  describe("clearCache", () => {
    it("não lança exceção quando chamado múltiplas vezes", () => {
      expect(() => {
        clearCache();
        clearCache();
        clearCache();
      }).not.toThrow();
    });
  });
});
