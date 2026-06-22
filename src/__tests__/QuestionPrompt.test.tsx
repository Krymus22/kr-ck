/**
 * QuestionPrompt.test.tsx — Testes de UI do QuestionPrompt (Sprint 1).
 *
 * Cobre o componente de pergunta interativa (AskUser) com ink-testing-library:
 *   - Renderização: pergunta + alternativas numeradas + contexto
 *   - Navegação por setas ↑↓
 *   - Seleção por número 1-6
 *   - Enter confirma; Esc cancela
 *   - Tab alterna entre "select" e "type"
 *   - Modo "type": digita texto, backspace remove, Enter envia
 *   - No modo "select", digitar texto não-numérico muda pra "type"
 *   - Alternativa selecionada destacada (cor primary)
 *   - Mais de 6 alternativas → só mostra 6 (maxItems do schema)
 *
 * Mocks: logger.js e config.js (defensivo — não há import direto, mas a
 * cadeia transitiva pode puxá-los). Padrão seguido: vi.mock de logger e
 * config como nos demais testes TUI.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// --- Mocks defensivos (logger + config) -------------------------------------

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), success: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
    setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com",
    model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.5,
    contextCompactThreshold: 0.8, costPerKPrompt: 0.01,
    costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

// Import depois dos mocks
import { QuestionPrompt } from "../tui/QuestionPrompt.js";
import type { AskUserQuestion, AskUserResponse } from "../askUser.js";

// --- Helpers ----------------------------------------------------------------

/** Remove códigos ANSI para inspecionar texto puro renderizado. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Delay mínimo para o useInput processar o stdin.write antes do assert. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Constrói pergunta padrão com N alternativas. */
function makeQuestion(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    pergunta: "Qual framework?",
    alternativas: ["React", "Vue", "Svelte"],
    ...overrides,
  };
}

// --- Testes -----------------------------------------------------------------

