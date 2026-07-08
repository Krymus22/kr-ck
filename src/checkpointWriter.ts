/**
 * checkpointWriter.ts - Proactive structured state extraction.
 *
 * Instead of reactive compaction (wait until 75% full, then summarize
 * everything in one shot), this module proactively extracts structured
 * state at 3 checkpoints: 20%, 45%, 70% of context window.
 *
 * Each checkpoint is INCREMENTAL (only updates what changed since last
 * checkpoint) and extracts 11 fields:
 *   1. Current intention (what the user asked)
 *   2. Next action (what to do next)
 *   3. Constraints (things to respect)
 *   4. Task tree (subtasks remaining)
 *   5. Current work (what was just done)
 *   6. Files involved (paths + what was changed)
 *   7. Cross-task discoveries (things learned that affect other tasks)
 *   8. Errors and corrections (what failed and how it was fixed)
 *   9. Runtime state (tests passing, build status)
 *  10. Design decisions (choices made + rationale)
 *  11. Miscellaneous notes
 *
 * Evidence: MiMo Code proved that extracting at 20% (light context)
 * produces better summaries than at 95% (heavy context). "Lost in the
 * middle" - at 95% the model can't summarize well.
 */

import { chat } from "./apiClient.js";
import * as history from "./history.js";
import * as log from "./logger.js";
import { config } from "./config.js";

// --- Types ------------------------------------------------------------------

export interface CheckpointState {
  intention: string;
  nextAction: string;
  constraints: string[];
  taskTree: string[];
  currentWork: string;
  filesInvolved: Array<{ path: string; change: string }>;
  crossTaskDiscoveries: string[];
  errorsAndCorrections: Array<{ error: string; fix: string }>;
  runtimeState: string;
  designDecisions: Array<{ decision: string; rationale: string }>;
  miscNotes: string;
}

export interface CheckpointResult {
  state: CheckpointState;
  checkpointNumber: number;  // 1, 2, or 3
  contextPercent: number;
  durationMs: number;
}

// --- Config -----------------------------------------------------------------

const CHECKPOINT_THRESHOLDS = [0.20, 0.45, 0.70];  // 20%, 45%, 70%

/**
 * Resolve the context window size (in tokens) to use for checkpoint math.
 *
 * BUG FIX (Bug Hunter: checkpoint firing too early): previously this was a
 * hardcoded constant `MAX_CONTEXT_TOKENS = 128_000`. But the default model
 * (Kimi K2.6) has a 256_000-token context window (see modelRegistry.ts), and
 * `config.contextWindowTokens` already defaults to that value (see config.ts).
 * Using 128_000 meant the 20% threshold fired at 25_600 tokens, which is only
 * 10% of the actual 256_000 window — so the user saw "Salvando checkpoint…"
 * at ~10–13% context after just 2 messages.
 *
 * §17.1.1 compliance: `config.contextWindowTokens` defaults to
 * `getModelContextWindow(modelId)` from modelRegistry.ts (the registry is the
 * source of truth for context window). The user can still override via the
 * `CONTEXT_WINDOW_TOKENS` env var, but the default respects §1.1.
 *
 * The optional `override` parameter exists so tests can pin the value to
 * 128_000 (preserving historical assertions) without depending on the
 * registry / env.
 */
function resolveContextTokens(override?: number): number {
  const fromConfig = config?.contextWindowTokens;
  if (typeof fromConfig === "number" && fromConfig > 0) return fromConfig;
  if (typeof override === "number" && override > 0) return override;
  // Defensive fallback (e.g., partial config mock in a test that doesn't
  // override). Matches the historical hardcoded value so behavior is
  // unchanged if config is unavailable.
  return 128_000;
}

// --- State ------------------------------------------------------------------

let lastCheckpoint = 0;  // 0 = no checkpoint yet, 1/2/3 = checkpoint number
let lastCheckpointState: CheckpointState | null = null;

// --- Public API -------------------------------------------------------------

/**
 * Check if it's time for a checkpoint based on current context size.
 * Returns the checkpoint number (1, 2, 3) or 0 if not needed.
 *
 * BUG FIX (Bug Hunter: checkpoint firing too early): `historyLength` is the
 * current token estimate (NOT message count). It's compared against the
 * configured context window (`config.contextWindowTokens`, which defaults to
 * the registry value per §1.1) using the 20% / 45% / 70% thresholds.
 *
 * @param historyLength  Current token estimate (e.g., `history.estimateTokens()`).
 * @param contextWindow  Optional override for the context window size. Used by
 *                       tests to pin the value to 128_000 (preserving historical
 *                       assertions). In production this is left undefined and
 *                       `config.contextWindowTokens` is used (the actual model's
 *                       context window from modelRegistry.ts).
 */
export function shouldCheckpoint(historyLength: number, contextWindow?: number): number {
  const maxTokens = resolveContextTokens(contextWindow);
  const contextPercent = historyLength / maxTokens;

  for (let i = 0; i < CHECKPOINT_THRESHOLDS.length; i++) {
    const checkpointNum = i + 1;
    const threshold = CHECKPOINT_THRESHOLDS[i]!;
    if (contextPercent >= threshold && lastCheckpoint < checkpointNum) {
      return checkpointNum;
    }
  }

  return 0;
}

