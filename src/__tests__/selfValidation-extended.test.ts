/**
 * selfValidation-extended.test.ts — Casos edge / error / integração p/ selfValidation.ts.
 * Foco: shouldSelfValidate em casos limítrofes, formatação do prompt, throttle.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("../history.js", () => ({
  addSystemMessage: vi.fn(),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn().mockReturnValue("medium"),
}));

import { shouldSelfValidate, injectSelfValidationPrompt, resetSelfValidation } from "../selfValidation.js";
import * as history from "../history.js";
import { getEffortLevel } from "../effortLevels.js";

const mockedAddSystem = history.addSystemMessage as ReturnType<typeof vi.fn>;
const mockedGetEffort = getEffortLevel as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSelfValidation();
  mockedAddSystem.mockReset();
  mockedGetEffort.mockReturnValue("medium");
});

describe("selfValidation (extended) — shouldSelfValidate casos limítrofes", () => {
  it("counts negativos contam como >0 (touchFilesCount !== 0)", () => {
    // -1 não é === 0, então segue em frente; throttle e effort liberam
    mockedGetEffort.mockReturnValue("high");
    expect(shouldSelfValidate(-1)).toBe(true);
  });

  it("touchedFilesCount grande (1000) ainda funciona", () => {
    mockedGetEffort.mockReturnValue("medium");
    expect(shouldSelfValidate(1000)).toBe(true);
  });

  it("effort 'max' também libera validação", () => {
    mockedGetEffort.mockReturnValue("max");
    expect(shouldSelfValidate(1)).toBe(true);
  });
});

describe("selfValidation (extended) — injectSelfValidationPrompt output", () => {
  it("prompt contém as 5 perguntas obrigatórias (não só as 4 do teste básico)", () => {
    const prompt = injectSelfValidationPrompt(["foo.ts"]);
    expect(prompt).toContain("1. O QUE MUDOU");
    expect(prompt).toContain("2. VERIFICAÇÃO");
    expect(prompt).toContain("3. ERROS RESTANTES");
    expect(prompt).toContain("4. EDGE CASES");
    expect(prompt).toContain("5. HONESTIDADE");
  });

  it("lista exatamente N arquivos quando <= 5 (sem truncamento)", () => {
    const prompt = injectSelfValidationPrompt(["a.ts", "b.ts"]);
    expect(prompt).toContain("a.ts");
    expect(prompt).toContain("b.ts");
    expect(prompt).not.toContain("e mais");
  });
});

describe("selfValidation (extended) — formatIssues / conteúdo do prompt", () => {
  it("prompt enfatiza 'HONESTITY OVER AGREEMENT' (honesty system)", () => {
    const prompt = injectSelfValidationPrompt(["x.ts"]);
    expect(prompt).toContain("HONESTY OVER AGREEMENT");
  });

  it("prompt instrui a corrigir problemas antes de responder", () => {
    const prompt = injectSelfValidationPrompt(["x.ts"]);
    expect(prompt).toContain("CORRIJA");
    expect(prompt).toContain("Não pule esta validação");
  });
});

describe("selfValidation (extended) — edge cases", () => {
  it("dupla injeção na mesma sessão bloqueia a 2ª via throttle (e contador interno)", () => {
    const p1 = injectSelfValidationPrompt(["a.ts"]);
    const p2 = injectSelfValidationPrompt(["a.ts"]);
    // A 2ª chamada ainda retorna o prompt (não há bloqueio dentro de inject),
    // mas shouldSelfValidate passa a retornar false.
    expect(p1).toContain("SELF-VALIDATION");
    expect(p2).toContain("SELF-VALIDATION");
    // Throttle efetivo: próxima chamada de shouldSelfValidate retorna false
    expect(shouldSelfValidate(5)).toBe(false);
    // E addSystemMessage foi chamado 2x (uma por inject)
    expect(mockedAddSystem).toHaveBeenCalledTimes(2);
  });
});
