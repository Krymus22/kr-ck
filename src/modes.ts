/**
 * modes.ts - Project-mode system for Claude-Killer.
 *
 * A "mode" is a named preset that activates a specific combination of:
 *   - External CLI tools (from ~/.claude-killer/tools/*.json)
 *   - Skills (from ~/.claude-killer/skills/*.md)
 *   - Internal features (effort level, strict mode, read-before-write, etc.)
 *   - Luau validation rules (selene, stylua, luau-lsp, lune)
 *
 * Built-in modes:
 *   - "roblox": full Roblox external development preset
 *     (activates Rojo, Wally, Lune, Selene, StyLua, Rokit, wally-package-types,
 *      enables luau validation gate, sets effort=high, enables all Roblox skills)
 *
 * User-defined modes:
 *   - Stored at ~/.claude-killer/modes/<name>.json
 *   - User describes intent ("I want to write a Rust CLI"), AI suggests tool list
 *   - User confirms before activation
 *
 * Persistence:
 *   - Active mode: stored in ~/.claude-killer/modes/active.json (single string)
 *   - Mode definitions: ~/.claude-killer/modes/<name>.json
 *
 * Built-in mode "roblox" is bundled at defaults/modes/roblox.json and seeded
 * into the user's home directory on first run (see configSeeder.ts).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as log from "./logger.js";
import { fileURLToPath } from "node:url";

// --- Types ------------------------------------------------------------------

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface ModeValidationRule {
  /** Tool name that must be enabled for this rule to apply (e.g. "selene_lint") */
  tool: string;
  /** Files to validate (glob: "*.luau", "*.lua", or specific paths) */
  filePattern: string;
  /** Whether validation blocks file write (true) or just warns (false) */
  blocking: boolean;
  /**
   * Custom command to run (NEW - if set, runs this command instead of the
   * built-in tool dispatcher). Use {file} as placeholder for the file path.
   * Examples:
   *   "selene --no-global-check {file}"
   *   "terraform fmt -check {file}"
   *   "yamllint {file}"
   *   "mypy --strict {file}"
   * If not set, falls back to built-in selene/stylua/luau-lsp behavior.
   */
  command?: string;
}

export interface ModeSafetyPattern {
  /** Regex pattern to search for in proposed code (string form, will be compiled) */
  regex: string;
  /** Human-readable description shown to AI when pattern matches */
  description: string;
  /** Severity: "low" | "medium" | "high" - high blocks writes */
  severity: "low" | "medium" | "high";
}

export interface ModeSymbolPattern {
  /** Language name (used as key in symbolPatterns map) */
  language: string;
  /** File extensions for this language (e.g. [".luau", ".lua"]) */
  extensions: string[];
  /** Regex patterns to extract symbols (with capture group 1 or 2 = symbol name) */
  patterns: string[];
}

export interface ModeHook {
  /** Glob pattern for which files this hook runs (e.g. "*.tf", "*.py") */
  filePattern: string;
  /** Command to run. {file} is replaced with the file path. */
  command: string;
  /** Whether hook failure blocks the operation (true) or just warns (false) */
  blocking?: boolean;
}

export interface ModeDefinition {
  /** Unique mode name (lowercase, no spaces) */
  name: string;
  /** Human-readable label shown in UI */
  label: string;
  /** Short description of what this mode is for */
  description: string;
  /** Whether this is a built-in (bundled) mode or user-created */
  builtIn: boolean;
  /** Icon character/emoji for UI */
  icon?: string;

  /** Tools to enable (by id, e.g. "tool:rojo_build") */
  enableTools: string[];
  /** Skills to enable (by id, e.g. "skill:profilestore") */
  enableSkills: string[];
  /** Internal features to enable (by id, e.g. "feature:strict_gate") */
  enableFeatures: string[];

  /** Effort level to set when mode is active */
  effortLevel?: EffortLevel;
  /** Whether strict mode (tsc/lint/selene gate) should be enabled */
  strictMode?: boolean;
  /** Whether read-before-write protection should be enforced */
  readBeforeWrite?: boolean;
  /** Whether to enable advanced thinking prompts */
  advancedThinking?: boolean;

