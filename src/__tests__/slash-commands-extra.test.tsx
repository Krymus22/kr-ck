/**
 * slash-commands-extra.test.tsx — Testes dos slash commands NÃO cobertos
 * em slash-commands.test.tsx.
 *
 * Cobre:
 *   - /exit: chama shutdownMCPServers (e alias /quit)
 *   - /history: mostra contagem de mensagens e resumo
 *   - /skills: lista skills ativas / "Nenhuma skill"
 *   - /plugins: lista MCPs ativos / "Nenhum servidor MCP"
 *   - /caveman: sem arg, lite, off, inválido
 *   - /memory: nenhum CLAUDE.md / conteúdo carregado
 *   - /todos: lista vazia / com todos
 *   - /compact: "Nothing to compact" quando histórico pequeno
 *   - /dream: mensagem inicial
 *   - /distill: mensagem inicial
 *   - /toolinfo <nome>: info da tool / erro
 *   - /pool: single-key / com keys
 *
 * Estratégia: mesmo padrão de slash-commands.test.tsx — render(<App />),
 * stdin.write(command) + delay + stdin.write("\r") + delay + stripAnsi(lastFrame()).
 * Mocks hoisted pra controle per-test (especialmente /pool, /history, /caveman).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import Module from "node:module";

// ─── Mocks de dependências externas (mesmos do slash-commands.test.tsx) ─────

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

// Mock extensions (hoisted — /exit, /skills, /plugins precisam ser espiados/override)
const mockedShutdownMCPServers = vi.hoisted(() => vi.fn());
const mockedGetActiveSkills = vi.hoisted(() => vi.fn(() => []));
const mockedGetActiveMCPServers = vi.hoisted(() => vi.fn(() => []));
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: mockedShutdownMCPServers,
  getActiveSkills: mockedGetActiveSkills, getActiveMCPServers: mockedGetActiveMCPServers,
}));

// Mock extensionCenter (hoisted — ExtensionHub precisa de getHubSummary, getAllExtensions)
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
  // Reactive store hooks — required by useSyncExternalStore in ExtensionHub
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

// Mock modes (hoisted — App.tsx importa várias funções)
const mockedGetAllModes = vi.hoisted(() => vi.fn(() => []));
const mockedGetActiveModeName = vi.hoisted(() => vi.fn(() => null));
const mockedApplyMode = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const mockedDeactivateMode = vi.hoisted(() => vi.fn());
const mockedGetMode = vi.hoisted(() => vi.fn(() => null));
vi.mock("../modes.js", () => ({
  getAllModes: mockedGetAllModes,
  getActiveModeName: mockedGetActiveModeName,
  getActiveMode: vi.fn(() => null),
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

// Mock apiKeyPool (hoisted — /pool precisa de override per-test)
const mockedGetPoolSize = vi.hoisted(() => vi.fn(() => 1));
const mockedFormatPoolStats = vi.hoisted(() => vi.fn(() => "1 keys, 40 RPM"));
vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: mockedGetPoolSize,
  formatPoolStats: mockedFormatPoolStats,
}));

// Mock i18n — define os slash commands que aparecem em /help e no autocomplete
vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => [
    { cmd: "/help", desc: "Mostra comandos disponíveis" },
    { cmd: "/reset", desc: "Reseta histórico" },
    { cmd: "/effort", desc: "Define nível de effort", subcommands: ["low", "medium", "high", "max"] },
    { cmd: "/mode", desc: "Alterna modo", subcommands: ["roblox", "off"] },
    { cmd: "/tools", desc: "Lista ferramentas" },
    { cmd: "/hub", desc: "Abre Extension Hub" },
    { cmd: "/plan", desc: "Toggle plan mode" },
    { cmd: "/exit", desc: "Sai do app" },
    { cmd: "/history", desc: "Mostra histórico" },
    { cmd: "/skills", desc: "Lista skills" },
    { cmd: "/plugins", desc: "Lista MCPs" },
    { cmd: "/caveman", desc: "Modo caveman", subcommands: ["lite", "full", "ultra", "off"] },
    { cmd: "/memory", desc: "Carrega CLAUDE.md" },
    { cmd: "/todos", desc: "Lista todos" },
    { cmd: "/compact", desc: "Compacta contexto" },
    { cmd: "/dream", desc: "Revisa memória" },
    { cmd: "/distill", desc: "Extrai skills" },
    { cmd: "/toolinfo", desc: "Info de tool" },
    { cmd: "/pool", desc: "Status API pool" },
  ]),
  getCommandI18n: vi.fn((cmd: string) => ({ cmd, desc: `Descrição para ${cmd}` })),
}));

// Mock history (hoisted — /history, /caveman, /memory, /compact precisam de override)
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
  loadHistoryDirect: vi.fn(),
  getSystemPrompt: vi.fn(() => "system prompt"),
  optimizeContext: vi.fn(),
}));

// Mock externalTools (hoisted — /toolinfo precisa de registry.get/isInstalled)
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

// Mock session — return a valid session so FolderBrowser doesn't open
// (FolderBrowser-on-startup intercepts stdin and breaks tests).
vi.mock("../session.js", () => ({
  startSession: vi.fn(() => "test-session"),
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getLastSession: vi.fn(() => ({
    id: "test-session",
    path: "/tmp/test-session.jsonl",
    projectCwd: "/tmp",
    effortLevel: null,
  })),
  loadSessionMessages: vi.fn(() => ({
    messages: [{ role: "user", content: "dummy-previous-message" }],
    lastSnapshot: null,
    postSnapshotMessages: [{ role: "user", content: "dummy-previous-message" }],
    effortLevel: null,
  })),
  getSessionProjectCwd: vi.fn(() => "/tmp"),
  getSessionEffortLevel: vi.fn(() => null),
  updateSessionProjectCwd: vi.fn(),
  updateSessionEffortLevel: vi.fn(),
  setActiveSession: vi.fn(),
  getActiveSessionId: vi.fn(() => "test-session"),
  listSessions: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  renameSession: vi.fn(() => true),
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
 * `require("../apiKeyPool.js")` dentro de handleToolsCommand/handlePoolCommand/
 * handleToolInfoCommand. No vitest (ESM), o require nativo do Node não resolve
 * arquivos .ts nem aplica os vi.mock (que só interceptam import ESM). Este
 * patch intercepta o require CJS e retorna os mesmos mocks hoisted.
 */
