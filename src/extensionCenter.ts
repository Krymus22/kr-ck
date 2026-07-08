/**
 * extensionCenter.ts - Extension Hub: unified control center for skills, tools, MCPs, and plugins.
 *
 * Provides:
 *   - Central registry of all extensions across categories
 *   - Toggle on/off + trigger mode per extension
 *   - Persistence to ~/.claude-killer/hub.json
 *   - Trigger engine: auto-execute extensions based on trigger mode
 *
 * Trigger Modes:
 *   - disabled:  Never runs
 *   - on_file:   Runs after every file modification
 *   - on_task:   Runs when agent finishes a complete task (finish_reason === "stop")
 *   - always:    Runs on every agent loop iteration
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as log from "./logger.js";
import { getRegistry } from "./externalTools.js";
import { getActiveMCPServers } from "./extensions.js";

// --- Types ------------------------------------------------------------------

export type ExtensionCategory = "skill" | "tool" | "mcp" | "plugin" | "feature";
export type TriggerMode = "disabled" | "on_file" | "on_task" | "always";

export interface ExtensionEntry {
  id: string;
  name: string;
  category: ExtensionCategory;
  description: string;
  enabled: boolean;
  triggerMode: TriggerMode;
  installed: boolean;
  /** Optional: extra metadata (version, path, etc.) */
  meta?: Record<string, string>;
}

export interface ExtensionHubState {
  extensions: ExtensionEntry[];
  version: number;
  lastUpdated: string;
}

export interface TriggerContext {
  /** Which file was modified (for on_file) */
  filePath?: string;
  /** Tool name that was called */
  toolName?: string;
  /** Full agent loop iteration count */
  iteration?: number;
  /** Current working directory */
  cwd: string;
}

export interface TriggerResult {
  extensionId: string;
  success: boolean;
  output: string;
  duration: number;
}

// --- Constants --------------------------------------------------------------

const HUB_VERSION = 1;
const HUB_FILENAME = "hub.json";

const TRIGGER_MODES: TriggerMode[] = ["disabled", "on_file", "on_task", "always"];
const TRIGGER_LABELS: Record<TriggerMode, string> = {
  disabled: "OFF",
  on_file: "FILE",
  on_task: "TASK",
  always: "EVERY",
};

// --- Persistence ------------------------------------------------------------

function getHubPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return path.join(home, ".claude-killer", HUB_FILENAME);
}

