/**
 * planExecutor.ts - Plan-then-execute with visual checkpoints.
 *
 * Forces the AI to write a numbered plan BEFORE any edits. Each step
 * is shown in the TUI with a checkbox (☐ pending / ☑ done / ☐▶ in-progress).
 *
 * Flow:
 *   1. User sends request
 *   2. AI is forced to call criar_plano({ steps: [...] })
 *   3. Plan appears in TUI with all steps ☐ pending
 *   4. AI executes one step per turn, calls marcar_passo({ index, done: true })
 *   5. TUI updates checkbox to ☑
 *   6. When all steps ☑, AI can finish_reason
 *
 * Integration:
 *   - apiClient.ts: add criar_plano + marcar_passo to TOOL_DEFINITIONS
 *   - agent.ts: dispatch these tools
 *   - App.tsx: display plan in TodoPanel (reuse existing todo UI)
 *   - history.ts: system prompt mentions plan-first mode
 */

import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface PlanStep {
  description: string;
  done: boolean;
}

export interface Plan {
  steps: PlanStep[];
  createdAt: number;
  completedAt: number | null;
}

// --- State ------------------------------------------------------------------

let currentPlan: Plan | null = null;

// --- Public API -------------------------------------------------------------

/**
 * Create a new plan. Replaces any existing plan.
 * Called by the AI via the criar_plano tool.
 */
export function createPlan(steps: string[]): Plan {
  currentPlan = {
    steps: steps.map((s) => ({ description: s, done: false })),
    createdAt: Date.now(),
    completedAt: null,
  };
  log.info(`[PLAN] Created plan with ${steps.length} steps`);
  return currentPlan;
}

/**
 * Mark a step as done (or not done).
 * Called by the AI via the marcar_passo tool.
 */
export function markStep(index: number, done: boolean): boolean {
  if (!currentPlan) return false;
  // BUG FIX (FIX-CORE Bug 2): NaN bypasses the `< 0 || >= length` bounds check
  // (all NaN comparisons are false), so `steps[NaN].done = done` would throw
  // TypeError. Guard with Number.isInteger so any non-integer (NaN, Infinity,
  // floats, strings coerced by callers) returns false instead of throwing.
  if (!Number.isInteger(index)) {
    log.warn(`[PLAN] markStep received non-integer index: ${String(index)} — ignoring.`);
    return false;
  }
  if (index < 0 || index >= currentPlan.steps.length) return false;

  currentPlan.steps[index]!.done = done;

  // Check if all steps are done
  const allDone = currentPlan.steps.every((s) => s.done);
  if (allDone && currentPlan.completedAt === null) {
    currentPlan.completedAt = Date.now();
    log.info(`[PLAN] All steps completed!`);
  }

  // BUG FIX (FIX-MISC HIGH 3): completedAt is set when all steps are done
  // but was NEVER reset when a step was unmarked via markStep(i, false).
  // The short-circuit `if (currentPlan.completedAt !== null) return false;`
  // in hasIncompletePlan suppressed incomplete detection, allowing
  // finish_reason to fire on a plan with un-done steps. Reset it here so
  // un-marking a step correctly re-opens the plan.
  if (!allDone && currentPlan.completedAt !== null) {
    currentPlan.completedAt = null;
    log.info(`[PLAN] Step ${index + 1} un-marked; plan re-opened.`);
  }

  return true;
}

/**
 * Get the current plan (or null if none).
 */
export function getPlan(): Plan | null {
  return currentPlan;
}

/**
 * Check if there's an active plan with incomplete steps.
 * Used to block finish_reason until plan is complete.
 */
export function hasIncompletePlan(): boolean {
  if (!currentPlan) return false;
  if (currentPlan.completedAt !== null) return false;
  return currentPlan.steps.some((s) => !s.done);
}

/**
 * Get incomplete steps for display.
 */
export function getIncompleteSteps(): PlanStep[] {
  if (!currentPlan) return [];
  return currentPlan.steps.filter((s) => !s.done);
}

/**
 * Clear the current plan (for /reset or new task).
 */
export function clearPlan(): void {
  currentPlan = null;
}

/**
 * Format the plan as a readable string for the AI.
 */
export function formatPlan(): string {
  if (!currentPlan) return "";
  const lines: string[] = [`[PLAN - ${currentPlan.steps.length} steps]`];
  currentPlan.steps.forEach((step, i) => {
    const status = step.done ? "DONE" : "PENDING";
    lines.push(`${i + 1}. [${status}] ${step.description}`);
  });
  const incomplete = currentPlan.steps.filter((s) => !s.done).length;
  if (incomplete > 0) {
    lines.push(`\n${incomplete} step(s) remaining. Complete all before finishing.`);
  } else {
    lines.push(`\nAll steps completed! You may finish.`);
  }
  return lines.join("\n");
}

/**
 * Get plan as todo items (for TUI TodoPanel integration).
 */
export function getPlanAsTodos(): Array<{ content: string; done: boolean }> {
  if (!currentPlan) return [];
  return currentPlan.steps.map((s) => ({
    content: s.description,
    done: s.done,
  }));
}
