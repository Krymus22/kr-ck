/**
 * externalTools-deep.test.ts — Testes profundos do externalTools
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { getRegistry, getDetector, getExecutor, getSuggester } from "../externalTools.js";

describe("externalTools — deep coverage", () => {
  describe("getRegistry", () => {
    it("retorna ToolRegistry", () => {
      const registry = getRegistry();
      expect(registry).toBeTruthy();
      expect(typeof registry.getAll).toBe("function");
      expect(typeof registry.getByCategory).toBe("function");
      expect(typeof registry.get).toBe("function");
    });
  });

  describe("getDetector", () => {
    it("retorna ToolDetector", () => {
      const detector = getDetector();
      expect(detector).toBeTruthy();
    });
  });

  describe("getExecutor", () => {
    it("retorna ToolExecutor", () => {
      const executor = getExecutor();
      expect(executor).toBeTruthy();
    });
  });

  describe("getSuggester", () => {
    it("retorna ToolSuggester", () => {
      const suggester = getSuggester();
      expect(suggester).toBeTruthy();
    });
  });

  describe("Registry methods", () => {
    it("getAll retorna array", () => {
      const registry = getRegistry();
      const tools = registry.getAll();
      expect(Array.isArray(tools)).toBe(true);
    });

    it("get retorna undefined para tool inexistente", () => {
      const registry = getRegistry();
      const tool = registry.get("nonexistent_tool");
      expect(tool).toBeUndefined();
    });

    it("getByCategory retorna array", () => {
      const registry = getRegistry();
      const tools = registry.getByCategory("linter" as any);
      expect(Array.isArray(tools)).toBe(true);
    });

    it("isInstalled retorna false para tool inexistente", () => {
      const registry = getRegistry();
      expect(registry.isInstalled("nonexistent_tool")).toBe(false);
    });
  });
});
