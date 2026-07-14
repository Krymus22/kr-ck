/**
 * stateCleanup.ts — Centralized module-level state cleanup.
 *
 * Several modules keep per-turn or per-session state at the module level
 * (Maps, Sets, arrays, counters). If this state is NOT cleared when the user
 * starts a new session (via /reset, /session new, /session load, auto-load,
 * or the mode "new" context action), it leaks into the new session and
 * causes subtle, hard-to-diagnose bugs.
 *
 * §17.3.11 of BUSINESS_RULES.md mandates `clearReadPaths` on those four
 * reset points ("sem isso = gate bypassado"). This module extends the same
 * defense-in-depth to every other module with module-level state.
 *
 * Why a separate module?
 *   - App.tsx is a React component with many heavy transitive imports.
 *     Importing the cleanup helper from a tiny standalone module lets tests
 *     verify the cleanup contract without loading App.tsx (and Ink, React,
 *     the OpenAI SDK, etc.).
 *   - The same helper can be reused by future reset points (e.g. agent.ts
 *     pre-turn maintenance) without duplicating the call list.
 *
 * Resilience:
 *   Every clear is wrapped in its own try/catch so a failure in one module
 *   (e.g. an optional module not loaded, or a mock that doesn't expose the
 *   reset function in tests) doesn't block the rest. None of these throws
 *   in practice, but the safety net makes the helper robust to future
 *   refactors that conditionally load a module.
 *
 * Heavy vs. light modules:
 *   - Light modules (no heavy transitive deps) use static imports.
 *   - Heavy modules (bugHunter, dataGuard, checkpointWriter) transitively
 *     load apiClient, which constructs a real OpenAI client at module init.
 *     They are loaded lazily via dynamic `import()` — matching the pattern
 *     in agent.ts. This avoids forcing the OpenAI SDK to load in tests
 *     that mock `../agent.js`.
 */

import { clearReadPaths } from "./readBeforeWrite.js";
import { clearSessionFiles } from "./fileRehydration.js";
import { clearInvokedSkills } from "./skillTracker.js";
import { clearAllHonestyState } from "./honestySystem.js";
import { clearFailures } from "./failureMemory.js";
import { clearPatternCache } from "./patternExtractor.js";
import { clearActivity } from "./activityTracker.js";
// Round 4 integration fix: these light modules keep per-session state at the
// module level too, but were missing from the cleanup helper. Without these
// clears, /reset, /session new, /session load, auto-load, and the mode "new"
// context action would all leak the previous session's:
//   - planExecutor.currentPlan → hasIncompletePlan() blocks finish in the
//     NEW session on the first turn that touches files (BUSINESS_RULES.md
//     §10.5 step 4: "Plan completion check — se hasIncompletePlan() E
//     touchedFiles > 0"). The stale plan from session A blocks session B.
//   - specFirst.currentSpec → hasSpec() stays true; the spec from session A
//     is treated as the contract for session B's implementation.
//   - tddMode.currentTDD → hasTDD() stays true; tests from session A are
//     re-run against session B's code.
//   - todo.currentTodos → the TodoBar still shows the previous session's
//     task list (visible leak the user can see), and syncTodos() in App.tsx
//     copies them back into the React state.
// All four are light modules (only `logger.js` / `node:fs` / `node:path`
// imports — no apiClient, no OpenAI SDK), so they belong in the synchronous
// clear set alongside readBeforeWrite, fileRehydration, etc.
import { clearPlan } from "./planExecutor.js";
import { clearSpec } from "./specFirst.js";
import { clearTDD } from "./tddMode.js";
import { resetTodo } from "./todo.js";
import { clearTaskState } from "./taskState.js";

/**
 * Clear ALL module-level state that could leak between sessions/turns.
 *
 * Without these calls, stale data leaks into the new session:
 *   - honestySystem.filesEditedButNotReadBack → blocks finish on files edited
 *     in a DIFFERENT session (the IA never read them back in THIS session).
 *   - honestySystem.claimStore → flags "contradictions" against claims made in
 *     a previous session.
 *   - failureMemory.failures → injects "Avoid these recent mistakes" from a
 *     previous session's edit failures, polluting the new session's context.
 *   - checkpointWriter.lastCheckpointState → next incremental checkpoint
 *     builds on the STALE "previous state" from a different conversation.
 *   - patternExtractor.cachedPatterns → stale patterns from a different project
 *     (the cache is keyed on projectRoot, but /cd can change cwd without a
 *     process restart; explicit clear is safer than relying on TTL).
 *   - activityTracker.state.stack → if the previous turn was aborted (ESC) the
 *     stack may still have stale "Executando tool: foo" entries.
 *   - bugHunter.previousFindings / fileSnapshots → next round reports
 *     "previously identified bugs" that don't exist in the new session.
 *   - dataGuard.previousFindings → same pattern as bugHunter.
 *   - planExecutor.currentPlan → hasIncompletePlan() returns true in the
 *     new session, blocking finish on the first turn that touches files
 *     (BUSINESS_RULES.md §10.5 step 4 + §6.4 `[PLAN` preserve prefix).
 *   - specFirst.currentSpec → hasSpec() returns true in the new session,
 *     so the IA thinks a spec is already written.
 *   - tddMode.currentTDD → hasTDD() returns true in the new session, so
 *     tests from the previous session are re-run against new code.
 *   - todo.currentTodos → the TodoBar still shows the previous session's
 *     tasks (visible leak the user can see in the TUI).
 *
 * The helper is async because of the dynamic imports for the heavy modules.
 * Callers fire it best-effort via `void clearAllModuleState()`. The
 * synchronous resets (history, readPaths, etc.) complete before the helper
 * returns; the async ones complete in the background before the user can
 * send the next message. `runAgentLoop` ALSO resets per-turn state at the
 * start of the next turn, so any race here is bounded and defense-in-depth
 * — not a correctness issue.
 */
