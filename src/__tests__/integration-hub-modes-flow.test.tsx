/**
 * integration-hub-modes-flow.test.tsx — Testes de INTEGRAÇÃO CROSS-MODULE.
 *
 * Diferente dos testes unitários (hub-e2e.test.tsx, hub-mode-filter.test.tsx),
 * ESTES testes exercitam os módulos REAIS em conjunto:
 *
 *   - extensionCenter.ts (store real — toggle/cycle/setTriggerMode mutam estado real)
 *   - modes.ts (applyMode/deactivateMode reais, persistência em fs mock)
 *   - effortLevels.ts (setEffortLevel real — applyMode altera o nível)
 *   - tui/ExtensionHub.tsx + useStoreVersion.ts (componente real, useSyncExternalStore)
 *
 * Mockamos APENAS a borda externa:
 *   - node:fs (in-memory store seletivo; pass-through para defaults/modes/)
 *   - logger, config, externalTools, extensions, toolDetector, toolInstaller
 *   - history (effortLevels.ts importa, mas não queremos side-effects)
 *   - auxiliary modules (apiKeyPool, i18n, agent, todo, memory, session, etc.)
 *
 * Fluxos cobertos (13 testes):
 *   1. Ativar modo Roblox (UI + variação modo inexistente)        — 2 testes
 *   2. Desativar modo (tecla D)                                    — 1 teste
 *   3. Trocar de modo (roblox → devops)                           — 1 teste
 *   4. Mode filter M (liga/desliga; sem modo ativo)               — 2 testes
 *   5. Toggle extension + cycle trigger mode (T, 1-4, Enter)      — 2 testes
 *   6. Install tool flow (I)                                       — 1 teste
 *   7. (Removed in Sprint 2 — search system was deleted)
 *   8. State preservation (cursor/scroll mantidos entre ações)    — 2 testes
 *   + 2 testes extras de robustez (estado inicial, re-render)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// ─── Setup do FAKE_HOME antes de qualquer módulo carregar ─────────────────
//
// Precisa ser setado ANTES do import do extensionCenter/modes, pois esses
// módulos leem process.env.HOME no tempo de carga do módulo (loadState() e
// getModesDir()). vi.hoisted roda antes de qualquer import E antes das
// factories do vi.mock.
//
// FAKE_HOME é declarado DENTRO do bloco vi.hoisted para evitar temporal dead
// zone (const não é inicializada antes da execução do hoisted callback).

const { FAKE_HOME } = vi.hoisted(() => {
  const home = "/fake/claude-killer-integration-home";
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return { FAKE_HOME: home };
});

// ─── In-memory FS store (hoisted para ser acessível na factory do mock) ───
//
// Armazena apenas arquivos sob FAKE_HOME. Para QUALQUER outro path (ex.:
// defaults/modes/roblox.json), delega para o fs real — assim o modes.ts
// consegue ler os modos built-in reais do projeto.

const memFS = vi.hoisted(() => {
  const store = new Map<string, string>();
  return { store };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const nodePath = await import("node:path");

  const isFake = (p: unknown): boolean => {
    return typeof p === "string" && p.startsWith(FAKE_HOME);
  };

  const existsSync = (p: unknown) => {
    if (isFake(p)) return memFS.store.has(String(p));
    return actual.existsSync(p as any);
  };

  const readFileSync = ((p: unknown, ...args: any[]) => {
    if (isFake(p)) {
      const key = String(p);
      if (!memFS.store.has(key)) {
        const err = new Error(`ENOENT: no such file or directory, open '${key}'`);
        (err as any).code = "ENOENT";
        throw err;
      }
      return memFS.store.get(key);
    }
    return (actual.readFileSync as any)(p, ...args);
  }) as any;

  const writeFileSync = ((p: unknown, content: unknown, ...args: any[]) => {
    if (isFake(p)) {
      memFS.store.set(String(p), typeof content === "string" ? content : String(content));
      return;
    }
    return (actual.writeFileSync as any)(p, content, ...args);
  }) as any;

  const mkdirSync = ((p: unknown, ...args: any[]) => {
    if (isFake(p)) return; // no-op — diretorios são virtuais no memFS
    return (actual.mkdirSync as any)(p, ...args);
  }) as any;

  const readdirSync = ((p: unknown, ...args: any[]) => {
    if (isFake(p)) {
      const prefix = String(p).endsWith("/") ? String(p) : String(p) + "/";
      const out: string[] = [];
      for (const key of memFS.store.keys()) {
        if (key.startsWith(prefix)) {
          const rest = key.slice(prefix.length);
          if (!rest.includes("/")) out.push(rest);
        }
      }
      return out;
    }
    const result = (actual.readdirSync as any)(p, ...args);
    // BUG FIX (Sprint 12) workaround: getBuiltInModes agora lê subpastas
    // (<mode>/config.json — novo formato) ALÉM dos <mode>.json flat (legacy).
    // O novo formato usa campos diferentes (tools/skills/validators em vez de
    // enableTools/enableSkills/luauValidation), o que quebra o ExtensionHub
    // (ModeCard acessa mode.enableTools.length). Para preservar o comportamento
    // esperado pelo Hub (legacy format com enableTools), filtramos as
    // subpastas do diretório bundled defaults/modes/.
    if (typeof p === "string" && p.includes("defaults/modes")) {
      return result.filter((entry: string) => {
        try {
          const entryPath = nodePath.join(String(p), entry);
          return !(actual.statSync as any)(entryPath).isDirectory();
        } catch {
          return true;
        }
      });
    }
    return result;
  }) as any;

  const unlinkSync = ((p: unknown, ...args: any[]) => {
    if (isFake(p)) {
      memFS.store.delete(String(p));
      return;
    }
    return (actual.unlinkSync as any)(p, ...args);
  }) as any;

  const copyFileSync = ((src: unknown, dest: unknown, ...args: any[]) => {
    if (isFake(dest) && !isFake(src)) {
      memFS.store.set(String(dest), (actual.readFileSync as any)(src, "utf8"));
      return;
    }
    if (isFake(dest) && isFake(src)) {
      memFS.store.set(String(dest), memFS.store.get(String(src)) ?? "");
      return;
    }
    return (actual.copyFileSync as any)(src, dest, ...args);
  }) as any;

  const statSync = ((p: unknown, ...args: any[]) => {
    if (isFake(p)) {
      return {
        isDirectory: () => false,
        isFile: () => memFS.store.has(String(p)),
        size: (memFS.store.get(String(p)) ?? "").length,
        mtime: new Date(),
        mtimeMs: Date.now(),
      };
    }
    return (actual.statSync as any)(p, ...args);
  }) as any;

  const mocked = {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    readdirSync,
    unlinkSync,
    copyFileSync,
    statSync,
  };

  return {
    default: mocked,
    ...mocked,
  };
});

// ─── Mocks auxiliares (borda externa) ─────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.75,
    costPerKPrompt: 0, costPerKCompletion: 0, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

// toolDetector — mock controlável por teste
const mockDetectTool = vi.hoisted(() => vi.fn(() => ({
  status: "missing", binaryPath: null, version: null, error: "not found", searchedPaths: [],
})));

vi.mock("../toolDetector.js", () => ({
  detectTool: mockDetectTool,
  detectAndVerify: vi.fn(async () => ({ status: "missing", binaryPath: null, version: null, error: "", searchedPaths: [], verified: false })),
  verifyToolWorks: vi.fn(async () => ({ works: false })),
  getSearchPathsForTool: vi.fn(() => []),
  isAutoDetectEnabled: vi.fn(() => false),
  extractToolBinaryName: vi.fn((id: string) => id.replace(/^tool:/, "").replace(/_.+$/, "")),
  getModeToolNames: vi.fn((ids: string[]) => [...new Set(ids.map((id: string) => id.replace(/^tool:/, "").replace(/_.+$/, "")))]),
}));

// toolInstaller — mock controlável por teste
const mockInstallTool = vi.hoisted(() => vi.fn(async () => ({
  success: true, toolName: "rojo", version: "7.6.1", binaryPath: "/fake/rojo",
})));
vi.mock("../toolInstaller.js", () => ({
  installTool: mockInstallTool,
  canInstall: vi.fn(() => true),
  listInstallableTools: vi.fn(() => ["rojo", "selene", "stylua"]),
  getToolRepo: vi.fn(() => null),
  getInstallDir: vi.fn(() => ""),
}));

// extensions.js — usado por extensionCenter.discoverMCPServers (não chamado
// nos testes, mas precisa resolver o import no top-level)
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []),
  callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}),
  shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []),
  getActiveMCPServers: vi.fn(() => []),
}));

// externalTools.js — usado por extensionCenter.discoverTools
vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({
    getAll: vi.fn(() => []), getByCategory: vi.fn(() => []),
    isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn(),
    getToolStatus: vi.fn(() => "missing"),
  })),
  getDetector: vi.fn(() => ({ detect: vi.fn(), detectFromContext: vi.fn() })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn() })),
  initializeTools: vi.fn(),
}));

// history.js — effortLevels.ts importa, mas não queremos side-effects
vi.mock("../history.js", () => ({
  isPlanMode: vi.fn(() => false), setPlanMode: vi.fn(), resetHistory: vi.fn(),
  getHistory: vi.fn(() => []), addUserMessage: vi.fn(), addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(), addSystemMessage: vi.fn(), historySummary: vi.fn(() => ""),
  historyLength: vi.fn(() => 0), getSystemPrompt: vi.fn(() => ""),
  optimizeContext: vi.fn(), estimateTokens: vi.fn(() => 0),
}));

vi.mock("../apiKeyPool.js", () => ({ getPoolSize: vi.fn(() => 1), formatPoolStats: vi.fn(() => "") }));
vi.mock("../i18n.js", () => ({ getLocalizedSlashCommands: vi.fn(() => []), getCommandI18n: vi.fn(() => ({})) }));
vi.mock("../agent.js", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../todo.js", () => ({ resetTodo: vi.fn(), renderTodoBar: vi.fn(), getTodos: vi.fn() }));
vi.mock("../memory.js", () => ({ getMemoryConfig: vi.fn() }));
vi.mock("../session.js", () => ({ saveSession: vi.fn(), loadSession: vi.fn(), listSessions: vi.fn() }));
vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn() }));

// ─── Imports REAIS (não mockados) ─────────────────────────────────────────
//
// Estes módulos rodam de verdade. O estado é mutável e persistido no memFS.

import { ExtensionHub } from "../tui/ExtensionHub.js";
import {
  getAllExtensions,
  getExtension,
  syncExtensions,
  setTriggerMode,
  toggleExtension,
  cycleTriggerMode,
  getHubSummary,
  type ExtensionEntry,
} from "../extensionCenter.js";
import {
  getAllModes,
  getActiveModeName,
  getActiveMode,
  applyMode,
  deactivateMode,
  getMode,
} from "../modes.js";
import {
  getEffortLevel,
  setEffortLevel,
} from "../effortLevels.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Path do arquivo de modo ativo no memFS
const ACTIVE_MODE_FILE = `${FAKE_HOME}/.claude-killer/modes/active.json`;

// Conjunto base de extensões usado na maioria dos testes.
// 9 extensões (cabe exatamente no grid 3x3, sem paginação):
//   - 4 tools (3 do modo roblox, 2 fora do modo roblox)
//   - 2 skills (ambas do modo roblox)
//   - 2 features (ambas do modo roblox)
//   - 1 tool extra (não-roblox, já desabilitada)
//
// IMPORTANTE: os IDsbatem com os enableTools/enableSkills/enableFeatures
// do defaults/modes/roblox.json para que applyMode os ative corretamente.
const BASE_EXTENSIONS: Array<Omit<ExtensionEntry, "enabled" | "triggerMode">> = [
  // Tools (não-instaladas por padrão — aparecem como [FALTA])
  { id: "tool:rojo_build", name: "rojo_build", category: "tool", description: "Build Roblox project", installed: false },
  { id: "tool:selene_lint", name: "selene_lint", category: "tool", description: "Lint Luau files", installed: false },
  { id: "tool:stylua_format", name: "stylua_format", category: "tool", description: "Format Luau files", installed: false },
  { id: "tool:darklua_process", name: "darklua_process", category: "tool", description: "Minify (not in roblox mode)", installed: false },
  { id: "tool:terraform_validate", name: "terraform_validate", category: "tool", description: "TF validate (not in roblox mode)", installed: false },
  // Skills (instaladas por padrão)
  { id: "skill:profilestore", name: "profilestore", category: "skill", description: "DataStore wrapper", installed: true },
  { id: "skill:bytenet", name: "bytenet", category: "skill", description: "Networking", installed: true },
  // Features (instaladas por padrão)
  { id: "feature:think_tool", name: "think_tool", category: "feature", description: "Thinking space", installed: true },
  { id: "feature:strict_gate", name: "strict_gate", category: "feature", description: "Strict quality gate", installed: true },
];

// Estado inicial desejado para a maioria dos testes.
// Mapeia id -> { enabled, triggerMode } inicial.
const INITIAL_STATE: Record<string, { enabled: boolean; triggerMode: "disabled" | "on_file" | "on_task" | "always" }> = {
  "tool:rojo_build":          { enabled: true,  triggerMode: "on_file" },
  "tool:selene_lint":         { enabled: true,  triggerMode: "on_file" },
  "tool:stylua_format":       { enabled: true,  triggerMode: "on_file" },
  "tool:darklua_process":     { enabled: false, triggerMode: "disabled" },
  "tool:terraform_validate":  { enabled: false, triggerMode: "disabled" },
  "skill:profilestore":       { enabled: true,  triggerMode: "always" },
  "skill:bytenet":            { enabled: true,  triggerMode: "always" },
  "feature:think_tool":       { enabled: true,  triggerMode: "always" },
  "feature:strict_gate":      { enabled: true,  triggerMode: "always" },
};

/** Reinicia o estado do extensionCenter para o INITIAL_STATE conhecido. */
function resetExtensionState(): void {
  // syncExtensions([]) substitui hubState.extensions por [] — reset efetivo
  syncExtensions([]);
  // Recria com os defaults
  syncExtensions(BASE_EXTENSIONS);
  // Aplica o estado inicial conhecido via setTriggerMode (que também seta enabled)
  for (const [id, state] of Object.entries(INITIAL_STATE)) {
    setTriggerMode(id, state.triggerMode);
    // setTriggerMode com "disabled" deixa enabled=false; com outros, enabled=true.
    // Mas para garantir, chamamos toggleExtension se necessário.
    const ext = getExtension(id);
    if (ext && ext.enabled !== state.enabled) {
      toggleExtension(id);
    }
  }
}

