/**
 * configSeeder-deep.test.ts — Testes profundos do configSeeder
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { seedUserConfig, forceReseedOnNextRun, isSeeded } from "../configSeeder.js";

describe("configSeeder — deep coverage", () => {
  describe("seedUserConfig", () => {
    it("retorna number", () => {
      const result = seedUserConfig();
      expect(typeof result).toBe("number");
    });
  });

  describe("forceReseedOnNextRun", () => {
    it("não lança exceção", () => {
      expect(() => forceReseedOnNextRun()).not.toThrow();
    });
  });

  describe("isSeeded", () => {
    it("retorna boolean", () => {
      expect(typeof isSeeded()).toBe("boolean");
    });
  });
});
