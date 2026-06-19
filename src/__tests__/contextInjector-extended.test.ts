/**
 * contextInjector-extended.test.ts — Casos edge / integração p/ contextInjector.ts.
 * Foco: injectContext em 3 cenários, shouldInject em 2, formatContext em 2, edge cases.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("../taskState.js", () => ({
  getTaskStateSummary: vi.fn(),
}));

import { getContextInjection, resetContextInjection } from "../contextInjector.js";
import { getTaskStateSummary } from "../taskState.js";

const mockedGetSummary = getTaskStateSummary as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetContextInjection();
  mockedGetSummary.mockReset();
});

describe("contextInjector (extended) — injectContext", () => {
  it("injeção inclui sufixo 'Lembre-se destes pontos'", () => {
    mockedGetSummary.mockReturnValue("## TASK_STATE\nTodo:\n  ○ item");
    // Skip 2 calls to get to 3rd
    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");
    expect(result).toContain("Lembre-se destes pontos antes da próxima ação.");
  });

  it("retorna vazio quando summary tem apenas seções irrelevantes (Done/Notes)", () => {
    // compactSummary mantém só Todo/Decisions/Bugs/Dependencies
    mockedGetSummary.mockReturnValue("## TASK_STATE\nTitle: x\nDone:\n  ✓ done\nNotes:\n  note");
    // 3 calls
    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");
    // Nada relevante → retorna ""
    expect(result).toBe("");
  });

  it("injeção inclui a linha 'Title:' do summary", () => {
    mockedGetSummary.mockReturnValue("## TASK_STATE\nTitle: Meu Projeto\nTodo:\n  ○ fazer x");
    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");
    expect(result).toContain("Title: Meu Projeto");
  });
});

describe("contextInjector (extended) — shouldInject (throttle)", () => {
  it("retorna vazio para ferramenta desconhecida (ex: 'pensar')", () => {
    mockedGetSummary.mockReturnValue("## TASK_STATE\nTodo:\n  ○ x");
    // Pensar não é decision-critical; nunca injeta
    expect(getContextInjection("pensar")).toBe("");
    expect(getContextInjection("pensar")).toBe("");
    expect(getContextInjection("pensar")).toBe("");
  });

  it("retorna vazio quando summary contém só title e header (sem seções)", () => {
    mockedGetSummary.mockReturnValue("## TASK_STATE\nTitle: x");
    // 3 calls
    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");
    // compactSummary retorna "" se kept.length <= 2 (só ## TASK_STATE + Title:)
    expect(result).toBe("");
  });
});

describe("contextInjector (extended) — formatContext (separadores)", () => {
  it("formato inclui marcadores --- [CONTEXTO ATUAL] --- e --- [FIM DO CONTEXTO] ---", () => {
    mockedGetSummary.mockReturnValue("## TASK_STATE\nTodo:\n  ○ item");
    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");
    expect(result).toContain("--- [CONTEXTO ATUAL] ---");
    expect(result).toContain("--- [FIM DO CONTEXTO] ---");
  });

  it("mantém cabeçalho da seção 'Decisions:' e 'Bugs:' mas não itens fora delas", () => {
    mockedGetSummary.mockReturnValue(`## TASK_STATE
Title: t
Decisions:
  • use X
Bugs:
  ! bug 1`);
    getContextInjection("aplicar_diff");
    getContextInjection("aplicar_diff");
    const result = getContextInjection("aplicar_diff");
    expect(result).toContain("Decisions:");
    expect(result).toContain("use X");
    expect(result).toContain("Bugs:");
    expect(result).toContain("bug 1");
  });
});

describe("contextInjector (extended) — edge cases", () => {
  it("resetContextInjection reinicia throttle mesmo no meio de uma sequência", () => {
    mockedGetSummary.mockReturnValue("## TASK_STATE\nTodo:\n  ○ item");
    // 1 call (counter = 1)
    getContextInjection("aplicar_diff");
    // Reset → counter volta a 0
    resetContextInjection();
    // Após reset, primeiro 2 calls skip
    expect(getContextInjection("aplicar_diff")).toBe("");
    expect(getContextInjection("aplicar_diff")).toBe("");
    // 3ª call injeta
    expect(getContextInjection("aplicar_diff")).toContain("CONTEXTO ATUAL");
  });
});
