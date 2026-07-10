/**
 * dotfileConfig.ts - Dotfile config system (~/.claude-killer/config.json)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

// BUG FIX: previously fell back to "." (current working directory) when both
// HOME and USERPROFILE were unset. That meant the config file would be written
// to ./<cwd>/.claude-killer/config.json — silently polluting whatever
// directory the user happened to run the CLI from, and producing different
// configs per cwd. Every other module in this codebase (configSeeder.ts,
// modes.ts, modeMigration.ts) uses `os.homedir()` as the final fallback — we
// align with that pattern here.
const CONFIG_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
  ".claude-killer"
);

const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface DotfileConfig {
  model?: string;
  nvidiaBaseUrl?: string;
  rateLimitRpm?: number;
  maxHealRetries?: number;
  contextWindowTokens?: number;
  contextCompactThreshold?: number;
  contextWarnThreshold?: number;
  costPerKPrompt?: number;
  costPerKCompletion?: number;
  diffPreview?: boolean;
  defaultShell?: string;
  mcpServers?: Record<string, McpServerConfig>;
  skills?: string[];
  theme?: ThemeConfig;
  telemetry?: TelemetryConfig;
  shortcuts?: Record<string, string>;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ThemeConfig {
  primary?: string;
  accent?: string;
  success?: string;
  warning?: string;
  error?: string;
  muted?: string;
}

export interface TelemetryConfig {
  enabled?: boolean;
  endpoint?: string;
}

let cachedConfig: DotfileConfig | null = null;

export function loadConfig(): DotfileConfig {
  if (cachedConfig) return cachedConfig;

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, "utf8");
      // BUG FIX: previously, a parse failure (e.g., user typo in config.json)
      // fell through to `cachedConfig = {}` below, which PERMANENTLY cached
      // the empty object. Every subsequent loadConfig() returned `{}` even
      // after the user fixed the JSON — the only way out was to call
      // saveConfig(). Now we cache ONLY successful parses and return a fresh
      // `{` (not cached) on failure, so the next call retries reading the
      // file.
      cachedConfig = JSON.parse(raw) as DotfileConfig;
      log.debug(`Loaded config from ${CONFIG_FILE}`);
      return cachedConfig;
    }
    // File doesn't exist — cache the empty object. Cache invalidation here
    // is handled by saveConfig()/updateConfig() writing through the cache.
    cachedConfig = {};
    return cachedConfig;
  } catch (err) {
    log.error(`Failed to load config: ${(err as Error).message}`);
    // Don't cache — let the next call retry.
    return {};
  }
}

export function saveConfig(config: DotfileConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // SECURITY (BH28 MEDIUM 16): config.json may contain API keys, MCP
    // server env vars (tokens), telemetry endpoints with auth, etc. The
    // previous call used the default mode (0o644 on most systems → world
    // readable). Use 0o600 (owner read/write only). Also chmod after the
    // write, because Node's `writeFileSync({mode})` only applies the mode
    // on file CREATION — existing files keep their old mode, so a config
    // file previously created with 0o644 would stay world-readable on
    // every subsequent save.
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(CONFIG_FILE, 0o600);
    } catch {
      // chmod unsupported on some platforms (Windows) — ignore.
    }
    cachedConfig = config;
    log.success(`Config saved to ${CONFIG_FILE}`);
  } catch (err) {
    log.error(`Failed to save config: ${(err as Error).message}`);
  }
}

/**
 * Deep-merge `partial` into `current` for the nested object keys defined
 * in DotfileConfig (mcpServers, theme, telemetry, shortcuts). Top-level
 * scalar/array keys are replaced as before.
 *
 * (BH28 MEDIUM 15): previously `updateConfig({ theme: { primary: "red" } })`
 * on a config `{ theme: { primary: "blue", accent: "gray" } }` produced
 * `{ theme: { primary: "red" } }` — silently dropping `accent`. Same for
 * mcpServers (one new server wiped all existing servers), telemetry, and
 * shortcuts. Now we merge nested objects key-by-key.
 */
function deepMergeConfig(
  current: DotfileConfig,
  partial: Partial<DotfileConfig>
): DotfileConfig {
  const merged: DotfileConfig = { ...current };
  const nestedKeys: Array<keyof DotfileConfig> = [
    "mcpServers",
    "theme",
    "telemetry",
    "shortcuts",
  ];
  for (const key of nestedKeys) {
    const curVal = current[key] as Record<string, unknown> | undefined;
    const partVal = partial[key] as Record<string, unknown> | undefined;
    if (partVal === undefined) {
      // No update for this key — leave merged[key] as-is (already copied).
      continue;
    }
    if (curVal && typeof curVal === "object" && !Array.isArray(curVal) &&
        partVal && typeof partVal === "object" && !Array.isArray(partVal)) {
      // Merge nested object key-by-key.
      (merged as Record<string, unknown>)[key as string] = { ...curVal, ...partVal };
    } else {
      // Either side is missing/non-object — replace.
      (merged as Record<string, unknown>)[key as string] = partVal;
    }
  }
  // Apply all OTHER keys (scalars, arrays, and any non-nested-object keys)
  // with plain overwrite semantics.
  for (const key of Object.keys(partial) as Array<keyof DotfileConfig>) {
    if (nestedKeys.includes(key)) continue;
    (merged as Record<string, unknown>)[key as string] = partial[key] as unknown;
  }
  return merged;
}

export function updateConfig(partial: Partial<DotfileConfig>): DotfileConfig {
  const current = loadConfig();
  const updated = deepMergeConfig(current, partial);
  saveConfig(updated);
  return updated;
}

export function getConfigValue<K extends keyof DotfileConfig>(key: K): DotfileConfig[K] | undefined {
  const config = loadConfig();
  return config[key];
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getThemesDir(): string {
  return path.join(CONFIG_DIR, "themes");
}

export function listCustomThemes(): string[] {
  const themesDir = getThemesDir();
  if (!fs.existsSync(themesDir)) return [];
  return fs.readdirSync(themesDir).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
}