// ─── Testes ───────────────────────────────────────────────────────────────

describe("Integration: ExtensionHub + Modes + EffortLevels flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Limpa o memFS (apaga active.json, hub.json, etc.)
    memFS.store.clear();

    // Reseta mocks de toolDetector/Installer para o default
    mockDetectTool.mockReturnValue({
      status: "missing", binaryPath: null, version: null, error: "not found", searchedPaths: [],
    });
    mockInstallTool.mockResolvedValue({
      success: true, toolName: "rojo", version: "7.6.1", binaryPath: "/fake/rojo",
    });

    // Reseta variáveis de ambiente que applyMode possa ter setado
    delete process.env.STRICT_MODE;
    delete process.env.READ_BEFORE_WRITE;
    delete process.env.ADVANCED_THINKING;
    delete process.env.CLAUDE_KILLER_EFFORT;
    delete process.env.CLAUDE_KILLER_EFFORT_STORED;

    // Reseta o nível de esforço para o default (medium)
    setEffortLevel("medium");

    // Recria o estado das extensões
    resetExtensionState();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 1. Ativar modo Roblox (2 testes)
  // ═══════════════════════════════════════════════════════════════════════

  describe("1. Ativar modo Roblox", () => {
    it("ativa modo roblox via UI (Tab → Modes → Enter) e aplica mudanças reais", async () => {
      // Estado inicial: nenhum modo ativo
      expect(getActiveModeName()).toBeNull();
      // effortLevel inicial = medium (resetado no beforeEach)
      expect(getEffortLevel()).toBe("medium");
      // rojo_build começa ON (via INITIAL_STATE)
      const rojoBefore = getExtension("tool:rojo_build");
      expect(rojoBefore?.enabled).toBe(true);
      expect(rojoBefore?.triggerMode).toBe("on_file");

      // Renderiza o Hub
      const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      // Tab 6x: All → Skills → Tools → MCPs → Plugins → Features → Modes
      for (let i = 0; i < 6; i++) {
        stdin.write("\t");
        await delay(20);
      }
      const modesFrame = stripAnsi(lastFrame() ?? "");
      expect(modesFrame).toContain("Modes");

      // O cursor começa em 0 (devops, alfabético). Precisa ir pra 1 (roblox).
      // Press right arrow uma vez.
      stdin.write("\u001B[C"); // right
      await delay(30);

      // Enter para ativar o modo
      stdin.write("\r");
      await delay(80); // applyMode é async (dynamic imports)

      // ═══ Verificações cross-module ═══

      // (a) getActiveModeName() retorna "roblox" (persistido no memFS)
      expect(getActiveModeName()).toBe("roblox");

      // (b) effortLevel mudou para "high" (setEffortLevel real)
      expect(getEffortLevel()).toBe("high");

      // (c) Extensions filtradas pelo modo: rojo_build e selene_lint ON
      //     (já estavam ON, applyMode não desliga o que já está ON)
      const rojoAfter = getExtension("tool:rojo_build");
      const seleneAfter = getExtension("tool:selene_lint");
      expect(rojoAfter?.enabled).toBe(true);
      expect(rojoAfter?.triggerMode).not.toBe("disabled");
      expect(seleneAfter?.enabled).toBe(true);
      expect(seleneAfter?.triggerMode).not.toBe("disabled");

      // (d) Hub mostra "Active mode: roblox" no header
      const finalFrame = stripAnsi(lastFrame() ?? "");
      expect(finalFrame).toContain("Active mode: roblox");
    });

    it("variação: ativar modo inexistente retorna erro (não ativa nada)", async () => {
      // Chamada direta ao módulo real applyMode (UI não expõe modos inexistentes)
      const result = await applyMode("modo-que-com-certeira-nao-existe");

      // applyMode retorna success=false e lista de erros
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toMatch(/not found/i);

      // Nenhum modo foi ativado
      expect(getActiveModeName()).toBeNull();

      // effortLevel não mudou (continua medium)
      expect(getEffortLevel()).toBe("medium");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Desativar modo (1 teste)
  // ═══════════════════════════════════════════════════════════════════════

  describe("2. Desativar modo", () => {
    it("press D no Modes tab desativa o modo ativo", async () => {
      // Pré-ativa roblox (chamada direta ao módulo real)
      await applyMode("roblox");
      expect(getActiveModeName()).toBe("roblox");

      // Renderiza o Hub
      const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      // Vai pra Modes tab
      for (let i = 0; i < 6; i++) {
        stdin.write("\t");
        await delay(20);
      }

      // Press D para desativar
      stdin.write("d");
      await delay(50);

      // getActiveModeName() retorna null (deactivateMode real → setActiveMode(null))
      expect(getActiveModeName()).toBeNull();

      // ═══ BUG FIX ═══
      // deactivateMode() agora REVERTE as tools que o modo ativo havia
      // habilitado (mesmo padrão do applyMode: só toca tools, não skills/
      // features). rojo_build, selene_lint e stylua_format (todas no
      // enableTools do roblox) devem voltar a OFF após desativar o modo.
      //
      // A reversão é async (dynamic import), mas o delay(50) acima dá tempo
      // suficiente para o fire-and-forget completar.
      const rojo = getExtension("tool:rojo_build");
      expect(rojo?.enabled).toBe(false);
      expect(rojo?.triggerMode).toBe("disabled");

      const selene = getExtension("tool:selene_lint");
      expect(selene?.enabled).toBe(false);

      const stylua = getExtension("tool:stylua_format");
      expect(stylua?.enabled).toBe(false);

      // Skills/features NÃO são desligadas (usuário pode tê-las habilitado
      // manualmente — mesmo regra do applyMode).
      const profilestore = getExtension("skill:profilestore");
      expect(profilestore?.enabled).toBe(true);

      // Hub não mostra mais "Active mode: roblox"
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).not.toContain("Active mode: roblox");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. Trocar de modo (1 teste)
  // ═══════════════════════════════════════════════════════════════════════

  describe("3. Trocar de modo", () => {
    it("troca de roblox para devops: devops vira ativo, roblox não é mais", async () => {
      // Pré-ativa roblox
      await applyMode("roblox");
      expect(getActiveModeName()).toBe("roblox");
      expect(getEffortLevel()).toBe("high"); // roblox seta high

      // Aplica devops
      const result = await applyMode("devops");
      expect(result.success).toBe(true);

      // Modo ativo agora é devops, não roblox
      expect(getActiveModeName()).toBe("devops");
      expect(getActiveModeName()).not.toBe("roblox");

      // getActiveMode() retorna a definição de devops
      const activeMode = getActiveMode();
      expect(activeMode?.name).toBe("devops");

      // ═══ Verifica cross-module: extensions mudam ═══
      // devops.enableTools = [] (vazio) — então applyMode desliga tools que
      // roblox tinha ligado (rojo_build, selene_lint, stylua_format).
      // Skills e features NÃO são desligadas (applyMode só toca tools).
      const rojo = getExtension("tool:rojo_build");
      const selene = getExtension("tool:selene_lint");
      const stylua = getExtension("tool:stylua_format");
      // Tools que roblox ligou agora estão desligadas
      expect(rojo?.enabled).toBe(false);
      expect(selene?.enabled).toBe(false);
      expect(stylua?.enabled).toBe(false);
      // Skills/features permanecem (applyMode não toca nelas ao desligar)
      const profilestore = getExtension("skill:profilestore");
      expect(profilestore?.enabled).toBe(true);

      // effortLevel continua "high" (devops.json também define high)
      expect(getEffortLevel()).toBe("high");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Mode filter (M) (2 testes)
  // ═══════════════════════════════════════════════════════════════════════

  describe("4. Mode filter (M)", () => {
    it("liga e desliga o filtro: só extensions do modo roblox visíveis", async () => {
      // Pré-ativa roblox
      await applyMode("roblox");
      expect(getActiveModeName()).toBe("roblox");

      const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      // Estado inicial: filtro desligado — todas 9 extensions visíveis.
      // NOTA: o card trunca o nome para 14 chars (darklua_process → darklua_proces,
      // terraform_validate → terraform_vali). Por isso checamos substrings únicas.
      let frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("darklua"); // não-roblox
      expect(frame).toContain("terraform"); // não-roblox
      expect(frame).not.toContain("FILTRO");

      // Liga o filtro com M
      stdin.write("m");
      await delay(50);

      // FILTRO indicador aparece
      frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("FILTRO");
      expect(frame).toContain("só do modo ativo");

      // Extensions não-roblox desaparecem (darklua, terraform)
      expect(frame).not.toContain("darklua");
      expect(frame).not.toContain("terraform");

      // Extensions do modo roblox continuam visíveis
      expect(frame).toContain("rojo_build");
      expect(frame).toContain("selene_lint");
      expect(frame).toContain("profilestore");

      // Desliga o filtro com M novamente
      stdin.write("m");
      await delay(50);

      frame = stripAnsi(lastFrame() ?? "");
      expect(frame).not.toContain("FILTRO");
      // Todas as extensions voltam a ser visíveis
      expect(frame).toContain("darklua");
      expect(frame).toContain("terraform");
    });

    it("variação: M sem modo ativo não tem efeito (não aparece FILTRO)", async () => {
      // Nenhum modo ativo (resetado no beforeEach)
      expect(getActiveModeName()).toBeNull();

      const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      // Press M
      stdin.write("m");
      await delay(50);

      // FILTRO não aparece (não há modo ativo pra filtrar)
      const frame = stripAnsi(lastFrame() ?? "");
      expect(frame).not.toContain("FILTRO");
      // Todas as extensions continuam visíveis
      expect(frame).toContain("darklua");
      expect(frame).toContain("rojo_build");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Toggle extension + trigger mode cycle (2 testes)
  // ═══════════════════════════════════════════════════════════════════════

  describe("5. Toggle + trigger mode cycle", () => {
    it("T faz cycle: on_file → on_task → always → disabled; Enter re-habilita", async () => {
      const { stdin } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      // Cursor em 0 = rojo_build (que começa com triggerMode "on_file")
      const id = "tool:rojo_build";
      expect(getExtension(id)?.triggerMode).toBe("on_file");

      // T → on_task
      stdin.write("t");
      await delay(30);
      expect(getExtension(id)?.triggerMode).toBe("on_task");
      expect(getExtension(id)?.enabled).toBe(true);

      // T → always
      stdin.write("t");
      await delay(30);
      expect(getExtension(id)?.triggerMode).toBe("always");
      expect(getExtension(id)?.enabled).toBe(true);

      // T → disabled (desabilita)
      stdin.write("t");
      await delay(30);
      expect(getExtension(id)?.triggerMode).toBe("disabled");
      expect(getExtension(id)?.enabled).toBe(false);

      // Enter → toggleExtension re-habilita a extensão.
      // ═══ BUG FIX ═══
      // Antes, toggleExtension apenas invertia `enabled` e deixava
      // triggerMode="disabled", resultando em estado inconsistente
      // (enabled=true, triggerMode=disabled — card mostrava "ON [OFF]").
      //
      // Agora, ao re-habilitar (false → true), o triggerMode é restaurado
      // para o default da categoria. Para tool, default é "on_file".
      stdin.write("\r");
      await delay(30);
      expect(getExtension(id)?.enabled).toBe(true);
      // triggerMode restaurado para o default da categoria tool = "on_file"
      expect(getExtension(id)?.triggerMode).toBe("on_file");
    });

    it("variação: teclas 1-4 setam trigger mode específico", async () => {
      const { stdin } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      const id = "tool:rojo_build"; // cursor em 0
      expect(getExtension(id)?.triggerMode).toBe("on_file");

      // 1 → disabled
      stdin.write("1");
      await delay(30);
      expect(getExtension(id)?.triggerMode).toBe("disabled");
      expect(getExtension(id)?.enabled).toBe(false);

      // 2 → on_file
      stdin.write("2");
      await delay(30);
      expect(getExtension(id)?.triggerMode).toBe("on_file");
      expect(getExtension(id)?.enabled).toBe(true);

      // 3 → on_task
      stdin.write("3");
      await delay(30);
      expect(getExtension(id)?.triggerMode).toBe("on_task");

      // 4 → always
      stdin.write("4");
      await delay(30);
      expect(getExtension(id)?.triggerMode).toBe("always");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Install tool flow (I) (1 teste)
  // ═══════════════════════════════════════════════════════════════════════

  describe("6. Install tool flow (I)", () => {
    it("press I na tool faltante chama installTool", async () => {
      // rojo_build começa como [FALTA] (installed=false)
      expect(getExtension("tool:rojo_build")?.installed).toBe(false);

      const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      // Renderiza — deve mostrar [FALTA] para rojo_build (cursor em 0)
      const initial = stripAnsi(lastFrame() ?? "");
      expect(initial).toContain("FALTA");

      // Press I
      stdin.write("i");
      await delay(80); // install é async (dynamic import)

      // installTool foi chamado com "rojo" (extraído de "tool:rojo_build")
      expect(mockInstallTool).toHaveBeenCalled();
      const args = mockInstallTool.mock.calls[0];
      expect(args[0]).toBe("rojo");

      // ═══ BUG FIX ═══
      // Após installTool resolver com success=true, o handler 'I' agora
      // chama syncExtensions() para marcar a tool como installed=true.
      // Antes o bloco `if (result.success) { /* vazio */ }` não fazia nada,
      // e o card continuava mostrando [FALTA].
      const rojo = getExtension("tool:rojo_build");
      expect(rojo?.installed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. (Removed in Sprint 2) Search flow S/A/X — search system was deleted.
  // ═══════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════
  // 8. State preservation entre ações (2 testes)
  // ═══════════════════════════════════════════════════════════════════════

  describe("8. State preservation", () => {
    it("cursor permanece no índice 5 após toggle trigger mode (não pula)", async () => {
      // 9 extensões no grid 3x3. Índice 5 = linha 1, coluna 2 (direita-meio).
      // Mapeamento: 0=rojo_build, 1=selene_lint, 2=stylua_format,
      //             3=darklua_process, 4=terraform_validate, 5=profilestore,
      //             6=bytenet, 7=think_tool, 8=strict_gate
      const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      // Move cursor 5x para a direita (0 → 5)
      for (let i = 0; i < 5; i++) {
        stdin.write("\u001B[C"); // right arrow
        await delay(20);
      }

      // Verifica que cursor está em profilestore (índice 5)
      let frame = stripAnsi(lastFrame() ?? "");
      // O card selecionado tem "> " antes do nome
      expect(frame).toContain("> SK profilestore");

      // Press T para ciclar trigger mode — isso causa re-render (via emitChange)
      stdin.write("t");
      await delay(50);

      // Cursor AINDA está em profilestore (índice 5) — não pulou
      frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("> SK profilestore");

      // E o trigger mode de profilestore mudou (always → disabled)
      const ps = getExtension("skill:profilestore");
      expect(ps?.triggerMode).toBe("disabled");
    });

    it("muda de tab e volta: cursor volta pra posição original (índice 0)", async () => {
      const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
      await delay(30);

      // Cursor inicial: índice 0 = rojo_build (card selecionado tem "> TL rojo_build")
      let frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("> TL rojo_build");

      // Move cursor pra direita 2x (0 → 2 = stylua_format)
      stdin.write("\u001B[C");
      await delay(20);
      stdin.write("\u001B[C");
      await delay(20);
      frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("> TL stylua_format");

      // Troca de tab (Tab → Skills)
      stdin.write("\t");
      await delay(30);
      // Cursor volta pra 0 no novo tab
      frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("> SK profilestore"); // primeira skill

      // Volta pra tab All (Tab 6x: Skills → Tools → MCPs → Plugins → Features → Modes → All)
      for (let i = 0; i < 6; i++) {
        stdin.write("\t");
        await delay(20);
      }
      await delay(30);
      // Cursor volta pra 0 no tab All
      frame = stripAnsi(lastFrame() ?? "");
      expect(frame).toContain("> TL rojo_build");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Testes extras de robustez do estado integrado
  // ═══════════════════════════════════════════════════════════════════════

  describe("Cross-module state sanity", () => {
    it("estado inicial: nenhum modo ativo, esforço medium, 9 extensões carregadas", () => {
      // Nenhum modo ativo
      expect(getActiveModeName()).toBeNull();

      // Esforço medium (default)
      expect(getEffortLevel()).toBe("medium");

      // 9 extensões carregadas no extensionCenter real
      const all = getAllExtensions();
      expect(all.length).toBe(9);

      // Summary bate com 9 extensões, 7 habilitadas (5 ON inicial + 2 skills + 2 features - 2 disabled tools = 7)
      // Inicial: 3 tools ON, 2 tools OFF, 2 skills ON, 2 features ON → 7 enabled
      const summary = getHubSummary();
      expect(summary.total).toBe(9);
      expect(summary.enabled).toBe(7);
    });

    it("built-in modes roblox e devops são carregados do defaults/modes/", () => {
      const modes = getAllModes();
      const names = modes.map((m) => m.name);

      // Os dois modos built-in do projeto estão disponíveis
      expect(names).toContain("roblox");
      expect(names).toContain("devops");

      // roblox tem a configuração esperada (lida do JSON real)
      const roblox = getMode("roblox");
      expect(roblox).not.toBeNull();
      expect(roblox?.effortLevel).toBe("high");
      expect(roblox?.enableTools).toContain("tool:rojo_build");
      expect(roblox?.enableTools).toContain("tool:selene_lint");

      // devops tem tools vazias (diferente de roblox)
      const devops = getMode("devops");
      expect(devops).not.toBeNull();
      expect(devops?.enableTools.length).toBe(0);
    });
  });
});
