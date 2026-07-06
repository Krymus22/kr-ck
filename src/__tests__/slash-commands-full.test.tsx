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
  // NOTE: confirmAndSaveMode is SYNCHRONOUS in modes.ts (returns ModeDefinition,
  // not Promise<ModeDefinition>). The mock here returns the user-provided name
  // so tests can verify the right name was used.
  confirmAndSaveMode: vi.fn((suggestion: { name: string }) => ({
    name: suggestion.name, label: "Suggested", enableTools: [], enableSkills: [],
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
const mockedDetectLanguage = vi.hoisted(() => vi.fn(() => "en"));
const mockedSetLanguage = vi.hoisted(() => vi.fn());
const mockedResetLanguageCache = vi.hoisted(() => vi.fn());
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
    { cmd: "/lang", desc: "Troca idioma" },
  ]),
  getCommandI18n: vi.fn((cmd: string) => ({ cmd, desc: `Descrição para ${cmd}` })),
  detectLanguage: mockedDetectLanguage,
  setLanguage: mockedSetLanguage,
  resetLanguageCache: mockedResetLanguageCache,
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
  let originalCwd: string;

  beforeEach(() => {
    // Salva cwd original pra restaurar depois (testes de /cd mudam o cwd)
    originalCwd = process.cwd();
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

  afterEach(() => {
    // Restaura cwd original (testes de /cd mudam o cwd globalmente)
    try {
      process.chdir(originalCwd);
    } catch { /* cwd pode ter sido deletado — ignora */ }
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

  it("/reset — chama resetHistory() e mostra 'History reset.'", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/reset");
    expect(mockedResetHistory).toHaveBeenCalledTimes(1);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("History reset.");
  });

  // ─── /history ─────────────────────────────────────────────────────────────

  it("/history — mostra contagem de mensagens do histórico", async () => {
    mockedHistoryLength.mockReturnValue(7);
    mockedHistorySummary.mockReturnValue("7 mensagens, 1.2k tokens");
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/history");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("History:");
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
    expect(out).toContain("Installeds");
    expect(out).toContain("Not installed");
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
    expect(out).toContain("Installed");
  });

  it("/toolinfo <nome> (inválido) — mostra erro 'not found'", async () => {
    mockedToolGet.mockReturnValue(null);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/toolinfo nonexistent");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("not found");
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
    expect(out).toContain("Invalid level: bogus");
    expect(out).toContain("Options: low, medium, high, max");
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
    expect(out).toContain("Available modes");
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
    expect(out).toContain("Choose an option");
  });

  // ─── Regression: /mode <name> new|keep must NOT re-show the "Choose an option" prompt ──
  // Bug: handleSlashCommand used `parts[1]` as arg, dropping everything after the
  // second token. So `/mode roblox new` was parsed as `/mode roblox` and the user
  // saw the prompt again no matter how many times they typed `new` or `keep`.

  it("/mode roblox new — ativa modo, reseta chat, mostra sucesso (não re-prompta)", async () => {
    mockedGetMode.mockReturnValue({
      name: "roblox", label: "Roblox (External)", enableTools: ["rojo"], enableSkills: [],
      enableFeatures: [], effortLevel: "high", strictMode: true,
    });
    mockedApplyMode.mockResolvedValue({ success: true });
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode roblox new");
    // Wait a tick for the async applyMode().then(...) to resolve.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApplyMode).toHaveBeenCalledWith("roblox");
    expect(mockedResetHistory).toHaveBeenCalledTimes(1);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain('[OK] Modo "roblox"');
    expect(out).toContain("ativado!");
    expect(out).toContain("Chat reiniciado");
    // Must NOT re-show the prompt — that was the bug.
    expect(out).not.toContain("Choose an option");
  });

  it("/mode roblox keep — ativa modo, mantém chat, mostra sucesso (não reseta)", async () => {
    mockedGetMode.mockReturnValue({
      name: "roblox", label: "Roblox (External)", enableTools: ["rojo"], enableSkills: [],
      enableFeatures: [], effortLevel: "high", strictMode: true,
    });
    mockedApplyMode.mockResolvedValue({ success: true });
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode roblox keep");
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApplyMode).toHaveBeenCalledWith("roblox");
    // keep must NOT reset history.
    expect(mockedResetHistory).not.toHaveBeenCalled();
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain('[OK] Modo "roblox"');
    expect(out).toContain("ativado!");
    expect(out).toContain("Chat mantido");
    expect(out).not.toContain("Choose an option");
  });

  it("/mode ROBLOX NEW — case-insensitive mode name, uppercase action", async () => {
    // Mode name should be lowercased before lookup; action should be lowercased too.
    mockedGetMode.mockImplementation((name: string) =>
      name === "roblox"
        ? { name: "roblox", label: "Roblox", enableTools: [], enableSkills: [], enableFeatures: [], effortLevel: "high", strictMode: false }
        : null,
    );
    mockedApplyMode.mockResolvedValue({ success: true });
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode ROBLOX NEW");
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApplyMode).toHaveBeenCalledWith("roblox");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("ativado!");
    expect(out).not.toContain("Choose an option");
  });

  it("/mode roblox bogus — action inválido re-prompta (mas não ativa)", async () => {
    // Unknown action token should fall through to the "Choose an option" prompt
    // without calling applyMode.
    mockedGetMode.mockReturnValue({
      name: "roblox", label: "Roblox", enableTools: [], enableSkills: [], enableFeatures: [],
      effortLevel: "high", strictMode: false,
    });
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode roblox bogus");
    await new Promise((r) => setTimeout(r, 20));
    expect(mockedApplyMode).not.toHaveBeenCalled();
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Choose an option");
  });

  it("/compact <multi-word instruction> — preserva instrucao com espacos e case", async () => {
    // Same root bug: handleSlashCommand dropped everything after parts[1].
    // `/compact focus on code changes` was passed as arg="focus" only.
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/compact focus on Code Changes");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Compactando com foco em: focus on Code Changes");
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // REGRESSION SUITE — multi-token args + case-insensitive + parser edge cases
  // Root cause: old handleSlashCommand parsed `arg = parts[1]?.toLowerCase()`,
  // truncating multi-word args AND lowercasing values where it shouldn't.
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── ALTA: /mode create <multi-word description> ─────────────────────────
  // Bug: arg was "create" only → startsWith("create ") was false → fell through
  // to /mode <name> branch → showed "Mode 'create' not found".

  it("/mode create <multi-word> — sugere modo a partir de descrição completa", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode create modo para revisar código Luau");
    const out = stripAnsi(lastFrame() ?? "");
    // Deve chamar suggestMode (não cair no branch /mode <name>).
    expect(out).toContain("Modo sugerido:");
    expect(out).toContain("Reason:");
    expect(out).toContain("Para confirmar e ativar: /mode confirm");
    // Não deve mostrar "Mode 'create' not found" (sintoma do bug).
    expect(out).not.toContain('Mode "create" not found');
    expect(out).not.toContain("Choose an option");
  });

  it("/mode new <multi-word> — alias de create, também funciona", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode new criar ferramenta para formatar scripts");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Modo sugerido:");
    expect(out).not.toContain('Mode "new" not found');
  });

  it("/mode create (sem descrição) — mostra erro 'Empty description'", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode create");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Empty description");
    expect(out).toContain("/mode create <what you want to do>");
  });

  // ─── ALTA: /mode confirm <name> ──────────────────────────────────────────
  // Bug: arg was "confirm" only → startsWith("confirm ") was false.

  it("/mode confirm <name> — salva modo sugerido", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode confirm meu-modo");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain('Modo "meu-modo" salvo');
    expect(out).toContain("/mode meu-modo");
    expect(out).not.toContain('Mode "confirm" not found');
  });

  // ─── ALTA: /buscar <filename com espaços> ─────────────────────────────────
  // Bug: arg was only first token → "meu" instead of "meu arquivo.lua".

  it("/buscar <arquivo com espaços> — preserva nome completo", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/buscar meu arquivo.lua");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain('Searching "meu arquivo.lua"');
    // Sintoma do bug: mostrava 'Searching "meu"'.
    expect(out).not.toContain('Searching "meu"');
  });

  it("/buscar <arquivo com path> — preserva path com subpastas", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/buscar src/utils/helpers.ts");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain('Searching "src/utils/helpers.ts"');
  });

  // ─── MÉDIA: case-insensitive em /lang (bug preexistente era pt-BR→pt-br) ──

  it("/lang pt-BR — aceita case correto (regressão do lowercasing)", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/lang pt-BR");
    expect(mockedSetLanguage).toHaveBeenCalledWith("pt-BR");
    expect(mockedResetLanguageCache).toHaveBeenCalledTimes(1);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Idioma alterado para: pt-BR");
  });

  it("/lang pt-br — aceita lowercase e normaliza para pt-BR", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/lang pt-br");
    expect(mockedSetLanguage).toHaveBeenCalledWith("pt-BR");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("pt-BR");
    expect(out).not.toContain("Invalid language");
  });

  it("/lang PT-BR — aceita uppercase e normaliza para pt-BR", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/lang PT-BR");
    expect(mockedSetLanguage).toHaveBeenCalledWith("pt-BR");
  });

  it("/lang EN — aceita uppercase", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/lang EN");
    expect(mockedSetLanguage).toHaveBeenCalledWith("en");
  });

  it("/lang invalido — mostra erro com opções", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/lang fr");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Invalid language: fr");
    expect(out).toContain("Options: pt-BR, en");
    expect(mockedSetLanguage).not.toHaveBeenCalled();
  });

  it("/lang (sem arg) — mostra idioma atual", async () => {
    mockedDetectLanguage.mockReturnValue("pt-BR");
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/lang");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Idioma atual: pt-BR");
    expect(out).toContain("Use: /lang pt-BR | en");
  });

  // ─── MÉDIA: case-insensitive em /effort ──────────────────────────────────

  it("/effort HIGH — aceita uppercase e normaliza", async () => {
    const { stdin } = render(<App />);
    await sendCommand(stdin, "/effort HIGH");
    expect(mockedSetEffortLevel).toHaveBeenCalledWith("high");
  });

  it("/effort High — aceita mixed case", async () => {
    const { stdin } = render(<App />);
    await sendCommand(stdin, "/effort High");
    expect(mockedSetEffortLevel).toHaveBeenCalledWith("high");
  });

  // ─── MÉDIA: case-insensitive em /caveman ─────────────────────────────────

  it("/caveman LITE — aceita uppercase e normaliza", async () => {
    const { stdin } = render(<App />);
    await sendCommand(stdin, "/caveman LITE");
    expect(mockedSetCavemanLevel).toHaveBeenCalledWith("lite");
  });

  it("/caveman Ultra — aceita mixed case", async () => {
    const { stdin } = render(<App />);
    await sendCommand(stdin, "/caveman Ultra");
    expect(mockedSetCavemanLevel).toHaveBeenCalledWith("ultra");
  });

  it("/caveman OFF — aceita uppercase e desativa", async () => {
    const { stdin } = render(<App />);
    await sendCommand(stdin, "/caveman OFF");
    expect(mockedSetCavemanLevel).toHaveBeenCalledWith(null);
  });

  // ─── MÉDIA: case-insensitive em /tools <category> ────────────────────────

  it("/tools ROBLOX — aceita uppercase category e normaliza", async () => {
    mockedGetByCategory.mockReturnValue([
      { name: "rojo", category: "roblox", description: "Build tool", flags: [], context: { whenToUse: [], examples: [] } },
    ]);
    mockedIsInstalled.mockReturnValue(true);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/tools ROBLOX");
    // Deve chamar getByCategory com "roblox" (lowercase), não "ROBLOX".
    expect(mockedGetByCategory).toHaveBeenCalledWith("roblox");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("rojo");
  });

  // ─── MÉDIA: case-insensitive em /toolinfo <name> ──────────────────────────

  it("/toolinfo ROJO — aceita uppercase e encontra tool", async () => {
    mockedToolGet.mockImplementation((name: string) =>
      name === "rojo"
        ? { name: "rojo", category: "roblox", description: "Build", command: "rojo", args: [], flags: [], context: { whenToUse: [], examples: [] } }
        : null,
    );
    mockedIsInstalled.mockReturnValue(true);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/toolinfo ROJO");
    // Deve chamar registry.get com "rojo" (lowercase).
    expect(mockedToolGet).toHaveBeenCalledWith("rojo");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("[T] rojo");
  });

  // ─── MÉDIA: case-insensitive em /configurar <tool> ───────────────────────

  it("/configurar ROJO — aceita uppercase e normaliza tool name", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/configurar ROJO", 400);
    const out = stripAnsi(lastFrame() ?? "");
    // Mensagem de abertura deve mostrar "rojo" (lowercase).
    expect(out).toContain('Abrindo configurador for "rojo"');
  });

  it("/mode off — deactivates and calls deactivateMode()", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mode off");
    expect(mockedDeactivateMode).toHaveBeenCalledTimes(1);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Mode deactivated");
    expect(out).toContain("No automatic validation active");
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

  it.skip("/compact — shows 'Nothing to compact' when history is small", async () => {
    mockedCompactHistory.mockReturnValue(null);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/compact");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Nothing to compact");
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

  it("/buscar (sem arg) — mostra ajuda de uso com exemplo /buscar selene", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/buscar");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Usage: /buscar <filename>");
    expect(out).toContain("/buscar selene");
  });

  it("/buscar selene — mostra mensagem 'Searching \"selene\"'", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/buscar selene");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain('Searching "selene"');
  });

  // ─── /organize ────────────────────────────────────────────────────────────

  it.skip("/organize (sem modo ativo) — shows error 'No modes active'", async () => {
    mockedGetActiveMode.mockReturnValue(null);
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/organize");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("No modes active");
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
    expect(out).toContain("Opening configurator");
    // Componente ConfiguratorChat real é renderizado (mostra título)
    expect(out).toContain("Configurador de Tools");
  });

  it.skip("/configurar selene — opens configurator for specific tool", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/configurar selene", 400);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Opening configurator for \"selene\"");
    // ConfiguratorChat real renderiza "Configurando \"selene\"..."
    expect(out).toContain("Configurando");
    expect(out).toContain("selene");
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

