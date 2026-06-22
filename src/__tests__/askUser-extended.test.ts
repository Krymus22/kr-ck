/**
 * askUser-extended.test.ts — Edge cases do AskUser (Sprint 1).
 *
 * Cobre situações que o teste básico não toca:
 *   - alternativas com caracteres unicode (emoji, CJK)
 *   - pergunta muito longa (>1000 chars)
 *   - contexto muito longo
 *   - alternativas duplicadas (não valida duplicatas — deve funcionar)
 *   - callback que resolve após delay (async)
 *   - múltiplos handleAskUser em sequência (re-entrância)
 *   - clearAskUserCallback limpa corretamente entre chamadas
 *   - setAskUserCallback com allow=true mas callback undefined → erro
 *   - ASK_USER_TOOL_DEFINITION tem minItems/maxItems corretos
 *   - handleAskUser com args null/undefined → erro graceful
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

import {
  ASK_USER_TOOL_DEFINITION,
  handleAskUser,
  setAskUserCallback,
  clearAskUserCallback,
  type AskUserCallback,
  type AskUserQuestion,
} from "../askUser.js";

describe("AskUser — extended (edge cases)", () => {
  beforeEach(() => {
    clearAskUserCallback();
  });

  // --- Unicode ---------------------------------------------------------------

  it("lida com alternativas contendo emoji e caracteres CJK", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "🚀 Iniciar 部署",
      cancelled: false,
      fromAlternatives: true,
    });
    setAskUserCallback(mockCb, true);

    const alternativas = ["🚀 Iniciar 部署", "⏸️ Pausar 部署", "✅ Concluir 部署"];
    const result = await handleAskUser({
      pergunta: "O que fazer com o deploy?",
      alternativas,
    });

    expect(result.resultStr).toContain("🚀 Iniciar 部署");
    // Garante que o callback recebeu as alternativas unicode preservadas
    const received: AskUserQuestion = mockCb.mock.calls[0]![0];
    expect(received.alternativas).toEqual(alternativas);
  });

  it("lida com pergunta muito longa (>1000 chars)", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "ok",
      cancelled: false,
      fromAlternatives: true,
    });
    setAskUserCallback(mockCb, true);

    const longQuestion = "Q".repeat(1500);
    const result = await handleAskUser({
      pergunta: longQuestion,
      alternativas: ["A", "B"],
    });

    // Não deve rejeitar por tamanho — apenas repassa ao callback.
    expect(result.resultStr).toContain("ok");
    expect(mockCb.mock.calls[0]![0].pergunta).toHaveLength(1500);
  });

  it("lida com contexto muito longo", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "A",
      cancelled: false,
      fromAlternatives: true,
    });
    setAskUserCallback(mockCb, true);

    const longContexto = "C".repeat(2000);
    await handleAskUser({
      pergunta: "Qual?",
      alternativas: ["A", "B"],
      contexto: longContexto,
    });

    expect(mockCb.mock.calls[0]![0].contexto).toHaveLength(2000);
  });

  // --- Duplicatas ------------------------------------------------------------

  it("aceita alternativas duplicadas (não valida duplicatas)", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "A",
      cancelled: false,
      fromAlternatives: true,
    });
    setAskUserCallback(mockCb, true);

    const result = await handleAskUser({
      pergunta: "Qual?",
      alternativas: ["A", "A", "B"],
    });

    expect(result.resultStr).not.toMatch(/\[ERRO\]/);
    expect(mockCb).toHaveBeenCalledOnce();
  });

  // --- Async / delay ---------------------------------------------------------

  it("suporta callback que resolve após delay (async)", async () => {
    const mockCb: AskUserCallback = vi.fn().mockImplementation(
      () => new Promise((resolve) => {
        setTimeout(() => resolve({ value: "tarde", cancelled: false, fromAlternatives: true }), 50);
      }),
    );
    setAskUserCallback(mockCb, true);

    const start = Date.now();
    const result = await handleAskUser({ pergunta: "Q?", alternativas: ["A", "B"] });
    const elapsed = Date.now() - start;

    expect(result.resultStr).toContain("tarde");
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it("suporta múltiplos handleAskUser em sequência (re-entrância)", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "seq",
      cancelled: false,
      fromAlternatives: true,
    });
    setAskUserCallback(mockCb, true);

    const r1 = await handleAskUser({ pergunta: "Q1", alternativas: ["A", "B"] });
    const r2 = await handleAskUser({ pergunta: "Q2", alternativas: ["C", "D"] });
    const r3 = await handleAskUser({ pergunta: "Q3", alternativas: ["E", "F"] });

    expect(mockCb).toHaveBeenCalledTimes(3);
    expect(r1.resultStr).toContain("seq");
    expect(r2.resultStr).toContain("seq");
    expect(r3.resultStr).toContain("seq");
  });

  // --- clearAskUserCallback --------------------------------------------------

  it("clearAskUserCallback limpa callback entre chamadas", async () => {
    const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
      value: "A", cancelled: false, fromAlternatives: true,
    });
    setAskUserCallback(mockCb, true);
    clearAskUserCallback();
    setAskUserCallback(mockCb, true);

    await handleAskUser({ pergunta: "Q", alternativas: ["A", "B"] });
    expect(mockCb).toHaveBeenCalledOnce();
  });

  // --- setAskUserCallback edge cases -----------------------------------------

  it("setAskUserCallback com allow=true mas callback undefined → handler retorna erro", async () => {
    // Passar allow=true mas callback undefined não deve quebrar o setter;
    // o handler detecta ausência de callback e retorna erro graceful.
    setAskUserCallback(undefined, true);
    const result = await handleAskUser({ pergunta: "Q?", alternativas: ["A", "B"] });
    expect(result.resultStr).toMatch(/não está disponível neste contexto/i);
  });

  // --- Tool definition structure ---------------------------------------------

  it("ASK_USER_TOOL_DEFINITION tem minItems=2 e maxItems=6 em alternativas", () => {
    const alternativas = ASK_USER_TOOL_DEFINITION.function.parameters?.properties?.alternativas as any;
    expect(alternativas.minItems).toBe(2);
    expect(alternativas.maxItems).toBe(6);
  });

  it("ASK_USER_TOOL_DEFINITION tem 'pergunta' e 'alternativas' como required", () => {
    const required = ASK_USER_TOOL_DEFINITION.function.parameters?.required as string[];
    expect(required).toContain("pergunta");
    expect(required).toContain("alternativas");
    // contexto não é required
    expect(required).not.toContain("contexto");
  });

  // --- args null/undefined ---------------------------------------------------

  it("handleAskUser com args undefined retorna erro graceful (guarda contra null/undefined)", async () => {
    // BUG FIX (Sprint 12): agora há guarda para null/undefined — retorna erro em
    // vez de lançar TypeError ao tentar acessar args.pergunta.
    // @ts-expect-error chamada propositalmente inválida
    const result = await handleAskUser(undefined);
    expect(result.resultStr).toMatch(/args inválidos/i);
    expect(result.usedHeal).toBe(false);
  });

  it("handleAskUser com args null retorna erro graceful (guarda contra null/undefined)", async () => {
    // BUG FIX (Sprint 12): agora há guarda para null/undefined.
    // @ts-expect-error chamada propositalmente inválida
    const result = await handleAskUser(null);
    expect(result.resultStr).toMatch(/args inválidos/i);
    expect(result.usedHeal).toBe(false);
  });

  it("handleAskUser com args={} retorna erro de pergunta obrigatória", async () => {
    const result = await handleAskUser({});
    expect(result.resultStr).toMatch(/pergunta/i);
  });
});
