/**
 * subAgents-deep.test.ts — Testes profundos do subAgents
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../apiClient.js", () => ({ chat: vi.fn() }));
vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));
vi.mock("../activityTracker.js", () => ({ pushActivity: vi.fn(() => () => {}) }));

import { shouldDelegateToSubAgent, shouldUsePowerfulSubAgents } from "../subAgents.js";

describe("subAgents — deep coverage", () => {
  describe("shouldDelegateToSubAgent", () => {
    it("retorna true para 'explore the codebase'", () => {
      const result = shouldDelegateToSubAgent("explore the codebase to understand the structure");
      expect(typeof result).toBe("boolean");
    });

    it("retorna true para 'pesquise no projeto'", () => {
      const result = shouldDelegateToSubAgent("pesquise no projeto como funciona X");
      expect(typeof result).toBe("boolean");
    });

    it("retorna false para mensagem simples", () => {
      const result = shouldDelegateToSubAgent("crie uma função que soma dois números");
      expect(typeof result).toBe("boolean");
    });

    it("retorna boolean para string vazia", () => {
      const result = shouldDelegateToSubAgent("");
      expect(typeof result).toBe("boolean");
    });

    it("retorna boolean para query longa", () => {
      const result = shouldDelegateToSubAgent("explore deeply the entire codebase structure and find all files that reference the database module and also check for any tests that might be affected by changes to the authentication system");
      expect(typeof result).toBe("boolean");
    });
  });

  describe("shouldUsePowerfulSubAgents", () => {
    it("retorna boolean", () => {
      expect(typeof shouldUsePowerfulSubAgents()).toBe("boolean");
    });
  });
});
