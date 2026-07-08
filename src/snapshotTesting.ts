/**
 * snapshotTesting.ts - Capture function output before/after edits.
 *
 * When the AI edits a function, this module:
 *   1. Captures the function's output BEFORE the edit (by running it
 *      with sample inputs if available, or extracting test expectations)
 *   2. After the edit, runs the same function and compares outputs
 *   3. If outputs differ unexpectedly, alerts the AI
 *
 * This catches "silent regressions" where the code still compiles and
 * lints clean, but the behavior changed in a way that breaks callers.
 *
 * Limitations:
 *   - Can only snapshot PURE functions (no side effects)
 *   - Requires the function to be callable in the current environment
 *   - Falls back to "no snapshot" if function can't be run
 */

import * as path from "node:path";
import { spawn } from "node:child_process";
import * as log from "./logger.js";

// --- Types ------------------------------------------------------------------

export interface Snapshot {
  functionName: string;
  filePath: string;
  inputs: string;          // JSON string of inputs
  outputBefore: string;    // Output before edit
  outputAfter: string | null;  // Output after edit (null = not run yet)
  matched: boolean | null;     // true = same, false = different, null = not compared
  timestamp: number;
}

export interface SnapshotResult {
  captured: boolean;
  snapshot: Snapshot | null;
  message: string;
}

// --- State ------------------------------------------------------------------

const snapshots = new Map<string, Snapshot>();  // key: functionName

// --- Public API -------------------------------------------------------------

/**
 * Capture a snapshot of a function's output BEFORE editing.
 *
 * This is called by the AI via the capturar_snapshot tool, or automatically
 * before edits to pure functions.
 *
 * @param functionName - Name of the function to snapshot
 * @param filePath - File containing the function
 * @param inputs - JSON string of inputs to call the function with
 */
export async function captureBeforeSnapshot(
  functionName: string,
  filePath: string,
  inputs: string
): Promise<SnapshotResult> {
  const key = `${filePath}::${functionName}`;

  // Try to run the function and capture output
  const output = await tryRunFunction(filePath, functionName, inputs);

  if (output === null) {
    return {
      captured: false,
      snapshot: null,
      message: `[SNAPSHOT] Could not run ${functionName} - function may have side effects or require runtime context.`,
    };
  }

  const snapshot: Snapshot = {
    functionName,
    filePath,
    inputs,
    outputBefore: output,
    outputAfter: null,
    matched: null,
    timestamp: Date.now(),
  };

  snapshots.set(key, snapshot);
  log.info(`[SNAPSHOT] Captured before-snapshot for ${functionName}: output=${output.slice(0, 100)}`);

  return {
    captured: true,
    snapshot,
    message: `[SNAPSHOT] Captured output of ${functionName} before edit: ${output.slice(0, 200)}`,
  };
}

/**
 * Capture a snapshot of a function's output AFTER editing and compare.
 *
 * @param functionName - Name of the function
 * @param filePath - File containing the function
 * @returns SnapshotResult with comparison result
 */
export async function captureAfterSnapshot(
  functionName: string,
  filePath: string
): Promise<SnapshotResult> {
  const key = `${filePath}::${functionName}`;
  const before = snapshots.get(key);

  if (!before) {
    return {
      captured: false,
      snapshot: null,
      message: `[SNAPSHOT] No before-snapshot for ${functionName}. Run capturar_snapshot first.`,
    };
  }

  const output = await tryRunFunction(filePath, functionName, before.inputs);

  if (output === null) {
    return {
      captured: false,
      snapshot: before,
      message: `[SNAPSHOT] Could not run ${functionName} after edit.`,
    };
  }

  before.outputAfter = output;
  before.matched = output === before.outputBefore;

  const matched = before.matched;
  log.info(`[SNAPSHOT] After-snapshot for ${functionName}: matched=${matched}`);

  if (matched) {
    return {
      captured: true,
      snapshot: before,
      message: `[SNAPSHOT OK] ${functionName} output unchanged after edit.`,
    };
  }

  return {
    captured: true,
    snapshot: before,
    message: `[SNAPSHOT CHANGED] ${functionName} output changed after edit!\n  Before: ${before.outputBefore.slice(0, 200)}\n  After:  ${output.slice(0, 200)}\n\nVerify this change is intentional.`,
  };
}

/**
 * Try to run a function and capture its output.
 * Uses Node.js to import the file and call the function.
 *
 * Returns null if the function can't be run (side effects, runtime deps, etc).
 */
async function tryRunFunction(
  filePath: string,
  functionName: string,
  inputsJson: string
): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();

  // Only support JS/TS files (Luau/Python need their own runtimes)
  if (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".mjs") {
    return null;
  }

  try {
    const inputs = JSON.parse(inputsJson);
    const inputArgs = Array.isArray(inputs) ? inputs : [inputs];

    // Use a child process to isolate execution
    // BUG FIX: previously `process.stdout.write(typeof r === 'string' ? r : JSON.stringify(r))`.
    // `JSON.stringify(undefined)` returns the VALUE `undefined` (not the string
    // "undefined"), and `JSON.stringify(function(){})` does the same. Passing
    // `undefined` to `process.stdout.write` throws a synchronous TypeError,
    // which the inner .catch swallowed — the snapshot then failed with a
    // confusing "chunk argument" error instead of just recording the
    // undefined return value. Coerce to a string before writing.
    const script = `
      import('${filePath}').then(mod => {
        const fn = mod.${functionName} || mod.default?.${functionName};
        if (typeof fn !== 'function') {
          process.stdout.write('__SNAPSHOT_ERROR__: function not found');
          return;
        }
        try {
          const result = fn(...${JSON.stringify(inputArgs)});
          Promise.resolve(result).then(r => {
            const s = typeof r === 'string' ? r : JSON.stringify(r);
            process.stdout.write(s === undefined ? 'undefined' : s);
          }).catch(e => {
            process.stdout.write('__SNAPSHOT_ERROR__: ' + e.message);
          });
        } catch(e) {
          process.stdout.write('__SNAPSHOT_ERROR__: ' + e.message);
        }
      }).catch(e => {
        process.stdout.write('__SNAPSHOT_ERROR__: ' + e.message);
      });
    `;

    const result = await new Promise<{ ok: boolean; stdout: string }>((resolve) => {
      const child = spawn("node", ["--input-type=module", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      let stdout = "";
      child.stdout?.on("data", (data) => { stdout += data.toString(); });
      child.on("close", () => resolve({ ok: true, stdout }));
      child.on("error", () => resolve({ ok: false, stdout: "" }));
    });

    if (result.stdout.startsWith("__SNAPSHOT_ERROR__")) {
      return null;
    }

    return result.stdout || "undefined";
  } catch {
    return null;
  }
}

/**
 * Get all snapshots (for debugging).
 */
export function getSnapshots(): Snapshot[] {
  return Array.from(snapshots.values());
}

/**
 * Clear all snapshots (for new task or /reset).
 */
export function clearSnapshots(): void {
  snapshots.clear();
}

/**
 * Check if a before-snapshot exists for a function.
 */
export function hasBeforeSnapshot(functionName: string, filePath: string): boolean {
  return snapshots.has(`${filePath}::${functionName}`);
}