function ensureDir(): void {
  const dir = path.dirname(getHubPath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// --- Reactive subscription system -------------------------------------------
//
// BUG FIX (audit issue #1 — setRenderKey hack): the Hub component used to
// call setRenderKey((n) => n + 1) after every mutation (25 occurrences) to
// force a remount, because the store here was non-reactive — React had no
// way to know when hubState changed.
//
// Now we expose a subscribe() function and a getSnapshot() function that
// work with React's useSyncExternalStore(). Every mutation calls
// emitChange() which notifies all subscribers, who then re-render naturally
// without losing focus or component state.
//
// The version counter is the snapshot — useSyncExternalStore compares
// snapshots by Object.is, so we bump the version on every change.

let hubVersion = 0;
const subscribers = new Set<() => void>();

/**
 * Subscribe to store changes. Returns an unsubscribe function.
 * Used by React's useSyncExternalStore.
 */
export function subscribeToHubChanges(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/**
 * Get the current store version. Bumped on every mutation.
 * Used by React's useSyncExternalStore as the snapshot.
 */
export function getHubVersion(): number {
  return hubVersion;
}

/**
 * Notify all subscribers that the store changed.
 * Called internally after every mutation (toggle, setTriggerMode, etc).
 */
function emitChange(): void {
  hubVersion++;
  // BUG FIX (concurrency race — mirrors Bug Hunter #8c fix in activityTracker
  // and the Round 4 Concurrency Hunter fix in fileWatcher): previously
  // iterated `subscribers` Set directly. A listener that called its own
  // unsubscribe() (common one-shot pattern) or subscribeToHubChanges()
  // (e.g. a React effect re-subscribing after a state change) mutated the
  // Set mid-iteration — leading to non-deterministic behavior (a newly-
  // subscribed listener might be called or skipped depending on V8's Set
  // iteration order, and a just-removed listener might still be called
  // once). Snapshot the subscribers into an array so notification is
  // stable regardless of any subscribe/unsubscribe that happens inside a
  // listener.
  const snapshot = Array.from(subscribers);
  for (const listener of snapshot) {
    try {
      listener();
    } catch (err) {
      log.warn(`Hub subscriber threw: ${(err as Error).message}`);
    }
  }
}

function loadState(): ExtensionHubState {
  const p = getHubPath();
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as ExtensionHubState;
      if (parsed.version === HUB_VERSION && Array.isArray(parsed.extensions)) {
        // Check if this is an old state with all features disabled (v1.0 bug)
        // If so, discard and start fresh with new defaults
        const allDisabled = parsed.extensions.every(e => !e.enabled || e.triggerMode === "disabled");
        const hasFeatures = parsed.extensions.some(e => e.category === "feature");
        if (hasFeatures && allDisabled) {
          log.info("Hub: resetting state to apply new default settings");
          const fresh = { extensions: [], version: HUB_VERSION, lastUpdated: new Date().toISOString() };
          saveState(fresh);
          return fresh;
        }
        return parsed;
      }
    }
  } catch (err) {
    log.warn(`Failed to load hub state: ${(err as Error).message}`);
  }
  return { extensions: [], version: HUB_VERSION, lastUpdated: new Date().toISOString() };
}

function saveState(state: ExtensionHubState): void {
  ensureDir();
  state.lastUpdated = new Date().toISOString();
  try {
    fs.writeFileSync(getHubPath(), JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    log.warn(`Failed to save hub state: ${(err as Error).message}`);
  }
}

// --- Registry ---------------------------------------------------------------

let hubState: ExtensionHubState = loadState();

/** Get all registered extensions. */
export function getAllExtensions(): readonly ExtensionEntry[] {
  return hubState.extensions;
}

/** Get extensions filtered by category. */
export function getExtensionsByCategory(category: ExtensionCategory): readonly ExtensionEntry[] {
  return hubState.extensions.filter((e) => e.category === category);
}

/** Get only enabled extensions. */
export function getEnabledExtensions(): readonly ExtensionEntry[] {
  return hubState.extensions.filter((e) => e.enabled && e.triggerMode !== "disabled");
}

/** Get enabled extensions for a specific trigger mode. */
export function getExtensionsForTrigger(mode: TriggerMode): readonly ExtensionEntry[] {
  return hubState.extensions.filter((e) => e.enabled && e.triggerMode === mode);
}

/** Find extension by id. */
export function getExtension(id: string): ExtensionEntry | undefined {
  return hubState.extensions.find((e) => e.id === id);
}

/**
 * Register or update extensions from external sources (skills, tools, MCPs, plugins).
 * Existing entries preserve their enabled/triggerMode state.
 */
export function syncExtensions(entries: Omit<ExtensionEntry, "enabled" | "triggerMode">[]): void {
  const existingMap = new Map(hubState.extensions.map((e) => [e.id, e]));

  const merged: ExtensionEntry[] = entries.map((entry) => {
    const existing = existingMap.get(entry.id);
    
    // Default behavior:
    // - Features internas (Think Tool, Rollback, etc): ON by default
    // - Tools externas (Roblox, Python, etc): OFF by default
    // - Skills: ON by default (user installed them)
    // - MCPs: ON by default (user configured them)
    const isInternalFeature = entry.category === "feature";
    const defaultEnabled = isInternalFeature ? true : entry.installed && entry.category !== "tool";
    // BUG FIX (P-5 property test): quando defaultEnabled=true for categoria
    // não-feature (skill/mcp/plugin instalados), usar defaultTriggerForCategory
    // em vez de "disabled". Antes, o estado inicial ficava inconsistente —
    // enabled=true MAS triggerMode="disabled" — fazendo o card mostrar "ON
    // [OFF]" e getEnabledExtensions() filtrar a extensão. tools continuam com
    // defaultEnabled=false (logo defaultTrigger="disabled") — não muda nada
    // for elas.
    const defaultTrigger: TriggerMode = defaultEnabled
      ? defaultTriggerForCategory(entry.category)
      : "disabled";
    
    return {
      ...entry,
      enabled: existing?.enabled ?? defaultEnabled,
      triggerMode: existing?.triggerMode ?? defaultTrigger,
    };
  });

  hubState.extensions = merged;
  saveState(hubState);
  emitChange();
}

/** Toggle enabled/disabled for an extension. Returns new state. */
export function toggleExtension(id: string): boolean | null {
  const ext = hubState.extensions.find((e) => e.id === id);
  if (!ext) return null;
  ext.enabled = !ext.enabled;
  if (!ext.enabled) {
    // Desligando: marca como disabled.
    ext.triggerMode = "disabled";
  } else if (ext.triggerMode === "disabled") {
    // Re-habilitando: restaura o triggerMode for um default sensato baseado
    // na categoria (BUG FIX — antes o triggerMode ficava "disabled" mesmo com
    // enabled=true, deixando a extensão em estado inconsistente — o card
    // mostrava "ON [OFF]" e getEnabledExtensions filtrava ela).
    ext.triggerMode = defaultTriggerForCategory(ext.category);
  }
  saveState(hubState);
  emitChange();
  return ext.enabled;
}

/**
 * Trigger mode default por categoria, usado ao re-habilitar uma extensão
 * via toggleExtension (não temos info do triggerMode anterior).
 *   - feature: "always" (features internas rodam sempre)
 *   - tool:    "on_file" (rodam após modificar arquivo)
 *   - skill:   "on_file"
 *   - mcp:     "on_task" (rodados ao terminar task)
 *   - plugin:  "on_file"
 */
function defaultTriggerForCategory(category: ExtensionCategory): TriggerMode {
  switch (category) {
    case "feature": return "always";
    case "mcp":     return "on_task";
    case "tool":
    case "skill":
    case "plugin":
    default:        return "on_file";
  }
}

/** Set trigger mode for an extension. Returns new mode or null if not found. */
export function setTriggerMode(id: string, mode: TriggerMode): TriggerMode | null {
  const ext = hubState.extensions.find((e) => e.id === id);
  if (!ext) return null;
  ext.triggerMode = mode;
  ext.enabled = mode !== "disabled";
  saveState(hubState);
  emitChange();
  return ext.triggerMode;
}

/** Cycle trigger mode to next value. Returns new mode. */
export function cycleTriggerMode(id: string): TriggerMode | null {
  const ext = hubState.extensions.find((e) => e.id === id);
  if (!ext) return null;
  const currentIdx = TRIGGER_MODES.indexOf(ext.triggerMode);
  const nextIdx = (currentIdx + 1) % TRIGGER_MODES.length;
  const nextMode = TRIGGER_MODES[nextIdx] ?? "disabled";
  ext.triggerMode = nextMode;
  ext.enabled = nextMode !== "disabled";
  saveState(hubState);
  emitChange();
  return ext.triggerMode;
}

/** Enable all extensions in a category with a specific trigger mode. */
export function enableAllInCategory(category: ExtensionCategory, mode: TriggerMode): number {
  let count = 0;
  for (const ext of hubState.extensions) {
    if (ext.category === category && ext.installed) {
      ext.triggerMode = mode;
      ext.enabled = mode !== "disabled";
      count++;
    }
  }
  saveState(hubState);
  emitChange();
  return count;
}

/** Disable all extensions. */
export function disableAll(): void {
  for (const ext of hubState.extensions) {
    ext.enabled = false;
    ext.triggerMode = "disabled";
  }
  saveState(hubState);
  emitChange();
}

// --- Trigger Engine ---------------------------------------------------------

type ExtensionExecutor = (ext: ExtensionEntry, ctx: TriggerContext) => Promise<string>;

let executor: ExtensionExecutor | null = null;

/** Register the executor function that will run extensions. */
export function registerExecutor(fn: ExtensionExecutor): void {
  executor = fn;
}

/**
 * Run all extensions matching a trigger mode.
 * Called from the agent loop at appropriate lifecycle points.
 */
export async function executeTrigger(
  mode: TriggerMode,
  ctx: TriggerContext
): Promise<TriggerResult[]> {
  if (!executor) return [];

  const extensions = getExtensionsForTrigger(mode);
  if (extensions.length === 0) return [];

  const results: TriggerResult[] = [];
  for (const ext of extensions) {
    const start = Date.now();
    try {
      const output = await executor(ext, ctx);
      results.push({
        extensionId: ext.id,
        success: true,
        output,
        duration: Date.now() - start,
      });
    } catch (err) {
      results.push({
        extensionId: ext.id,
        success: false,
        output: (err as Error).message,
        duration: Date.now() - start,
      });
    }
  }
  return results;
}

// --- Auto-Discovery ---------------------------------------------------------

/**
 * Scan all extension sources and sync to hub.
 * Called once at startup to populate the hub with available extensions.
 */
export function discoverExtensions(): void {
  const entries: Omit<ExtensionEntry, "enabled" | "triggerMode">[] = [];

  // Discover skills from disk
  discoverSkills(entries);

  // Discover external tools from registry
  discoverTools(entries);

  // Discover MCP servers from config
  discoverMCPServers(entries);

  // Discover Claude-Killer features (effort, strict mode, LSP, etc.)
  discoverFeatures(entries);

  syncExtensions(entries);
  log.debug(`Extension Hub: discovered ${entries.length} extensions`);
}

function discoverSkills(entries: Omit<ExtensionEntry, "enabled" | "triggerMode">[]): void {
  const dirs = [
    path.join(process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(), ".claude-killer", "skills"),
    path.join(process.cwd(), ".claude-killer", "skills"),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".yaml") || f.endsWith(".yml"));
      for (const file of files) {
        const filePath = path.join(dir, file);
        const name = path.basename(file, path.extname(file));
        entries.push({
          id: `skill:${name}`,
          name,
          category: "skill",
          description: `Skill: ${name}`,
          installed: true,
          meta: { path: filePath },
        });
      }
    } catch {
      // Skip unreadable dirs
    }
  }
}

