/**
 * activityTracker.ts - Real-time activity tracking for the TUI.
 *
 * Problem solved: the old ThinkingIndicator showed "PENSANDO..." forever,
 * giving the user no clue whether the agent was:
 *   - Waiting for the LLM API to start streaming
 *   - Streaming tokens from the LLM
 *   - Executing a tool (ler_arquivo, aplicar_diff, executar_comando)
 *   - Running a sub-agent
 *   - Running the quality gate (tsc/lint)
 *   - Compacting context
 *
 * This module exposes a single global activity state with subscribe/notify
 * semantics, so any part of the codebase (agent.ts, apiClient.ts, tools.ts,
 * strictQualityGate.ts) can push an activity update, and the TUI re-renders
 * automatically.
 *
 * Design:
 *   - Pure in-memory, single-process (no IPC).
 *   - Stack-based: callers push an activity and pop it when done. This
 *     handles nested activities correctly (e.g. quality gate running while
 *     a tool is running while streaming).
 *   - Each activity has a label, a category, and an optional startedAt.
 *   - Listeners are notified synchronously on every push/pop.
 */

export type ActivityCategory =
  | "idle"
  | "thinking"            // LLM is reasoning (no streaming yet)
  | "streaming"           // LLM is streaming tokens
  | "tool"                // Executing a tool call
  | "subagent"            // Running a sub-agent
  | "quality_gate"        // Running tsc/lint
  | "compacting"          // Compacting context
  | "checkpoint"          // Writing checkpoint
  | "api_call"            // Making HTTP request to LLM
  | "api_retry"           // Retrying after transient error
  | "bug_hunter";         // Running Bug Hunter critical review

export interface ActivityState {
  stack: ActivityEntry[];
}

export interface ActivityEntry {
  category: ActivityCategory;
  label: string;
  startedAt: number;
}

export interface ActivitySnapshot {
  current: ActivityEntry | null;
  depth: number;
  /** Flat human-readable label like "Executando tool: ler_arquivo" */
  displayLabel: string;
  /** Short label like "ler_arquivo" for compact UIs */
  shortLabel: string;
  /** Elapsed ms since the current activity started */
  elapsedMs: number;
}

type Listener = (snapshot: ActivitySnapshot) => void;

let state: ActivityState = { stack: [] };
const listeners = new Set<Listener>();

/** Returns the current activity snapshot. */
export function getActivitySnapshot(): ActivitySnapshot {
  const current = state.stack.at(-1) ?? null;
  const depth = state.stack.length;
  const elapsedMs = current ? Date.now() - current.startedAt : 0;
  return {
    current,
    depth,
    displayLabel: current ? formatDisplayLabel(current) : "",
    shortLabel: current ? formatShortLabel(current) : "",
    elapsedMs,
  };
}

/** Subscribe to activity changes. Returns an unsubscribe function. */
export function subscribeToActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Push a new activity onto the stack. Returns a function that, when called,
 * pops the activity (or any descendant) off the stack.
 *
 * Usage:
 *   const done = pushActivity("tool", "ler_arquivo /home/user/foo.ts");
 *   try { ... } finally { done(); }
 */
export function pushActivity(category: ActivityCategory, label: string): () => void {
  const entry: ActivityEntry = { category, label, startedAt: Date.now() };
  state = { ...state, stack: [...state.stack, entry] };
  notify();
  return () => popActivity(entry);
}

/**
 * Pop the matching activity (or any activity above it on the stack) off.
 * Safe to call multiple times.
 */
function popActivity(entry: ActivityEntry): void {
  const idx = state.stack.indexOf(entry);
  if (idx === -1) return; // already popped
  const newStack = state.stack.slice(0, idx);
  state = { ...state, stack: newStack };
  notify();
}

/** Clear the entire activity stack (e.g. when the agent loop terminates). */
export function clearActivity(): void {
  if (state.stack.length === 0) return;
  state = { stack: [] };
  notify();
}

/** Force a notify (useful for elapsed-time ticks in the UI). */
export function notifyActivity(): void {
  notify();
}

// --- Helpers ---------------------------------------------------------------

function notify(): void {
  const snap = getActivitySnapshot();
  for (const l of listeners) {
    try { l(snap); } catch { /* listener error must not break the agent */ }
  }
}

function formatDisplayLabel(entry: ActivityEntry): string {
  switch (entry.category) {
    case "thinking":     return `Pensando: ${entry.label}`;
    case "streaming":    return `Gerando resposta${entry.label ? `: ${entry.label}` : ""}`;
    case "tool":         return `Executando tool: ${entry.label}`;
    case "subagent":     return `Sub-agente: ${entry.label}`;
    case "quality_gate": return `Quality gate: ${entry.label}`;
    case "compacting":   return `Compactando contexto…`;
    case "checkpoint":   return `Salvando checkpoint…`;
    case "api_call":     return `Chamando API: ${entry.label}`;
    case "api_retry":    return `Tentando novamente: ${entry.label}`;
    case "idle":
    default:             return entry.label;
  }
}

function formatShortLabel(entry: ActivityEntry): string {
  switch (entry.category) {
    case "thinking":     return "pensando";
    case "streaming":    return "streaming";
    case "tool":         return entry.label.split(" ")[0] ?? "tool";
    case "subagent":     return "sub-agente";
    case "quality_gate": return "quality gate";
    case "compacting":   return "compactando";
    case "checkpoint":   return "checkpoint";
    case "api_call":     return "API";
    case "api_retry":    return "retry";
    case "idle":
    default:             return "";
  }
}

// --- Convenience wrappers --------------------------------------------------

/**
 * Wraps an async function with pushActivity/popActivity.
 *
 * Usage:
 *   const result = await withActivity("tool", "ler_arquivo", async () => {
 *     return await readFile(...);
 *   });
 */
export async function withActivity<T>(
  category: ActivityCategory,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const done = pushActivity(category, label);
  try {
    return await fn();
  } finally {
    done();
  }
}

/** Sync variant of withActivity. */
export function withActivitySync<T>(
  category: ActivityCategory,
  label: string,
  fn: () => T,
): T {
  const done = pushActivity(category, label);
  try {
    return fn();
  } finally {
    done();
  }
}

// --- Test-only helpers -----------------------------------------------------

/** Reset state — used by tests to start from a clean slate. */
export function _resetActivityForTests(): void {
  state = { stack: [] };
  listeners.clear();
}
