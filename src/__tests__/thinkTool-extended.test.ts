/**
 * thinkTool-extended.test.ts — Casos edge / error / integração p/ thinkTool.ts.
 * Foco: handler pensar com categorias, formato da mensagem, casos limítrofes.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { think, THINK_TOOL_DEFINITION } from "../thinkTool.js";

describe("thinkTool (extended) — handler pensar", () => {
  it("aceita pensamento vazio sem lançar (categoria default)", async () => {
    const r = await think({ pensamento: "" });
    expect(r.confirmed).toBe(true);
    expect(r.message).toContain("0 chars");
  });

  it("lida com pensamento muito longo (10k chars) e reflete o length", async () => {
    const thought = "x".repeat(10_000);
    const r = await think({ pensamento: thought });
    expect(r.confirmed).toBe(true);
    expect(r.message).toContain("10000 chars");
  });

  it("preserva a categoria informada em todos os 5 valores do enum", async () => {
    for (const cat of ["planning", "verification", "debugging", "architecture", "general"]) {
      const r = await think({ pensamento: "x", category: cat });
      expect(r.message).toContain(`category: ${cat}`);
    }
  });
});

describe("thinkTool (extended) — reasoning storage", () => {
  it("cada chamada retorna resultado novo e stateless (não acumula)", async () => {
    const r1 = await think({ pensamento: "primeiro" });
    const r2 = await think({ pensamento: "segundo" });
    // Mensagens devem refletir a entrada atual, não histórico
    expect(r1.message).toContain("8 chars");
    expect(r2.message).toContain("7 chars");
    expect(r1).not.toBe(r2);
  });

  it("categoria 'debugging' aparece literalmente na mensagem registrada", async () => {
    const r = await think({ pensamento: "analisando bug", category: "debugging" });
    expect(r.message).toContain("category: debugging");
    expect(r.message).toContain("THOUGHT RECORDED");
  });
});

describe("thinkTool (extended) — context injection na mensagem", () => {
  it("mensagem orienta a prosseguir com a ação planejada", async () => {
    const r = await think({ pensamento: "planejando" });
    expect(r.message).toContain("proceed");
    expect(r.message).toContain("planned action");
  });

  it("mensagem sempre começa com marcador THOUGHT RECORDED", async () => {
    const r = await think({ pensamento: "teste", category: "planning" });
    expect(r.message.startsWith("[THOUGHT RECORDED")).toBe(true);
  });
});

describe("thinkTool (extended) — edge cases", () => {
  it("pensamento com quebras de linha e caracteres unicode é aceito", async () => {
    const thought = "linha1\nlinha2 🚀\nçãõé";
    const r = await think({ pensamento: thought });
    expect(r.confirmed).toBe(true);
    // length conta code units UTF-16, não bytes
    expect(r.message).toContain(`${thought.length} chars`);
  });
});

describe("THINK_TOOL_DEFINITION (extended)", () => {
  it("parâmetro 'pensamento' tem descrição não-vazia", () => {
    const params = THINK_TOOL_DEFINITION.function.parameters as {
      properties: { pensamento: { description: string; type: string } };
    };
    expect(params.properties.pensamento.type).toBe("string");
    expect(params.properties.pensamento.description.length).toBeGreaterThan(20);
  });

  it("'categoria' é opcional (não está em required)", () => {
    const params = THINK_TOOL_DEFINITION.function.parameters as { required: string[] };
    expect(params.required).toEqual(["pensamento"]);
    expect(params.required).not.toContain("categoria");
  });
});
