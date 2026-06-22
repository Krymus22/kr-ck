/**
 * manifestLoader.ts — Loads tool manifests from the active mode's folder.
 *
 * Sprint 3: replaces the old generic `executar_tool` with specific function
 * calls generated from manifests. Each tool in the manifest becomes a separate
 * function call (e.g., rojo_build, rojo_serve, wally_install).
 *
 * Manifest format (from defaults/modes/<mode>/manifests/*.json):
 * Each file is an array of tool definitions:
 * [
 *   {
 *     "name": "rojo_build",
 *     "description": "Build .rbxl place file from Rojo project",
 *     "category": "roblox",
 *     "command": "rojo",         ← binary name to find
 *     "args": ["build"],          ← base args
 *     "flags": [                   ← additional flags → schema properties
 *       { "name": "--output", "type": "string", "description": "..." },
 *       { "name": "--watch", "type": "boolean", "description": "..." }
 *     ],
 *     "context": { "whenToUse": [...], "examples": [...] }
 *   }
 * ]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";
import { findToolBinary } from "./toolDetector.js";
import { getActiveMode } from "./modes.js";
import type OpenAI from "openai";

// --- Types -------------------------------------------------------------------

export interface ToolFlag {
  name: string;
  type: "string" | "boolean" | "number";
  description?: string;
  default?: string | number | boolean;
}

export interface ToolManifest {
  name: string;
  description: string;
  category: string;
  command: string;
  args: string[];
  flags?: ToolFlag[];
  /** Sprint 6: Modes that can use this tool (in addition to the mode where it lives). */
  sharedWith?: string[];
  detection?: { method: string; check: string };
  context?: {
    whenToUse?: string[];
    requiresProject?: string[];
    examples?: string[];
  };
  outputParser?: string;
  /**
   * Sprint A (Sistema de Modos v2): args específicas para invocar a tool como
   * validator (em vez de quando invocada pela IA). {file} é substituído pelo
   * path do arquivo sendo validado.
   *
   * Exemplo (selene): ["--no-global-check", "--quiet", "{file}"]
   * Exemplo (stylua): ["--check", "{file}"]
   * Exemplo (ruff): ["check", "--quiet", "{file}"]
   *
   * Se não setado, validator usa args (base) + {file}. Se args também é
   * vazio, validator usa só [{file}].
   */
  validatorArgs?: string[];
}

// --- Manifest Loading --------------------------------------------------------

/**
 * Get the manifests directory for the active mode.
 * Priority: user's ~/.claude-killer/modes/<mode>/manifests/ → bundled defaults/modes/<mode>/manifests/
 */
function getManifestsDir(modeName: string): string | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();

  // 1. User's custom manifests (highest priority)
  const userDir = path.join(home, ".claude-killer", "modes", modeName, "manifests");
  if (fs.existsSync(userDir)) return userDir;

  // 2. Bundled defaults
  const bundledDir = path.join(process.cwd(), "defaults", "modes", modeName, "manifests");
  if (fs.existsSync(bundledDir)) return bundledDir;

  // 3. Try relative to import.meta.dirname (when running from dist/)
  // ESM-compatible: use import.meta.dirname (Node 20.11+) or fallback to process.cwd()
  const distDir = typeof import.meta !== "undefined" && import.meta.dirname
    ? path.join(import.meta.dirname, "..", "defaults", "modes", modeName, "manifests")
    : path.join(process.cwd(), "defaults", "modes", modeName, "manifests");
  if (fs.existsSync(distDir)) return distDir;

  return null;
}

/**
 * Load all manifests for the active mode.
 * Returns an array of ToolManifest objects.
 */
