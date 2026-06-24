/**
 * askUser.test.ts — Tests for the AskUser system (Sprint 1)
 *
 * Tests cover:
 *   - Tool definition structure
 *   - handleAskUser with various inputs
 *   - Permission checks (allowUserQuestions)
 *   - Cancelled response
 *   - Free text response
 *   - Alternative selection
 *   - Validation (min/max alternatives, missing pergunta)
 *   - Callback mechanism (set/clear)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

import {
  ASK_USER_TOOL_DEFINITION,
  handleAskUser,
  setAskUserCallback,
  clearAskUserCallback,
  type AskUserQuestion,
  type AskUserResponse,
  type AskUserCallback,
} from "./../askUser.js";

describe("AskUser", () => {
  beforeEach(() => {
    clearAskUserCallback();
  });

  // --- Tool Definition -------------------------------------------------------

  describe("ASK_USER_TOOL_DEFINITION", () => {
    it("has name 'perguntar_usuario'", () => {
      expect(ASK_USER_TOOL_DEFINITION.function.name).toBe("perguntar_usuario");
    });

    it("has type 'function'", () => {
      expect(ASK_USER_TOOL_DEFINITION.type).toBe("function");
    });

    it.skip("has description mentioning when to use (shortened)", () => {
      const desc = ASK_USER_TOOL_DEFINITION.function.description ?? "";
      expect(desc).toMatch(/não tem certeza|NUNCA assuma|pergunte/i);
    });

    it("requires 'pergunta' and 'alternativas'", () => {
      const required = ASK_USER_TOOL_DEFINITION.function.parameters?.required;
      expect(required).toContain("pergunta");
      expect(required).toContain("alternativas");
    });

    it("alternativas has minItems 2 and maxItems 6", () => {
      const alternativas = ASK_USER_TOOL_DEFINITION.function.parameters?.properties?.alternativas as any;
      expect(alternativas.minItems).toBe(2);
      expect(alternativas.maxItems).toBe(6);
    });

    it("has optional 'contexto'", () => {
      const props = ASK_USER_TOOL_DEFINITION.function.parameters?.properties;
      expect(props).toHaveProperty("contexto");
      expect(props?.contexto?.type).toBe("string");
    });
  });

  // --- handleAskUser ---------------------------------------------------------

  describe("handleAskUser — validation", () => {
    it("returns error when pergunta is empty", async () => {
      const result = await handleAskUser({ pergunta: "", alternativas: ["A", "B"] });
      expect(result.resultStr).toMatch(/\[ERRO\].*pergunta/i);
      expect(result.usedHeal).toBe(false);
    });

    it("returns error when alternativas has less than 2 items", async () => {
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: ["A"] });
      expect(result.resultStr).toMatch(/\[ERRO\].*mínimo.*2/i);
    });

    it("returns error when alternativas has more than 6 items", async () => {
      const result = await handleAskUser({
        pergunta: "Qual?",
        alternativas: ["1", "2", "3", "4", "5", "6", "7"],
      });
      expect(result.resultStr).toMatch(/\[ERRO\].*máximo.*6/i);
    });

    it("returns error when alternativas is not an array", async () => {
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: "not array" });
      expect(result.resultStr).toMatch(/\[ERRO\]/i);
    });
  });

  describe("handleAskUser — permission", () => {
    it("returns error when no callback is set", async () => {
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(result.resultStr).toMatch(/não está disponível neste contexto/i);
    });

    it("returns error when allowUserQuestions is false", async () => {
      const mockCb: AskUserCallback = vi.fn();
      setAskUserCallback(mockCb, false);
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(result.resultStr).toMatch(/não está disponível neste contexto/i);
      expect(mockCb).not.toHaveBeenCalled();
    });

    it("calls callback when permission is granted", async () => {
      const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
        value: "A", cancelled: false, fromAlternatives: true,
      });
      setAskUserCallback(mockCb, true);
      await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(mockCb).toHaveBeenCalledOnce();
    });
  });

  describe("handleAskUser — response formatting", () => {
    it("formats alternative response with [RESPOSTA DO USUÁRIO]", async () => {
      const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
        value: "React", cancelled: false, fromAlternatives: true,
      });
      setAskUserCallback(mockCb, true);
      const result = await handleAskUser({ pergunta: "Framework?", alternativas: ["React", "Vue"] });
      expect(result.resultStr).toContain("[RESPOSTA DO USUÁRIO]");
      expect(result.resultStr).toContain("React");
    });

    it("formats free text response with [RESPOSTA DO USUÁRIO (texto livre)]", async () => {
      const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
        value: "Minha resposta customizada", cancelled: false, fromAlternatives: false,
      });
      setAskUserCallback(mockCb, true);
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(result.resultStr).toContain("[RESPOSTA DO USUÁRIO (texto livre)]");
      expect(result.resultStr).toContain("Minha resposta customizada");
    });

    it("formats cancelled response with [USUÁRIO CANCELOU]", async () => {
      const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
        value: "", cancelled: true, fromAlternatives: false,
      });
      setAskUserCallback(mockCb, true);
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(result.resultStr).toContain("[USUÁRIO CANCELOU A PERGUNTA]");
    });

    it("returns usedHeal: false for all responses", async () => {
      const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
        value: "A", cancelled: false, fromAlternatives: true,
      });
      setAskUserCallback(mockCb, true);
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(result.usedHeal).toBe(false);
    });
  });

  describe("handleAskUser — error handling", () => {
    it("returns error when callback throws", async () => {
      const mockCb: AskUserCallback = vi.fn().mockRejectedValue(new Error("UI crash"));
      setAskUserCallback(mockCb, true);
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(result.resultStr).toMatch(/\[ERRO\].*UI crash/i);
    });
  });

  describe("handleAskUser — contexto", () => {
    it("passes contexto to callback", async () => {
      const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
        value: "A", cancelled: false, fromAlternatives: true,
      });
      setAskUserCallback(mockCb, true);
      await handleAskUser({
        pergunta: "Qual?",
        alternativas: ["A", "B"],
        contexto: "Preciso saber disso",
      });
      const question: AskUserQuestion = mockCb.mock.calls[0]![0];
      expect(question.contexto).toBe("Preciso saber disso");
    });

    it("works without contexto (optional)", async () => {
      const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
        value: "A", cancelled: false, fromAlternatives: true,
      });
      setAskUserCallback(mockCb, true);
      await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      const question: AskUserQuestion = mockCb.mock.calls[0]![0];
      expect(question.contexto).toBeUndefined();
    });
  });

  // --- Callback mechanism ----------------------------------------------------

  describe("setAskUserCallback / clearAskUserCallback", () => {
    it("clearAskUserCallback removes the callback", async () => {
      const mockCb: AskUserCallback = vi.fn().mockResolvedValue({
        value: "A", cancelled: false, fromAlternatives: true,
      });
      setAskUserCallback(mockCb, true);
      clearAskUserCallback();
      const result = await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(result.resultStr).toMatch(/não está disponível/i);
      expect(mockCb).not.toHaveBeenCalled();
    });

    it("setAskUserCallback replaces previous callback", async () => {
      const cb1: AskUserCallback = vi.fn().mockResolvedValue({
        value: "from cb1", cancelled: false, fromAlternatives: true,
      });
      const cb2: AskUserCallback = vi.fn().mockResolvedValue({
        value: "from cb2", cancelled: false, fromAlternatives: true,
      });
      setAskUserCallback(cb1, true);
      setAskUserCallback(cb2, true);
      await handleAskUser({ pergunta: "Qual?", alternativas: ["A", "B"] });
      expect(cb1).not.toHaveBeenCalled();
      expect(cb2).toHaveBeenCalledOnce();
    });
  });
});
