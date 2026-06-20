/**
 * auto-build.js — Roblox mode "on_file" hook (Sprint 8 example).
 *
 * Runs in a Node Worker Thread after editar_arquivo writes a file to disk.
 * Currently a no-op placeholder: emits a warning describing what would
 * happen in a real implementation (call `rojo build` to sync the project).
 *
 * Worker protocol:
 *   - workerData: { filePath, content, mode }
 *   - postMessage({ warning?, blocking?, modifiedContent?, message? })
 *
 * Uses CommonJS require() because the host project loads hook files via
 * `new Worker(code, { eval: true })` (eval mode runs as CJS).
 */

const { parentPort, workerData } = require("worker_threads");

async function run() {
  const { filePath, mode } = workerData || {};

  // Only run for .luau files — auto-build is irrelevant for other types.
  if (!filePath || !filePath.endsWith(".luau")) {
    parentPort.postMessage(null);
    return;
  }

  // No-op for now — in the future this could spawn `rojo build` here.
  parentPort.postMessage({
    warning:
      `auto-build: ${filePath} was modified` +
      (mode ? ` (mode=${mode})` : "") +
      " — rojo build would run here",
  });
}

run().catch((err) => {
  try {
    parentPort.postMessage({ warning: `auto-build error: ${err && err.message ? err.message : String(err)}` });
  } catch {
    /* parentPort already torn down */
  }
});
