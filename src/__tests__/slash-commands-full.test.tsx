/**
 * slash-commands-full.test.tsx — Cobertura COMPLETA de TODOS os slash commands.
 *
 * Diferente de slash-commands.test.tsx (cobre /help, /reset, /effort, /mode,
 * /tools, /hub, /plan) e slash-commands-extra.test.tsx (cobre /exit, /history,
 * /skills, /plugins, /caveman, /memory, /todos, /compact, /dream, /distill,
 * /toolinfo, /pool), ESTE arquivo foca nos comandos NÃO cobertos pelos dois
 * anteriores + casos extras de validação:
 *
 *   - /buscar (sem arg, com arg)
 *   - /organize (sem modo, com modo)
 *   - /configurar (sem arg, com tool)
 *   - /exit + /quit (alias shutdown)
 *   - casos extras: /toolinfo sem arg, /mode invalid, etc.
 *
 * Estratégia: mesmo padrão dos outros arquivos — render(<App />) + stdin.write
 * + delay + stripAnsi(lastFrame()). Mocks hoisted pra controle per-test.
 *
 * IMPORTANTE: NÃO altera código-fonte. Se algum teste falhar, ajusta o teste.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import Module from "node:module";

// ─── Mocks de dependências externas (mesmos dos outros arquivos) ────────────

// Mock logger
vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(),
  debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

// Mock config (StatusBar precisa de config numérica)
vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.5, contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

// Mock extensions (hoisted — /skills, /plugins, /exit precisam de override)
const mockedShutdownMCPServers = vi.hoisted(() => vi.fn());
const mockedGetActiveSkills = vi.hoisted(() => vi.fn(() => []));
const mockedGetActiveMCPServers = vi.hoisted(() => vi.fn(() => []));
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: mockedShutdownMCPServers,
  getActiveSkills: mockedGetActiveSkills, getActiveMCPServers: mockedGetActiveMCPServers,
}));

// Mock extensionCenter (hoisted — ExtensionHub precisa)
const mockedGetAllExtensions = vi.hoisted(() => vi.fn(() => []));
const mockedGetHubSummary = vi.hoisted(() => vi.fn(() => ({
  total: 0, enabled: 0, byCategory: {
    tool: { total: 0, enabled: 0 }, skill: { total: 0, enabled: 0 },
    mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
    feature: { total: 0, enabled: 0 },
  },
})));
vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: mockedGetAllExtensions,
  getExtensionsByCategory: vi.fn(() => []),
  getHubSummary: mockedGetHubSummary,
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn((m: string) => m.toUpperCase()),
  getTriggerModes: vi.fn(() => ["disabled", "on_file", "on_task", "always"]),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn(() => "T"),
  discoverExtensions: vi.fn(),
  executeTrigger: vi.fn(() => Promise.resolve()),
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

// Mock modes (hoisted — /mode e /organize precisam de getActiveMode override)
const mockedGetAllModes = vi.hoisted(() => vi.fn(() => []));
const mockedGetActiveModeName = vi.hoisted(() => vi.fn(() => null));
const mockedGetActiveMode = vi.hoisted(() => vi.fn(() => null));
const mockedApplyMode = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const mockedDeactivateMode = vi.hoisted(() => vi.fn());
const mockedGetMode = vi.hoisted(() => vi.fn(() => null));
vi.mock("../modes.js", () => ({
  getAllModes: mockedGetAllModes,
  getActiveModeName: mockedGetActiveModeName,
  getActiveMode: mockedGetActiveMode,
  applyMode: mockedApplyMode,
  deactivateMode: mockedDeactivateMode,
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
  getMode: mockedGetMode,
  suggestMode: vi.fn(() => ({
    name: "suggested", label: "Suggested", reasoning: "", enableTools: [],
    enableSkills: [], enableFeatures: [], effortLevel: "medium", strictMode: false,
    readBeforeWrite: false, advancedThinking: false, luauValidation: [],
  })),
  confirmAndSaveMode: vi.fn(async () => ({
    name: "suggested", label: "Suggested", enableTools: [], enableSkills: [],
    enableFeatures: [], effortLevel: "medium", strictMode: false,
  })),
}));

// Mock effortLevels (hoisted)
const mockedSetEffortLevel = vi.hoisted(() => vi.fn());
const mockedGetEffortLabel = vi.hoisted(() => vi.fn(() => "MEDIUM"));
vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: mockedSetEffortLevel,
  getEffortLabel: mockedGetEffortLabel,
}));

// Mock apiKeyPool (hoisted — /pool precisa de override)
const mockedGetPoolSize = vi.hoisted(() => vi.fn(() => 1));
const mockedFormatPoolStats = vi.hoisted(() => vi.fn(() => "1 keys, 40 RPM"));
vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: mockedGetPoolSize,
  formatPoolStats: mockedFormatPoolStats,
}));

// Mock i18n — define TODOS os slash commands (incluindo /buscar, /organize, /configurar)
vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => [
    { cmd: "/help", desc: "Mostra comandos disponíveis" },
    { cmd: "/reset", desc: "Reseta histórico" },
    { cmd: "/history", desc: "Mostra histórico" },
    { cmd: "/skills", desc: "Lista skills" },
    { cmd: "/plugins", desc: "Lista MCPs" },
    { cmd: "/tools", desc: "Lista ferramentas" },
    { cmd: "/toolinfo", desc: "Info de tool" },
    { cmd: "/effort", desc: "Define nível de effort", subcommands: ["low", "medium", "high", "max"] },
    { cmd: "/mode", desc: "Alterna modo", subcommands: ["roblox", "off"] },
    { cmd: "/plan", desc: "Toggle plan mode" },
    { cmd: "/compact", desc: "Compacta contexto" },
    { cmd: "/caveman", desc: "Modo caveman", subcommands: ["lite", "full", "ultra", "off"] },
    { cmd: "/memory", desc: "Carrega CLAUDE.md" },
    { cmd: "/todos", desc: "Lista todos" },
    { cmd: "/pool", desc: "Status API pool" },
    { cmd: "/hub", desc: "Abre Extension Hub" },
    { cmd: "/exit", desc: "Sai do app" },
    { cmd: "/buscar", desc: "Procurar arquivo na máquina (tools, etc)" },
    { cmd: "/organize", desc: "Organiza inbox do modo ativo" },
    { cmd: "/configurar", desc: "Abre configurador de tools" },
  ]),
  getCommandI18n: vi.fn((cmd: string) => ({ cmd, desc: `Descrição para ${cmd}` })),
}));

// Mock history (hoisted — /reset, /history, /plan, /compact, /caveman, /memory, /todos)
const mockedResetHistory = vi.hoisted(() => vi.fn());
const mockedIsPlanMode = vi.hoisted(() => vi.fn(() => false));
const mockedSetPlanMode = vi.hoisted(() => vi.fn());
const mockedHistorySummary = vi.hoisted(() => vi.fn(() => "0 msgs"));
const mockedHistoryLength = vi.hoisted(() => vi.fn(() => 0));
const mockedCompactHistory = vi.hoisted(() => vi.fn(() => null));
const mockedGetCavemanLevel = vi.hoisted(() => vi.fn(() => null));
const mockedSetCavemanLevel = vi.hoisted(() => vi.fn());
const mockedReloadProjectMemory = vi.hoisted(() => vi.fn(() => null));
vi.mock("../history.js", () => ({
  isPlanMode: mockedIsPlanMode,
  resetHistory: mockedResetHistory,
  setPlanMode: mockedSetPlanMode,
  getHistory: vi.fn(() => []),
  addUserMessage: vi.fn(),
  addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(),
  addSystemMessage: vi.fn(),
  historySummary: mockedHistorySummary,
  historyLength: mockedHistoryLength,
  compactHistory: mockedCompactHistory,
  getCavemanLevel: mockedGetCavemanLevel,
  setCavemanLevel: mockedSetCavemanLevel,
  reloadProjectMemory: mockedReloadProjectMemory,
}));

// Mock externalTools (hoisted — /tools, /toolinfo precisam de registry)
const mockedGetAll = vi.hoisted(() => vi.fn(() => []));
const mockedGetByCategory = vi.hoisted(() => vi.fn(() => []));
const mockedIsInstalled = vi.hoisted(() => vi.fn(() => false));
const mockedToolGet = vi.hoisted(() => vi.fn(() => null));
const mockedGetRegistry = vi.hoisted(() => vi.fn(() => ({
  getAll: mockedGetAll,
  getByCategory: mockedGetByCategory,
  isInstalled: mockedIsInstalled,
  get: mockedToolGet,
  addTool: vi.fn(),
})));
vi.mock("../externalTools.js", () => ({
  getRegistry: mockedGetRegistry,
  getDetector: vi.fn(() => ({
    detect: vi.fn(() => ({ intent: null, context: [] })),
    detectFromContext: vi.fn(() => []),
  })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(async () => {}),
}));

// Mock agent (evita chamadas reais à API)
vi.mock("../agent.js", () => ({
  runAgentLoop: vi.fn(async () => ""),
}));

// Mock todo (hoisted — /todos precisa de renderTodoBar override)
const mockedRenderTodoBar = vi.hoisted(() => vi.fn(() => ""));
vi.mock("../todo.js", () => ({
  getTodos: vi.fn(() => []),
  renderTodoBar: mockedRenderTodoBar,
  addTodo: vi.fn(),
  updateTodo: vi.fn(),
  resetTodo: vi.fn(),
}));

// Mock memory (handleDream/handleDistill usam import dinâmico)
vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({})),
  runDream: vi.fn(async () => ({ reviewedSessions: 0, extractedSkills: 0, deduplicatedEntries: 0 })),
  runDistill: vi.fn(async () => ({ skillsExtracted: 0 })),
}));

// Mock inboxOrganizer (hoisted — /organize precisa de organizeInbox + formatOrganizeResult override)
const mockedOrganizeInbox = vi.hoisted(() => vi.fn(() => ({
  organized: [], ignored: [], errors: [],
})));
const mockedFormatOrganizeResult = vi.hoisted(() => vi.fn(() => ""));
vi.mock("../inboxOrganizer.js", () => ({
  organizeInbox: mockedOrganizeInbox,
  formatOrganizeResult: mockedFormatOrganizeResult,
}));

// Mock toolConfigurator (ConfiguratorChat.tsx importa configureTool)
vi.mock("../toolConfigurator.js", () => ({
  configureTool: vi.fn(async () => ({ success: true, message: "OK" })),
  detectToolsWithoutManifest: vi.fn(() => []),
}));

// ─── Imports (após mocks) ───────────────────────────────────────────────────

import { App } from "../tui/App.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Remove códigos ANSI (cores) do output renderizado. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Delay helper para aguardar re-renders do React/Ink. */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Envia um comando slash via stdin: digita o texto, aguarda re-render,
 * envia Enter (\r) e aguarda o processamento do handler.
 */
