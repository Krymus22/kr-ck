/**
 * effortLevels.ts - User-controlled reasoning effort via prompt.
 *
 * NVIDIA NIM API exposes thinking as on/off (no native Low/Medium/High/Max).
 * Fable 5 has 5 native effort levels; we approximate the same UX by adjusting
 * the SYSTEM PROMPT to instruct the model how much to reason.
 *
 * Levels:
 *   - low    -> "Responda direto. Não use pensar() a menos que seja muito complexo."
 *              For trivial tasks (rename, format, simple Q&A). Skips self-validation.
 *   - medium -> "Use pensar() for tarefas não-triviais. Mantenha raciocínio curto."
 *              Default. Good balance.
 *   - high   -> "Use pensar() antes de CADA escrita. Verifique tipos e edge cases."
 *              For complex refactors, multi-file changes.
 *   - max    -> "Use pensar() antes de cada tool call. Valide cada passo. Considere
 *              alternativas. Reflita sobre o trabalho feito antes de terminar."
 *              Mirrors Fable 5 max effort: "reflects on and validates its own work".
 *
 * The level is stored in env var CLAUDE_KILLER_EFFORT or memory; the TUI can
 * expose a /effort low|medium|high|max slash command to change at runtime.
 */

import * as history from "./history.js";

export type EffortLevel = "low" | "medium" | "high" | "max";

const VALID_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "max"]);
const ENV_KEY = "CLAUDE_KILLER_EFFORT";
const STORAGE_KEY = "claude-killer:effort-level";

let currentLevel: EffortLevel = loadInitialLevel();

function loadInitialLevel(): EffortLevel {
  // 1. Env var wins (highest priority - for CLI/scripted use)
  const envVal = (process.env[ENV_KEY] ?? "").toLowerCase();
  if (VALID_LEVELS.has(envVal as EffortLevel)) return envVal as EffortLevel;
  // 2. Persistent storage (set via /effort slash command)
  try {
    // BUG FIX: previously the stored value was compared case-sensitively
    // against VALID_LEVELS (which contains only lowercase). So a stored
    // value of "LOW" (e.g., from CLAUDE_KILLER_EFFORT_STORED=LOW set in
    // a shell) would be rejected and fall through to "medium", even
    // though the env-var path (CLAUDE_KILLER_EFFORT=LOW) accepts it.
    // This was inconsistent. Now we lowercase the stored value to match
    // the env-var path's case-insensitive behavior.
    const rawStored = typeof localStorage !== "undefined"
      ? localStorage.getItem(STORAGE_KEY)
      : process.env[`${ENV_KEY}_STORED`];
    const stored = rawStored?.toLowerCase();
    if (stored && VALID_LEVELS.has(stored as EffortLevel)) return stored as EffortLevel;
  } catch { /* localStorage not available */ }
  // 3. Default
  return "medium";
}

export function getEffortLevel(): EffortLevel {
  return currentLevel;
}

export function setEffortLevel(level: EffortLevel): boolean {
  if (!VALID_LEVELS.has(level)) return false;
  currentLevel = level;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, level);
    else process.env[`${ENV_KEY}_STORED`] = level;
  } catch { /* ignore persistence failure */ }
  // Refresh the system prompt so the new level takes effect immediately
  if (history.getHistory().length > 0 && history.getHistory()[0]?.role === "system") {
    history.getHistory()[0].content = history.getSystemPrompt();
  }
  return true;
}

/**
 * Effort-specific instructions to inject into the system prompt.
 * These tell the model how much reasoning to perform.
 */
export function getEffortPromptSnippet(): string {
  switch (currentLevel) {
    case "low":
      return `## EFFORT LEVEL: LOW
Always use pensar() before acting — even a 1-sentence thought: "vou fazer X porque Y".
Responda direto e conciso. Foque em velocidade mas NÃO pule o pensar().
Categorias: pre_edit (antes de editar), pre_response (antes de responder), planning (antes de começar).`;

    case "medium":
      return `## EFFORT LEVEL: MEDIUM (default)
Use pensar() before any action (edit, command, respond). 2-3 frases: o que, por quê, o que pode dar errado.
Categorias obrigatórias:
- pre_edit: antes de editar arquivo (responda o checklist anti-bug)
- pre_research: antes de pesquisar API
- pre_response: antes de responder ao usuário (honestidade)
- planning: antes de começar uma tarefa
Verifique tipos e erros óbvios antes de escrever código.`;

    case "high":
      return `## EFFORT LEVEL: HIGH
Use pensar() before EVERY action with the correct category. 4-6 frases, responda o checklist completo.
Categorias obrigatórias:
- planning: antes de começar (liste arquivos, ordem, riscos)
- pre_edit: antes de editar (checklist anti-bug: leu? search existe? quebugs? edge cases? Bug Hunter aprovaria?)
- pre_research: antes de pesquisar (o que sei, o que preciso confirmar)
- pre_response: antes de responder (verifiquei? estou sendo honesto?)
- debugging: investigando bugs
Após editar, rode testes/tsc para validar.
Considere delegar exploração para sub-agentes.`;

    case "max":
      return `## EFFORT LEVEL: MAX
Use pensar() before EVERY tool call. 6+ frases estruturadas. Responda o checklist completo.
Estruture: (1) o que vou fazer, (2) por quê, (3) o que li do arquivo, (4) edge cases, (5) alternativas consideradas, (6) impacto em outros arquivos, (7) que bugs o Bug Hunter encontraria.
Categorias obrigatórias: planning, pre_edit, pre_research, pre_response, debugging, architecture.
Antes de finish, valide explicitamente o trabalho feito nesta turn.
Use sub-agentes para explorar em paralelo.
Se não tiver certeza, faça mais research antes de agir.
HONESTY OVER AGREEMENT — sempre.`;

    default:
      return "";
  }
}

/**
 * Returns a hint string suitable for the status bar / TUI.
 */
export function getEffortLabel(): string {
  const labels: Record<EffortLevel, string> = {
    low: "LOW !",
    medium: "MEDIUM G",
    high: "HIGH Q",
    max: "MAX B",
  };
  return labels[currentLevel];
}

/**
 * Whether the current level enables auto-test generation after diffs.
 * Low effort skips it; medium+ enables it.
 */
export function shouldAutoGenerateTests(): boolean {
  return currentLevel !== "low";
}

/**
 * Whether the current level enables sub-agent spawning for exploration.
 * Low and medium skip it (sub-agents add latency); high+ enable it.
 */
export function shouldUseSubAgents(): boolean {
  return currentLevel === "high" || currentLevel === "max";
}

/**
 * Whether the current level enables intelligent compaction (calling the
 * model to summarize history). Low skips (uses simple truncation).
 */
export function shouldUseIntelligentCompaction(): boolean {
  return currentLevel !== "low";
}
