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
 *   - medium -> "Use pensar() para tarefas não-triviais. Mantenha raciocínio curto."
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
    const stored = typeof localStorage !== "undefined"
      ? localStorage.getItem(STORAGE_KEY)
      : process.env[`${ENV_KEY}_STORED`];
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
Responda direto e conciso. Use pensar() APENAS para tarefas complexas (multi-arquivo, algoritmos, debugging).
Não valide cada passo - foque em velocidade.
Pule auto-testes pós-diff a menos que o usuário peça.`;

    case "medium":
      return `## EFFORT LEVEL: MEDIUM (default)
Use pensar() para tarefas não-triviais (escritas, edições, comandos que mudam estado).
Raciocínio curto e focado: 1-3 frases no pensar().
Verifique tipos e erros óbvios antes de escrever código.`;

    case "high":
      return `## EFFORT LEVEL: HIGH
Use pensar() antes de CADA escrita (aplicar_diff, editar_arquivo, desfazer_edicao).
No pensar(), verifique explicitamente: tipos, dependências, edge cases, regressões.
Raciocínio médio: 3-6 frases. Sempre considere o que pode dar errado.
Após editar, rode testes/tsc para validar.`;

    case "max":
      return `## EFFORT LEVEL: MAX
Use pensar() antes de CADA tool call que muda estado (write, edit, command, rollback).
No pensar(), estruture: (1) o que vou fazer, (2) por quê, (3) o que li do arquivo, (4) edge cases, (5) alternativas consideradas, (6) impacto em outros arquivos.
Raciocínio longo e detalhado: 6+ frases quando apropriado.
Antes de finish_reason, valide explicitamente o trabalho feito nesta turn.
Se não tiver certeza, faça mais research antes de agir.`;

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