  /** Luau validation rules (LEGACY - kept for backwards compat with roblox.json).
   *  New modes should use 'validation' instead. If both are set, they're merged. */
  luauValidation?: ModeValidationRule[];

  /**
   * Generic validation rules (NEW - works for ANY language, not just Luau).
   * Each rule has: tool name, file pattern, blocking flag, and optional command.
   * If command is set, runs that command. Otherwise falls back to built-in
   * selene/stylua/luau-lsp behavior (for backwards compat with Luau tools).
   */
  validation?: ModeValidationRule[];

  /** Whether to enable auto-API-research (sub-agent that searches the web
   * for current API docs before writing code, and on selene false positives). */
  autoResearch?: boolean;

  /** Whether to enable LLM-based safety review before writing files.
   * When true, a second LLM call reviews code for data-destructive operations
   * (DataStore:RemoveAsync, profile.Data =, etc). High-risk writes are BLOCKED. */
  safetyReview?: boolean;

  /**
   * Custom safety patterns (NEW). When set, MERGED with built-in DANGEROUS_PATTERNS.
   * Lets mode authors add language-specific dangerous patterns
   * (e.g. "terraform destroy" for DevOps mode) without modifying source code.
   */
  safetyPatterns?: ModeSafetyPattern[];

  /**
   * Custom trusted research sources (NEW). When set, MERGED with built-in
   * TRUSTED_SOURCES. Lets mode authors add their preferred docs sites.
   * Example: { "terraform": ["terraform.io/docs", "registry.terraform.io"] }
   */
  researchSources?: Record<string, string[]>;

  /**
   * Custom symbol patterns for impact analysis (NEW). When set, MERGED with
   * built-in EXTENSIONS_BY_LANG and symbol extraction patterns. Lets mode
   * authors add support for new languages (HCL, Elixir, Kotlin, etc).
   */
  symbolPatterns?: ModeSymbolPattern[];

  /**
   * Custom hooks (NEW). Run external commands at specific lifecycle points.
   * - postEdit: runs after editar_arquivo writes a file (e.g. auto-format)
   * - preCommit: runs before git commit (e.g. lint, test)
   */
  hooks?: {
    postEdit?: ModeHook[];
    preCommit?: ModeHook[];
  };

  /** For user modes: the original prompt the user gave when creating */
  userPrompt?: string;
  /** When this mode was created (ISO date) */
  createdAt?: string;
}

export interface ActiveModeState {
  activeMode: string | null;
  activatedAt: string | null;
}

// --- Paths ------------------------------------------------------------------

function getModesDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
    ".claude-killer",
    "modes"
  );
}

function getActiveModeFile(): string {
  return path.join(getModesDir(), "active.json");
}

function getModeFile(name: string): string {
  return path.join(getModesDir(), `${name}.json`);
}