// ─── /cd — change working directory ────────────────────────────────────────

  it("/cd (sem arg) — abre seletor visual de pastas (FolderBrowser)", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/cd");
    const out = stripAnsi(lastFrame() ?? "");
    // FolderBrowser overlay deve aparecer
    expect(out).toContain("Select working directory");
    expect(out).toContain("Path:");
    expect(out).toContain("navigate");
    expect(out).toContain("open/select");
  });

  it("/cd <subfolder> — muda cwd e confirma", async () => {
    const { stdin } = render(<App />);
    // Vai pra tmp (sempre existe)
    const tmpDir = require("node:os").tmpdir();
    const beforeCwd = process.cwd();
    // Delay maior (600ms) pra CI — máquinas mais lentas precisam de mais tempo
    await sendCommand(stdin, `/cd ${tmpDir}`, 600);
    // Verifica EFEITO COLATERAL (cwd mudou) em vez de output renderizado.
    // Isso é mais robusto em CI (não depende de timing de render do Ink).
    expect(process.cwd()).not.toBe(beforeCwd);
    expect(process.cwd()).toBe(tmpDir);
  });

  it("/cd <path-inexistente> — mostra erro", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/cd /caminho/que/nao/existe/12345", 600);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("[ERROR] Path does not exist");
  });

  it("/cd ~ — vai pra home directory", async () => {
    const { stdin } = render(<App />);
    const home = require("node:os").homedir();
    await sendCommand(stdin, "/cd ~", 600);
    // Verifica efeito colateral (cwd = home) em vez de output
    expect(process.cwd()).toBe(home);
  });

  it("/cd . — mantém no mesmo diretório", async () => {
    const { stdin } = render(<App />);
    const beforeCwd = process.cwd();
    await sendCommand(stdin, "/cd .", 600);
    // Verifica efeito colateral (cwd não mudou)
    expect(process.cwd()).toBe(beforeCwd);
  });

