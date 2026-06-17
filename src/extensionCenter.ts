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

function loadState(): ExtensionHubState {
  const p = getHubPath();
  try {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as ExtensionHubState;
      if (parsed.version === HUB_VERSION && Array.isArray(parsed.extensions)) {
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
    return {
      ...entry,
      enabled: existing?.enabled ?? entry.installed,
      triggerMode: existing?.triggerMode ?? "disabled",
    };
  });

  hubState.extensions = merged;
  saveState(hubState);
}

/** Toggle enabled/disabled for an extension. Returns new state. */
export function toggleExtension(id: string): boolean | null {
  const ext = hubState.extensions.find((e) => e.id === id);
  if (!ext) return null;
  ext.enabled = !ext.enabled;
  if (!ext.enabled) {
    ext.triggerMode = "disabled";
  }
  saveState(hubState);
  return ext.enabled;
}

/** Set trigger mode for an extension. Returns new mode or null if not found. */
export function setTriggerMode(id: string, mode: TriggerMode): TriggerMode | null {
  const ext = hubState.extensions.find((e) => e.id === id);
  if (!ext) return null;
  ext.triggerMode = mode;
  ext.enabled = mode !== "disabled";
  saveState(hubState);
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
  return count;
}

/** Disable all extensions. */
export function disableAll(): void {
  for (const ext of hubState.extensions) {
    ext.enabled = false;
    ext.triggerMode = "disabled";
  }
  saveState(hubState);
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
  try {
    // Dynamic import to avoid circular dependency
    const mod = require("./externalTools.js");
    const registry = mod.getRegistry?.();
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
  } catch {
    // External tools module not available
  }
}

function discoverMCPServers(entries: Omit<ExtensionEntry, "enabled" | "triggerMode">[]): void {
  try {
    const mod = require("./extensions.js");
    const servers = mod.getActiveMCPServers?.() ?? [];
    for (const serverName of servers) {
      entries.push({
        id: `mcp:${serverName}`,
        name: serverName,
        category: "mcp",
        description: `MCP Server: ${serverName}`,
        installed: true,
      });
    }
  } catch {
    // Extensions module not available
  }
}

// --- Feature Discovery -----------------------------------------------------

function discoverFeatures(entries: Omit<ExtensionEntry, "enabled" | "triggerMode">[]): void {
  const features = [
    {
      id: "feature:think_tool",
      name: "Think Tool",
      description: "Structured reasoning space (pensar) before each write",
      installed: true,
      meta: { module: "thinkTool" },
    },
    {
      id: "feature:read_before_write",
      name: "Read-before-Write",
      description: "Blocks edits on files that haven't been read first",
      installed: true,
      meta: { module: "readBeforeWrite" },
    },
    {
      id: "feature:rollback",
      name: "Auto Rollback",
      description: "Saves backups in .rollback/ before each edit",
      installed: true,
      meta: { module: "rollbackStore" },
    },
    {
      id: "feature:strict_gate",
      name: "Strict Quality Gate",
      description: "Blocks finish_reason until tsc + lint pass",
      installed: true,
      meta: { module: "strictQualityGate" },
    },
    {
      id: "feature:schema_validation",
      name: "Schema Validation",
      description: "Validates tool args against JSON Schema before execution",
      installed: true,
      meta: { module: "toolSchemaValidation" },
    },
    {
      id: "feature:poka_yoke",
      name: "Poka-Yoke",
      description: "Error-proofing: path validation, diff structure checks",
      installed: true,
      meta: { module: "pokaYoke" },
    },
    {
      id: "feature:task_state",
      name: "Task State",
      description: "Structured TASK_STATE.md (done/todo/bugs/decisions)",
      installed: true,
      meta: { module: "taskState" },
    },
    {
      id: "feature:self_validation",
      name: "Self-Validation",
      description: "Forces model to reflect before finish_reason",
      installed: true,
      meta: { module: "selfValidation" },
    },
    {
      id: "feature:context_injection",
      name: "Context Injection",
      description: "Auto-injects TASK_STATE.md before each decision",
      installed: true,
      meta: { module: "contextInjector" },
    },
    {
      id: "feature:auto_test",
      name: "Auto-Test Gen",
      description: "Suggests tests after each diff (skip Luau/Roblox)",
      installed: true,
      meta: { module: "autoTestGenerator" },
    },
    {
      id: "feature:lsp",
      name: "LSP Integration",
      description: "Real LSP (tsserver/pylsp) with tree-sitter fallback",
      installed: true,
      meta: { module: "lspClient" },
    },
    {
      id: "feature:sub_agents",
      name: "Sub-Agents",
      description: "Parallel exploration sub-agents with retry+checkpoint",
      installed: true,
      meta: { module: "subAgents" },
    },
    {
      id: "feature:model_compaction",
      name: "Model Compaction",
      description: "LLM summarizes context preserving decisions/bugs",
      installed: true,
      meta: { module: "contextCompaction" },
    },
    {
      id: "feature:multi_key_pool",
      name: "Multi-Key Pool",
      description: "Round-robin API key pool with 429 cooldown",
      installed: true,
      meta: { module: "apiKeyPool" },
    },
  ];

  for (const f of features) {
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
    case "skill": return "[S]";
    case "tool": return "[T]";
    case "mcp": return "[M]";
    case "plugin": return "[P]";
    case "feature": return "[F]";
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
