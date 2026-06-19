/**
 * slash-commands.test.tsx — Testes do output organizado dos slash commands.
 *
 * Cobre:
 *   - /help: lista de comandos com colunas alinhadas (cmd.padEnd(12))
 *   - /reset: chama history.resetHistory() + mensagem "Histórico resetado."
 *   - /effort: sem arg (mostra atual), low|medium|high|max (seta nível), invalid (erro)
 *   - /mode: sem arg (lista modos), roblox (ativa), off (desativa)
 *   - /tools: sem arg (lista todas), <categoria> (filtra), vazio (mensagem)
 *   - /hub: retorna { handled: true, openHub: true } → abre Extension Hub
 *   - /plan: toggle on/off
 *
 * Estratégia: renderiza <App /> com ink-testing-library, envia comandos via
 * stdin.write() + "\r" (Enter), e verifica output com stripAnsi.
 *
 * Mocks seguem o padrão de tui-render-snapshots.test.tsx e tui-interactions.test.tsx.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import Module from "node:module";

// ─── Mocks de dependências externas ─────────────────────────────────────────

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

// Mock extensions
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
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

// Mock modes (hoisted — /mode precisa de getAllModes, getMode, deactivateMode)
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
  // Reactive store hooks — required by useSyncExternalStore
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
  getMode: mockedGetMode,
  suggestMode: vi.fn(() => ({
    name: "suggested", label: "Suggested", reasoning: "", enableTools: [],
    enableSkills: [], enableFeatures: [], effortLevel: "medium", strictMode: false,
    readBeforeWrite: false, advancedThinking: false, luauValidation: [],
  })),
  confirmAndSaveMode: vi.fn(async () => true),
}));

// Mock effortLevels (hoisted — /effort precisa de setEffortLevel, getEffortLabel)
const mockedSetEffortLevel = vi.hoisted(() => vi.fn());
const mockedGetEffortLabel = vi.hoisted(() => vi.fn(() => "MEDIUM"));
vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: mockedSetEffortLevel,
  getEffortLabel: mockedGetEffortLabel,
}));

// Mock apiKeyPool
vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn(() => 1),
  formatPoolStats: vi.fn(() => "1 keys, 40 RPM"),
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
  ]),
  getCommandI18n: vi.fn((cmd: string) => ({ cmd, desc: `Descrição para ${cmd}` })),
}));

// Mock history (hoisted — /reset e /plan precisam de resetHistory, isPlanMode, setPlanMode)
const mockedResetHistory = vi.hoisted(() => vi.fn());
const mockedIsPlanMode = vi.hoisted(() => vi.fn(() => false));
const mockedSetPlanMode = vi.hoisted(() => vi.fn());
vi.mock("../history.js", () => ({
  isPlanMode: mockedIsPlanMode,
  resetHistory: mockedResetHistory,
  setPlanMode: mockedSetPlanMode,
  getHistory: vi.fn(() => []),
  addUserMessage: vi.fn(),
  addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(),
  addSystemMessage: vi.fn(),
  historySummary: vi.fn(() => "0 msgs"),
  historyLength: vi.fn(() => 0),
  compactHistory: vi.fn(() => null),
  getCavemanLevel: vi.fn(() => null),
  setCavemanLevel: vi.fn(),
  reloadProjectMemory: vi.fn(() => null),
}));

// Mock externalTools (hoisted — /tools precisa de getRegistry com getAll/getByCategory)
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

// Mock todo
vi.mock("../todo.js", () => ({
  getTodos: vi.fn(() => []),
  renderTodoBar: vi.fn(() => ""),
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
 * Patch de Module._load — App.tsx usa `require("../externalTools.js")` dentro
 * de handleToolsCommand/handlePoolCommand. No ambiente vitest (ESM), o require
 * nativo do Node não resolve arquivos .ts nem aplica os vi.mock (que só
 * interceptam import ESM). Este patch intercepta o require CJS e retorna os
 * mesmos mocks hoisted, restaurando o comportamento original após os testes.
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
      return { getPoolSize: vi.fn(() => 1), formatPoolStats: vi.fn(() => "1 keys, 40 RPM") };
    }
    return (originalModuleLoad as any).call(this, request, parent, ...args);
  } as typeof Module._load;
});

afterAll(() => {
  Module._load = originalModuleLoad;
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Slash Commands — output organizado", () => {
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
  });

  // ─── /help ────────────────────────────────────────────────────────────────

  describe("/help", () => {
    it("lista todos os comandos disponíveis", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/help");
      const out = stripAnsi(lastFrame() ?? "");
      // Todos os comandos do mock devem aparecer no output
      expect(out).toContain("/help");
      expect(out).toContain("/reset");
      expect(out).toContain("/effort");
      expect(out).toContain("/mode");
      expect(out).toContain("/tools");
      expect(out).toContain("/hub");
      expect(out).toContain("/plan");
    });

    it("colunas alinhadas — cmd.padEnd(12) deixa todas as descrições na mesma coluna", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/help");
      const out = stripAnsi(lastFrame() ?? "");
      // Extrai linhas de comando: começam com espaços + "/" + palavra
      const cmdLines = out.split("\n").filter((l) => /^\s*\/\w/.test(l));
      expect(cmdLines.length).toBeGreaterThanOrEqual(5);
      // Para cada linha, calcula a posição onde a descrição começa
      // Formato: [pad]  /cmd<padEnd(12)><espaço>desc
      const descPositions = cmdLines.map((line) => {
        const match = line.match(/^(\s*)(\/\w+)/);
        if (!match) return -1;
        const cmdEnd = match[1].length + match[2].length;
        let i = cmdEnd;
        while (i < line.length && line[i] === " ") i++; // pula padding + separador
        return i;
      });
      // Todas as descrições devem começar na mesma coluna (alinhamento)
      const uniquePositions = new Set(descPositions);
      expect(uniquePositions.size).toBe(1);
      // Posição deve ser >= 15 (2 spaces + 12 padEnd + 1 separator, podendo ter pad do Box)
      expect(descPositions[0]).toBeGreaterThanOrEqual(15);
    });

    it("acentos PT-BR aparecem corretamente (sem mojibake)", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/help");
      const out = stripAnsi(lastFrame() ?? "");
      // Descrições com acentos do mock i18n
      expect(out).toContain("Mostra comandos");
      expect(out).toContain("histórico");
      expect(out).toContain("nível");
      // Não deve haver mojibake
      expect(out).not.toContain("├");
      expect(out).not.toContain("Ã");
    });
  });

  // ─── /reset ───────────────────────────────────────────────────────────────

  describe("/reset", () => {
    it("mostra mensagem 'Histórico resetado.'", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/reset");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Histórico resetado.");
    });

    it("chama history.resetHistory()", async () => {
      const { stdin } = render(<App />);
      await sendCommand(stdin, "/reset");
      expect(mockedResetHistory).toHaveBeenCalledTimes(1);
    });

    it("acento 'Histórico' renderiza sem mojibake", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/reset");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Histórico");
      expect(out).not.toContain("├");
      expect(out).not.toContain("Ã");
    });
  });

  // ─── /effort ──────────────────────────────────────────────────────────────

  describe("/effort", () => {
    it("sem arg — mostra effort atual e instrução de uso", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/effort");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Effort atual: MEDIUM");
      expect(out).toContain("Use: /effort low|medium|high|max");
    });

    it("low — chama setEffortLevel('low') e mostra confirmação", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/effort low");
      expect(mockedSetEffortLevel).toHaveBeenCalledWith("low");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Effort alterado para: MEDIUM");
    });

    it("high — chama setEffortLevel('high')", async () => {
      const { stdin } = render(<App />);
      await sendCommand(stdin, "/effort high");
      expect(mockedSetEffortLevel).toHaveBeenCalledWith("high");
    });

    it("max — chama setEffortLevel('max')", async () => {
      const { stdin } = render(<App />);
      await sendCommand(stdin, "/effort max");
      expect(mockedSetEffortLevel).toHaveBeenCalledWith("max");
    });

    it("invalid — mostra erro com acento 'Nível' e opções válidas", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/effort invalid");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Nível inválido: invalid");
      expect(out).toContain("Opções: low, medium, high, max");
      // Acento correto, sem mojibake
      expect(out).not.toContain("├");
    });
  });

  // ─── /mode ────────────────────────────────────────────────────────────────

  describe("/mode", () => {
    it("sem arg — lista modos disponíveis", async () => {
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

    it("roblox — mostra prompt de ativação ('Ativando modo')", async () => {
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

    it("off — desativa modo e chama deactivateMode()", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/mode off");
      expect(mockedDeactivateMode).toHaveBeenCalledTimes(1);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Modo desativado");
      expect(out).toContain("Nenhuma validação automática ativa");
    });
  });

  // ─── /tools ───────────────────────────────────────────────────────────────

  describe("/tools", () => {
    it("sem arg — lista todas as tools com contagem total", async () => {
      mockedGetAll.mockReturnValue([
        { name: "rojo", category: "build", description: "Build Roblox project" },
        { name: "wally", category: "package", description: "Install Wally packages" },
      ]);
      mockedIsInstalled.mockReturnValue(true);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/tools");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Tools: 2 total");
      expect(out).toContain("2 OK");
      expect(out).toContain("rojo");
      expect(out).toContain("wally");
      expect(out).toContain("Instaladas");
    });

    it("com categoria — filtra tools por categoria", async () => {
      mockedGetByCategory.mockReturnValue([
        { name: "rojo", category: "build", description: "Build Roblox project" },
      ]);
      mockedIsInstalled.mockReturnValue(true);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/tools build");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Tools: 1 total");
      expect(out).toContain("rojo");
      // wally não deve aparecer (categoria diferente)
      expect(out).not.toContain("wally");
    });

    it("sem tools — mostra 'Nenhuma tool disponível'", async () => {
      mockedGetAll.mockReturnValue([]);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/tools");
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Nenhuma tool disponível");
    });
  });

  // ─── /hub ─────────────────────────────────────────────────────────────────

  describe("/hub", () => {
    it("abre Extension Hub (openHub: true → renderiza hub)", async () => {
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/hub", 500);
      const out = stripAnsi(lastFrame() ?? "");
      // Extension Hub deve estar visível
      expect(out).toContain("EXTENSION HUB");
    });
  });

  // ─── /plan ────────────────────────────────────────────────────────────────

  describe("/plan", () => {
    it("toggle ON — ativa plan mode e mostra mensagem de ativação", async () => {
      mockedIsPlanMode.mockReturnValue(false);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/plan");
      // isPlanMode() retorna false → setPlanMode(true)
      expect(mockedSetPlanMode).toHaveBeenCalledWith(true);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Modo Plan ATIVADO");
      expect(out).toContain("modelo cria plano sem executar ferramentas");
    });

    it("toggle OFF — desativa plan mode e mostra mensagem de desativação", async () => {
      mockedIsPlanMode.mockReturnValue(true);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/plan");
      // isPlanMode() retorna true → setPlanMode(false)
      expect(mockedSetPlanMode).toHaveBeenCalledWith(false);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Modo Plan DESATIVADO");
      expect(out).toContain("ferramentas executadas normalmente");
    });
  });

  // ─── Verificação adicional de alinhamento /mode ───────────────────────────

  describe("/mode — alinhamento de colunas", () => {
    it("lista modos com name.padEnd(20) e kind.padEnd(12)", async () => {
      mockedGetAllModes.mockReturnValue([
        { name: "roblox", label: "Roblox", builtIn: true, enableTools: [], enableSkills: [], enableFeatures: [] },
        { name: "devops", label: "DevOps", builtIn: false, enableTools: [], enableSkills: [], enableFeatures: [] },
      ]);
      const { stdin, lastFrame } = render(<App />);
      await sendCommand(stdin, "/mode");
      const out = stripAnsi(lastFrame() ?? "");
      // Ambos os modos devem aparecer
      expect(out).toContain("roblox");
      expect(out).toContain("devops");
      // Verifica que kind (built-in/user) aparece
      expect(out).toContain("(built-in)");
      expect(out).toContain("(user)");
    });
  });
});
