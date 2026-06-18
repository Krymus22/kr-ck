/**
 * modelRegistry.ts - Registry of models available on NVIDIA NIM with their
 * actual context window sizes, max output tokens, and cost estimates.
 *
 * Used by:
 *   - StatusBar (to show the REAL context window for the active model)
 *   - config.ts (to override CONTEXT_WINDOW_TOKENS when not set explicitly)
 *   - compaction logic (to know when to compact based on actual capacity)
 *
 * Source: NVIDIA NIM documentation (https://build.nvidia.com/models)
 * Last updated: 2026-06-18
 */

export interface ModelInfo {
  /** NVIDIA NIM model identifier (e.g., "moonshotai/kimi-k2.6"). */
  id: string;
  /** Display name for the model. */
  name: string;
  /** Maximum total context (prompt + completion) in tokens. */
  contextWindow: number;
  /** Maximum output tokens per response. */
  maxOutputTokens: number;
  /** Approximate cost per 1M prompt tokens in USD (0 for free tier). */
  costPer1MPrompt: number;
  /** Approximate cost per 1M completion tokens in USD. */
  costPer1MCompletion: number;
  /** Whether the model supports tool calling. */
  supportsTools: boolean;
  /** Whether the model supports parallel tool calls. */
  supportsParallelTools: boolean;
}

/**
 * Registry of known models on NVIDIA NIM.
 *
 * If the user's MODEL env var doesn't match any entry, we fall back to a
 * safe default (128k context, 16k max output).
 */
export const MODEL_REGISTRY: ModelInfo[] = [
  {
    id: "moonshotai/kimi-k2.6",
    name: "Kimi K2.6 (Moonshot AI)",
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: true,
  },
  {
    id: "minimaxai/minimax-m3",
    name: "MiniMax M3",
    contextWindow: 1_000_000, // 1M tokens
    maxOutputTokens: 16_384,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: true,
  },
  {
    id: "qwen/qwen2.5-coder-32b-instruct",
    name: "Qwen2.5 Coder 32B",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: false,
  },
  {
    id: "qwen/qwen3-235b-a22b-instruct-2507",
    name: "Qwen3 235B",
    contextWindow: 256_000,
    maxOutputTokens: 16_384,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: true,
  },
  {
    id: "deepseek-ai/deepseek-r1",
    name: "DeepSeek R1",
    contextWindow: 128_000,
    maxOutputTokens: 32_768,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: false,
    supportsParallelTools: false,
  },
  {
    id: "deepseek-ai/deepseek-v3.1",
    name: "DeepSeek V3.1",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: false,
  },
  {
    id: "meta/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: false,
  },
  {
    id: "meta/llama-4-maverick-17b-128e-instruct",
    name: "Llama 4 Maverick",
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: true,
  },
  {
    id: "nvidia/llama-3.1-nemotron-70b-instruct",
    name: "Nemotron 70B",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: false,
  },
  {
    id: "mistralai/mistral-nemotron",
    name: "Mistral Nemotron",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: false,
  },
  {
    id: "writer/palmyra-x5",
    name: "Palmyra X5",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: false,
    supportsParallelTools: false,
  },
  {
    id: "thudm/glm-4.5",
    name: "GLM 4.5",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    costPer1MPrompt: 0,
    costPer1MCompletion: 0,
    supportsTools: true,
    supportsParallelTools: false,
  },
];

/** Fallback model info when MODEL env var doesn't match any registry entry. */
export const FALLBACK_MODEL_INFO: ModelInfo = {
  id: "unknown",
  name: "Unknown Model",
  contextWindow: 128_000,
  maxOutputTokens: 8_192,
  costPer1MPrompt: 0,
  costPer1MCompletion: 0,
  supportsTools: true,
  supportsParallelTools: false,
};

/**
 * Look up model info by NVIDIA NIM model ID.
 * Falls back to FALLBACK_MODEL_INFO (128k context) if not found.
 *
 * @param modelId  The model ID (e.g., "moonshotai/kimi-k2.6")
 * @returns        ModelInfo with context window, max tokens, etc.
 */
export function getModelInfo(modelId: string): ModelInfo {
  return MODEL_REGISTRY.find((m) => m.id === modelId) ?? FALLBACK_MODEL_INFO;
}

/**
 * Get the context window size for a model.
 * Used by config.ts to override CONTEXT_WINDOW_TOKENS when not set explicitly.
 */
export function getModelContextWindow(modelId: string): number {
  return getModelInfo(modelId).contextWindow;
}

/**
 * Get the max output tokens for a model.
 * Used by apiClient.ts to set max_tokens appropriately.
 */
export function getModelMaxOutputTokens(modelId: string): number {
  return getModelInfo(modelId).maxOutputTokens;
}

/**
 * Get the cost per 1M tokens for a model.
 * Returns { prompt, completion } in USD.
 */
export function getModelCost(modelId: string): { prompt: number; completion: number } {
  const info = getModelInfo(modelId);
  return {
    prompt: info.costPer1MPrompt,
    completion: info.costPer1MCompletion,
  };
}

/**
 * Check if a model supports tool calling.
 */
export function modelSupportsTools(modelId: string): boolean {
  return getModelInfo(modelId).supportsTools;
}

/**
 * Check if a model supports parallel tool calls.
 */
export function modelSupportsParallelTools(modelId: string): boolean {
  return getModelInfo(modelId).supportsParallelTools;
}

/**
 * List all known models (for /model slash command).
 */
export function listKnownModels(): ModelInfo[] {
  return [...MODEL_REGISTRY];
}

/**
 * Format a model's context window for display.
 * E.g., 256000 -> "256k", 1000000 -> "1M"
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return k === Math.floor(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${tokens}`;
}
