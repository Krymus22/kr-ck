/**
 * ConfiguratorChat.test.tsx — Testes de UI do ConfiguratorChat (Sprint 11).
 *
 * Cobre o mini chat do configurador:
 *   - Header com "Configurador de Tools" + nome do modo ativo
 *   - Renderização de mensagens (configurador / usuário / sistema) com ícones
 *   - Esc fecha o chat (chama onClose)
 *   - Digitar "sair" fecha o chat
 *   - Digitar tool name + Enter inicia configuração (chama configureTool)
 *   - Estado "⏳ Trabalhando..." enquanto running
 *   - Estado "Concluído" quando finished
 *
 * Mocks: logger, config, apiClient, toolConfigurator (configureTool +
 * detectToolsWithoutManifest + ConfiguratorResult) e modes (getActiveMode).
 * O configureTool é mockado como Promise controlável para permitir inspecionar
 * os estados running/finished.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// --- Mocks ------------------------------------------------------------------

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

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
}));

// Mock controllable de configureTool: permite inspecionar estados
// "running" (antes de resolver) e "finished" (depois de resolver).
// Usa vi.hoisted para que o mock factory (que é hoisted) tenha acesso.
const configuratorMocks = vi.hoisted(() => {
  const resolveRef: { current: ((r: { success: boolean; message: string }) => void) | null } = { current: null };
  const configureToolMock = vi.fn(
    (
      _toolName: string,
      _modeName: string | null,
      _onAskUser: unknown,
      onMessage?: (msg: string) => void,
    ) => {
      // Dispara uma mensagem de configurador imediatamente (simula IA trabalhando)
      if (onMessage) onMessage("Analisando a tool...");
      return new Promise<{ success: boolean; message: string }>((resolve) => {
        resolveRef.current = resolve;
      });
    },
  );
  const detectToolsWithoutManifestMock = vi.fn(() => []);
  return { configureToolMock, detectToolsWithoutManifestMock, resolveRef };
});

vi.mock("../toolConfigurator.js", () => ({
  configureTool: configuratorMocks.configureToolMock,
  detectToolsWithoutManifest: configuratorMocks.detectToolsWithoutManifestMock,
}));

// Mock controllable de getActiveMode: retorna um modo com nome "roblox" por padrão.
const getActiveModeMock = vi.hoisted(() => vi.fn(() => ({
  name: "roblox", label: "Roblox",
})));

vi.mock("../modes.js", () => ({
  getActiveMode: getActiveModeMock,
}));

// Alias locais (após hoist) pra uso nos testes
const { configureToolMock, detectToolsWithoutManifestMock, resolveRef } = configuratorMocks;

// Import depois dos mocks
import { ConfiguratorChat } from "../tui/ConfiguratorChat.js";

// --- Helpers ----------------------------------------------------------------

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Testes -----------------------------------------------------------------

describe("ConfiguratorChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRef.current = null;
    configureToolMock.mockClear();
    detectToolsWithoutManifestMock.mockReset();
    detectToolsWithoutManifestMock.mockReturnValue([]);
    getActiveModeMock.mockReset();
    getActiveModeMock.mockReturnValue({ name: "roblox", label: "Roblox" });
  });

  it("renderiza header com 'Configurador de Tools'", async () => {
    const { lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);
    const out = stripAnsi(lastFrame() ?? "");

    expect(out).toContain("Configurador de Tools");
  });

  it("mostra nome do modo ativo no header", async () => {
    getActiveModeMock.mockReturnValue({ name: "devops", label: "DevOps" });
    const { lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);
    const out = stripAnsi(lastFrame() ?? "");

    expect(out).toContain("Configurador de Tools");
    expect(out).toContain("devops");
  });

  it("mostra mensagens do configurador (role: configurador, prefixo 🤖)", async () => {
    // Render → useEffect dispara detectToolsWithoutManifest (retorna []).
    // Depois, digitar "darklua" + Enter dispara configureTool, que chama
    // onMessage("Analisando a tool...") → mensagem role=configurator.
    const { stdin, lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);

    stdin.write("darklua");
    await delay(10);
    stdin.write("\r"); // Enter
    await delay(30);

    const out = stripAnsi(lastFrame() ?? "");
    // A mensagem "Analisando a tool..." foi enviada pelo mock do configureTool.
    expect(out).toContain("Analisando a tool...");
  });

  it("mostra mensagens do usuário (prefixo 👤)", async () => {
    const { stdin, lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);

    stdin.write("darklua");
    await delay(10);
    stdin.write("\r"); // Enter
    await delay(30);

    const out = stripAnsi(lastFrame() ?? "");
    // A mensagem do usuário (o que foi digitado) aparece com prefixo 👤.
    expect(out).toContain("darklua");
  });

  it("mostra mensagens do sistema (prefixo ℹ️)", async () => {
    // detectToolsWithoutManifest retorna [] → useEffect adiciona mensagem
    // de sistema "Nenhuma tool sem manifest encontrada..."
    detectToolsWithoutManifestMock.mockReturnValue([]);
    const { lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);
    const out = stripAnsi(lastFrame() ?? "");

    // Mensagem de sistema inicial aparece
    expect(out).toContain("Nenhuma tool sem manifest");
  });

  it("Esc fecha o chat (chama onClose)", async () => {
    const onClose = vi.fn();
    const { stdin } = render(<ConfiguratorChat onClose={onClose} />);
    await delay(30);

    stdin.write("\u001B"); // Esc
    await delay(50);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("digitar 'sair' fecha o chat", async () => {
    const onClose = vi.fn();
    const { stdin } = render(<ConfiguratorChat onClose={onClose} />);
    await delay(30);

    stdin.write("sair");
    await delay(10);
    stdin.write("\r"); // Enter
    await delay(50);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("digitar tool name + Enter inicia configuração (chama configureTool)", async () => {
    const { stdin } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);

    stdin.write("darklua");
    await delay(10);
    stdin.write("\r"); // Enter
    await delay(30);

    expect(configureToolMock).toHaveBeenCalledTimes(1);
    const [toolName, modeName] = configureToolMock.mock.calls[0];
    expect(toolName).toBe("darklua");
    expect(modeName).toBe("roblox");
  });

  it("mostra '⏳ Trabalhando...' enquanto running", async () => {
    const { stdin, lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);

    // Dispara configureTool (Promise fica pendente enquanto não resolver)
    stdin.write("darklua");
    await delay(10);
    stdin.write("\r"); // Enter
    await delay(50);

    const out = stripAnsi(lastFrame() ?? "");
    // Estado running: mostra "⏳ Trabalhando..."
    expect(out).toContain("Trabalhando");
  });

  it("mostra 'Concluído' quando finished", async () => {
    const { stdin, lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);

    // Dispara configureTool
    stdin.write("darklua");
    await delay(10);
    stdin.write("\r"); // Enter
    await delay(50);

    // Antes de resolver: running
    expect(stripAnsi(lastFrame() ?? "")).toContain("Trabalhando");

    // Resolve a Promise → componente fica "finished"
    expect(resolveRef.current).not.toBeNull();
    resolveRef.current!({ success: true, message: "Tool configurada!" });
    await delay(50);

    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Concluído");
  });
});
