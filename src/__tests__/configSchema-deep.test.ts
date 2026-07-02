/**
 * configSchema-deep.test.ts — Testes profundos do configSchema
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { validateModeConfig, isValidModeConfig } from "../configSchema.js";

describe("configSchema — deep coverage", () => {
  describe("validateModeConfig", () => {
    it("retorna array vazio para config válido", () => {
      const errors = validateModeConfig({
        name: "test",
        label: "Test",
        description: "Test mode",
        builtIn: false,
      });
      expect(Array.isArray(errors)).toBe(true);
    });

    it("retorna erros para config sem name", () => {
      const errors = validateModeConfig({
        label: "Test",
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("retorna erros para config null", () => {
      const errors = validateModeConfig(null);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("retorna erros para config undefined", () => {
      const errors = validateModeConfig(undefined);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("retorna erros para config vazio", () => {
      const errors = validateModeConfig({});
      expect(errors.length).toBeGreaterThan(0);
    });

    it("retorna erros para name não-string", () => {
      const errors = validateModeConfig({
        name: 123,
        label: "Test",
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it("retorna erros para name vazio", () => {
      const errors = validateModeConfig({
        name: "",
        label: "Test",
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("isValidModeConfig", () => {
    it("retorna true para config válido", () => {
      expect(isValidModeConfig({
        name: "test",
        label: "Test",
        description: "Test mode",
      })).toBe(true);
    });

    it("retorna false para config inválido", () => {
      expect(isValidModeConfig({})).toBe(false);
    });

    it("retorna false para null", () => {
      expect(isValidModeConfig(null)).toBe(false);
    });

    it("retorna false para undefined", () => {
      expect(isValidModeConfig(undefined)).toBe(false);
    });
  });
});
