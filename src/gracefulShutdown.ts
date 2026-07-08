/**
 * gracefulShutdown.ts - Save state on SIGINT/SIGTERM.
 *
 * When the user presses Ctrl+C or the process is killed, this module
 * saves TASK_STATE.md, plan state, and session trace so the user can
 * resume without losing work.
 *
 * Integration:
 *   - index.ts: register shutdown handlers on startup
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

let isShuttingDown = false;
let shutdownHandlers: Array<() => void> = [];
let handlersRegistered = false; // dedup guard for registerShutdownHandlers()

/** Clear shutdown state (for tests). */
export function resetShutdownState(): void {
  isShuttingDown = false;
  shutdownHandlers = [];
  handlersRegistered = false; // also reset dedup flag so tests can re-register
}

/**
 * Register a handler to run during shutdown.
 * Handlers run in reverse order (last registered = first to run).
 */
export function onShutdown(handler: () => void): void {
  shutdownHandlers.push(handler);
}

/**
 * Perform graceful shutdown.
 * Runs all registered handlers, saves state, then exits.
 * Safe to call multiple times (idempotent).
 *
 * BUG FIX (audit issue #7): previously, a handler that hung (e.g., a
 * database connection that never closed) would block shutdown forever,
 * requiring the user to Ctrl+C twice. Now each handler runs with a 5s
 * timeout — if it doesn't complete in time, we log a warning and move on.
 *
 * Default timeout is 5s per handler, configurable via SHUTDOWN_HANDLER_TIMEOUT_MS.
 * Total shutdown budget is 30s (also configurable via SHUTDOWN_TOTAL_TIMEOUT_MS).
 */
export async function shutdown(signal: string = "SIGINT"): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`[SHUTDOWN] Received ${signal}. Saving state...`);

  // Per-handler timeout (default 5s)
  const handlerTimeoutMs = parseInt(
    process.env.SHUTDOWN_HANDLER_TIMEOUT_MS ?? "5000",
    10,
  );
  // Total shutdown budget (default 30s)
  const totalTimeoutMs = parseInt(
    process.env.SHUTDOWN_TOTAL_TIMEOUT_MS ?? "30000",
    10,
  );

  const shutdownStart = Date.now();
  const remainingBudget = () => Math.max(0, totalTimeoutMs - (Date.now() - shutdownStart));

  // Run registered handlers in reverse order (LIFO)
  const reversedHandlers = [...shutdownHandlers].reverse();
  for (const handler of reversedHandlers) {
    const budget = remainingBudget();
    if (budget <= 0) {
      log.warn(`[SHUTDOWN] Total timeout (${totalTimeoutMs}ms) exceeded, skipping remaining ${reversedHandlers.length - reversedHandlers.indexOf(handler)} handler(s)`);
      break;
    }
    const perHandlerBudget = Math.min(handlerTimeoutMs, budget);
    // BUG FIX (timer leak): previously the per-handler `setTimeout` was
    // created inside the Promise.race and never cleared. When the handler
    // resolved before the timeout, the timer kept ticking for the full
    // `perHandlerBudget` milliseconds — keeping the event loop alive
    // (and the test process hanging for 5s per handler). We now track
    // the timer and clear it in a `finally` block so it can't outlive
    // the race.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve(handler()),
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Handler timeout after ${perHandlerBudget}ms`)),
            perHandlerBudget,
          );
        }),
      ]);
    } catch (err) {
      log.warn(`[SHUTDOWN] Handler failed: ${(err as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Save plan state if active
  try {
    const { getPlan, formatPlan } = await import("./planExecutor.js");
    const plan = getPlan();
    if (plan?.steps.some((s: { done: boolean }) => !s.done)) {
      const planPath = path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
        ".claude-killer",
        "last_plan.json"
      );
      const dir = path.dirname(planPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(planPath, JSON.stringify({
        plan,
        savedAt: new Date().toISOString(),
        signal,
      }, null, 2), "utf8");
      log.info(`[SHUTDOWN] Plan saved to ${planPath} (${plan.steps.filter((s: { done: boolean }) => !s.done).length} incomplete steps)`);
    }
  } catch {
    // planExecutor not available
  }

  // Save failure memory if any
  try {
    const { getFailures } = await import("./failureMemory.js");
    const failures = getFailures();
    if (failures.length > 0) {
      const failPath = path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
        ".claude-killer",
        "last_failures.json"
      );
      fs.writeFileSync(failPath, JSON.stringify(failures, null, 2), "utf8");
      log.info(`[SHUTDOWN] ${failures.length} failure(s) saved`);
    }
  } catch {
    // failureMemory not available
  }

  // Write shutdown marker
  try {
    const markerDir = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
      ".claude-killer"
    );
    if (!fs.existsSync(markerDir)) fs.mkdirSync(markerDir, { recursive: true });
    const markerPath = path.join(markerDir, ".last_shutdown");
    fs.writeFileSync(markerPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      signal,
      pid: process.pid,
    }, null, 2), "utf8");
  } catch {
    // ignore
  }

  log.info(`[SHUTDOWN] State saved. Exiting.`);
}