/**
 * Extract structured state at a checkpoint.
 *
 * Calls the LLM with a focused prompt to extract the 11 fields.
 * The LLM receives the current conversation history (or a summary of it)
 * and returns structured JSON.
 *
 * @param checkpointNum   - 1, 2, or 3
 * @param contextWindow   - Optional override for the context window size (used
 *                          by tests to pin to 128_000). Production leaves this
 *                          undefined and `config.contextWindowTokens` is used.
 * @returns CheckpointResult with extracted state
 */
export async function writeCheckpoint(checkpointNum: number, contextWindow?: number): Promise<CheckpointResult> {
  const start = Date.now();
  const history_msgs = history.getHistory();
  // Bug fix (Bug Hunter #2): previously used `history_msgs.length` (MESSAGE COUNT)
  // divided by MAX_CONTEXT_TOKENS, which is meaningless — 50 messages / 128000 tokens
  // = ~0.04%, so contextPercent was always ~0. The caller (agent.ts) already
  // correctly passes estimateTokens() to shouldCheckpoint(); this function must
  // do the same for the reported contextPercent metadata. Falls back to 0 if
  // estimateTokens is not available (e.g., in tests with partial mocks).
  //
  // Bug fix (Bug Hunter: checkpoint firing too early): use
  // `resolveContextTokens()` (which reads `config.contextWindowTokens`) instead
  // of the old hardcoded `MAX_CONTEXT_TOKENS = 128_000`. This makes the
  // reported contextPercent match what the user sees in the StatusBar (which
  // also uses `config.contextWindowTokens`).
  const maxTokens = resolveContextTokens(contextWindow);
  const currentTokens = typeof history.estimateTokens === "function"
    ? history.estimateTokens()
    : 0;
  const contextPercent = Math.round((currentTokens / maxTokens) * 100);

  log.info(`[CHECKPOINT] Writing checkpoint ${checkpointNum} at ~${contextPercent}% context`);

  // Build a focused extraction prompt
  const recentMessages = history_msgs.slice(-20);  // Last 20 messages (most relevant)
  const conversationSummary = recentMessages
    .map((m) => `[${m.role}] ${typeof m.content === "string" ? m.content.slice(0, 500) : "[complex]"}`)
    .join("\n\n");

  // Include previous checkpoint state if available (incremental)
  const previousStateStr = lastCheckpointState
    ? `\n\nPrevious checkpoint state (update what changed):\n${JSON.stringify(lastCheckpointState, null, 2)}`
    : "";

  const messages = [
    {
      role: "system" as const,
      content: `You are a state extraction agent. Extract the current task state from the conversation.
Return ONLY valid JSON with these 11 fields:
{
  "intention": "what the user originally asked for",
  "nextAction": "what should be done next",
  "constraints": ["list of constraints to respect"],
  "taskTree": ["remaining subtasks"],
  "currentWork": "what was just completed",
  "filesInvolved": [{"path": "file path", "change": "what was changed"}],
  "crossTaskDiscoveries": ["things learned that affect other tasks"],
  "errorsAndCorrections": [{"error": "what failed", "fix": "how it was fixed"}],
  "runtimeState": "tests passing, build status, etc",
  "designDecisions": [{"decision": "choice made", "rationale": "why"}],
  "miscNotes": "anything else important"
}

Be CONCISE. Each field should be 1-3 lines max. Only include what's relevant.`,
    },
    {
      role: "user" as const,
      content: `Conversation (last 20 messages):\n${conversationSummary}${previousStateStr}\n\nExtract the current state as JSON.`,
    },
  ];

  try {
    const response = await chat(messages);
    const content = response.choices?.[0]?.message?.content ?? "";

    // Parse JSON from response
    const jsonStart = content.indexOf("{");
    const jsonEnd = content.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const jsonStr = content.slice(jsonStart, jsonEnd + 1);
      // Bug Hunter #2c: normalize partial LLM JSON (missing array fields).
      const parsed = JSON.parse(jsonStr) as Partial<CheckpointState>;
      const state = normalizeState(parsed);

      lastCheckpoint = checkpointNum;
      lastCheckpointState = state;

      const result: CheckpointResult = {
        state,
        checkpointNumber: checkpointNum,
        contextPercent,
        durationMs: Date.now() - start,
      };

      log.info(`[CHECKPOINT] Checkpoint ${checkpointNum} written in ${result.durationMs}ms`);
      return result;
    }

    log.warn(`[CHECKPOINT] Failed to parse LLM response as JSON`);
    return {
      state: emptyState(),
      checkpointNumber: checkpointNum,
      contextPercent,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    log.warn(`[CHECKPOINT] LLM call failed: ${(err as Error).message}`);
    return {
      state: emptyState(),
      checkpointNumber: checkpointNum,
      contextPercent,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Format checkpoint state as a string for context injection.
 * This is what gets injected into the conversation to preserve memory.
 *
 * Bug Hunter #2c: defensive against partial state. Callers (and tests) may
 * pass a state missing some fields (e.g. when the LLM returned incomplete
 * JSON). Previously `state.constraints.length` would throw TypeError. Now
 * each field is null-checked via `asArray()`.
 */
export function formatCheckpoint(state: CheckpointState): string {
  const lines: string[] = [`[CHECKPOINT STATE]`];
  lines.push(`Intention: ${state?.intention ?? ""}`);
  lines.push(`Next action: ${state?.nextAction ?? ""}`);

  const constraints = asArray<string>(state?.constraints);
  if (constraints.length > 0) {
    lines.push(`Constraints:`);
    constraints.forEach((c) => lines.push(`  - ${c}`));
  }

  const taskTree = asArray<string>(state?.taskTree);
  if (taskTree.length > 0) {
    lines.push(`Remaining tasks:`);
    taskTree.forEach((t) => lines.push(`  - ${t}`));
  }

  lines.push(`Current work: ${state?.currentWork ?? ""}`);

  const filesInvolved = asArray<{ path: string; change: string }>(state?.filesInvolved);
  if (filesInvolved.length > 0) {
    lines.push(`Files involved:`);
    filesInvolved.forEach((f) => lines.push(`  - ${f?.path ?? "?"}: ${f?.change ?? ""}`));
  }

  const errorsAndCorrections = asArray<{ error: string; fix: string }>(state?.errorsAndCorrections);
  if (errorsAndCorrections.length > 0) {
    lines.push(`Errors & corrections:`);
    errorsAndCorrections.forEach((e) => lines.push(`  - ${e?.error ?? "?"} → ${e?.fix ?? ""}`));
  }

  const designDecisions = asArray<{ decision: string; rationale: string }>(state?.designDecisions);
  if (designDecisions.length > 0) {
    lines.push(`Design decisions:`);
    designDecisions.forEach((d) => lines.push(`  - ${d?.decision ?? "?"} (${d?.rationale ?? ""})`));
  }

  if (state?.runtimeState) {
    lines.push(`Runtime: ${state.runtimeState}`);
  }

  if (state?.miscNotes) {
    lines.push(`Notes: ${state.miscNotes}`);
  }

  return lines.join("\n");
}

/**
 * Get the last checkpoint state (or null if none).
 */
export function getLastCheckpointState(): CheckpointState | null {
  return lastCheckpointState;
}

/**
 * Get the last checkpoint number (0 = none, 1/2/3 = checkpoint).
 */
export function getLastCheckpointNumber(): number {
  return lastCheckpoint;
}

/**
 * Reset checkpoint state (for new task or /reset).
 */
export function resetCheckpoints(): void {
  lastCheckpoint = 0;
  lastCheckpointState = null;
}

/** Create an empty state (for error fallback). */
function emptyState(): CheckpointState {
  return {
    intention: "",
    nextAction: "",
    constraints: [],
    taskTree: [],
    currentWork: "",
    filesInvolved: [],
    crossTaskDiscoveries: [],
    errorsAndCorrections: [],
    runtimeState: "",
    designDecisions: [],
    miscNotes: "",
  };
}

/**
 * Coerce an unknown value into a typed array (empty if not an array).
 * Used by normalizeState + formatCheckpoint to defend against partial / malformed
 * LLM JSON (e.g. `{"intention":"..."}` with arrays missing entirely).
 */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Normalize a partial (possibly malformed) parsed object into a full CheckpointState.
 *
 * Bug Hunter #2c: `JSON.parse(jsonStr) as CheckpointState` is just a type
 * assertion — it does NOT validate. LLMs routinely return JSON missing fields
 * (only intention, or arrays as null). Without normalization, downstream code
 * that does `state.constraints.length` throws TypeError, the agent.ts
 * try/catch swallows it, and the checkpoint is silently dropped.
 */
function normalizeState(parsed: Partial<CheckpointState>): CheckpointState {
  return {
    intention: typeof parsed.intention === "string" ? parsed.intention : "",
    nextAction: typeof parsed.nextAction === "string" ? parsed.nextAction : "",
    constraints: asArray<string>(parsed.constraints),
    taskTree: asArray<string>(parsed.taskTree),
    currentWork: typeof parsed.currentWork === "string" ? parsed.currentWork : "",
    filesInvolved: asArray<{ path: string; change: string }>(parsed.filesInvolved),
    crossTaskDiscoveries: asArray<string>(parsed.crossTaskDiscoveries),
    errorsAndCorrections: asArray<{ error: string; fix: string }>(parsed.errorsAndCorrections),
    runtimeState: typeof parsed.runtimeState === "string" ? parsed.runtimeState : "",
    designDecisions: asArray<{ decision: string; rationale: string }>(parsed.designDecisions),
    miscNotes: typeof parsed.miscNotes === "string" ? parsed.miscNotes : "",
  };
}
