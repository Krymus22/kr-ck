/**
 * lspAst-deep.test.ts — Testes profundos do lspAst
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { parseSource, parseFile, findSymbol, findDependencies } from "../lspAst.js";

describe("lspAst — deep coverage", () => {
  describe("parseSource", () => {
    it("parseia código Lua", async () => {
      const result = await parseSource("test.lua", "local function foo()\n  return 1\nend");
      expect(result).toBeTruthy();
    });

    it("parseia código TypeScript", async () => {
      const result = await parseSource("test.ts", "function foo(): number { return 1; }");
      expect(result).toBeTruthy();
    });

    it("parseia código Python", async () => {
      const result = await parseSource("test.py", "def foo():\n    return 1");
      expect(result).toBeTruthy();
    });

    it("parseia código JavaScript", async () => {
      const result = await parseSource("test.js", "function foo() { return 1; }");
      expect(result).toBeTruthy();
    });

    it("retorna resultado para código vazio", async () => {
      const result = await parseSource("test.lua", "");
      expect(result).toBeTruthy();
    });
  });

  describe("parseFile", () => {
    it("parseia arquivo existente", async () => {
      const tmpFile = path.join(os.tmpdir(), `lsp-test-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "local function foo()\n  return 1\nend");
      try {
        const result = await parseFile(tmpFile);
        expect(result).toBeTruthy();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it("lida com arquivo inexistente", async () => {
      const result = await parseFile("/nonexistent/file.lua");
      expect(result).toBeTruthy();
    });
  });

  describe("findSymbol", () => {
    it("encontra símbolo no parseResult", () => {
      const parseResult = {
        symbols: [{ name: "foo", type: "function", line: 1 }],
      } as any;
      const symbol = findSymbol(parseResult, "foo");
      expect(symbol).toBeDefined();
      expect(symbol?.name).toBe("foo");
    });

    it("retorna undefined para símbolo inexistente", () => {
      const parseResult = {
        symbols: [{ name: "foo", type: "function", line: 1 }],
      } as any;
      const symbol = findSymbol(parseResult, "nonexistent");
      expect(symbol).toBeUndefined();
    });
  });

  describe("findDependencies", () => {
    it("retorna array de imports", () => {
      const parseResult = {
        imports: [{ module: "someModule", items: ["foo"] }],
      } as any;
      const deps = findDependencies(parseResult);
      expect(Array.isArray(deps)).toBe(true);
    });

    it("retorna array vazio quando não há imports", () => {
      const parseResult = { imports: [] } as any;
      const deps = findDependencies(parseResult);
      expect(deps).toEqual([]);
    });
  });
});