/**
 * Check if the previous session was interrupted (crash/Ctrl+C).
 * Returns the shutdown info if found, or null.
 */
export function checkPreviousShutdown(): { timestamp: string; signal: string; pid: number } | null {
  try {
    const markerPath = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
      ".claude-killer",
      ".last_shutdown"
    );
    if (!fs.existsSync(markerPath)) return null;
    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    // Delete the marker so it doesn't trigger on next clean startup
    fs.unlinkSync(markerPath);
    return data;
  } catch {
    return null;
  }
}

/**
 * Load the last saved plan (if any) from a previous interrupted session.
 */
export function loadLastPlan(): { plan: any; savedAt: string } | null {
  try {
    const planPath = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
      ".claude-killer",
      "last_plan.json"
    );
    if (!fs.existsSync(planPath)) return null;
    const data = JSON.parse(fs.readFileSync(planPath, "utf8"));
    // Don't delete - user might want to review it
    return data;
  } catch {
    return null;
  }
}

/**
 * Register signal handlers. Call this once at startup.
 *
 * BUG FIX (audit issue #7): previously, calling registerShutdownHandlers()
 * multiple times (e.g., in tests, or if index.ts was loaded twice) would
 * add duplicate listeners for SIGINT/SIGTERM/SIGHUP/uncaughtException.
 * Each Ctrl+C would then trigger shutdown() N times, where N is the number
 * of duplicate registrations — causing handlers to run N times, files to
 * be written N times, and "max listeners exceeded" warnings.
 *
 * Fix: guard with `handlersRegistered` flag. Subsequent calls are no-ops.
 * Use `resetShutdownState()` (for tests) to clear the flag and re-register.
 */
export function registerShutdownHandlers(): void {
  if (handlersRegistered) {
    log.debug("[SHUTDOWN] Handlers already registered, skipping duplicate registration");
    return;
  }
  handlersRegistered = true;

  // BUG FIX (Bug Hunter #8c): previously the signal handler was
  //   `async (signal) => { await shutdown(signal); setTimeout(() => process.exit(0), 100); }`
  // If `shutdown(signal)` rejected (e.g., a handler inside shutdown threw an
  // uncaught error that escaped the internal try/catch — such as `log.info()`
  // itself throwing if stdout was closed), the `await` would throw, the
  // `setTimeout` would never be scheduled, and the process would HANG —
  // requiring the user to Ctrl+C twice. Wrap the shutdown call in try/catch
  // so `process.exit` is ALWAYS reached, even if shutdown fails.
  const handler = async (signal: string) => {
    try {
      await shutdown(signal);
    } catch (err) {
      // Last-resort: shutdown itself failed. Don't hang the process —
      // log the error (best-effort) and still exit.
      try {
        log.error(`[SHUTDOWN] Shutdown failed: ${(err as Error).message}`);
      } catch {
        // even log.error threw (e.g. stderr closed) — nothing more we can do
      }
    }
    // Give a brief moment for logs to flush
    setTimeout(() => process.exit(0), 100);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGHUP", () => handler("SIGHUP"));

  // Handle uncaught exceptions - save state before crashing.
  // Same defensive wrapping as `handler` above: if `shutdown()` rejects,
  // we still need to exit(1) so the process doesn't hang.
  process.on("uncaughtException", async (err) => {
    try {
      log.error(`[SHUTDOWN] Uncaught exception: ${err.message}`);
      await shutdown("uncaughtException");
    } catch (err2) {
      try {
        log.error(`[SHUTDOWN] Shutdown after uncaughtException failed: ${(err2 as Error).message}`);
      } catch {
        // stderr closed — nothing more we can do
      }
    }
    setTimeout(() => process.exit(1), 100);
  });
}
