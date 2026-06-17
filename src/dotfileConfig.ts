/**
 * dotfileConfig.ts - Dotfile config system (~/.claude-killer/config.json)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as log from "./logger.js";

const CONFIG_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
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
      cachedConfig = JSON.parse(raw);
      log.debug(`Loaded config from ${CONFIG_FILE}`);
      return cachedConfig!;
    }
  } catch (err) {
    log.error(`Failed to load config: ${(err as Error).message}`);
  }

  cachedConfig = {};
  return cachedConfig;
}

export function saveConfig(config: DotfileConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    cachedConfig = config;
    log.success(`Config saved to ${CONFIG_FILE}`);
  } catch (err) {
    log.error(`Failed to save config: ${(err as Error).message}`);
  }
}

export function updateConfig(partial: Partial<DotfileConfig>): DotfileConfig {
  const current = loadConfig();
  const updated = { ...current, ...partial };
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
