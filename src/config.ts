/**
 * config.ts - Centralized configuration loaded from environment variables.
 * All runtime tunables live here; the rest of the codebase imports from this
 * module instead of reading process.env directly.
 */

import "dotenv/config";
import { getModelContextWindow, getModelMaxOutputTokens, getModelCost } from "./modelRegistry.js";

// --- Helpers ----------------------------------------------------------------

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    console.error(
      `\nX  Missing required environment variable: ${key}\n` +
        `   Set it in your shell or in a .env file.\n` +
        `   Example: NVIDIA_API_KEY=nvapi-xxxx\n`
    );
    process.exit(1);
  }
  return value.trim();
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

function optionalFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// --- Validate: at least one key source must be set -------------------------

const hasSingleKey = process.env.NVIDIA_API_KEY?.trim();
const hasMultiKeys = process.env.NVIDIA_API_KEYS?.trim();
const hasKeysFile = process.env.NVIDIA_API_KEYS_FILE?.trim();

if (!hasSingleKey && !hasMultiKeys && !hasKeysFile) {
  console.error(
    `\nX  Missing NVIDIA API key configuration.\n` +
    `   Set ONE of:\n` +
    `     NVIDIA_API_KEY=nvapi-xxx        (single key, 40 RPM, 1 concurrent)\n` +
    `     NVIDIA_API_KEYS=nvapi-x1,nvapi-x2,nvapi-x3   (multi-key pool, N x 40 RPM)\n` +
    `     NVIDIA_API_KEYS_FILE=/path/to/keys.txt       (one key per line)\n`
  );
  process.exit(1);
}

// --- Exported Config --------------------------------------------------------

export const config = {
  /** NVIDIA NIM API key (required if NVIDIA_API_KEYS not set). */
  nvidiaApiKey: process.env.NVIDIA_API_KEY ?? "",

  /**
   * Multi-key pool (optional). Comma-separated list of NVIDIA API keys
   * for parallel requests. Each key gets its own 40 RPM / 1 concurrent quota.
   * Set NVIDIA_API_KEYS or NVIDIA_API_KEYS_FILE to enable multi-key mode.
   * Falls back to NVIDIA_API_KEY (single-key) if not set.
   */
  nvidiaApiKeys: process.env.NVIDIA_API_KEYS ?? "",
  nvidiaApiKeysFile: process.env.NVIDIA_API_KEYS_FILE ?? "",

  /** Base URL for the NVIDIA NIM OpenAI-compatible endpoint. */
  nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",

  /** Model identifier for the model on NVIDIA NIM. */
  model: process.env.MODEL ?? "moonshotai/kimi-k2.6",

  /** Temperature for sampling (0.0-2.0). Default: 1.0 (NVIDIA recommended). */
  temperature: optionalFloat("TEMPERATURE", 1.0),

  /** Top-p for nucleus sampling (0.0-1.0). Default: 0.95 (NVIDIA recommended). */
  topP: optionalFloat("TOP_P", 0.95),

  /** Max tokens per response. Default: 16384. */
  maxTokens: optionalInt("MAX_TOKENS", 16384),

  /**
   * Maximum requests per minute the CLI is allowed to send.
   * The rate-limiter uses a sliding-window token bucket.
   */
  rateLimitRpm: optionalInt("RATE_LIMIT_RPM", 40),

  /**
   * Maximum number of simultaneous API calls (hard limit: 1 for MVP).
   * The concurrency mutex enforces this.
   */
  maxConcurrency: Math.min(optionalInt("MAX_CONCURRENCY", 1), 1),

  /**
   * How many times the auto-heal loop may retry writing a file
   * whose generated code failed syntax validation.
   */
  maxHealRetries: optionalInt("MAX_HEAL_RETRIES", 3),

    /** When true, prints verbose internal logs to stderr. */
  debug: optionalBool("DEBUG", false),

  /** Model's context window size in tokens (used for status bar). */
  // BUG FIX: previously hardcoded to 128000. Now we look up the actual
  // context window for the active model from MODEL_REGISTRY. The user can
  // still override via CONTEXT_WINDOW_TOKENS env var.
  contextWindowTokens: optionalInt(
    "CONTEXT_WINDOW_TOKENS",
    getModelContextWindow(process.env.MODEL ?? "moonshotai/kimi-k2.6"),
  ),

  /** Threshold (0.0-1.0) of context window that triggers auto-compact. */
  contextCompactThreshold: optionalFloat("CONTEXT_COMPACT_THRESHOLD", 0.75),

  /** Threshold (0.0-1.0) of context window that warns user with yellow bar. */
  contextWarnThreshold: optionalFloat("CONTEXT_WARN_THRESHOLD", 0.6),

  /** Approximate USD cost per 1k prompt tokens (estimate only). */
  // BUG FIX: previously defaulted to 0. Now we look up the actual cost
  // for the active model from MODEL_REGISTRY. The user can still override.
  costPerKPrompt: optionalFloat(
    "COST_PER_K_PROMPT",
    getModelCost(process.env.MODEL ?? "moonshotai/kimi-k2.6").prompt / 1000,
  ),

    /** Approximate USD cost per 1k completion tokens. */
  costPerKCompletion: optionalFloat(
    "COST_PER_K_COMPLETION",
    getModelCost(process.env.MODEL ?? "moonshotai/kimi-k2.6").completion / 1000,
  ),

  /** When true, shows a diff preview and asks for user confirmation before applying file changes. */
  diffPreview: optionalBool("DIFF_PREVIEW", true),
} as const;

export type Config = typeof config;
