/**
 * thinkTool-coverage.test.ts — Testes de cobertura do thinkTool
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { think } from "../thinkTool.js";

describe("thinkTool — coverage", () => {
  describe("think", () => {
    it("retorna result para pensamento válido", async () => {
      const result = await think({
        pensamento: "Preciso analisar o código antes de editar",
        categoria: "pre_edit",
      } as any);
      expect(result).toHaveProperty("confirmed");
      expect(typeof result.confirmed).toBe("boolean");
    });

    it("retorna result para categoria pre_research", async () => {
      const result = await think({
        pensamento: "Vou pesquisar antes de responder",
        categoria: "pre_research",
      } as any);
      expect(result).toHaveProperty("confirmed");
    });

    it("retorna result para categoria pre_response", async () => {
      const result = await think({
        pensamento: "Vou estruturar minha resposta",
        categoria: "pre_response",
      } as any);
      expect(result).toHaveProperty("confirmed");
    });

    it("retorna result para categoria post_edit", async () => {
      const result = await think({
        pensamento: "Edição concluída, preciso verificar",
        categoria: "post_edit",
      } as any);
      expect(result).toHaveProperty("confirmed");
    });

    it("retorna result para categoria custom", async () => {
      const result = await think({
        pensamento: "Pensamento customizado",
        categoria: "custom",
      } as any);
      expect(result).toHaveProperty("confirmed");
    });

    it("retorna result para pensamento vazio", async () => {
      const result = await think({
        pensamento: "",
        categoria: "pre_edit",
      } as any);
      expect(result).toHaveProperty("confirmed");
    });
  });
});
