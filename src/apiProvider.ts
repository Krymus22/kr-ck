/**
 * apiProvider.ts — Abstraction over API providers (NVIDIA NIM, ZenMux).
 *
 * Each provider has different characteristics:
 *
 * NVIDIA NIM (build.nvidia.com):
 *   - Cold start: 5-60s (model unloaded from GPU after idle)
 *   - Concurrency: 1 per key (need multi-key pool for parallelism)
 *   - Rate limit: 40 RPM per key
 *   - Thinking: needs chat_template_kwargs: { thinking_mode: "enabled" }
 *   - Reasoning field: reasoning_content
 *   - Heartbeat: required (prevents cold start)
 *   - Hedging: useful (GPU queue contention)
 *
 * ZenMux (zenmux.ai):
 *   - Cold start: none (instant)
 *   - Concurrency: 10+ simultaneous (no GPU queue)
 *   - Rate limit: none apparent
 *   - Thinking: built-in per model (don't send chat_template_kwargs)
 *   - Reasoning field: "reasoning" (not "reasoning_content")
 *   - Heartbeat: not needed
 *   - Hedging: not needed
 *   - Sub-agents: 10+ parallel (no key contention)
 */

import { platform } from "node:os";

export type ProviderName = "nvidia" | "zenmux";

export interface ProviderConfig {
  name: ProviderName;
  baseUrl: string;
  apiKey: string;
  /** Whether to send chat_template_kwargs with thinking_mode. */
  sendThinkingMode: boolean;
  /** Field name for reasoning content in stream chunks. */
  reasoningField: "reasoning_content" | "reasoning";
  /** Whether heartbeat is needed (prevents cold start). */
  needsHeartbeat: boolean;
  /** Whether delayed hedging is useful (GPU queue contention). */
  needsHedging: boolean;
  /** Whether multi-key pool is needed (NVIDIA: yes, ZenMux: no). */
  needsMultiKeyPool: boolean;
  /** Max concurrent sub-agents. */
  maxConcurrentSubAgents: number;
  /** Max tokens to request in heartbeat (1 for both). */
  heartbeatMaxTokens: number;
}

// --- Provider definitions ---------------------------------------------------

const NVIDIA_CONFIG: Omit<ProviderConfig, "apiKey"> = {
  name: "nvidia",
  baseUrl: "https://integrate.api.nvidia.com/v1",
  sendThinkingMode: true,
  reasoningField: "reasoning_content",
  needsHeartbeat: true,
  needsHedging: true,
  needsMultiKeyPool: true,
  maxConcurrentSubAgents: 2,
  heartbeatMaxTokens: 1,
};

const ZENMUX_CONFIG: Omit<ProviderConfig, "apiKey"> = {
  name: "zenmux",
  baseUrl: "https://zenmux.ai/api/v1",
  sendThinkingMode: false,
  reasoningField: "reasoning",
  needsHeartbeat: false,
  needsHedging: false,
  needsMultiKeyPool: false,
  maxConcurrentSubAgents: 10,
  heartbeatMaxTokens: 1,
};

// --- Public API -------------------------------------------------------------

/**
 * Detect which provider to use based on env vars.
 *
 * Priority:
 *   1. API_PROVIDER env var (explicit choice)
 *   2. ZENMUX_API_KEY set → zenmux
 *   3. NVIDIA_API_KEY or NVIDIA_API_KEYS set → nvidia (default)
 */
export function detectProvider(): ProviderName {
  const explicit = process.env.API_PROVIDER?.toLowerCase().trim();
  if (explicit === "zenmux") return "zenmux";
  if (explicit === "nvidia") return "nvidia";

  // Auto-detect: if ZENMUX_API_KEY is set and NVIDIA keys are not, use zenmux
  if (process.env.ZENMUX_API_KEY && !process.env.NVIDIA_API_KEY && !process.env.NVIDIA_API_KEYS) {
    return "zenmux";
  }

  // Default: nvidia
  return "nvidia";
}

/**
 * Get the full provider config, including API key from env vars.
 */
export function getProviderConfig(): ProviderConfig {
  const provider = detectProvider();

  if (provider === "zenmux") {
    const apiKey = process.env.ZENMUX_API_KEY ?? "";
    if (!apiKey) {
      console.error(
        `[claude-killer] API_PROVIDER=zenmux but ZENMUX_API_KEY is not set.\n` +
        `  Get your key at https://zenmux.ai and set ZENMUX_API_KEY=sk-ai-v1-...\n`
      );
      process.exit(1);
    }
    return { ...ZENMUX_CONFIG, apiKey };
  }

  // NVIDIA
  const apiKey = process.env.NVIDIA_API_KEY ?? process.env.NVIDIA_API_KEYS?.split(",")[0] ?? "";
  if (!apiKey) {
    console.error(
      `[claude-killer] No API key configured.\n` +
      `  Set NVIDIA_API_KEY or NVIDIA_API_KEYS for NVIDIA NIM,\n` +
      `  or ZENMUX_API_KEY for ZenMux.\n`
    );
    process.exit(1);
  }
  return { ...NVIDIA_CONFIG, apiKey };
}

/**
 * Check if the current provider needs heartbeat.
 * Uses detectProvider() (no exit) instead of getProviderConfig() (which exits on missing key).
 */
export function providerNeedsHeartbeat(): boolean {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.needsHeartbeat : ZENMUX_CONFIG.needsHeartbeat;
}

/**
 * Check if the current provider needs hedging.
 */
export function providerNeedsHedging(): boolean {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.needsHedging : ZENMUX_CONFIG.needsHedging;
}

/**
 * Get the max concurrent sub-agents for the current provider.
 */
export function getProviderMaxSubAgents(): number {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.maxConcurrentSubAgents : ZENMUX_CONFIG.maxConcurrentSubAgents;
}

/**
 * Get the reasoning field name for the current provider.
 * NVIDIA uses "reasoning_content", ZenMux uses "reasoning".
 */
export function getProviderReasoningField(): "reasoning_content" | "reasoning" {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.reasoningField : ZENMUX_CONFIG.reasoningField;
}

/**
 * Whether to send chat_template_kwargs with thinking_mode.
 * NVIDIA: yes (enables thinking mode on the server).
 * ZenMux: no (thinking is built-in per model, sending it may cause errors).
 */
export function providerSendsThinkingMode(): boolean {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.sendThinkingMode : ZENMUX_CONFIG.sendThinkingMode;
}

/**
 * Whether the provider uses a multi-key pool.
 * NVIDIA: yes (each key = 1 concurrent, 40 RPM).
 * ZenMux: no (single key handles 10+ concurrent, no rate limit).
 */
export function providerUsesMultiKeyPool(): boolean {
  const provider = detectProvider();
  return provider === "nvidia" ? NVIDIA_CONFIG.needsMultiKeyPool : ZENMUX_CONFIG.needsMultiKeyPool;
}
