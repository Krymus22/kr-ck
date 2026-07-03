/**
 * hookRunner.ts - Sandbox-mature hook system using Node Worker Threads.
 *
 * Hooks are user-provided JavaScript snippets that run on agent-loop events:
 *   - before_write : before editar_arquivo writes to disk (can block / modify)
 *   - on_file      : after editar_arquivo writes to disk (best-effort)
 *   - on_task      : after the agent finishes a task (finish_reason=stop)
 *   - always       : after every chat response
 *
 * Each hook runs in its OWN Worker Thread with:
 *   - Resource limits (heap size capped)
 *   - Timeout (default 5s, configurable per-hook)
 *   - No access to the main thread's globals/imports (must require() its own)
 *   - Communication only via parentPort.postMessage()
 *
 * Hook discovery:
 *   1. ~/.claude-killer/modes/<mode>/hooks/*.json  (user overrides)
 *   2. defaults/modes/<mode>/hooks/*.json           (bundled defaults)
 *
 * Hook .json config:
 *   { "name": "auto-build", "file": "auto-build.js", "trigger": "on_file", "timeout": 30000 }
 *
 * Hook .js file (runs in Worker — CJS context, so `require()` works):
 *   const { parentPort, workerData } = require("worker_threads");
 *   parentPort.postMessage({ warning: "..." });
 *
 * Implementation note: the host project is ESM ("type": "module" in package.json),
 * so .js files would normally be treated as ESM (and require() would be undefined).
 * To allow hooks to use CommonJS `require()` regardless of the host project's
 * module config, we read the hook file content and pass it to the Worker with
 * `eval: true` (which runs the code as a CommonJS script).
 */

import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as log from "./logger.js";

export type HookTrigger = "before_write" | "on_file" | "on_task" | "always";

export interface HookConfig {
  name: string;
  /** .js file relative to hooks/ dir */
  file: string;
  trigger: HookTrigger;
  /** default 5000ms */
  timeout?: number;
}

export interface HookContext {
  filePath?: string;
  content?: string;
  mode?: string;
}

export interface HookResult {
  /** If true, no further hooks run; caller should abort the action. */
  blocking?: boolean;
  /** Message returned with a blocking result (shown to the AI/user). */
  message?: string;
  /** If present, replaces the content about to be written (before_write only). */
  modifiedContent?: string;
  /** Non-blocking warning surfaced to the caller. */
  warning?: string;
}

/**
 * Resolve the two candidate hooks directories for a mode:
 *   1. ~/.claude-killer/modes/<mode>/hooks  (user overrides — wins if present)
 *   2. defaults/modes/<mode>/hooks          (bundled defaults)
 *
 * Returns [userDir, bundledDir] (either may not exist on disk).
 */
function candidateHooksDirs(modeName: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  return [
    path.join(home, ".claude-killer", "modes", modeName, "hooks"),
    path.join(process.cwd(), "defaults", "modes", modeName, "hooks"),
  ];
}

/**
 * Load hook configs from a SINGLE directory.
 *
 * Reads every *.json file, parses it as a HookConfig, and returns the valid
 * ones. Invalid JSON / missing fields are silently skipped (defensive).
 *
 * Exported for testing — production code uses loadHooks(modeName).
 */
export function loadHooksFromDir(dir: string): HookConfig[] {
  const hooks: HookConfig[] = [];
  if (!fs.existsSync(dir)) return hooks;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return hooks;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (cfg && cfg.name && cfg.file && cfg.trigger) {
        hooks.push({ timeout: 5000, ...cfg });
      }
    } catch {
      /* skip invalid JSON */
    }
  }
  return hooks;
}

/**
 * Load hooks for a mode from the first candidate directory that contains
 * any valid hooks. Returns [] if mode is null or no hooks are found.
 */
export function loadHooks(modeName: string | null): HookConfig[] {
  if (!modeName) return [];
  for (const dir of candidateHooksDirs(modeName)) {
    const hooks = loadHooksFromDir(dir);
    if (hooks.length > 0) return hooks;
  }
  return [];
}

/**
 * Resolve the directory that actually contains the hooks for a mode.
 * Returns the user dir if it exists (and has files), else the bundled dir.
 * Returns "" if neither exists.
 *
 * Exported for testing.
 */
export function resolveHooksDir(modeName: string | null): string {
  if (!modeName) return "";
  for (const dir of candidateHooksDirs(modeName)) {
    if (fs.existsSync(dir)) return dir;
  }
  return "";
}

/**
 * Run hooks for a specific trigger using Worker Threads.
 *
 * Iterates through all hooks matching the trigger, runs each in its own
 * Worker, and collects results. Stops on the first `blocking: true` result
 * (later hooks are skipped). Failed/timed-out hooks produce a `warning`
 * result but never throw — the caller's action always continues.
 */
export async function runHooks(
  trigger: HookTrigger,
  context: HookContext,
  modeName: string | null,
): Promise<HookResult[]> {
  const all = loadHooks(modeName);
  const hooks = all.filter((h) => h.trigger === trigger);
  if (hooks.length === 0) return [];

  const results: HookResult[] = [];
  const hooksDir = resolveHooksDir(modeName);

  for (const hook of hooks) {
    try {
      const result = await runHookInWorker(hook, context, hooksDir);
      // Worker may resolve to null (no message posted) — skip silently
      if (result) results.push(result);
      if (result?.blocking) break; // stop on first blocking
    } catch (err) {
      log.warn(`[HOOK] ${hook.name} failed: ${(err as Error).message}`);
      results.push({
        warning: `Hook ${hook.name} failed: ${(err as Error).message}`,
      });
    }
  }
  return results;
}

/**
 * Run a single hook in a Worker Thread with timeout + resource limits.
 *
 * The hook .js file is read into memory and executed via `eval: true` so it
 * runs as a CommonJS script (require() works) regardless of the host
 * project's "type" field in package.json.
 *
 * Resolves with:
 *   - The message posted by the worker (HookResult), or
 *   - null if the worker exited without posting a message, or
 *   - { warning } on timeout / error
 */
async function runHookInWorker(
  hook: HookConfig,
  context: HookContext,
  hooksDir: string,
): Promise<HookResult | null> {
  const hookFile = path.join(hooksDir, hook.file);
  if (!fs.existsSync(hookFile)) {
    return { warning: `Hook file not found: ${hook.file}` };
  }

  let code: string;
  try {
    code = fs.readFileSync(hookFile, "utf8");
  } catch (err) {
    return {
      warning: `Hook ${hook.name} could not be read: ${(err as Error).message}`,
    };
  }

  return new Promise((resolve) => {
    const timeout = hook.timeout ?? 5000;
    let resolved = false;

    const finish = (value: HookResult | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      // worker.terminate() is synchronous and can throw if worker already exited
      try {
        worker.terminate();
      } catch { /* worker already exited — ignore */
        /* ignore */
      }
      resolve(value);
    };

    const worker = new Worker(code, {
      eval: true,
      workerData: {
        filePath: context.filePath,
        content: context.content,
        mode: context.mode,
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
      },
    });

    const timer = setTimeout(() => {
      finish({
        warning: `Hook ${hook.name} timed out after ${timeout}ms`,
      });
    }, timeout);

    worker.on("message", (msg: HookResult) => {
      finish(msg ?? null);
    });

    worker.on("error", (err) => {
      finish({
        warning: `Hook ${hook.name} error: ${err.message}`,
      });
    });

    worker.on("exit", () => {
      // Worker exited without posting a message — treat as no-op.
      finish(null);
    });
  });
}
