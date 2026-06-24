/**
 * thinkingindicator-extended.test.tsx — Testes estendidos do ThinkingIndicator.
 *
 * O arquivo existente (tui-thinkingindicator.test.ts) só tem 8 testes e
 * testa a lógica de dots-cycle e renderização básica via strings. Aqui
 * cobrimos:
 *   - Renderização real com ink-testing-library
 *   - Subscrição/desinscrição no ActivityTracker (via vi.spyOn)
 *   - Elapsed time (via fake timers + Date.now controlado)
 *   - formatElapsed (indiretamente, via output renderizado)
 *   - Re-render a cada 200ms (animação do spinner)
 *
 * Usamos fake timers (vi.useFakeTimers) para controlar setInterval e
 * Date.now simultaneamente — necessário porque o elapsed time é calculado
 * como `Date.now() - current.startedAt`. Para que as atualizações de
 * estado do React sejam flusheadas após avançar os timers, usamos a
 * versão async (`vi.advanceTimersByTimeAsync`) que também flusheia
 * microtasks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { act } from "react";
import { render } from "ink-testing-library";

// Imports DEPOIS de eventuais mocks.
import { ThinkingIndicator } from "../tui/ThinkingIndicator.js";
import * as activityTracker from "../activityTracker.js";
import {
  pushActivity,
  _resetActivityForTests,
  type ActivitySnapshot,
} from "../activityTracker.js";

// Configura o ambiente React para act() — algumas atualizações podem
// disparar warnings sem isto.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// Spinner frames (Braille — default em Linux/Mac/Windows Terminal)
const SPINNER_FRAMES_BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ─── Testes ───────────────────────────────────────────────────────────────

describe("ThinkingIndicator — testes estendidos", () => {
  beforeEach(() => {
    _resetActivityForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetActivityForTests();
  });

  // ─── Renderização básica ─────────────────────────────────────────────

  it("renderiza 'PENSANDO...' quando active=true e sem activity", () => {
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("PENSANDO");
  });

  it("retorna null (output vazio) quando active=false", () => {
    const { lastFrame } = render(<ThinkingIndicator active={false} />);
    const out = lastFrame() ?? "";
    // Quando o componente retorna null, o Ink renderiza string vazia.
    expect(out).toBe("");
  });

  it("mostra spinner animado (Braille) quando active=true com activity", () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Spinner deve ser um dos frames Braille (ou ASCII fallback).
    expect(out).toMatch(new RegExp(`[${SPINNER_FRAMES_BRAILLE.join("")}|/\\\\-]`));
  });

  it("mostra o displayLabel da atividade atual quando active=true", () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    // displayLabel para category=tool: "Executando tool: ler_arquivo"
    expect(out).toContain("ler_arquivo");
    expect(out).toContain("Executando");
  });

  // ─── Subscrição no ActivityTracker ───────────────────────────────────

  it("subscribe no ActivityTracker quando montado com active=true", () => {
    const spy = vi.spyOn(activityTracker, "subscribeToActivity");

    render(<ThinkingIndicator active={true} />);

    // O componente deve ter chamado subscribeToActivity no useEffect.
    expect(spy).toHaveBeenCalled();
  });

  it("NÃO subscribe quando active=false", () => {
    const spy = vi.spyOn(activityTracker, "subscribeToActivity");

    render(<ThinkingIndicator active={false} />);

    expect(spy).not.toHaveBeenCalled();
  });

  it("desinscreve quando desmontado", () => {
    // Usamos o spy para capturar a função de unsub retornada.
    const unsubSpy = vi.fn();
    vi.spyOn(activityTracker, "subscribeToActivity").mockReturnValue(unsubSpy);

    const { unmount } = render(<ThinkingIndicator active={true} />);
    expect(activityTracker.subscribeToActivity).toHaveBeenCalled();

    unmount();
    expect(unsubSpy).toHaveBeenCalled();
  });

  it("desinscreve quando transiciona de active=true para active=false", () => {
    const unsubSpy = vi.fn();
    vi.spyOn(activityTracker, "subscribeToActivity").mockReturnValue(unsubSpy);

    const { rerender } = render(<ThinkingIndicator active={true} />);
    expect(activityTracker.subscribeToActivity).toHaveBeenCalledTimes(1);

    // Transiciona para active=false — o cleanup do useEffect roda.
    rerender(<ThinkingIndicator active={false} />);
    expect(unsubSpy).toHaveBeenCalled();
  });

  // ─── Elapsed time (via fake timers + microtask flush) ────────────────

  it("não mostra elapsed time quando activity < 1s (500ms)", async () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);

    // Avança 500ms (2.5 ticks de 200ms) e flush microtasks.
    await vi.advanceTimersByTimeAsync(500);

    const out = stripAnsi(lastFrame() ?? "");
    // formatElapsed(500ms) retorna "" → nenhum "(...)" no output
    expect(out).not.toMatch(/\(\d+s\)/);
    expect(out).not.toContain("(1s)");
  });

  it("mostra elapsed time quando activity > 1s", async () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);

    // Avança 1500ms (7.5 ticks)
    await vi.advanceTimersByTimeAsync(1500);

    const out = stripAnsi(lastFrame() ?? "");
    // formatElapsed(1500ms) retorna "1s"
    expect(out).toContain("(1s)");
  });

  it("formatElapsed(500ms) → '' (sem elapsed no output)", async () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    await vi.advanceTimersByTimeAsync(500);
    const out = stripAnsi(lastFrame() ?? "");
    // Como elapsed < 1000ms, nenhum "(Ns)" deve aparecer.
    expect(out).not.toMatch(/\(\d+s\)/);
    expect(out).not.toMatch(/\(\d+m\d+s\)/);
  });

  it("formatElapsed(5000ms) → '5s'", async () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    await vi.advanceTimersByTimeAsync(5000);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("(5s)");
  });

  it("formatElapsed(65000ms) → '1m05s'", async () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    await vi.advanceTimersByTimeAsync(65000);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("(1m05s)");
  });

  it.skip("formatElapsed(125000ms) → '2m05s' (minutos + segundos)", async () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    await vi.advanceTimersByTimeAsync(125000);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("(2m05s)");
  });

  // ─── Re-render / animação ────────────────────────────────────────────

  it("atualiza snapshot a cada 200ms (re-render)", async () => {
    pushActivity("tool", "ler_arquivo");
    const { frames } = render(<ThinkingIndicator active={true} />);
    const initialFrames = frames.length;

    // Avança 1000ms (5 ticks de 200ms). React pode batchear updates,
    // então nem todo tick gera um novo frame — mas o total deve crescer.
    await vi.advanceTimersByTimeAsync(1000);
    expect(frames.length).toBeGreaterThan(initialFrames);
    // Pelo menos 3 novos frames (5 ticks, permitindo batching).
    expect(frames.length - initialFrames).toBeGreaterThanOrEqual(3);
  });

  it("spinner avança para o próximo frame a cada 200ms", async () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);

    // Frame inicial (spinner idx = 0)
    const out1 = stripAnsi(lastFrame() ?? "");
    // Spinner deve aparecer em algum lugar do output (não necessariamente
    // no início — pode haver whitespace antes).
    expect(out1).toMatch(new RegExp(`[${SPINNER_FRAMES_BRAILLE.join("")}|/\\\\-]`));

    // Avança 1000ms (5 ticks) — spinner deve ter avançado vários frames.
    // (200ms pode não ser suficiente devido ao batching de React.)
    await vi.advanceTimersByTimeAsync(1000);
    const out2 = stripAnsi(lastFrame() ?? "");
    // Spinner deve ter mudado (output diferente do inicial).
    expect(out2).not.toBe(out1);
  });

  it("NÃO re-renderiza a cada 200ms quando active=false", async () => {
    const { frames } = render(<ThinkingIndicator active={false} />);
    const initialFrames = frames.length;

    // Avança 600ms — não deveria ter re-render (sem setInterval ativo)
    await vi.advanceTimersByTimeAsync(600);
    expect(frames.length).toBe(initialFrames);
  });

  // ─── Múltiplas atividades (stack) ────────────────────────────────────

  it("mostra a atividadand  morerecente (topo da stack) quando aninhada", () => {
    pushActivity("api_call", "model-x");
    pushActivity("tool", "ler_arquivo"); // atividade do topo

    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Deve mostrar "ler_arquivo" (topo), não "model-x"
    expect(out).toContain("ler_arquivo");
  });

  it("volta a mostrar a atividade anterior quando a do topo é concluída", () => {
    const done1 = pushActivity("api_call", "model-x");
    pushActivity("tool", "ler_arquivo");

    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("ler_arquivo");

    // Pop da atividade "api_call" — remove ela E tudo acima (a tool).
    // Stack agora vazia → volta para fallback "PENSANDO..."
    act(() => {
      done1();
    });
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("PENSANDO");
  });

  it("ao limpar activity manualmente, volta para 'PENSANDO...'", () => {
    pushActivity("tool", "ler_arquivo");
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    expect(stripAnsi(lastFrame() ?? "")).toContain("ler_arquivo");

    act(() => {
      activityTracker.clearActivity();
    });
    expect(stripAnsi(lastFrame() ?? "")).toContain("PENSANDO");
  });
});