export async function clearAllModuleState(): Promise<void> {
  // Synchronous clears (light modules — static imports above).
  try { clearReadPaths(); } catch { /* readBeforeWrite optional */ }
  try { clearSessionFiles(); } catch { /* fileRehydration optional */ }
  try { clearInvokedSkills(); } catch { /* skillTracker optional */ }
  try { clearAllHonestyState(); } catch { /* honestySystem optional */ }
  try { clearFailures(); } catch { /* failureMemory optional */ }
  try { clearPatternCache(); } catch { /* patternExtractor optional */ }
  try { clearActivity(); } catch { /* activityTracker optional */ }
  // Round 4 integration fix: plan/spec/tdd/todo module-level singletons.
  try { clearPlan(); } catch { /* planExecutor optional */ }
  try { clearSpec(); } catch { /* specFirst optional */ }
  try { clearTDD(); } catch { /* tddMode optional */ }
  try { resetTodo(); } catch { /* todo optional */ }
  // BH-SESSION-NEW-1 HIGH #1 fix: clear TASK_STATE.md so old session's
  // title/todos/bugs don't get injected into the new session via
  // getTaskStateSummary() → runAgentLoop → history.addSystemMessage().
  try { clearTaskState(); } catch { /* taskState optional */ }

  // Asynchronous clears (heavy modules — dynamic import to avoid eager-loading
  // apiClient / OpenAI SDK at module init time).
  try {
    const { resetBugHunterState } = await import("./bugHunter.js");
    resetBugHunterState();
  } catch { /* bugHunter optional */ }
  try {
    const { resetDataGuardState } = await import("./dataGuard.js");
    resetDataGuardState();
  } catch { /* dataGuard optional */ }
  try {
    const { resetCheckpoints } = await import("./checkpointWriter.js");
    resetCheckpoints();
  } catch { /* checkpointWriter optional */ }
  // BH-SESSION-NEW-1 HIGH #2 fix: clear pending small task summaries so
  // old /small results don't get injected into the new session via
  // consumePendingSummaries() → runAgentLoop → history.addSystemMessage().
  try {
    const { _resetSmallTaskState } = await import("./smallTaskAgent.js");
    _resetSmallTaskState();
  } catch { /* smallTaskAgent optional */ }
  // BH-SESSION-NEW-1 MEDIUM #3 fix: clear memory checkpoint so old session's
  // currentTask doesn't get injected via injectMemory() → addSystemMessage().
  try {
    const { clearCheckpoint, getMemoryConfig } = await import("./memory.js");
    clearCheckpoint(getMemoryConfig());
  } catch { /* memory optional */ }
}

/**
 * Synchronous subset of clearAllModuleState.
 *
 * Clears only the light modules (no dynamic import, no await). Useful for
 * reset points that MUST complete synchronously before returning (e.g. a
 * hypothetical synchronous /reset path). The current App.tsx uses the async
 * `clearAllModuleState` because all reset handlers can tolerate a
 * fire-and-forget cleanup, but this export is provided for future
 * synchronous reset points and for tests that want to verify the light
 * clears in isolation.
 */
export function clearAllModuleStateSync(): void {
  try { clearReadPaths(); } catch { /* readBeforeWrite optional */ }
  try { clearSessionFiles(); } catch { /* fileRehydration optional */ }
  try { clearInvokedSkills(); } catch { /* skillTracker optional */ }
  try { clearAllHonestyState(); } catch { /* honestySystem optional */ }
  try { clearFailures(); } catch { /* failureMemory optional */ }
  try { clearPatternCache(); } catch { /* patternExtractor optional */ }
  try { clearActivity(); } catch { /* activityTracker optional */ }
  // Round 4 integration fix: plan/spec/tdd/todo module-level singletons.
  try { clearPlan(); } catch { /* planExecutor optional */ }
  try { clearSpec(); } catch { /* specFirst optional */ }
  try { clearTDD(); } catch { /* tddMode optional */ }
  try { resetTodo(); } catch { /* todo optional */ }
  // BH-SESSION-NEW-1 HIGH #1 fix: clear TASK_STATE.md so old session's
  // title/todos/bugs don't get injected into the new session via
  // getTaskStateSummary() → runAgentLoop → history.addSystemMessage().
  try { clearTaskState(); } catch { /* taskState optional */ }
}