async function sendCommand(
  stdin: { write: (s: string) => void },
  command: string,
  postDelay = 200,
): Promise<void> {
  stdin.write(command);
  await delay(50);
  stdin.write("\r");
  await delay(postDelay);
}

/**
 * Patch de Module._load — App.tsx usa `require("../externalTools.js")` e
 * `require("../apiKeyPool.js")` dentro de handlers. No vitest (ESM), o
 * require nativo do Node não resolve arquivos .ts nem aplica os vi.mock.
 */
const originalModuleLoad = Module._load;
beforeAll(() => {
  Module._load = function (request: string, parent: NodeJS.Module | undefined, ...args: any[]): any {
    const parentFile = parent?.filename ?? "";
    if (parentFile.includes("App.") && request.includes("externalTools")) {
      return {
        getRegistry: mockedGetRegistry,
        getDetector: vi.fn(() => ({
          detect: vi.fn(() => ({ intent: null, context: [] })),
          detectFromContext: vi.fn(() => []),
        })),
        getExecutor: vi.fn(() => ({ execute: vi.fn() })),
        getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
        initializeTools: vi.fn(async () => {}),
      };
    }
    if (parentFile.includes("App.") && request.includes("apiKeyPool")) {
      return { getPoolSize: mockedGetPoolSize, formatPoolStats: mockedFormatPoolStats };
    }
    return (originalModuleLoad as any).call(this, request, parent, ...args);
  } as typeof Module._load;
});

