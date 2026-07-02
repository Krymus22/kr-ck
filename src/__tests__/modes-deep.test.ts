/**
 * modes-deep.test.ts — Testes profundos do modes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import {
  getModesVersion,
  getBuiltInModes,
  getUserModes,
  getAllModes,
  getMode,
  getActiveModeName,
  getActiveMode,
  setActiveMode,
  deactivateMode,
} from "../modes.js";

describe("modes — deep coverage", () => {
  describe("getModesVersion", () => {
    it("retorna number", () => {
      expect(typeof getModesVersion()).toBe("number");
    });
  });

  describe("getBuiltInModes", () => {
    it("retorna array não vazio", () => {
      const modes = getBuiltInModes();
      expect(modes.length).toBeGreaterThan(0);
    });

    it("inclui modo roblox", () => {
      const modes = getBuiltInModes();
      expect(modes.some(m => m.name === "roblox")).toBe(true);
    });
  });

  describe("getUserModes", () => {
    it("retorna array", () => {
      const modes = getUserModes();
      expect(Array.isArray(modes)).toBe(true);
    });
  });

  describe("getAllModes", () => {
    it("retorna array não vazio", () => {
      const modes = getAllModes();
      expect(modes.length).toBeGreaterThan(0);
    });

    it("inclui modos built-in", () => {
      const modes = getAllModes();
      expect(modes.some(m => m.name === "roblox")).toBe(true);
    });
  });

  describe("getMode", () => {
    it("retorna modo para nome existente", () => {
      const mode = getMode("roblox");
      expect(mode).not.toBeNull();
      expect(mode!.name).toBe("roblox");
    });

    it("retorna null para nome inexistente", () => {
      const mode = getMode("nonexistent_mode");
      expect(mode).toBeNull();
    });

    it("retorna null para string vazia", () => {
      const mode = getMode("");
      expect(mode).toBeNull();
    });
  });

  describe("getActiveModeName / getActiveMode", () => {
    it("getActiveModeName retorna string ou null", () => {
      const name = getActiveModeName();
      expect(name === null || typeof name === "string").toBe(true);
    });

    it("getActiveMode retorna objeto ou null", () => {
      const mode = getActiveMode();
      expect(mode === null || typeof mode === "object").toBe(true);
    });
  });

  describe("setActiveMode / deactivateMode", () => {
    it("setActiveMode não lança exceção", () => {
      expect(() => setActiveMode("roblox")).not.toThrow();
    });

    it("deactivateMode não lança exceção", () => {
      expect(() => deactivateMode()).not.toThrow();
    });

    it("setActiveMode(null) não lança exceção", () => {
      expect(() => setActiveMode(null)).not.toThrow();
    });

    it("ativa e desativa modo", () => {
      setActiveMode("roblox");
      deactivateMode();
      expect(getActiveModeName()).toBeNull();
    });
  });
});
