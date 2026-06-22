/**
 * integration-tui-new-components.test.tsx — Testes de INTEGRAÇÃO E2E dos
 * componentes TUI novos (QuestionPrompt, ConfiguratorChat, ExtensionHub)
 * com o resto do sistema (askUser, toolConfigurator, inboxOrganizer).
 *
 * Diferente dos testes unitários (QuestionPrompt.test.tsx, etc), ESTES
 * testes exercitam o fluxo completo:
 *   1. Renderiza o componente TUI real
 *   2. Simula input do usuário via stdin
 *   3. Verifica que o callback (onRespond, onClose, onConfigure, etc) foi
 *      chamado com os argumentos corretos
 *   4. Em alguns casos, pega o objeto retornado e alimenta o handler real
 *      (handleAskUser, configureTool) pra verificar o resultado formatado
 *      que voltaria pra IA
 *
 * Cenários:
 *   - QuestionPrompt + AskUser: 5 testes
 *   - ConfiguratorChat + toolConfigurator: 4 testes
 *   - ExtensionHub + Organize + Configure: 5 testes
 *
 * Mocks: logger, config, apiClient, toolConfigurator (com Promise controlável),
 * modes, extensionCenter, toolInstaller, etc.
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

vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
}));

// --- Mock de toolConfigurator (com Promise controlável) ---------------------
// Permite inspecionar os estados "running" (antes de resolver) e "finished"
// (depois de resolver) do ConfiguratorChat.

const configuratorMocks = vi.hoisted(() => {
  const resolveRef: { current: ((r: { success: boolean; message: string }) => void) | null } = { current: null };
  const configureToolMock = vi.fn(
    (
      _toolName: string,
      _modeName: string | null,
      _onAskUser: unknown,
      onMessage?: (msg: string) => void,
    ) => {
      // Dispara uma mensagem de configurador imediatamente
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

// --- Mock de modes (getActiveMode retorna modo roblox) ----------------------

const getActiveModeMock = vi.hoisted(() => vi.fn(() => ({
  name: "roblox", label: "Roblox",
})));

const getActiveModeNameMock = vi.hoisted(() => vi.fn(() => "roblox"));

vi.mock("../modes.js", () => ({
  getActiveMode: getActiveModeMock,
  getActiveModeName: getActiveModeNameMock,
  getAllModes: vi.fn(() => [
    { name: "roblox", label: "Roblox", description: "Roblox mode", builtIn: true,
      enableTools: ["tool:rojo_build"], enableSkills: [], enableFeatures: [], icon: "R" },
  ]),
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
}));

// --- Mocks auxiliares para ExtensionHub --------------------------------------

const mockedGetAllExtensions = vi.hoisted(() => vi.fn(() => [
  { id: "tool:rojo_build", name: "rojo_build", category: "tool", enabled: true,
    installed: false, triggerMode: "on_file", description: "Build Roblox project" },
  { id: "skill:rojo-cli", name: "rojo-cli", category: "skill", enabled: true,
    installed: true, triggerMode: "always", description: "Rojo CLI skill" },
]));
const mockedGetHubSummary = vi.hoisted(() => vi.fn(() => ({
  total: 2, enabled: 2, byCategory: {
    tool: { total: 1, enabled: 1 },
    skill: { total: 1, enabled: 1 },
    mcp: { total: 0, enabled: 0 },
    plugin: { total: 0, enabled: 0 },
    feature: { total: 0, enabled: 0 },
  },
})));

vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: mockedGetAllExtensions,
  getExtensionsByCategory: vi.fn((cat: string) =>
    mockedGetAllExtensions().filter((e: any) => e.category === cat)),
  getHubSummary: mockedGetHubSummary,
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn((m: string) => m === "disabled" ? "OFF" : m === "on_file" ? "FILE" : "EVERY"),
  getTriggerModes: vi.fn(() => ["disabled", "on_file", "on_task", "always"]),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn((cat: string) => cat === "tool" ? "T" : "S"),
  discoverExtensions: vi.fn(),
  executeTrigger: vi.fn(() => Promise.resolve()),
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

vi.mock("../toolDetector.js", () => ({
  detectTool: vi.fn(() => ({ status: "missing", binaryPath: null, version: null, error: "", searchedPaths: [] })),
  detectAndVerify: vi.fn(async () => ({ status: "missing", binaryPath: null, version: null, error: "", searchedPaths: [], verified: false })),
  verifyToolWorks: vi.fn(async () => ({ works: false })),
  getSearchPathsForTool: vi.fn(() => []),
  isAutoDetectEnabled: vi.fn(() => false),
}));

vi.mock("../toolInstaller.js", () => ({
  installTool: vi.fn(async () => ({ success: true, toolName: "rojo", version: "7.6.1", binaryPath: "/fake/rojo" })),
  canInstall: vi.fn(() => true),
  listInstallableTools: vi.fn(() => ["rojo"]),
  getToolRepo: vi.fn(() => null),
  getInstallDir: vi.fn(() => ""),
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
}));

vi.mock("../apiKeyPool.js", () => ({ getPoolSize: vi.fn(() => 1), formatPoolStats: vi.fn(() => "") }));
vi.mock("../i18n.js", () => ({ getLocalizedSlashCommands: vi.fn(() => []), getCommandI18n: vi.fn(() => ({})) }));
vi.mock("../history.js", () => ({
  isPlanMode: vi.fn(() => false), setPlanMode: vi.fn(), resetHistory: vi.fn(),
  getHistory: vi.fn(() => []), addUserMessage: vi.fn(), addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(), addSystemMessage: vi.fn(), historySummary: vi.fn(() => ""),
  historyLength: vi.fn(() => 0),
}));
vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []),
    isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn(), getToolStatus: vi.fn(() => "missing") })),
  getDetector: vi.fn(() => ({ detect: vi.fn(), detectFromContext: vi.fn() })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn() })),
  initializeTools: vi.fn(),
}));
vi.mock("../agent.js", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../todo.js", () => ({ resetTodo: vi.fn(), renderTodoBar: vi.fn(), getTodos: vi.fn() }));
vi.mock("../memory.js", () => ({ getMemoryConfig: vi.fn() }));
vi.mock("../session.js", () => ({ saveSession: vi.fn(), loadSession: vi.fn(), listSessions: vi.fn() }));
vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn() }));

// --- Imports (após mocks) ---------------------------------------------------

import { QuestionPrompt } from "../tui/QuestionPrompt.js";
import { ConfiguratorChat } from "../tui/ConfiguratorChat.js";
import { ExtensionHub } from "../tui/ExtensionHub.js";
import {
  handleAskUser,
  setAskUserCallback,
  clearAskUserCallback,
  type AskUserQuestion,
  type AskUserResponse,
} from "../askUser.js";
import { organizeInbox } from "../inboxOrganizer.js";

const { configureToolMock, detectToolsWithoutManifestMock, resolveRef } = configuratorMocks;

// --- Helpers ----------------------------------------------------------------

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeQuestion(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
  return {
    pergunta: "Qual framework?",
    alternativas: ["React", "Vue", "Svelte"],
    ...overrides,
  };
}

// --- Setup ------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resolveRef.current = null;
  configureToolMock.mockClear();
  detectToolsWithoutManifestMock.mockReset();
  detectToolsWithoutManifestMock.mockReturnValue([]);
  getActiveModeMock.mockReset();
  getActiveModeMock.mockReturnValue({ name: "roblox", label: "Roblox" });
  getActiveModeNameMock.mockReset();
  getActiveModeNameMock.mockReturnValue("roblox");
  mockedGetAllExtensions.mockReturnValue([
    { id: "tool:rojo_build", name: "rojo_build", category: "tool", enabled: true,
      installed: false, triggerMode: "on_file", description: "Build Roblox project" },
    { id: "skill:rojo-cli", name: "rojo-cli", category: "skill", enabled: true,
      installed: true, triggerMode: "always", description: "Rojo CLI skill" },
  ]);
  clearAskUserCallback();
});

// --- Testes: QuestionPrompt + AskUser integration ---------------------------

describe("E2E: QuestionPrompt + AskUser integration", () => {
  it("IA chama perguntar_usuario → QuestionPrompt aparece", async () => {
    // Cenário: IA faz tool_call perguntar_usuario → handler chama callback
    // → callback (setado pelo App.tsx) renderiza QuestionPrompt.
    // Verificamos que o componente renderiza a pergunta + alternativas.
    const onRespond = vi.fn();
    const { lastFrame } = render(
      <QuestionPrompt question={makeQuestion({ pergunta: "Qual framework usar?" })} onRespond={onRespond} />,
    );
    await delay(10);
    const out = stripAnsi(lastFrame() ?? "");

    // Pergunta aparece
    expect(out).toContain("Qual framework usar?");
    // Alternativas aparecem numeradas
    expect(out).toContain("[1]");
    expect(out).toContain("React");
    expect(out).toContain("[2]");
    expect(out).toContain("Vue");
  });

  it("usuário escolhe alternativa → resposta formatada corretamente via handleAskUser", async () => {
    // Cenário: usuário escolhe "React" (número 1) → onRespond é chamado com
    // { value: "React", cancelled: false, fromAlternatives: true }.
    // Esse response é então alimentado em handleAskUser (como o agente faria)
    // e o resultado formatado deve conter "[RESPOSTA DO USUÁRIO] React".
    const onRespond = vi.fn();
    const { stdin } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Usuário pressiona "1"
    stdin.write("1");
    await delay(10);

    // onRespond foi chamado com a resposta certa
    expect(onRespond).toHaveBeenCalledTimes(1);
    const response: AskUserResponse = onRespond.mock.calls[0][0];
    expect(response.value).toBe("React");
    expect(response.cancelled).toBe(false);
    expect(response.fromAlternatives).toBe(true);

    // Integração: alimenta handleAskUser com essa resposta e verifica o formato
    const mockCb = vi.fn().mockResolvedValue(response);
    setAskUserCallback(mockCb, true);
    const result = await handleAskUser({
      pergunta: "Qual framework?",
      alternativas: ["React", "Vue", "Svelte"],
    });
    expect(result.resultStr).toContain("[RESPOSTA DO USUÁRIO]");
    expect(result.resultStr).toContain("React");
    // Não tem o sufixo "(texto livre)" porque veio de alternativa
    expect(result.resultStr).not.toContain("texto livre");
  });

  it("usuário cancela (Esc) → [USUÁRIO CANCELOU A PERGUNTA]", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    // Delay maior antes de Esc pra garantir que o listener registrou
    await delay(30);
    stdin.write("\u001B"); // Esc
    await delay(50);

    // onRespond chamado com cancelled: true
    expect(onRespond).toHaveBeenCalledTimes(1);
    const response: AskUserResponse = onRespond.mock.calls[0][0];
    expect(response.cancelled).toBe(true);
    expect(response.fromAlternatives).toBe(false);

    // Integração: handleAskUser formata como cancelamento
    const mockCb = vi.fn().mockResolvedValue(response);
    setAskUserCallback(mockCb, true);
    const result = await handleAskUser({
      pergunta: "Confirma?",
      alternativas: ["Sim", "Não"],
    });
    expect(result.resultStr).toContain("[USUÁRIO CANCELOU A PERGUNTA]");
  });

  it("usuário digita resposta livre → [RESPOSTA DO USUÁRIO (texto livre)]", async () => {
    const onRespond = vi.fn();
    const { stdin } = render(
      <QuestionPrompt question={makeQuestion()} onRespond={onRespond} />,
    );
    await delay(10);

    // Tab → modo type
    stdin.write("\t");
    await delay(10);
    // Digita "minha resposta custom"
    stdin.write("minha resposta custom");
    await delay(10);
    // Enter envia
    stdin.write("\r");
    await delay(10);

    expect(onRespond).toHaveBeenCalledTimes(1);
    const response: AskUserResponse = onRespond.mock.calls[0][0];
    expect(response.value).toBe("minha resposta custom");
    expect(response.cancelled).toBe(false);
    expect(response.fromAlternatives).toBe(false); // texto livre!

    // Integração: handleAskUser formata com sufixo "(texto livre)"
    const mockCb = vi.fn().mockResolvedValue(response);
    setAskUserCallback(mockCb, true);
    const result = await handleAskUser({
      pergunta: "Qual seu nome?",
      alternativas: ["Anônimo", "Não dizer"],
    });
    expect(result.resultStr).toContain("[RESPOSTA DO USUÁRIO (texto livre)]");
    expect(result.resultStr).toContain("minha resposta custom");
  });

  it("múltiplas perguntas em sequência → cada uma renderiza e resolve", async () => {
    // Cenário: IA faz 3 perguntas em sequência. Cada uma é renderizada,
    // o usuário responde, e a resposta formatada é alimentada em handleAskUser.
    const respostasEsperadas = ["React", "Vue", "Svelte"];

    for (let i = 0; i < 3; i++) {
      const onRespond = vi.fn();
      const { stdin, unmount } = render(
        <QuestionPrompt question={makeQuestion({ pergunta: `Pergunta ${i + 1}?` })} onRespond={onRespond} />,
      );
      await delay(10);

      // Escolhe a alternativa (i+1)
      stdin.write(String(i + 1));
      await delay(10);

      expect(onRespond).toHaveBeenCalledTimes(1);
      const response: AskUserResponse = onRespond.mock.calls[0][0];
      expect(response.value).toBe(respostasEsperadas[i]);
      expect(response.cancelled).toBe(false);

      // Integração: handleAskUser retorna a resposta formatada
      const mockCb = vi.fn().mockResolvedValue(response);
      setAskUserCallback(mockCb, true);
      const result = await handleAskUser({
        pergunta: `Pergunta ${i + 1}?`,
        alternativas: ["React", "Vue", "Svelte"],
      });
      expect(result.resultStr).toContain(respostasEsperadas[i]);

      unmount();
    }
  });
});

// --- Testes: ConfiguratorChat + toolConfigurator integration ----------------

describe("E2E: ConfiguratorChat + toolConfigurator integration", () => {
  it("digitar tool name + Enter → configureTool chamado com args corretos", async () => {
    const { stdin } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);

    stdin.write("darklua");
    await delay(10);
    stdin.write("\r"); // Enter
    await delay(30);

    // configureTool foi chamado com (toolName="darklua", modeName="roblox", ...)
    expect(configureToolMock).toHaveBeenCalledTimes(1);
    const [toolName, modeName] = configureToolMock.mock.calls[0];
    expect(toolName).toBe("darklua");
    expect(modeName).toBe("roblox");
  });

  it("configureTool success → mostra mensagem de sucesso", async () => {
    const { stdin, lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);

    stdin.write("darklua");
    await delay(10);
    stdin.write("\r");
    await delay(30);

    // Antes de resolver: running ("Trabalhando...")
    expect(stripAnsi(lastFrame() ?? "")).toContain("Trabalhando");

    // Resolve a Promise com success=true
    expect(resolveRef.current).not.toBeNull();
    resolveRef.current!({ success: true, message: "Tool configurada com sucesso!" });
    await delay(50);

    const out = stripAnsi(lastFrame() ?? "");
    // Mensagem de sucesso aparece
    expect(out).toContain("Tool configurada com sucesso!");
    // Estado "Concluído" aparece
    expect(out).toContain("Concluído");
  });

  it("configureTool failure → mostra mensagem de erro", async () => {
    const { stdin, lastFrame } = render(<ConfiguratorChat onClose={vi.fn()} />);
    await delay(30);

    stdin.write("broken-tool");
    await delay(10);
    stdin.write("\r");
    await delay(30);

    // Resolve com success=false e mensagem de erro
    expect(resolveRef.current).not.toBeNull();
    resolveRef.current!({ success: false, message: "Erro: tool não encontrada" });
    await delay(50);

    const out = stripAnsi(lastFrame() ?? "");
    // Mensagem de erro aparece
    expect(out).toContain("Erro: tool não encontrada");
    // Estado "Concluído" aparece (mesmo com falha — finished=true após resolver)
    expect(out).toContain("Concluído");
  });

  it("Esc fecha configurador → estado limpo (onClose chamado)", async () => {
    const onClose = vi.fn();
    const { stdin } = render(<ConfiguratorChat onClose={onClose} />);
    await delay(30);

    stdin.write("\u001B"); // Esc
    await delay(50);

    expect(onClose).toHaveBeenCalledTimes(1);
    // configureTool NÃO foi chamado (Esc antes de digitar)
    expect(configureToolMock).not.toHaveBeenCalled();
  });
});

// --- Testes: ExtensionHub + Organize + Configure integration ----------------

describe("E2E: ExtensionHub + Organize + Configure integration", () => {
  it("tecla O organiza inbox → resultado aparece como system message", async () => {
    // Setamos HOME pra um tmpDir vazio (sem inbox) → organizeInbox retorna erro
    const onMessage = vi.fn();
    const { stdin } = render(<ExtensionHub onClose={vi.fn()} onMessage={onMessage} />);
    await delay(30);

    stdin.write("o");
    await delay(50);

    // onMessage foi chamado com o resultado formatado
    expect(onMessage).toHaveBeenCalledTimes(1);
    const summary: string = onMessage.mock.calls[0][0];
    // Sem inbox → mensagem de erro ou "Inbox vazio"
    // (organizeInbox("roblox") em HOME vazio retorna erro "Inbox directory does not exist")
    expect(typeof summary).toBe("string");
    expect(summary.length).toBeGreaterThan(0);
  });

  it("tecla C abre configurador → hub fecha, configurador abre (via onConfigure)", async () => {
    const onConfigure = vi.fn();
    const { stdin } = render(<ExtensionHub onClose={vi.fn()} onConfigure={onConfigure} />);
    await delay(30);

    stdin.write("c");
    await delay(30);

    // onConfigure foi chamado com o toolName derivado do item selecionado
    expect(onConfigure).toHaveBeenCalledTimes(1);
    const toolName = onConfigure.mock.calls[0][0];
    // O item selecionado é "tool:rojo_build" → toolName = "rojo"
    // (código: item.id.replace(/^tool:/, "").replace(/_\w+$/, ""))
    expect(toolName).toBe("rojo");
  });

  it("configurador fecha → hub pode reabrir (estado limpo)", async () => {
    // Cenário: usuário abre hub, pressiona C, hub chama onConfigure.
    // O App.tsx fecha o hub e abre o configurador. Quando o configurador
    // fecha (Esc), o App.tsx pode reabrir o hub.
    // Aqui testamos que o onClose do hub pode ser chamado e o configurador
    // pode ser renderizado depois (estado limpo).
    const hubOnClose = vi.fn();
    const hubOnConfigure = vi.fn();
    const { stdin: hubStdin, unmount: unmountHub } = render(
      <ExtensionHub onClose={hubOnClose} onConfigure={hubOnConfigure} />,
    );
    await delay(30);

    // Pressiona C → onConfigure chamado
    hubStdin.write("c");
    await delay(30);
    expect(hubOnConfigure).toHaveBeenCalledTimes(1);

    // Fecha o hub (simula o App.tsx fechando após onConfigure)
    unmountHub();

    // Agora renderiza o ConfiguratorChat (simula App.tsx abrindo)
    const cfgOnClose = vi.fn();
    const { stdin: cfgStdin } = render(<ConfiguratorChat onClose={cfgOnClose} toolName="rojo" />);
    await delay(50);

    // ConfiguratorChat está aberto e funcionando
    // (com toolName="rojo", ele dispara configureTool automaticamente)
    expect(configureToolMock).toHaveBeenCalledWith(
      "rojo",
      "roblox",
      undefined,
      expect.any(Function),
    );

    // Fecha o configurador via Esc
    cfgStdin.write("\u001B");
    await delay(50);
    expect(cfgOnClose).toHaveBeenCalledTimes(1);
  });

  it("tool sem manifest → C abre configurador com tool name correto", async () => {
    // Configura um item tool sem manifest (instalado mas sem manifest)
    mockedGetAllExtensions.mockReturnValueOnce([
      { id: "tool:darklua_process", name: "darklua_process", category: "tool",
        enabled: true, installed: true, triggerMode: "on_task", description: "Darklua" },
    ]);

    const onConfigure = vi.fn();
    const { stdin } = render(<ExtensionHub onClose={vi.fn()} onConfigure={onConfigure} />);
    await delay(30);

    stdin.write("c");
    await delay(30);

    expect(onConfigure).toHaveBeenCalledTimes(1);
    const toolName = onConfigure.mock.calls[0][0];
    // "tool:darklua_process" → "darklua"
    expect(toolName).toBe("darklua");
  });

  it("organize + configure em sequência → ambos funcionam", async () => {
    // Cenário: usuário pressiona O (organize) e depois C (configure).
    // Ambos devem funcionar sem interferência.
    const onMessage = vi.fn();
    const onConfigure = vi.fn();
    const { stdin, lastFrame } = render(
      <ExtensionHub onClose={vi.fn()} onMessage={onMessage} onConfigure={onConfigure} />,
    );
    await delay(30);

    // Pressiona O
    stdin.write("o");
    await delay(30);
    expect(onMessage).toHaveBeenCalledTimes(1);

    // Pressiona C
    stdin.write("c");
    await delay(30);
    expect(onConfigure).toHaveBeenCalledTimes(1);

    // Hub continua aberto e funcional (não crashou)
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("EXTENSION HUB");
  });

  it("tecla C na tab Modes → NÃO abre configurador (só em extensions tab)", async () => {
    // Cenário: na tab Modes, pressionar C não deve chamar onConfigure
    // (código: `if (!isModesTab && onConfigure) { ... }`)
    const onConfigure = vi.fn();
    const { stdin } = render(<ExtensionHub onClose={vi.fn()} onConfigure={onConfigure} />);
    await delay(30);

    // Tab 6x pra chegar na tab Modes (All → Skills → Tools → MCPs → Plugins → Features → Modes)
    for (let i = 0; i < 6; i++) {
      stdin.write("\t");
      await delay(30);
    }

    // Pressiona C
    stdin.write("c");
    await delay(30);

    // onConfigure NÃO foi chamado (estamos na tab Modes)
    expect(onConfigure).not.toHaveBeenCalled();
  });
});
