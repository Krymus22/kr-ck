/**
 * config.ts - Centralized configuration loaded from environment variables.
 * All runtime tunables live here; the rest of the codebase imports from this
 * module instead of reading process.env directly.
 */

import "dotenv/config";
import { getModelContextWindow, getModelCost } from "./modelRegistry.js";
import { detectProvider, getProviderConfig } from "./apiProvider.js";

// --- Helpers ----------------------------------------------------------------

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  // BUG FIX: previously did not trim whitespace, so DEBUG="  true  " (with
  // surrounding whitespace from shell quoting or .env files) would fail the
  // strict equality check and silently fall back to the default. This caused
  // confusing behavior where users thought they enabled debug mode but it
  // stayed off. Trim before comparing to handle these cases.
  const raw = process.env[key]?.trim().toLowerCase();
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

// --- Detect API provider (NVIDIA NIM or ZenMux) -----------------------------

const _provider = detectProvider();
const _providerConfig = getProviderConfig();

// --- Validate: at least one key source must be set -------------------------

const hasNvidiaKey = process.env.NVIDIA_API_KEY?.trim() || process.env.NVIDIA_API_KEYS?.trim() || process.env.NVIDIA_API_KEYS_FILE?.trim();
const hasZenmuxKey = process.env.ZENMUX_API_KEY?.trim();

if (!hasNvidiaKey && !hasZenmuxKey) {
  console.error(
    `\nX  Missing API key configuration.\n` +
    `   Set ONE of:\n` +
    `     NVIDIA_API_KEY=nvapi-xxx        (NVIDIA NIM, single key)\n` +
    `     NVIDIA_API_KEYS=nvapi-x1,...     (NVIDIA NIM, multi-key pool)\n` +
    `     ZENMUX_API_KEY=sk-ai-v1-xxx     (ZenMux, single key)\n` +
    `   Optional: API_PROVIDER=nvidia|zenmux (auto-detected if not set)\n`
  );
  process.exit(1);
}

// --- Exported Config --------------------------------------------------------

export const config = {
  /** API provider name ("nvidia" or "zenmux"). */
  apiProvider: _provider,

  /** API key for the active provider.
   *
   * BUG FIX: trimmed to remove accidental leading/trailing whitespace from
   * shell quoting or .env files. Without this, NVIDIA_API_KEY="  nvapi-xxx  "
   * would be sent verbatim to the API and cause confusing 401 Unauthorized
   * errors. The apiProvider.ts getProviderConfig() does NOT trim, so we do
   * it here as a defensive measure. */
  nvidiaApiKey: _providerConfig.apiKey.trim(),

  /**
   * Multi-key pool (optional). Comma-separated list of NVIDIA API keys
   * for parallel requests. Each key gets its own 40 RPM / 1 concurrent quota.
   * Set NVIDIA_API_KEYS or NVIDIA_API_KEYS_FILE to enable multi-key mode.
   * Falls back to NVIDIA_API_KEY (single-key) if not set.
   */
  nvidiaApiKeys: process.env.NVIDIA_API_KEYS ?? "",
  nvidiaApiKeysFile: process.env.NVIDIA_API_KEYS_FILE ?? "",

  /** Base URL for the API endpoint (provider-specific). */
  nvidiaBaseUrl: _providerConfig.baseUrl,

  /** Model identifier for the model on NVIDIA NIM. */
  model: process.env.MODEL ?? "moonshotai/kimi-k2.6",

  /** Temperature for sampling (0.0-2.0). Default: 1.0 (NVIDIA recommended). */
  temperature: optionalFloat("TEMPERATURE", 1.0),

  /** Top-p for nucleus sampling (0.0-1.0). Default: 0.95 (NVIDIA recommended). */
  topP: optionalFloat("TOP_P", 0.95),

  /**
   * Max tokens per response.
   *
   * BUG FIX: previously hardcoded to 16384, which capped reasoning models
   * (deepseek-r1, glm-5.2) at 16k even though they support 32k. Reasoning
   * content is generated BEFORE visible content, so a 16k cap left no room
   * for the actual response after reasoning ate the budget. Now we default
   * to the active model's maxOutputTokens from the registry (capped at the
   * model limit by apiClient via Math.min).
   */
  // Default: very high (128k). The ACTUAL limit is enforced by apiClient.ts:
  //   max_tokens: Math.min(config.maxTokens, getModelMaxOutputTokens(config.model))
  // So if you use kimi-k2.6 (8k max), it sends 8k. If you use GLM 5.2 (32k max),
  // it sends 32k. The config default just needs to be high enough to NOT cap
  // models that support more.
  // Bug hunter rodada 2 mudou pra getModelMaxOutputTokens(defaultModel) = 8192,
  // mas isso cortava GLM 5.2 em 8k (Math.min(8192, 32768) = 8192). Corrigido.
  maxTokens: optionalInt(
    "MAX_TOKENS",
    131072, // 128k — higher than any model's maxOutputTokens, so the registry is the real cap
  ),

  /**
   * Maximum requests per minute the CLI is allowed to send.
   * The rate-limiter uses a sliding-window token bucket.
   */
  rateLimitRpm: optionalInt("RATE_LIMIT_RPM", 40),

  /**
   * Maximum number of simultaneous API calls (hard limit: 1 for MVP).
   * The concurrency mutex enforces this.
   *
   * BUG FIX: previously `Math.min(optionalInt(...), 1)` — Math.min returns
   * the smaller value, so MAX_CONCURRENCY=-1 resulted in -1 (negative!),
   * which broke the concurrency limiter (a negative limit means unlimited
   * or always-block depending on the loop). Now clamped to [1, 1] so the
   * hard limit is enforced regardless of user input. Per BUSINESS_RULES §2:
   * maxConcurrency is "Hard limit (MVP)" = 1.
   */
  maxConcurrency: Math.max(1, Math.min(optionalInt("MAX_CONCURRENCY", 1), 1)),

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

  /** Threshold (0.0-1.0) of context window that triggers auto-compact.
   *  Default 0.70 — when context reaches 70%, LLM-based compaction runs
   *  FIRST (priority strategy), preserving architectural decisions and
   *  unresolved bugs. Heuristic/mechanical compaction only runs as fallback
   *  if LLM fails or effortLevel="low". */
  contextCompactThreshold: optionalFloat("CONTEXT_COMPACT_THRESHOLD", 0.70),

  /** Threshold (0.0-1.0) of context window that warns user with yellow bar. */
  contextWarnThreshold: optionalFloat("CONTEXT_WARN_THRESHOLD", 0.65),

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
