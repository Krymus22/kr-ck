/**
 * extensions-deep.test.ts — Testes profundos do extensions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { getActiveSkills, getActiveMCPServers, getMCPToolDefinitions, shutdownMCPServers } from "../extensions.js";

describe("extensions — deep coverage", () => {
  describe("getActiveSkills", () => {
    it("retorna array", () => {
      const skills = getActiveSkills();
      expect(Array.isArray(skills)).toBe(true);
    });
  });

  describe("getActiveMCPServers", () => {
    it("retorna array", () => {
      const servers = getActiveMCPServers();
      expect(Array.isArray(servers)).toBe(true);
    });
  });

  describe("getMCPToolDefinitions", () => {
    it("retorna array", () => {
      const defs = getMCPToolDefinitions();
      expect(Array.isArray(defs)).toBe(true);
    });
  });

  describe("shutdownMCPServers", () => {
    it("não lança exceção", () => {
      expect(() => shutdownMCPServers()).not.toThrow();
    });
  });
});