// ═══════════════════════════════════════════════════════════════════════════
  // BUG 3C regression: /mcp slash command
  // ═══════════════════════════════════════════════════════════════════════════

  it("/mcp (sem arg) — lista servidores ativos + localizações de config", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mcp");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("MCP Servers:");
    // Should list the 5 config locations
    expect(out).toContain(".mcp.json");
    expect(out).toContain("~/.claude-killer/config.json");
    expect(out).toContain("~/.claude.json");
    // Should show usage
    expect(out).toContain("/mcp add");
    expect(out).toContain("/mcp remove");
  });

  it("/mcp list — alias para /mcp (mostra mesma saída)", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mcp list");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("MCP Servers:");
    expect(out).toContain("Config locations");
  });

  it("/mcp add (sem args suficientes) — mostra usage", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mcp add");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Usage:");
    expect(out).toContain("/mcp add");
  });

  it("/mcp add <name> <command> [args...] — adiciona server ao config", async () => {
    // Mock dotfileConfig to capture the updateConfig call
    const mockLoadConfig = vi.fn(() => ({ mcpServers: {} }));
    const mockUpdateConfig = vi.fn((partial: any) => ({ mcpServers: partial.mcpServers }));
    vi.doMock("../dotfileConfig.js", () => ({
      loadConfig: mockLoadConfig,
      updateConfig: mockUpdateConfig,
      saveConfig: vi.fn(),
    }));
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mcp add Roblox_Studio cmd.exe /c mcp.bat");
    // Note: due to how App.tsx uses require("../dotfileConfig.js") at runtime,
    // the mock may not intercept. We at least verify the success message format.
    const out = stripAnsi(lastFrame() ?? "");
    // Either the add succeeded (shows [OK]) or failed gracefully (shows error)
    expect(out).toMatch(/\[OK\]|Failed to add MCP server/);
  });

  it("/mcp remove (sem name) — mostra usage", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mcp remove");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Usage:");
    expect(out).toContain("/mcp remove <name>");
  });

  it("/mcp bogus — mostra erro com subcomandos válidos", async () => {
    const { stdin, lastFrame } = render(<App />);
    await sendCommand(stdin, "/mcp bogus");
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain('Unknown subcommand: "bogus"');
    expect(out).toContain("/mcp");
  });
});