const originalModuleLoad = Module._load;
beforeAll(() => {
  Module._load = function (request: string, parent: NodeJS.Module | undefined, ...args: any[]): any {
    const parentFile = parent?.filename ?? "";
    // Só intercepta requires vindos do App.tsx (evita afetar outros módulos)
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

describe("Slash Commands extras — output dos commands não cobertos", () => {
  beforeEach(() => {
    // Limpa histórico de chamadas (não reseta implementações)
    vi.clearAllMocks();
    // Re-seta defaults que testes individuais podem override
    mockedGetAllModes.mockReturnValue([]);
    mockedGetActiveModeName.mockReturnValue(null);
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
    // Defaults dos mocks deste arquivo
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
  });

  // ─── /exit ────────────────────────────────────────────────────────────────

  describe("/exit", () => {
    it("chama shutdownMCPServers() ao executar /exit", async () => {
      const { stdin } = render(<App />);
      await sendCommand(stdin, "/exit");
      // /exit dispara shutdownMCPServers antes de sair
      expect(mockedShutdownMCPServers).toHaveBeenCalledTimes(1);
    });

    it("alias /quit também chama shutdownMCPServers()", async () => {
      const { stdin } = render(<App />);
      await sendCommand(stdin, "/quit");
      // /quit é alias de /exit no COMMAND_HANDLERS
      expect(mockedShutdownMCPServers).toHaveBeenCalledTimes(1);
    });
  });

  // ─── /history ─────────────────────────────────────────────────────────────

  describe("/history", () => {
    it("mostra contagem de mensagens do histórico", async () => {
      mockedHistoryLength.mockReturnValue(5);
      mockedHistorySummary.mockReturnValue("5 mensagens");
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/history");
      const out = stripAnsi(lastFrame() ?? "");
      // Formato esperado: "History: <n> mensagens (<summary>)"
      expect(out).toContain("History:");
      expect(out).toContain("5 mensagens");
    });

    it("mostra o resumo retornado por historySummary()", async () => {
      mockedHistoryLength.mockReturnValue(10);
      mockedHistorySummary.mockReturnValue("Resumo customizado de 10 msgs");
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/history");
      const out = stripAnsi(lastFrame() ?? "");
      // O resumo aparece entre parênteses no output
      expect(out).toContain("Resumo customizado de 10 msgs");
      expect(out).toContain("10 messages");
    });
  });

  // ─── /skills ──────────────────────────────────────────────────────────────

  describe("/skills", () => {
    it("mostra 'Nenhuma skill carregada.' quando vazio", async () => {
      mockedGetActiveSkills.mockReturnValue([]);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/skills");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Nenhuma skill carregada.");
    });

    it("lista skills ativas com nome e descrição", async () => {
      mockedGetActiveSkills.mockReturnValue([
        { name: "git-helper", description: "Auxilia em operações git" },
        { name: "test-gen", description: "Gera testes automaticamente" },
      ]);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/skills");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Skills:");
      expect(out).toContain("git-helper");
      expect(out).toContain("Auxilia em operações git");
      expect(out).toContain("test-gen");
      expect(out).toContain("Gera testes automaticamente");
    });
  });

  // ─── /plugins ─────────────────────────────────────────────────────────────

  describe("/plugins", () => {
    it("mostra 'Nenhum servidor MCP ativo.' quando vazio", async () => {
      mockedGetActiveMCPServers.mockReturnValue([]);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/plugins");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Nenhum servidor MCP ativo.");
    });

    it("lista MCPs ativos (nome do servidor)", async () => {
      mockedGetActiveMCPServers.mockReturnValue(["filesystem", "github"]);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/plugins");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("MCP Servers");
      expect(out).toContain("filesystem");
      expect(out).toContain("github");
    });
  });

  // ─── /caveman ─────────────────────────────────────────────────────────────

  describe("/caveman", () => {
    it("sem arg — mostra nível atual e instrução de uso", async () => {
      mockedGetCavemanLevel.mockReturnValue(null);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/caveman");
      const out = stripAnsi(lastFrame() ?? "");
      // Quando getCavemanLevel() === null, mostra "desativado"
      expect(out).toContain("Caveman: desativado");
      expect(out).toContain("Uso: /caveman");
      expect(out).toContain("lite");
      expect(out).toContain("off");
    });

    it("'lite' — ativa caveman e mostra confirmação em uppercase", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/caveman lite");
      // setCavemanLevel chamado com "lite"
      expect(mockedSetCavemanLevel).toHaveBeenCalledWith("lite");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Caveman ativado: LITE");
    });

    it("'off' — desativa caveman e chama setCavemanLevel(null)", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/caveman off");
      // setCavemanLevel chamado com null
      expect(mockedSetCavemanLevel).toHaveBeenCalledWith(null);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Caveman desativado!");
    });

    it("nível inválido — mostra erro com lista de níveis válidos", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/caveman invalid");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Invalid level");
      // Lista de níveis válidos aparece na mensagem de erro
      expect(out).toContain("lite");
      expect(out).toContain("full");
      expect(out).toContain("ultra");
      // setCavemanLevel não deve ser chamado
      expect(mockedSetCavemanLevel).not.toHaveBeenCalled();
    });
  });

  // ─── /memory ──────────────────────────────────────────────────────────────

  describe("/memory", () => {
    it("mostra 'Nenhum CLAUDE.md/AGENTS.md encontrado.' quando reload retorna null", async () => {
      mockedReloadProjectMemory.mockReturnValue(null);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/memory");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Nenhum CLAUDE.md/AGENTS.md encontrado.");
    });

    it("mostra conteúdo quando CLAUDE.md existe", async () => {
      mockedReloadProjectMemory.mockReturnValue("# Projeto\n\nDiretrizes de código.");
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/memory");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Project memory carregada:");
      expect(out).toContain("# Projeto");
      expect(out).toContain("Diretrizes de código.");
    });
  });

  // ─── /todos ───────────────────────────────────────────────────────────────

  describe("/todos", () => {
    it("mostra 'Lista vazia.' quando renderTodoBar retorna string vazia", async () => {
      mockedRenderTodoBar.mockReturnValue("");
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/todos");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Lista vazia.");
    });

    it("mostra barra de todos quando há itens", async () => {
      mockedRenderTodoBar.mockReturnValue("[ ] Task 1\n[ ] Task 2\n[x] Task 3");
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/todos");
      const out = stripAnsi(lastFrame() ?? "");
      // O conteúdo da barra deve aparecer (não a mensagem "Lista vazia.")
      expect(out).toContain("Task 1");
      expect(out).toContain("Task 2");
      expect(out).toContain("Task 3");
      expect(out).not.toContain("Lista vazia.");
    });
  });

  // ─── /compact ─────────────────────────────────────────────────────────────

  describe("/compact", () => {
    it.skip("shows 'Nothing to compact' when history is small (compactHistory returns null)", async () => {
      mockedCompactHistory.mockReturnValue(null);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/compact");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Nothing to compact");
    });
  });

  // ─── /dream ───────────────────────────────────────────────────────────────

  describe("/dream", () => {
    it("mostra mensagem 'Running /dream - reviewing memory...'", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/dream");
      const out = stripAnsi(lastFrame() ?? "");
      // /dream retorna imediatamente com a mensagem inicial
      expect(out).toContain("Running /dream - reviewing memory...");
    });
  });

  // ─── /distill ─────────────────────────────────────────────────────────────

  describe("/distill", () => {
    it("mostra mensagem 'Executando /distill - extraindo workflow skills...'", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/distill");
      const out = stripAnsi(lastFrame() ?? "");
      // /distill retorna imediatamente com a mensagem inicial
      expect(out).toContain("Executando /distill - extraindo workflow skills...");
    });
  });

  // ─── /toolinfo ────────────────────────────────────────────────────────────

  describe("/toolinfo", () => {
    it("mostra info da tool quando ela existe no registry", async () => {
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
        flags: [{ name: "--output", type: "string", required: false, default: "build" }],
      });
      mockedIsInstalled.mockReturnValue(true);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/toolinfo rojo");
      const out = stripAnsi(lastFrame() ?? "");
      // Header com nome da tool
      expect(out).toContain("rojo");
      // Descrição
      expect(out).toContain("Builds a Roblox project from source");
      // Categoria
      expect(out).toContain("build");
      // Quando usar (pattern do context.whenToUse)
      expect(out).toContain("Quando precisar buildar um projeto Roblox");
      // Exemplo
      expect(out).toContain("rojo build default.project.json");
      // Status instalada
      expect(out).toContain("Installed");
    });

    it("mostra erro 'not found' quando tool não existe", async () => {
      mockedToolGet.mockReturnValue(null);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/toolinfo nonexistent");
      const out = stripAnsi(lastFrame() ?? "");
      // Mensagem de erro com o nome da tool
      expect(out).toContain("not found");
      expect(out).toContain("nonexistent");
    });
  });

  // ─── /pool ────────────────────────────────────────────────────────────────

  describe("/pool", () => {
    it("mostra 'single-key' quando pool size é 0 (sem multi-key configurado)", async () => {
      mockedGetPoolSize.mockReturnValue(0);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/pool");
      const out = stripAnsi(lastFrame() ?? "");
      // Mensagem de modo single-key
      expect(out).toContain("single-key");
      expect(out).toContain("NVIDIA_API_KEYS");
    });

    it("mostra contagem de keys quando pool tem keys (formatPoolStats)", async () => {
      mockedGetPoolSize.mockReturnValue(3);
      mockedFormatPoolStats.mockReturnValue("3 keys, 120 RPM");
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/pool");
      const out = stripAnsi(lastFrame() ?? "");
      // Resultado de formatPoolStats() aparece no output
      expect(out).toContain("3 keys, 120 RPM");
    });
  });
});