function discoverTools(entries: Omit<ExtensionEntry, "enabled" | "triggerMode">[]): void {
  let registry: ReturnType<typeof getRegistry> | null = null;
  try {
    registry = getRegistry();
  } catch {
    // External tools module not available
    return;
  }
  if (!registry) return;

  const tools = registry.getAll?.() ?? [];
  for (const tool of tools) {
    entries.push({
      id: `tool:${tool.name}`,
      name: tool.name,
      category: "tool",
      description: tool.description ?? "",
      installed: registry.isInstalled?.(tool.name) ?? false,
      meta: { command: tool.command ?? "" },
    });
  }
}

function discoverMCPServers(entries: Omit<ExtensionEntry, "enabled" | "triggerMode">[]): void {
  let servers: string[] = [];
  try {
    servers = getActiveMCPServers() ?? [];
  } catch {
    // Extensions module not available
    return;
  }
  for (const serverName of servers) {
    entries.push({
      id: `mcp:${serverName}`,
      name: serverName,
      category: "mcp",
      description: `MCP Server: ${serverName}`,
      installed: true,
    });
  }
}

// --- Feature Discovery -----------------------------------------------------

function discoverFeatures(entries: Omit<ExtensionEntry, "enabled" | "triggerMode">[]): void {
  const features = [
    {
      id: "feature:think_tool",
      name: "Think Tool",
      description: "Espaco estruturado de raciocinio (pensar) antes de cada escrita",
      installed: true,
      meta: { module: "thinkTool" },
    },
    {
      id: "feature:read_before_write",
      name: "Read-before-Write",
      description: "Bloqueia edicoes em arquivos que nao foram lidos primeiro",
      installed: true,
      meta: { module: "readBeforeWrite" },
    },
    {
      id: "feature:rollback",
      name: "Auto Rollback",
      description: "Salva backups em .rollback/ antes de cada edicao",
      installed: true,
      meta: { module: "rollbackStore" },
    },
    {
      id: "feature:strict_gate",
      name: "Strict Quality Gate",
      description: "Bloqueia finish_reason ate tsc + lint passarem",
      installed: true,
      meta: { module: "strictQualityGate" },
    },
    {
      id: "feature:schema_validation",
      name: "Schema Validation",
      description: "Valida argumentos de tools contra JSON Schema antes de executar",
      installed: true,
      meta: { module: "toolSchemaValidation" },
    },
    {
      id: "feature:poka_yoke",
      name: "Poka-Yoke",
      description: "Validacao de caminhos, estrutura de diff, descricoes expandidas",
      installed: true,
      meta: { module: "pokaYoke" },
    },
    {
      id: "feature:task_state",
      name: "Task State",
      description: "TASK_STATE.md estruturado (feito/falta/decisoes/bugs)",
      installed: true,
      meta: { module: "taskState" },
    },
    {
      id: "feature:self_validation",
      name: "Self-Validation",
      description: "Forca reflexao do modelo antes do finish_reason",
      installed: true,
      meta: { module: "selfValidation" },
    },
    {
      id: "feature:context_injection",
      name: "Context Injection",
      description: "Injeta TASK_STATE.md automaticamente antes de cada decisao",
      installed: true,
      meta: { module: "contextInjector" },
    },
    {
      id: "feature:auto_test",
      name: "Auto-Test Gen",
      description: "Sugere testes apos cada diff (pula Luau/Roblox)",
      installed: true,
      meta: { module: "autoTestGenerator" },
    },
    {
      id: "feature:lsp",
      name: "LSP Integration",
      description: "LSP real (tsserver/pylsp) com fallback for tree-sitter",
      installed: true,
      meta: { module: "lspClient" },
    },
    {
      id: "feature:sub_agents",
      name: "Sub-Agents",
      description: "Sub-agentes paralelos com retry e checkpoint",
      installed: true,
      meta: { module: "subAgents" },
    },
    {
      id: "feature:model_compaction",
      name: "Model Compaction",
      description: "LLM sumariza contexto preservando decisoes e bugs",
      installed: true,
      meta: { module: "contextCompaction" },
    },
    {
      id: "feature:multi_key_pool",
      name: "Multi-Key Pool",
      description: "Pool de chaves API com round-robin e cooldown 429",
      installed: true,
      meta: { module: "apiKeyPool" },
    },
  ];

  // Honesty system features (10 anti-sycophancy / anti-hallucination layers)
  const honestyFeatures = [
    { id: "feature:devils_advocate", name: "Devil's Advocate", description: "Sub-agente adversarial revisa codigo antes de finalizar", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:diff_reality_check", name: "Diff Reality Check", description: "Verifica se arquivo editado contem o que a IA disse que adicionou", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:read_back_verify", name: "Read-Back Verify", description: "Forca IA a ler arquivo de volta apos editar", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:hallucination_detector", name: "Hallucination Detector", description: "Verifica se simbolos usados realmente existem", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:evidence_requirement", name: "Evidence Requirement", description: "Claims sem tool call de evidencia sao flagadas", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:user_claim_verify", name: "User Claim Verify", description: "Verifica automaticamente claims factuais do usuario", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:confidence_mapping", name: "Confidence Mapping", description: "IA classifica confianca (1-10) antes de agir", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:anonymous_review", name: "Anonymous Review", description: "Sub-agente neutro revisa codigo as cegas", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:contradiction_tracker", name: "Contradiction Tracker", description: "Rastreia claims e alerta se nova claim contradiz anterior", installed: true, meta: { module: "honestySystem" } },
    { id: "feature:prove_it_mode", name: "Prove It Mode", description: "Toda claim factual deve ter tool call que a comprova", installed: true, meta: { module: "honestySystem" } },
  ];

  for (const f of [...features, ...honestyFeatures]) {
    entries.push({ ...f, category: "feature" });
  }
}

