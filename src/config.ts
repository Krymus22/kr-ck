/**
 * config.ts — Centralized configuration loaded from environment variables.
 * All runtime tunables live here; the rest of the codebase imports from this
 * module instead of reading process.env directly.
 */

import "dotenv/config";

// ─── Helpers ────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    console.error(
      `\n❌  Missing required environment variable: ${key}\n` +
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

// ─── Exported Config ────────────────────────────────────────────────────────

export const config = {
  /** NVIDIA NIM API key (required). */
  nvidiaApiKey: requireEnv("NVIDIA_API_KEY"),

  /** Base URL for the NVIDIA NIM OpenAI-compatible endpoint. */
  nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",

  /** Model identifier for the model on NVIDIA NIM. */
  model: process.env.MODEL || "moonshotai/kimi-k2.6",

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
  contextWindowTokens: optionalInt("CONTEXT_WINDOW_TOKENS", 128000),

  /** Threshold (0.0–1.0) of context window that triggers auto-compact. */
  contextCompactThreshold: optionalFloat("CONTEXT_COMPACT_THRESHOLD", 0.75),

  /** Threshold (0.0–1.0) of context window that warns user with yellow bar. */
  contextWarnThreshold: optionalFloat("CONTEXT_WARN_THRESHOLD", 0.6),

  /** Approximate USD cost per 1k prompt tokens (estimate only). */
  costPerKPrompt: optionalFloat("COST_PER_K_PROMPT", 0),

    /** Approximate USD cost per 1k completion tokens. */
  costPerKCompletion: optionalFloat("COST_PER_K_COMPLETION", 0),

  /** When true, shows a diff preview and asks for user confirmation before applying file changes. */
  diffPreview: optionalBool("DIFF_PREVIEW", true),
} as const;

export type Config = typeof config;
