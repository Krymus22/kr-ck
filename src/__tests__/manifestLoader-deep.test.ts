/**
 * manifestLoader-deep.test.ts — Testes profundos do manifestLoader
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import {
  loadModeManifests,
  loadActiveManifests,
  isManifestTool,
} from "../manifestLoader.js";

describe("manifestLoader — deep coverage", () => {
  describe("loadModeManifests", () => {
    it("retorna array para mode null", () => {
      const result = loadModeManifests(null);
      expect(Array.isArray(result)).toBe(true);
    });

    it("retorna array para mode inexistente", () => {
      const result = loadModeManifests("nonexistent_mode");
      expect(Array.isArray(result)).toBe(true);
    });

    it("retorna array para mode roblox", () => {
      const result = loadModeManifests("roblox");
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("loadActiveManifests", () => {
    it("retorna array", () => {
      const result = loadActiveManifests();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("isManifestTool", () => {
    it("retorna false para manifests vazio", () => {
      expect(isManifestTool("any_tool", [])).toBe(false);
    });

    it("retorna false para tool não presente nos manifests", () => {
      const manifests = [{ tool: "selene_lint", command: "selene" }] as any;
      expect(isManifestTool("nonexistent", manifests)).toBe(false);
    });
  });
});
