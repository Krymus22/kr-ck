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

/** Clear shutdown state (for tests). */
export function resetShutdownState(): void {
  isShuttingDown = false;
  shutdownHandlers = [];
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
 */
export async function shutdown(signal: string = "SIGINT"): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info(`[SHUTDOWN] Received ${signal}. Saving state...`);

  // Run registered handlers in reverse order
  const reversedHandlers = [...shutdownHandlers].reverse();
  for (const handler of reversedHandlers) {
    try {
      handler();
    } catch (err) {
      log.warn(`[SHUTDOWN] Handler failed: ${(err as Error).message}`);
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
 */
export function registerShutdownHandlers(): void {
  const handler = async (signal: string) => {
    await shutdown(signal);
    // Give a brief moment for logs to flush
    setTimeout(() => process.exit(0), 100);
  };

  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGHUP", () => handler("SIGHUP"));

  // Handle uncaught exceptions - save state before crashing
  process.on("uncaughtException", async (err) => {
    log.error(`[SHUTDOWN] Uncaught exception: ${err.message}`);
    await shutdown("uncaughtException");
    setTimeout(() => process.exit(1), 100);
  });
}
