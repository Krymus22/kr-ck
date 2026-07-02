/**
 * importResolver-deep.test.ts — Testes profundos do importResolver
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { checkImports } from "../importResolver.js";

describe("importResolver — deep coverage", () => {
  describe("checkImports", () => {
    it("retorna resultado para código Lua sem imports", () => {
      const result = checkImports("test.lua", "local x = 1\nprint(x)");
      expect(result).toBeTruthy();
    });

    it("retorna resultado para código com require", () => {
      const result = checkImports("test.lua", "local Module = require(path.to.module)");
      expect(result).toBeTruthy();
    });

    it("retorna resultado para TypeScript com import", () => {
      const result = checkImports("test.ts", "import { foo } from './module'");
      expect(result).toBeTruthy();
    });

    it("retorna resultado para Python com import", () => {
      const result = checkImports("test.py", "import os\nfrom typing import List");
      expect(result).toBeTruthy();
    });

    it("retorna resultado para código vazio", () => {
      const result = checkImports("test.lua", "");
      expect(result).toBeTruthy();
    });

    it("retorna resultado para JavaScript com require", () => {
      const result = checkImports("test.js", "const fs = require('fs')");
      expect(result).toBeTruthy();
    });
  });
});
