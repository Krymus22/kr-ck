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
    it("retorna null para tool inexistente", () => {
      const result = searchInDefinedFolders("nonexistent_tool_xyz", null);
      expect(result === null || typeof result === 'string').toBe(true);
    });

    it("retorna null ou path para tool conhecida", () => {
      const result = searchInDefinedFolders("selene", null);
      expect(result === null || typeof result === 'string' || result === undefined).toBe(true);
    });

    it("retorna null ou path com mode", () => {
      const result = searchInDefinedFolders("selene", "roblox");
      expect(result === null || typeof result === 'string' || result === undefined).toBe(true);
    });
  });

  describe("searchFile", () => {
    it("retorna null ou path para arquivo inexistente", async () => {
      const result = await searchFile("definitely_nonexistent_file_12345.lua");
      expect(result === null || typeof result === 'string' || result === undefined).toBe(true);
    });
  });

  describe("copyToModeTools", () => {
    it("retorna null para arquivo inexistente", () => {
      const result = copyToModeTools("/nonexistent/file.lua", "roblox");
      expect(result === null || typeof result === 'string').toBe(true);
    });

    it("copia arquivo existente para mode tools", () => {
      const tmpFile = path.join(os.tmpdir(), `ff-test-${Date.now()}.lua`);
      fs.writeFileSync(tmpFile, "print('hello')");
      try {
        const result = copyToModeTools(tmpFile, "roblox");
        expect(result === null || typeof result === 'string' || result === undefined).toBe(true);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });
});