// --- UI Helpers -------------------------------------------------------------

export function getTriggerLabel(mode: TriggerMode): string {
  return TRIGGER_LABELS[mode];
}

export function getTriggerModes(): readonly TriggerMode[] {
  return TRIGGER_MODES;
}

export function getCategoryIcon(category: ExtensionCategory): string {
  switch (category) {
    case "skill": return "SK";    // Skill
    case "tool": return "TL";     // Tool
    case "mcp": return "MC";      // MCP
    case "plugin": return "PL";   // Plugin
    case "feature": return "FT";  // Feature
  }
}

export function getCategoryColor(category: ExtensionCategory): string {
  switch (category) {
    case "skill": return "#6EE7F7";
    case "tool": return "#FBBF24";
    case "mcp": return "#A78BFA";
    case "plugin": return "#34D399";
    case "feature": return "#60A5FA";
  }
}

// --- Summary ----------------------------------------------------------------

export function getHubSummary(): {
  total: number;
  enabled: number;
  byCategory: Record<ExtensionCategory, { total: number; enabled: number }>;
  byTrigger: Record<TriggerMode, number>;
} {
  const byCategory: Record<ExtensionCategory, { total: number; enabled: number }> = {
    skill: { total: 0, enabled: 0 },
    tool: { total: 0, enabled: 0 },
    mcp: { total: 0, enabled: 0 },
    plugin: { total: 0, enabled: 0 },
    feature: { total: 0, enabled: 0 },
  };
  const byTrigger: Record<TriggerMode, number> = {
    disabled: 0,
    on_file: 0,
    on_task: 0,
    always: 0,
  };

  for (const ext of hubState.extensions) {
    byCategory[ext.category].total++;
    if (ext.enabled) byCategory[ext.category].enabled++;
    byTrigger[ext.triggerMode]++;
  }

  return {
    total: hubState.extensions.length,
    enabled: hubState.extensions.filter((e) => e.enabled).length,
    byCategory,
    byTrigger,
  };
}
