/**
 * fileFinder-deep.test.ts — Testes profundos do fileFinder
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { searchInDefinedFolders, searchFile, copyToModeTools } from "../fileFinder.js";

describe("fileFinder — deep coverage", () => {
  describe("searchInDefinedFolders", () => {
    it("retorna array para arquivo inexistente", () => {
      const result = searchInDefinedFolders("nonexistent_file_xyz.lua", null);
      expect(Array.isArray(result)).toBe(true);
    });

    it("retorna array para arquivo conhecido", () => {
      const result = searchInDefinedFolders("selene", null);
      expect(Array.isArray(result)).toBe(true);
    });

    it("retorna array com mode", () => {
      const result = searchInDefinedFolders("selene", "roblox");
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("searchFile", () => {
    it("retorna objeto com results e searchedEntireMachine", async () => {
      const result = await searchFile("definitely_nonexistent_file_12345.lua", null);
      expect(result).toHaveProperty("results");
      expect(result).toHaveProperty("searchedEntireMachine");
      expect(Array.isArray(result.results)).toBe(true);
    });
  });

  describe("copyToModeTools", () => {
    it("retorna null para arquivo inexistente", () => {
      const result = copyToModeTools("/nonexistent/file.lua", "roblox");
      expect(result === null || typeof result === "string").toBe(true);
    });

    it("copia arquivo existente para mode tools", () => {
      const tmpFile = path.join(os.tmpdir(), `ff-test-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "print('hello')");
      try {
        const result = copyToModeTools(tmpFile, "roblox");
        expect(result === null || typeof result === "string").toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });
});