/** Find bundled defaults/modes/ directory (works in dev and prod). */
function findBundledModesDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "defaults", "modes"),       // dist/ -> ../defaults/modes
    path.join(here, "..", "..", "defaults", "modes"),  // src/ -> ../../defaults/modes
    path.join(process.cwd(), "defaults", "modes"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

// --- Built-in modes discovery ----------------------------------------------

/** Cache of built-in mode definitions (invalidated by emitModesChange). */
let cachedBuiltInModes: ModeDefinition[] | null = null;

// --- Reactive subscription system (mirrors extensionCenter.ts) --------------
//
// Same pattern: subscribe() + getSnapshot() (version counter) that works
// with React's useSyncExternalStore. Every mutation that affects what the
// Hub displays (setActiveMode, saveUserMode, deleteUserMode, deactivateMode,
// applyMode, confirmAndSaveMode) calls emitModesChange().

let modesVersion = 0;
const modesSubscribers = new Set<() => void>();

/** Subscribe to modes store changes. Returns unsubscribe function. */
export function subscribeToModesChanges(listener: () => void): () => void {
  modesSubscribers.add(listener);
  return () => modesSubscribers.delete(listener);
}

/** Get current modes store version (bumped on every mutation). */
export function getModesVersion(): number {
  return modesVersion;
}

function emitModesChange(): void {
  modesVersion++;
  // Invalidate the cached built-in modes so the next read picks up changes
  // (e.g., after seedBuiltInModes runs).
  cachedBuiltInModes = null;
  for (const listener of modesSubscribers) {
    try {
      listener();
    } catch (err) {
      log.warn(`Modes subscriber threw: ${(err as Error).message}`);
    }
  }
}


/**
 * Load built-in mode definitions from defaults/modes/*.json.
 * These are bundled with the package and seeded into the user's
 * ~/.claude-killer/modes/ on first run (configSeeder.ts handles that).
 */
export function getBuiltInModes(): ModeDefinition[] {
  if (cachedBuiltInModes) return cachedBuiltInModes;

  const modesDir = findBundledModesDir();
  if (!modesDir) {
    cachedBuiltInModes = [];
    return cachedBuiltInModes;
  }

  const result: ModeDefinition[] = [];
  try {
    const entries = fs.readdirSync(modesDir);
    // Sprint B bug fix: se existe <mode>/ (dir) E <mode>.json (flat legacy),
    // carregar SÓ o dir (novo formato) e ignorar o flat. Antes, ambos eram
    // carregados, causando 2 entradas duplicadas em getBuiltInModes() —
    // uma do config.json (novo, vazio) e outra do .json legacy (com dados).
    // Como getAllModes() faz map.set(name, mode), o último ganha, e a ordem
    // do readdirSync é indefinida — podia sair o legacy ou o novo.
    const dirNames = new Set(
      entries.filter((e) => {
        try { return fs.statSync(path.join(modesDir, e)).isDirectory(); } catch { return false; }
      })
    );

    for (const entry of entries) {
      const entryPath = path.join(modesDir, entry);

      // BUG FIX (Sprint 12): try new format: <mode>/config.json
      if (fs.statSync(entryPath).isDirectory()) {
        const configPath = path.join(entryPath, "config.json");
        if (fs.existsSync(configPath)) {
          try {
            const content = fs.readFileSync(configPath, "utf8");
            const mode = JSON.parse(content) as ModeDefinition;
            if (mode && mode.name && typeof mode.name === "string") {
              mode.builtIn = true;
              result.push(mode);
            }
          } catch (err) {
            log.warn(`modes: failed to parse ${entry}/config.json: ${(err as Error).message}`);
          }
        }
        continue;
      }

      // Legacy format: <mode>.json (flat file)
      // Sprint B: SKIP se existe <mode>/ directory correspondente (novo formato)
      // E esse directory tem config.json. Se o dir existe mas NÃO tem config.json,
      // ainda carrega o flat file (não há novo formato pra substituir).
      if (entry.endsWith(".json") && entry !== "active.json") {
        const modeNameFromFlat = entry.slice(0, -5); // remove .json
        if (dirNames.has(modeNameFromFlat)) {
          const dirConfigPath = path.join(modesDir, modeNameFromFlat, "config.json");
          if (fs.existsSync(dirConfigPath)) {
            log.debug(`modes: skipping legacy ${entry} (superseded by ${modeNameFromFlat}/config.json)`);
            continue;
          }
        }
        try {
          const content = fs.readFileSync(entryPath, "utf8");
          const mode = JSON.parse(content) as ModeDefinition;
          if (mode && mode.name && typeof mode.name === "string") {
            mode.builtIn = true;
            result.push(mode);
          }
        } catch (err) {
          log.warn(`modes: failed to parse ${entry}: ${(err as Error).message}`);
        }
      }
    }
  } catch {
    // directory not readable
  }

  cachedBuiltInModes = result;
  return result;
}

// --- User modes -------------------------------------------------------------

/**
 * List all user-created modes (excluding built-ins).
 * Reads from ~/.claude-killer/modes/*.json, excluding "active.json".
 */
export function getUserModes(): ModeDefinition[] {
  const dir = getModesDir();
  if (!fs.existsSync(dir)) return [];

  const result: ModeDefinition[] = [];
  try {
    const entries = fs.readdirSync(dir);
    // Sprint B bug fix: mesmo padrão do getBuiltInModes — se <mode>/ dir
    // existe, NÃO carregar <mode>.json legacy (evita duplicata).
    const dirNames = new Set(
      entries.filter((e) => {
        try { return fs.statSync(path.join(dir, e)).isDirectory(); } catch { return false; }
      })
    );

    for (const entry of entries) {
      const entryPath = path.join(dir, entry);

      // BUG FIX (Sprint 12): try new format: <mode>/config.json
      if (fs.statSync(entryPath).isDirectory()) {
        const configPath = path.join(entryPath, "config.json");
        if (fs.existsSync(configPath)) {
          try {
            const content = fs.readFileSync(configPath, "utf8");
            const mode = JSON.parse(content) as ModeDefinition;
            if (mode && mode.name && typeof mode.name === "string") {
              const builtIn = getBuiltInModes().find((m) => m.name === mode.name);
              mode.builtIn = !!builtIn;
              result.push(mode);
            }
          } catch {
            // skip invalid
          }
        }
        continue;
      }

      // Legacy format: <mode>.json (flat file)
      // Sprint B: SKIP se existe <mode>/ directory correspondente COM config.json.
      // Se dir existe mas sem config.json, ainda carrega flat file.
      if (entry.endsWith(".json") && entry !== "active.json") {
        const modeNameFromFlat = entry.slice(0, -5);
        if (dirNames.has(modeNameFromFlat)) {
          const dirConfigPath = path.join(dir, modeNameFromFlat, "config.json");
          if (fs.existsSync(dirConfigPath)) {
            log.debug(`modes: skipping user legacy ${entry} (superseded by ${modeNameFromFlat}/config.json)`);
            continue;
          }
        }
        try {
          const content = fs.readFileSync(entryPath, "utf8");
          const mode = JSON.parse(content) as ModeDefinition;
          if (mode && mode.name && typeof mode.name === "string") {
            const builtIn = getBuiltInModes().find((m) => m.name === mode.name);
            mode.builtIn = !!builtIn;
            result.push(mode);
          }
        } catch {
          // skip invalid
        }
      }
    }
  } catch {
    // directory not readable
  }
  return result;
}

/** Get ALL available modes (built-in + user). */
export function getAllModes(): ModeDefinition[] {
  const builtIns = getBuiltInModes();
  const users = getUserModes();
  // User modes with same name as built-in override
  const map = new Map<string, ModeDefinition>();
  for (const m of builtIns) map.set(m.name, m);
  for (const m of users) {
    // Sprint B (BUG-A prevention): warn se user mode está em formato legacy
    // (enableTools sem toolsDir) e o built-in correspondente está em formato
    // novo (toolsDir). Isso indica que o legacy deveria ter sido removido
    // pela migration. MAS ainda respeita o override do user — só warn.
    const builtIn = map.get(m.name);
    const userIsLegacy = (m as any).enableTools && !(m as any).toolsDir;
    const builtInIsNew = builtIn && (builtIn as any).toolsDir;
    if (userIsLegacy && builtInIsNew) {
      log.warn(
        `modes: user mode "${m.name}" is in legacy format (enableTools) but ` +
        `built-in is in new format (toolsDir). User override still wins. ` +
        `For consistency, consider migrating ~/.claude-killer/modes/${m.name}.json ` +
        `to the new directory format (run /migrate or delete the file).`
      );
    }
    // User mode sempre override built-in (comportamento original).
    map.set(m.name, m);
  }
  return Array.from(map.values());
}

/** Find a mode by name (built-in or user). */
export function getMode(name: string): ModeDefinition | null {
  return getAllModes().find((m) => m.name === name) ?? null;
}

// --- Persistence ------------------------------------------------------------

function ensureModesDir(): void {
  const dir = getModesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Save a user mode to ~/.claude-killer/modes/<name>.json */
export function saveUserMode(mode: ModeDefinition): void {
  if (!mode.name) throw new Error("Mode name is required");
  ensureModesDir();
  mode.builtIn = false;
  if (!mode.createdAt) mode.createdAt = new Date().toISOString();
  const filePath = getModeFile(mode.name);
  fs.writeFileSync(filePath, JSON.stringify(mode, null, 2), "utf8");
  log.info(`modes: saved user mode "${mode.name}" to ${filePath}`);
  emitModesChange();
}

/** Delete a user mode. Returns true if deleted, false if not found. */
export function deleteUserMode(name: string): boolean {
  const filePath = getModeFile(name);
  if (!fs.existsSync(filePath)) return false;
  try {
    fs.unlinkSync(filePath);
    log.info(`modes: deleted user mode "${name}"`);
    emitModesChange();
    return true;
  } catch (err) {
    log.warn(`modes: failed to delete "${name}": ${(err as Error).message}`);
    return false;
  }
}

// --- Active mode ------------------------------------------------------------

/** Get the currently active mode name (or null if none). */
export function getActiveModeName(): string | null {
  const file = getActiveModeFile();
  if (!fs.existsSync(file)) return null;
  try {
    const content = fs.readFileSync(file, "utf8");
    const state = JSON.parse(content) as ActiveModeState;
    return state.activeMode ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the full ModeDefinition of the currently active mode.
 *
 * Sprint 6: If no mode is explicitly active, returns the "normal" base mode.
 * This means getActiveMode() never returns null — there's always a mode.
 * Other modes INHERIT from normal (tools, skills, etc.).
 */
export function getActiveMode(): ModeDefinition | null {
  const name = getActiveModeName();
  if (!name) {
    // Sprint 6: Fall back to "normal" base mode
    const normalMode = getMode("normal");
    if (normalMode) return normalMode;
    // BUG FIX (Sprint 12): if "normal" mode not found in files, create a
    // minimal default so getActiveMode() NEVER returns null. This ensures
    // the system always has a base mode to work with.
    return {
      name: "normal",
      label: "Default",
      description: "Default mode",
      builtIn: true,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    } as ModeDefinition;
  }
  return getMode(name);
}

/**
 * Set the active mode. Persists to ~/.claude-killer/modes/active.json.
 * Does NOT actually apply the mode's settings - that's done by applyMode().
 * Pass null to clear (deactivate).
 *
 * Sprint C bug fix: também aplicar readBeforeWrite env var quando setActiveMode
 * é chamado (não só applyMode). Muitos testes e fluxos usam setActiveMode
 * diretamente sem chamar applyMode — antes, o readBeforeWrite ficava stuck
 * no valor anterior.
 */
export function setActiveMode(name: string | null): void {
  ensureModesDir();
  const state: ActiveModeState = {
    activeMode: name,
    activatedAt: name ? new Date().toISOString() : null,
  };
  fs.writeFileSync(getActiveModeFile(), JSON.stringify(state, null, 2), "utf8");
  if (name) {
    log.info(`modes: active mode set to "${name}"`);
    // Sprint C: aplicar settings críticas imediatamente
    const mode = getMode(name);
    if (mode) {
      if (mode.readBeforeWrite !== undefined) {
        process.env.READ_BEFORE_WRITE = mode.readBeforeWrite ? "true" : "false";
      }
      if (mode.strictMode !== undefined) {
        process.env.STRICT_MODE = mode.strictMode ? "true" : "false";
      }
      if (mode.advancedThinking !== undefined) {
        process.env.ADVANCED_THINKING = mode.advancedThinking ? "true" : "false";
      }
    }

    // BUG-VALIDATORS: When roblox mode is activated, check that required
    // tools (selene, stylua) are installed. Without them, the fileValidator
    // blocks all .luau writes — warn the user proactively.
    if (name === "roblox") {
      try {
        const { warnIfMissingTools } = require("./ensureRobloxTools.js");
        warnIfMissingTools();
      } catch {
        // best-effort — don't crash if module not available
      }
    }
  } else {
    log.info(`modes: active mode cleared`);
    // Reset env vars to defaults
    process.env.READ_BEFORE_WRITE = "false";
    process.env.STRICT_MODE = "false";
    process.env.ADVANCED_THINKING = "false";
  }
  emitModesChange();
}

// --- Mode application -------------------------------------------------------

export interface ModeApplyResult {
  success: boolean;
  modeName: string;
  toolsEnabled: string[];
  toolsDisabled: string[];
  skillsEnabled: string[];
  featuresEnabled: string[];
  errors: string[];
}

/**
 * Apply a mode: set effort level, enable/disable tools/skills/features.
 *
 * This calls into:
 *   - effortLevels.ts to set effort
 *   - extensionCenter.ts to toggle extensions
 *   - strictQualityGate.ts to set STRICT_MODE env
 *   - readBeforeWrite.ts to set its flag
 *
 * Returns a summary of what was changed. Safe to call multiple times.
 */
export async function applyMode(name: string): Promise<ModeApplyResult> {
  const mode = getMode(name);
  const result: ModeApplyResult = {
    success: false,
    modeName: name,
    toolsEnabled: [],
    toolsDisabled: [],
    skillsEnabled: [],
    featuresEnabled: [],
    errors: [],
  };

  if (!mode) {
    result.errors.push(`Mode "${name}" not found`);
    return result;
  }

  try {
    // Lazy-import to avoid circular dependencies
    const { toggleExtension, getAllExtensions } = await import("./extensionCenter.js");
    const { setEffortLevel } = await import("./effortLevels.js");

    const all = getAllExtensions();

    // Build a set of ids that should be enabled
    // Sprint B bug fix: support both new format ('tools'/'skills'/'enableFeatures')
    // and legacy format ('enableTools'/'enableSkills'/'enableFeatures').
    const modeTools = (mode as any).tools ?? mode.enableTools;
    const modeSkills = (mode as any).skills ?? mode.enableSkills;
    const shouldEnable = new Set<string>([
      ...modeTools,
      ...modeSkills,
      ...mode.enableFeatures,
    ]);

    for (const ext of all) {
      const wantsOn = shouldEnable.has(ext.id);
      const isOn = ext.enabled && ext.triggerMode !== "disabled";
      if (wantsOn && !isOn) {
        // Turn on
        if (ext.category === "feature") {
          // Features use "always" trigger by default
          const { setTriggerMode } = await import("./extensionCenter.js");
          setTriggerMode(ext.id, "always");
        } else {
          toggleExtension(ext.id);
        }
        if (ext.category === "tool") result.toolsEnabled.push(ext.id);
        else if (ext.category === "skill") result.skillsEnabled.push(ext.id);
        else if (ext.category === "feature") result.featuresEnabled.push(ext.id);
      } else if (!wantsOn && isOn && ext.category === "tool") {
        // Only disable tools (don't touch skills/features the user might want)
        toggleExtension(ext.id);
        result.toolsDisabled.push(ext.id);
      }
    }

    // Set effort level
    if (mode.effortLevel) {
      try {
        setEffortLevel(mode.effortLevel);
        log.info(`modes: effort set to ${mode.effortLevel}`);
      } catch (err) {
        result.errors.push(`Failed to set effort: ${(err as Error).message}`);
      }
    }

    // Set strict mode (via env var - strictQualityGate reads this)
    if (mode.strictMode !== undefined) {
      process.env.STRICT_MODE = mode.strictMode ? "true" : "false";
    }

    // Set read-before-write (via env var)
    if (mode.readBeforeWrite !== undefined) {
      process.env.READ_BEFORE_WRITE = mode.readBeforeWrite ? "true" : "false";
    }

    // Set advanced thinking (via env var, used by contextInjector)
    if (mode.advancedThinking !== undefined) {
      process.env.ADVANCED_THINKING = mode.advancedThinking ? "true" : "false";
    }

    setActiveMode(name);
    result.success = true;
    return result;
  } catch (err) {
    result.errors.push(`Failed to apply mode: ${(err as Error).message}`);
    return result;
  }
}

/**
 * Deactivate the current mode: reverte as tools habilitadas pelo modo e
 * limpa o ponteiro do modo ativo.
 *
 * IMPORTANTE: só desliga TOOLS (não skills/features), seguindo o mesmo padrão
 * do `applyMode` — o usuário pode ter habilitado skills/features manualmente.
 */
export function deactivateMode(): void {
  // ANTES de limpar o ponteiro, lê o modo ativo for saber quais tools reverter.
  const mode = getActiveMode();
  // Sprint B bug fix: enableTools pode ser undefined no novo formato (que usa 'tools').
  // Usar optional chaining + fallback pra array vazia.
  const modeTools = (mode as any)?.tools ?? mode?.enableTools ?? [];
  if (mode && modeTools.length > 0) {
    try {
      // Lazy-import for evitar dependência circular (mesmo padrão do applyMode).
      // Como o dynamic import é async, usamos um wrapper fire-and-forget —
      // chamadas sincronizadas a deactivateMode ainda limpam o ponteiro
      // imediatamente (abaixo), mas a reversão das tools acontece de forma
      // assíncrona. O handler do TUI aguarda a próxima renderização.
      void (async () => {
        const { toggleExtension, getAllExtensions } = await import("./extensionCenter.js");
        const all = getAllExtensions();
        for (const toolId of modeTools) {
          const ext = all.find((e) => e.id === toolId);
          // Só desliga se estiver ON (enabled && triggerMode !== "disabled").
          // Não desliga skills/features — usuário pode ter habilitado manualmente.
          if (ext && ext.category === "tool" && ext.enabled && ext.triggerMode !== "disabled") {
            toggleExtension(toolId);
          }
        }
      })().catch((err) => {
        log.warn(`deactivateMode: failed to revert tools: ${(err as Error).message}`);
      });
    } catch (err) {
      log.warn(`deactivateMode: failed to revert tools: ${(err as Error).message}`);
    }
  }
  setActiveMode(null);
}

// --- Mode creation (AI-assisted) -------------------------------------------

export interface ModeSuggestionRequest {
  /** User's natural language description of what they want */
  prompt: string;
  /** List of available tool ids (e.g. ["tool:rojo_build", "tool:stylua_lint"]) */
  availableTools: string[];
  /** List of available skill ids */
  availableSkills: string[];
  /** List of available feature ids */
  availableFeatures: string[];
}

export interface ModeSuggestion {
  name: string;
  label: string;
  description: string;
  enableTools: string[];
  enableSkills: string[];
  enableFeatures: string[];
  effortLevel: EffortLevel;
  strictMode: boolean;
  readBeforeWrite: boolean;
  advancedThinking: boolean;
  luauValidation?: ModeValidationRule[];
  /** AI's reasoning for these choices (shown to user for confirmation) */
  reasoning: string;
}

/**
 * Suggest a mode based on user prompt. This is a heuristic implementation -
 * for production use, this would call the LLM with the available tools list
 * and ask it to pick relevant ones.
 *
 * The heuristic:
 *   1. Keyword matching against tool descriptions
 *   2. If "roblox" or "luau" mentioned → suggest Roblox preset
 *   3. If "rust" → suggest cargo/rustc tools
 *   4. If "python" → suggest pip/pytest tools
 *   5. If "typescript" or "node" → suggest npm/vitest tools
 *
 * Returns a suggestion the user must confirm before activation.
 */
export function suggestMode(req: ModeSuggestionRequest): ModeSuggestion {
  const prompt = req.prompt.toLowerCase();

  // Default suggestion: high effort, strict mode, read-before-write
  const base: ModeSuggestion = {
    name: "",
    label: "",
    description: req.prompt,
    enableTools: [],
    enableSkills: [],
    enableFeatures: [],
    effortLevel: "high",
    strictMode: true,
    readBeforeWrite: true,
    advancedThinking: true,
    reasoning: "",
  };

  // Heuristic: keyword matching
  const keywords: Array<{ pattern: RegExp; tools: string[]; skills: string[]; label: string; name: string; reasoning: string }> = [
    {
      pattern: /\b(roblox|luau|rojo|wally|rbxl|studio)\b/i,
      tools: ["tool:rojo_build", "tool:rojo_serve", "tool:rojo_sourcemap",
              "tool:wally_install", "tool:wally_search", "tool:wally_publish",
              "tool:lune_run", "tool:selene_lint", "tool:rokit_install",
              "tool:rokit_add", "tool:wally_package_types",
              "tool:stylua_format"],
      skills: [],
      label: "Roblox (External)",
      name: "roblox-custom",
      reasoning: "Detected Roblox/Luau context. Activating: Rojo (sync+build), Wally (package manager), Lune (offline runtime), Selene (linter), StyLua (formatter), Rokit (toolchain), wally-package-types (type defs). Enabling strict mode + read-before-write because Roblox is sensitive. Effort=high for thorough reasoning.",
    },
    {
      pattern: /\b(rust|cargo)\b/i,
      tools: [],
      skills: [],
      label: "Rust",
      name: "rust-custom",
      reasoning: "Detected Rust context. No Rust tools are bundled (would need to add cargo/rustc/clippy externally). Enabling strict mode + read-before-write as Rust is type-sensitive.",
    },
    {
      pattern: /\b(python|pytest|pip|poetry)\b/i,
      tools: [],
      skills: [],
      label: "Python",
      name: "python-custom",
      reasoning: "Detected Python context. No Python tools are bundled. Enabling strict mode + read-before-write.",
    },
    {
      pattern: /\b(typescript|node|npm|vitest|jest)\b/i,
      tools: [],
      skills: [],
      label: "TypeScript/Node",
      name: "ts-custom",
      reasoning: "Detected TypeScript/Node context. Using built-in tsc + lint strict gate. Enabling strict mode + read-before-write.",
    },
  ];

  for (const kw of keywords) {
    if (kw.pattern.test(prompt)) {
      // Filter to tools that actually exist
      const tools = kw.tools.filter((t) => req.availableTools.includes(t));
      const skills = kw.skills.filter((s) => req.availableSkills.includes(s));
      return {
        ...base,
        name: kw.name,
        label: kw.label,
        enableTools: tools,
        enableSkills: skills,
        enableFeatures: [
          "feature:strict_gate",
          "feature:read_before_write",
          "feature:think_tool",
          "feature:self_validation",
          "feature:poka_yoke",
          "feature:rollback",
        ].filter((f) => req.availableFeatures.includes(f)),
        luauValidation: kw.tools.some((t) => t.includes("selene") || t.includes("lune"))
          ? [
              { tool: "selene_lint", filePattern: "*.luau", blocking: true },
              { tool: "selene_lint", filePattern: "*.lua", blocking: true },
              { tool: "stylua_format", filePattern: "*.luau", blocking: false },
              { tool: "stylua_format", filePattern: "*.lua", blocking: false },
            ]
          : undefined,
        reasoning: kw.reasoning,
      };
    }
  }

  // Fallback: generic mode with default settings
  return {
    ...base,
    name: "custom",
    label: "Custom",
    reasoning: "No specific context detected. Suggesting conservative defaults: strict mode on, read-before-write on, effort=high. You can add specific tools manually.",
  };
}

/**
 * Confirm and save a user mode from a suggestion.
 * Returns the saved ModeDefinition.
 */
export function confirmAndSaveMode(suggestion: ModeSuggestion): ModeDefinition {
  const mode: ModeDefinition = {
    name: suggestion.name,
    label: suggestion.label,
    description: suggestion.description,
    builtIn: false,
    enableTools: suggestion.enableTools,
    enableSkills: suggestion.enableSkills,
    enableFeatures: suggestion.enableFeatures,
    effortLevel: suggestion.effortLevel,
    strictMode: suggestion.strictMode,
    readBeforeWrite: suggestion.readBeforeWrite,
    advancedThinking: suggestion.advancedThinking,
    luauValidation: suggestion.luauValidation,
    userPrompt: suggestion.description,
    createdAt: new Date().toISOString(),
  };
  saveUserMode(mode);
  return mode;
}

// --- Seed built-in modes on first run --------------------------------------

/**
 * Copy built-in modes from defaults/modes/ to ~/.claude-killer/modes/
 * if they don't already exist. Called from configSeeder.ts on first run.
 */
export function seedBuiltInModes(): number {
  const bundledDir = findBundledModesDir();
  if (!bundledDir) return 0;

  const userDir = getModesDir();
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  let count = 0;
  try {
    const files = fs.readdirSync(bundledDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const destPath = path.join(userDir, file);
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(path.join(bundledDir, file), destPath);
        count++;
        log.info(`modes: seeded built-in mode ${file}`);
      }
    }
  } catch (err) {
    log.warn(`modes: failed to seed: ${(err as Error).message}`);
  }
  if (count > 0) emitModesChange();
  return count;
}