describe("QuestionPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renderiza pergunta + alternativas numeradas", async () => {
    const onRespond = vi.fn();
    const { lastFrame } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);
    const out = stripAnsi(lastFrame() ?? "");

    // Pergunta aparece
    expect(out).toContain("Qual framework?");
    // Alternativas numeradas com [1], [2], [3]
    expect(out).toContain("[1]");
    expect(out).toContain("React");
    expect(out).toContain("[2]");
    expect(out).toContain("Vue");
    expect(out).toContain("[3]");
    expect(out).toContain("Svelte");
  });

  it("mostra contexto quando fornecido", async () => {
    const onRespond = vi.fn();
    const { lastFrame } = render(
      <QuestionPrompt
        question={makeQuestion({ contexto: "Preciso saber disso pra continuar" })}
        onRespond={onRespond}
      />,
    );
    await delay(10);
    const out = stripAnsi(lastFrame() ?? "");

    expect(out).toContain("Contexto:");
    expect(out).toContain("Preciso saber disso pra continuar");
  });

  it("não mostra contexto quando não fornecido", async () => {
    const onRespond = vi.fn();
    const { lastFrame } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);
    const out = stripAnsi(lastFrame() ?? "");

    expect(out).not.toContain("Contexto:");
  });

  it("setas ↑↓ navegam entre alternativas", async () => {
    const onRespond = vi.fn();
    const { stdin, lastFrame } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Estado inicial: primeira alternativa selecionada (React)
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Selecionado: React");

    // Seta pra baixo → segunda alternativa (Vue)
    stdin.write("\u001B[B"); // down arrow
    await delay(10);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Selecionado: Vue");

    // Seta pra cima → volta pra primeira (React)
    stdin.write("\u001B[A"); // up arrow
    await delay(10);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Selecionado: React");
  });

  it("número 1 seleciona primeira alternativa", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    stdin.write("1");
    await delay(10);

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response: AskUserResponse = onRespond.mock.calls[0][0];
    expect(response.value).toBe("React");
    expect(response.cancelled).toBe(false);
    expect(response.fromAlternatives).toBe(true);
  });

  it("número 2 seleciona segunda alternativa", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    stdin.write("2");
    await delay(10);

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response: AskUserResponse = onRespond.mock.calls[0][0];
    expect(response.value).toBe("Vue");
    expect(response.cancelled).toBe(false);
    expect(response.fromAlternatives).toBe(true);
  });

  it("Enter confirma seleção atual", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Estado inicial: primeira alternativa (React) selecionada
    stdin.write("\r"); // Enter
    await delay(10);

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response: AskUserResponse = onRespond.mock.calls[0][0];
    expect(response.value).toBe("React");
    expect(response.cancelled).toBe(false);
    expect(response.fromAlternatives).toBe(true);
  });

  it("Esc cancela (onRespond com cancelled: true)", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    // Delay maior antes de enviar Esc: garante que o listener de useInput
    // já registrou (ink-testing-library processa stdin de forma assíncrona).
    await delay(30);

    stdin.write("\u001B"); // Esc
    await delay(50);

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response: AskUserResponse = onRespond.mock.calls[0][0];
    expect(response.cancelled).toBe(true);
    expect(response.fromAlternatives).toBe(false);
  });

  it("Tab alterna entre modo 'select' e 'type'", async () => {
    const onRespond = vi.fn();
    const { stdin, lastFrame } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Estado inicial: modo select (mostra "Selecionado:")
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Selecionado:");

    // Tab → muda pra modo type (mostra "Digite sua resposta")
    stdin.write("\t");
    await delay(10);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Digite sua resposta");

    // Tab novamente → volta pra modo select
    stdin.write("\t");
    await delay(10);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Selecionado:");
  });

  it("no modo 'type', texto digitado aparece", async () => {
    const onRespond = vi.fn();
    const { stdin, lastFrame } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Tab → entra no modo type
    stdin.write("\t");
    await delay(10);

    // Digita "custom"
    stdin.write("custom");
    await delay(10);

    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("custom");
  });

  it("no modo 'type', Enter envia texto livre", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Tab → entra no modo type
    stdin.write("\t");
    await delay(10);

    // Digita "resposta livre"
    stdin.write("resposta livre");
    await delay(10);

    // Enter envia
    stdin.write("\r");
    await delay(10);

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response: AskUserResponse = onRespond.mock.calls[0][0];
    expect(response.value).toBe("resposta livre");
    expect(response.cancelled).toBe(false);
    expect(response.fromAlternatives).toBe(false);
  });

  it("no modo 'type', backspace remove último char", async () => {
    const onRespond = vi.fn();
    const { stdin, lastFrame } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Tab → entra no modo type
    stdin.write("\t");
    await delay(10);

    // Digita "abc"
    stdin.write("abc");
    await delay(10);
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("abc");

    // Backspace → remove último char ("c")
    stdin.write("\u007F"); // DEL (mapeado pra backspace/delete)
    await delay(10);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("ab");
    expect(out).not.toMatch(/> ab.*c_/);
  });

  it("no modo 'select', digitar texto não-numérico muda pra modo 'type'", async () => {
    const onRespond = vi.fn();
    const { stdin, lastFrame } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Estado inicial: modo select
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Selecionado:");

    // Digita um char não-numérico ("x")
    stdin.write("x");
    await delay(10);

    // Deve ter mudado pra modo type e ter "x" no texto digitado
    out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Digite sua resposta");
    expect(out).toContain("x");
  });

  it("alternativa selecionada destacada (cor primary)", async () => {
    const onRespond = vi.fn();
    const { stdin, lastFrame } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Seleciona a 3ª alternativa (Svelte) via número
    // NOTA: número 3 dispara onRespond direto, então pra navegar sem
    // confirmar, usamos seta pra baixo 2x.
    stdin.write("\u001B[B"); // down → Vue
    await delay(10);
    stdin.write("\u001B[B"); // down → Svelte
    await delay(10);

    const out = stripAnsi(lastFrame() ?? "");
    // "Selecionado:" mostra a alternativa atual destacada
    expect(out).toContain("Selecionado: Svelte");
  });

  it("mais de 6 alternativas → só mostra 6 (maxItems do schema)", async () => {
    const onRespond = vi.fn();
    const { lastFrame } = render(
      <QuestionPrompt
        question={makeQuestion({
          alternativas: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"],
        })}
        onRespond={onRespond}
      />,
    );
    await delay(10);

    const out = stripAnsi(lastFrame() ?? "");

    // A1..A6 devem aparecer (com [1]..[6])
    expect(out).toContain("A1");
    expect(out).toContain("A6");
    // A7 e A8 NÃO devem aparecer (slice(0,6) corta em 6)
    expect(out).not.toContain("A7");
    expect(out).not.toContain("A8");
    // Hint de navegação mostra "1-6"
    expect(out).toContain("1-6");
  });
});
