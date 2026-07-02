/**
 * modeExtensions-deep.test.ts — Testes profundos do modeExtensions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import {
  getActiveSafetyPatterns,
  getActiveResearchSources,
  getActiveSymbolPatterns,
  getActiveValidationRules,
  getActivePostEditHooks,
  getActivePreCommitHooks,
  runHook,
  runPostEditHooks,
} from "../modeExtensions.js";

describe("modeExtensions — deep coverage", () => {
  describe("getActiveSafetyPatterns", () => {
    it("retorna array", async () => {
      const result = await getActiveSafetyPatterns();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getActiveResearchSources", () => {
    it("retorna Record", async () => {
      const result = await getActiveResearchSources();
      expect(typeof result).toBe("object");
    });
  });

  describe("getActiveSymbolPatterns", () => {
    it("retorna array", async () => {
      const result = await getActiveSymbolPatterns();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getActiveValidationRules", () => {
    it("retorna array", async () => {
      const result = await getActiveValidationRules();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getActivePostEditHooks", () => {
    it("retorna array", async () => {
      const result = await getActivePostEditHooks();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("getActivePreCommitHooks", () => {
    it("retorna array", async () => {
      const result = await getActivePreCommitHooks();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("runHook", () => {
    it("runHook não lança exceção para hook inexistente", async () => {
      await expect(runHook({ name: "nonexistent", command: "echo test", type: "post_edit" } as any, {})).resolves.toBeTruthy();
    });
  });

  describe("runPostEditHooks", () => {
    it("retorna string", async () => {
      const result = await runPostEditHooks("/tmp/test.lua");
      expect(result).toBeTruthy();
    });
  });
});