export function loadModeManifests(modeName: string | null): ToolManifest[] {
  if (!modeName) return [];

  const dir = getManifestsDir(modeName);
  if (!dir) {
    log.debug(`[MANIFEST] No manifests directory for mode: ${modeName}`);
    return [];
  }

  const manifests: ToolManifest[] = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (Array.isArray(content)) {
          manifests.push(...content);
        } else if (content.name) {
          manifests.push(content);
        }
      } catch (err) {
        log.warn(`[MANIFEST] Failed to parse ${file}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log.warn(`[MANIFEST] Failed to read manifests dir: ${(err as Error).message}`);
  }

  log.debug(`[MANIFEST] Loaded ${manifests.length} manifests for mode: ${modeName}`);
  return manifests;
}

/**
 * Load manifests for the active mode + the "normal" base mode + shared tools.
 *
 * Sprint 6: Also loads manifests from OTHER modes that have sharedWith
 * including the active mode. For example, if "normal" has darklua with
 * sharedWith: ["roblox"], and roblox is active, darklua is included.
 *
 * Priority: mode-specific > shared > normal (base).
 */
export function loadActiveManifests(): ToolManifest[] {
  const mode = getActiveMode();
  const modeName = mode?.name ?? null;

  // 1. Load mode-specific manifests (highest priority)
  const modeManifests = loadModeManifests(modeName);

  // 2. Load normal mode manifests (base mode — always inherited)
  const normalManifests = loadModeManifests("normal");

  // 3. Sprint 6: Load shared manifests from other modes
  const sharedManifests = findSharedManifests(modeName);

  // Merge: mode-specific > shared > normal (by tool name)
  const mergedMap = new Map<string, ToolManifest>();

  // Normal first (lowest priority)
  for (const m of normalManifests) mergedMap.set(m.name, m);

  // Shared (medium priority)
  for (const m of sharedManifests) mergedMap.set(m.name, m);

  // Mode-specific (highest priority — overrides everything)
  for (const m of modeManifests) mergedMap.set(m.name, m);

  return Array.from(mergedMap.values());
}

/**
 * Sprint 6: Find manifests from OTHER modes that are shared with the active mode.
 *
 * Scans all mode directories for manifests with `sharedWith` containing the
 * active mode name. Returns manifests that should be visible in the active
 * mode but live in a different mode's folder.
 */
function findSharedManifests(modeName: string | null): ToolManifest[] {
  if (!modeName) return [];

  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const modesDir = path.join(home, ".claude-killer", "modes");
  const shared: ToolManifest[] = [];

  // Scan user's modes directory
  if (fs.existsSync(modesDir)) {
    try {
      for (const entry of fs.readdirSync(modesDir)) {
        const entryPath = path.join(modesDir, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;
        if (entry === modeName || entry === "normal") continue; // skip self + normal

        // Load manifests from this mode
        const otherManifests = loadModeManifests(entry);
        for (const m of otherManifests) {
          if (m.sharedWith?.includes(modeName)) {
            shared.push(m);
            log.debug(`[MANIFEST] Shared tool: ${m.name} from mode "${entry}" → "${modeName}"`);
          }
        }
      }
    } catch {
      // Can't read dir, skip
    }
  }

  // Also scan bundled defaults
  const bundledModesDir = path.join(process.cwd(), "defaults", "modes");
  if (fs.existsSync(bundledModesDir)) {
    try {
      for (const entry of fs.readdirSync(bundledModesDir)) {
        const entryPath = path.join(bundledModesDir, entry);
        if (!fs.statSync(entryPath).isDirectory()) continue;
        if (entry === modeName || entry === "normal") continue;

        const otherManifests = loadModeManifests(entry);
        for (const m of otherManifests) {
          if (m.sharedWith?.includes(modeName) && !shared.some((s) => s.name === m.name)) {
            shared.push(m);
          }
        }
      }
    } catch {
      // Can't read dir, skip
    }
  }

  return shared;
}

// --- Function Call Generation ------------------------------------------------

/**
 * Generate OpenAI function call definitions from manifests.
 * Each manifest becomes one function call with schema from flags.
 *
 * Only tools where the binary is found are included (so the IA doesn't
 * try to call tools that aren't installed).
 */
export function generateFunctionCallsFromManifests(
  manifests: ToolManifest[],
  modeName: string | null,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];

  for (const manifest of manifests) {
    // Check if the binary is available
    const binaryPath = findToolBinary(manifest.command, modeName);
    if (!binaryPath) {
      log.debug(`[MANIFEST] Skipping ${manifest.name} — binary "${manifest.command}" not found`);
      continue;
    }

    // Build schema properties from flags
    const properties: Record<string, any> = {
      dir: {
        type: "string",
        description: "Working directory (optional)",
      },
    };

    const required: string[] = [];

    if (manifest.flags) {
      for (const flag of manifest.flags) {
        const propName = flag.name.replace(/^--?/, "").replace(/-/g, "_");
        properties[propName] = {
          type: flag.type,
          description: flag.description ?? flag.name,
          ...(flag.default !== undefined ? { default: flag.default } : {}),
        };
      }
    }

    // Build description with context
    let description = manifest.description;
    if (manifest.context?.whenToUse?.length) {
      description += "\n\nWhen to use: " + manifest.context.whenToUse.join(", ");
    }
    if (manifest.context?.examples?.length) {
      description += "\n\nExamples:\n" + manifest.context.examples.map((e) => `  ${e}`).join("\n");
    }

    tools.push({
      type: "function",
      function: {
        name: manifest.name, // e.g., "rojo_build"
        description,
        parameters: {
          type: "object",
          properties,
          required,
        },
      },
    });
  }

  return tools;
}

// --- Tool Execution from Manifest -------------------------------------------

/**
 * Execute a tool call using its manifest.
 *
 * 1. Find the manifest by tool name
 * 2. Find the binary using findToolBinary()
 * 3. Build the command args from manifest + user-provided args
 * 4. Execute via spawn
 * 5. Return structured output
 */
export async function executeFromManifest(
  toolName: string,
  args: Record<string, unknown>,
  manifests: ToolManifest[],
  modeName: string | null,
): Promise<{ ok: boolean; output: string; errors: string[]; duration: number }> {
  const { execSync } = await import("node:child_process");
  const startTime = Date.now();

  // 1. Find manifest
  const manifest = manifests.find((m) => m.name === toolName);
  if (!manifest) {
    return { ok: false, output: "", errors: [`Tool "${toolName}" not found in manifests`], duration: 0 };
  }

  // 2. Find binary
  const binaryPath = findToolBinary(manifest.command, modeName);
  if (!binaryPath) {
    return {
      ok: false,
      output: "",
      errors: [`Binary "${manifest.command}" not found. Install it or add to modes/${modeName ?? "active"}/tools/`],
      duration: 0,
    };
  }

  // 3. Build command args
  const cmdArgs = [...manifest.args];

  // Add flags from user args
  if (manifest.flags) {
    for (const flag of manifest.flags) {
      const propName = flag.name.replace(/^--?/, "").replace(/-/g, "_");
      const value = args[propName];
      if (value === undefined) continue;

      if (flag.type === "boolean") {
        if (value === true || value === "true") {
          cmdArgs.push(flag.name);
        }
      } else {
        cmdArgs.push(flag.name, String(value));
      }
    }
  }

  // Add working directory
  const cwd = args.dir ? String(args.dir) : process.cwd();

  // 4. Execute
  try {
    const fullCmd = `"${binaryPath}" ${cmdArgs.map((a) => a.includes(" ") ? `"${a}"` : a).join(" ")}`;
    log.debug(`[MANIFEST] Executing: ${fullCmd} (cwd: ${cwd})`);

    const result = execSync(fullCmd, {
      encoding: "utf8",
      timeout: 60000, // 60s timeout
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      ok: true,
      output: result.trim(),
      errors: [],
      duration: Date.now() - startTime,
    };
  } catch (err: any) {
    const stdout = err.stdout ?? "";
    const stderr = err.stderr ?? "";
    return {
      ok: false,
      output: stdout.trim(),
      errors: [stderr.trim() || err.message || "Unknown error"],
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Check if a tool name is a manifest-based tool (vs the old executar_tool).
 */
export function isManifestTool(toolName: string, manifests: ToolManifest[]): boolean {
  return manifests.some((m) => m.name === toolName);
}
