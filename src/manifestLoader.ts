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
  detection?: { method: string; check: string };
  context?: {
    whenToUse?: string[];
    requiresProject?: string[];
    examples?: string[];
  };
  outputParser?: string;
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

  // 3. Try relative to __dirname (when running from dist/)
  const distDir = path.join(__dirname, "..", "defaults", "modes", modeName, "manifests");
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
 * Load manifests for the active mode + the "normal" base mode.
 * Mode-specific manifests take priority over normal mode manifests.
 */
export function loadActiveManifests(): ToolManifest[] {
  const mode = getActiveMode();
  const modeName = mode?.name ?? null;

  // Load mode-specific manifests
  const modeManifests = loadModeManifests(modeName);

  // Load normal mode manifests (base mode — always inherited)
  const normalManifests = loadModeManifests("normal");

  // Merge: mode-specific overrides normal (by tool name)
  const normalMap = new Map(normalManifests.map((m) => [m.name, m]));
  for (const m of modeManifests) {
    normalMap.set(m.name, m); // mode-specific wins
  }

  return Array.from(normalMap.values());
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