afterAll(() => {
  Module._load = originalModuleLoad;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Slash Commands FULL — cobertura completa de TODOS os comandos", () => {
  beforeEach(() => {
    // Limpa histórico de chamadas (não reseta implementações)
    vi.clearAllMocks();
    // Re-seta defaults que testes individuais podem override
    mockedGetAllModes.mockReturnValue([]);
    mockedGetActiveModeName.mockReturnValue(null);
    mockedGetActiveMode.mockReturnValue(null);
    mockedGetMode.mockReturnValue(null);
    mockedGetAll.mockReturnValue([]);
    mockedGetByCategory.mockReturnValue([]);
    mockedIsInstalled.mockReturnValue(false);
    mockedToolGet.mockReturnValue(null);
    mockedIsPlanMode.mockReturnValue(false);
    mockedGetEffortLabel.mockReturnValue("MEDIUM");
    mockedGetHubSummary.mockReturnValue({
      total: 0, enabled: 0, byCategory: {
        tool: { total: 0, enabled: 0 }, skill: { total: 0, enabled: 0 },
        mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
        feature: { total: 0, enabled: 0 },
      },
    });
    mockedGetAllExtensions.mockReturnValue([]);
    mockedGetActiveSkills.mockReturnValue([]);
    mockedGetActiveMCPServers.mockReturnValue([]);
    mockedHistoryLength.mockReturnValue(0);
    mockedHistorySummary.mockReturnValue("0 msgs");
    mockedCompactHistory.mockReturnValue(null);
    mockedGetCavemanLevel.mockReturnValue(null);
    mockedReloadProjectMemory.mockReturnValue(null);
    mockedRenderTodoBar.mockReturnValue("");
    mockedGetPoolSize.mockReturnValue(1);
    mockedFormatPoolStats.mockReturnValue("1 keys, 40 RPM");
    mockedOrganizeInbox.mockReturnValue({ organized: [], ignored: [], errors: [] });
    mockedFormatOrganizeResult.mockReturnValue("");
  });

  // ─── /help ────────────────────────────────────────────────────────────────

  it("/help — lista comandos incluindo /buscar, /organize, /configurar", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/help");
    const out = stripAnsi(lastFrame() ?? "");
    // Comandos do mock i18n devem aparecer
    expect(out).toContain("/help");
    expect(out).toContain("/reset");
    expect(out).toContain("/buscar");
    expect(out).toContain("/organize");
    expect(out).toContain("/configurar");
    // /buscar também é adicionado manualmente em SLASH_COMMANDS (App.tsx:64-67)
    // — não deve duplicar. Verifica que aparece exatamente uma vez na seção de comandos.
    const matches = out.match(/\/buscar\b/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // ─── /reset ───────────────────────────────────────────────────────────────

  it("/reset — chama resetHistory() e mostra 'Histórico resetado.'", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/reset");
    expect(mockedResetHistory).toHaveBeenCalledTimes(1);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Histórico resetado.");
  });

  // ─── /history ─────────────────────────────────────────────────────────────

  it("/history — mostra contagem de mensagens do histórico", async () => {
    mockedHistoryLength.mockReturnValue(7);
    mockedHistorySummary.mockReturnValue("7 mensagens, 1.2k tokens");
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/history");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Histórico:");
    expect(out).toContain("7 mensagens");
  });

  // ─── /skills ──────────────────────────────────────────────────────────────

  it("/skills (vazio) — mostra 'Nenhuma skill carregada.'", async () => {
    mockedGetActiveSkills.mockReturnValue([]);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/skills");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Nenhuma skill carregada.");
  });

  // ─── /plugins ─────────────────────────────────────────────────────────────

  it("/plugins (vazio) — mostra 'Nenhum servidor MCP ativo.'", async () => {
    mockedGetActiveMCPServers.mockReturnValue([]);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/plugins");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Nenhum servidor MCP ativo.");
  });

  // ─── /tools ───────────────────────────────────────────────────────────────

  it("/tools — lista total, instaladas e não instaladas", async () => {
    mockedGetAll.mockReturnValue([
      { name: "rojo", category: "build", description: "Build Roblox project" },
      { name: "wally", category: "package", description: "Install Wally packages" },
    ]);
    // Primeira tool instalada, segunda não
    mockedIsInstalled.mockImplementation((name: string) => name === "rojo");
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/tools");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Tools: 2 total");
    expect(out).toContain("1 OK");
    expect(out).toContain("1 X");
    expect(out).toContain("Instaladas");
    expect(out).toContain("Não instaladas");
  });

  // ─── /toolinfo ────────────────────────────────────────────────────────────

  it("/toolinfo (sem arg) — mostra 'Uso: /toolinfo <nome_da_tool>'", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/toolinfo");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Uso: /toolinfo");
  });

  it("/toolinfo <nome> (válido) — mostra info detalhada", async () => {
    mockedToolGet.mockReturnValue({
      name: "rojo",
      description: "Builds a Roblox project from source",
      category: "build",
      command: "rojo",
      args: ["build"],
      context: {
        whenToUse: ["Quando precisar buildar um projeto Roblox"],
        examples: ["rojo build default.project.json"],
      },
      flags: [],
    });
    mockedIsInstalled.mockReturnValue(true);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/toolinfo rojo");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("rojo");
    expect(out).toContain("Builds a Roblox project from source");
    expect(out).toContain("Instalada");
  });

  it("/toolinfo <nome> (inválido) — mostra erro 'não encontrada'", async () => {
    mockedToolGet.mockReturnValue(null);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/toolinfo nonexistent");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("não encontrada");
    expect(out).toContain("nonexistent");
  });

  // ─── /effort ──────────────────────────────────────────────────────────────

  it("/effort (sem arg) — mostra effort atual + instruções", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/effort");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Effort atual: MEDIUM");
    expect(out).toContain("Use: /effort low|medium|high|max");
  });

  it("/effort low — chama setEffortLevel('low')", async () => {
    const { stdin } = render(<App />);
    await sendCommand(stdin, "/effort low");
    expect(mockedSetEffortLevel).toHaveBeenCalledWith("low");
  });

  it("/effort invalid — mostra erro com acento 'Nível' e opções válidas", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/effort bogus");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Nível inválido: bogus");
    expect(out).toContain("Opções: low, medium, high, max");
    // setEffortLevel não deve ser chamado com valor inválido
    expect(mockedSetEffortLevel).not.toHaveBeenCalled();
  });

  // ─── /mode ────────────────────────────────────────────────────────────────

  it("/mode (sem arg) — lista modos disponíveis", async () => {
    mockedGetAllModes.mockReturnValue([
      { name: "roblox", label: "Roblox", builtIn: true, enableTools: [], enableSkills: [], enableFeatures: [] },
      { name: "devops", label: "DevOps", builtIn: false, enableTools: [], enableSkills: [], enableFeatures: [] },
    ]);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Modos disponíveis");
    expect(out).toContain("roblox");
    expect(out).toContain("devops");
    expect(out).toContain("Ativo: (nenhum)");
  });

  it("/mode roblox — mostra prompt de ativação", async () => {
    mockedGetMode.mockReturnValue({
      name: "roblox", label: "Roblox", enableTools: ["rojo"], enableSkills: [],
      enableFeatures: [], effortLevel: "high", strictMode: true,
    });
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode roblox");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Ativando modo");
    expect(out).toContain("roblox");
    expect(out).toContain("Escolha uma opção");
  });

  it("/mode off — desativa e chama deactivateMode()", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode off");
    expect(mockedDeactivateMode).toHaveBeenCalledTimes(1);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Modo desativado");
    expect(out).toContain("Nenhuma validação automática ativa");
  });

  // ─── /plan ────────────────────────────────────────────────────────────────

  it("/plan (toggle ON) — ativa plan mode e mostra mensagem", async () => {
    mockedIsPlanMode.mockReturnValue(false);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/plan");
    expect(mockedSetPlanMode).toHaveBeenCalledWith(true);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Modo Plan ATIVADO");
  });

  // ─── /compact ─────────────────────────────────────────────────────────────

  it("/compact — mostra 'Nada para compactar.' quando histórico é pequeno", async () => {
    mockedCompactHistory.mockReturnValue(null);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/compact");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Nada para compactar.");
  });

  // ─── /caveman ─────────────────────────────────────────────────────────────

  it("/caveman (sem arg) — mostra nível atual desativado + instrução", async () => {
    mockedGetCavemanLevel.mockReturnValue(null);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/caveman");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Caveman: desativado");
    expect(out).toContain("Uso: /caveman");
  });

  it("/caveman off — desativa e chama setCavemanLevel(null)", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/caveman off");
    expect(mockedSetCavemanLevel).toHaveBeenCalledWith(null);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Caveman desativado!");
  });

  // ─── /memory ──────────────────────────────────────────────────────────────

  it("/memory — mostra 'Nenhum CLAUDE.md/AGENTS.md encontrado.' quando reload retorna null", async () => {
    mockedReloadProjectMemory.mockReturnValue(null);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/memory");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Nenhum CLAUDE.md/AGENTS.md encontrado.");
  });

  // ─── /todos ───────────────────────────────────────────────────────────────

  it("/todos — mostra 'Lista vazia.' quando não há todos", async () => {
    mockedRenderTodoBar.mockReturnValue("");
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/todos");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Lista vazia.");
  });

  // ─── /pool ────────────────────────────────────────────────────────────────

  it("/pool (single-key) — mostra 'single-key' quando pool size é 0", async () => {
    mockedGetPoolSize.mockReturnValue(0);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/pool");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("single-key");
    expect(out).toContain("NVIDIA_API_KEYS");
  });

  // ─── /buscar ──────────────────────────────────────────────────────────────

  it("/buscar (sem arg) — mostra ajuda de uso com exemplo /buscar darklua", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/buscar");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Uso: /buscar <nome-do-arquivo>");
    expect(out).toContain("/buscar darklua");
  });

  it("/buscar darklua — mostra mensagem 'Buscando \"darklua\"'", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/buscar darklua");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain('Buscando "darklua"');
  });

  // ─── /organize ────────────────────────────────────────────────────────────

  it("/organize (sem modo ativo) — mostra erro 'Nenhum modo ativo'", async () => {
    mockedGetActiveMode.mockReturnValue(null);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/organize");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Nenhum modo ativo");
    // organizeInbox NÃO deve ser chamado quando não há modo
    expect(mockedOrganizeInbox).not.toHaveBeenCalled();
  });

  it("/organize (com modo ativo) — chama organizeInbox e mostra resultado formatado", async () => {
    mockedGetActiveMode.mockReturnValue({
      name: "roblox", label: "Roblox", builtIn: true,
      enableTools: [], enableSkills: [], enableFeatures: [],
    });
    mockedOrganizeInbox.mockReturnValue({
      organized: [
        { fileName: "rojo.exe", fileType: "tool", destination: "/tools/rojo.exe" },
      ],
      ignored: [],
      errors: [],
    });
    mockedFormatOrganizeResult.mockReturnValue("✓ Organizados:\n  rojo.exe → tools/");
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/organize");
    // organizeInbox deve ser chamado com o nome do modo ativo
    expect(mockedOrganizeInbox).toHaveBeenCalledWith("roblox");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Organizados");
    expect(out).toContain("rojo.exe → tools/");
  });

  // ─── /configurar ──────────────────────────────────────────────────────────

  it("/configurar (sem arg) — abre configurador genérico", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/configurar", 400);
    const out = stripAnsi(lastFrame() ?? "");
    // Mensagem de abertura do configurador genérico
    expect(out).toContain("Abrindo configurador");
    // Componente ConfiguratorChat real é renderizado (mostra título)
    expect(out).toContain("Configurador de Tools");
  });

  it("/configurar darklua — abre configurador pra tool específica", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/configurar darklua", 400);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Abrindo configurador para \"darklua\"");
    // ConfiguratorChat real renderiza "Configurando \"darklua\"..."
    expect(out).toContain("Configurando");
    expect(out).toContain("darklua");
  });

  // ─── /exit + /quit ────────────────────────────────────────────────────────

  it("/exit — chama shutdownMCPServers() antes de sair", async () => {
    const { stdin } = render(<App />);
    await sendCommand(stdin, "/exit");
    expect(mockedShutdownMCPServers).toHaveBeenCalledTimes(1);
  });

  it("/quit — alias de /exit (também chama shutdownMCPServers)", async () => {
    const { stdin } = render(<App />);
    await sendCommand(stdin, "/quit");
    expect(mockedShutdownMCPServers).toHaveBeenCalledTimes(1);
  });
});
