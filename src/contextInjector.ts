/**
 * contextInjector.ts - Auto-injects high-signal context into tool results.
 *
 * Inspired by Anthropic's "context engineering" article: Fable 5 improves its
 * outputs by reading its own notes before each decision. We replicate this by
 * appending a compact TASK_STATE.md snapshot to the result of "decision-critical"
 * tools (aplicar_diff, editar_arquivo, executar_comando, desfazer_edicao).
 *
 * Why this works even with weaker models:
 *   - Persistent memory compensates for context rot in long sessions
 *   - Forcing the model to re-read its plan/bugs/decisions before acting
 *     reduces drift and forgotten commitments
 *
 * The injection is:
 *   - Compact (~200-400 tokens max)
 *   - Only attached to write/command tools (not read-only - would bloat cache)
 *   - Suppressed when TASK_STATE.md is empty or doesn't exist
 *   - Throttled (at most once every 3 tool calls to avoid noise)
 */

import { getTaskStateSummary } from "./taskState.js";
import * as log from "./logger.js";

// Tools where decision context matters most - these change state, so the
// model benefits from re-reading its plan/bugs before committing.
const DECISION_CRITICAL_TOOLS = new Set([
  "aplicar_diff",
  "editar_arquivo",
  "editar_multi_arquivos",
  "desfazer_edicao",
  "executar_comando",
]);

let callsSinceLastInjection = 0;
const INJECT_EVERY_N_CALLS = 3;

/**
 * Returns the context suffix to append to a tool result, or empty string
 * if no injection should happen for this tool call.
 *
 * @param toolName  Name of the tool that just finished
 * @returns         Context block to append (may be empty)
 */
export function getContextInjection(toolName: string): string {
  if (!DECISION_CRITICAL_TOOLS.has(toolName)) return "";

  callsSinceLastInjection++;
  if (callsSinceLastInjection < INJECT_EVERY_N_CALLS) return "";
  callsSinceLastInjection = 0;

  const summary = getTaskStateSummary();
  if (!summary) return "";

  // Compact: only the most decision-relevant parts
  const compact = compactSummary(summary);
  if (!compact) return "";

  log.debug(`[CONTEXT_INJECT] Appended TASK_STATE snapshot to ${toolName} result (${compact.length} chars)`);
  return `\n\n--- [CURRENT CONTEXT] ---\n${compact}\n--- [END CONTEXT] ---\nRemember these points before the next action.`;
}

/**
 * Reduce the full TASK_STATE summary to only decision-critical fields.
 * Drops "Done" items (past) and notes - keeps Pending, Bugs, Decisions.
 *
 * Bug Hunter #2c: previously the section-state machine only transitioned
 * on Todo/Decisions/Bugs/Dependencies (→ relevant) and Done/Notes (→ not).
 * Any OTHER non-indented line (e.g. "Started: ...", "Updated: ...", or a
 * section header we didn't enumerate like "Comments:") did NOT reset
 * inRelevantSection — so indented items in that unknown section were
 * wrongly kept and injected. Fix: treat ANY non-indented line as a section
 * boundary; only Todo/Decisions/Bugs/Dependencies are relevant.
 */
function compactSummary(full: string): string {
  const lines = full.split("\n");
  const kept: string[] = [];
  let inRelevantSection = false;

  for (const line of lines) {
    // Keep title + header for context
    if (line.startsWith("## TASK_STATE") || line.startsWith("Title:")) {
      kept.push(line);
      continue;
    }
    // Any non-indented line is a section header (or metadata like "Started:").
    // Use this as the boundary: relevant sections stay open, everything else
    // closes the current section.
    if (!line.startsWith("  ")) {
      inRelevantSection = /^(Todo|Decisions|Bugs|Dependencies):/.test(line);
      if (inRelevantSection) {
        kept.push(line);
      }
      continue;
    }
    // Indented line: keep only if inside a relevant section.
    if (inRelevantSection) {
      kept.push(line);
    }
  }

  // If nothing relevant, return empty
  if (kept.length <= 2) return "";
  // Cap at 1500 chars to avoid bloat
  const result = kept.join("\n");
  return result.length > 1500 ? result.slice(0, 1500) + "\n... (truncado)" : result;
}

/**
 * Reset throttle counter - call at the start of a new user turn.
 */
export function resetContextInjection(): void {
  callsSinceLastInjection = 0;
}
