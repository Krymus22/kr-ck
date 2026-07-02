/**
 * searxManager.ts - Auto-start/stop local Searx instance on CLI launch.
 *
 * When the Claude-Killer CLI starts, this module:
 *   1. Checks if Searx is installed (~/.claude-killer/searxng)
 *   2. If installed but not running, starts it in background
 *   3. If not installed, skips silently (no nag, no error)
 *   4. Returns immediately — the actual startup is non-blocking
 *
 * On CLI shutdown, stops the Searx process if we started it.
 *
 * This is optional — if Searx is not installed, the CLI works normally
 * using Bing scraping as the search backend. Searx just provides better
 * quality results when available.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { platform } from "node:os";

const SEARX_DIR = path.join(os.homedir(), ".claude-killer", "searxng");
// Windows venv puts python at .venv/Scripts/python.exe
// Unix venv puts python at .venv/bin/python
const SEARX_VENV_PYTHON = platform() === "win32"
  ? path.join(SEARX_DIR, ".venv", "Scripts", "python.exe")
  : path.join(SEARX_DIR, ".venv", "bin", "python");
const SEARX_SETTINGS = path.join(SEARX_DIR, "settings.yml");
const SEARX_LOG = path.join(SEARX_DIR, "searx.log");
const SEARX_PORT = 8888;
const SEARX_URL = `http://localhost:${SEARX_PORT}`;

/** Track if WE started Searx (so we know if we should stop it) */
let weStartedSearx = false;
/** Track the Searx child process PID */
let searxPid: number | null = null;

/**
 * Check if Searx is installed (venv + settings.yml exist).
 */
export function isSearxInstalled(): boolean {
  return existsSync(SEARX_VENV_PYTHON) && existsSync(SEARX_SETTINGS);
}

/**
 * Check if Searx is currently running and responding with JSON.
 * Uses a 2-second timeout probe.
 */
export async function isSearxRunning(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const resp = await fetch(`${SEARX_URL}/search?q=test&format=json`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const data = await resp.json() as any;
    return data && typeof data === "object" && "results" in data;
  } catch {
    return false;
  }
}

/**
 * Check if a Searx process is already running by looking for the port.
 * Uses OS-native commands (lsof on Unix, netstat on Windows).
 *
 * ROBUSTNESS: uses spawnSync instead of execSync to avoid shell pipe
 * issues on some Windows configs. All errors are caught — if the check
 * fails for any reason, returns false (Searx not running).
 */
function isSearxProcessRunning(): boolean {
  try {
    if (platform() === "win32") {
      // Windows: use netstat without pipe (more reliable than piped findstr)
      // spawnSync avoids shell interpretation issues that execSync has
      const result = spawnSync("netstat", ["-ano"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,  // don't use shell — avoids pipe/quoting issues
      });
      if (result.status !== 0 || !result.stdout) return false;
      return result.stdout.includes(`:${SEARX_PORT}`);
    } else {
      // Unix: check if anything is listening on the port
      // Try lsof first, fall back to ss (common on modern Linux)
      const lsofResult = spawnSync("lsof", ["-i", `:${SEARX_PORT}`, "-t"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      if (lsofResult.status === 0 && lsofResult.stdout.trim().length > 0) {
        return true;
      }
      // Fallback: ss (iproute2, common on modern Linux)
      const ssResult = spawnSync("ss", ["-tlnp", `sport = :${SEARX_PORT}`], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      if (ssResult.status === 0 && ssResult.stdout.includes(`:${SEARX_PORT}`)) {
        return true;
      }
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Start Searx in background if it's installed but not running.
 * Non-blocking — returns immediately after spawning. The actual
 * startup takes 2-5 seconds (Python warmup), but the TUI doesn't wait.
 *
 * @returns true if Searx is running (was already or we started it),
 *          false if not installed or failed to start
 */
export async function autoStartSearx(): Promise<boolean> {
  // Not installed — skip silently
  if (!isSearxInstalled()) {
    return false;
  }

  // Already running — nothing to do
  if (await isSearxRunning()) {
    return true;
  }

  // Another process might be starting it — don't spawn a duplicate
  if (isSearxProcessRunning()) {
    // Wait a bit and re-check (the process might be mid-startup)
    await new Promise(r => setTimeout(r, 2000));
    if (await isSearxRunning()) {
      return true;
    }
    // Port is in use but not responding — something else is using it
    return false;
  }

  // Start Searx in background
  try {
    const logFd = await import("node:fs/promises").then(fs => fs.open(SEARX_LOG, "w"));
    const proc = spawn(SEARX_VENV_PYTHON, ["-m", "searx.webapp"], {
      cwd: SEARX_DIR,
      stdio: ["ignore", logFd.createWriteStream(), logFd.createWriteStream()],
      detached: true,
      env: {
        ...process.env,
        SEARXNG_SETTINGS_PATH: SEARX_SETTINGS,
      },
    });

    searxPid = proc.pid ?? null;
    weStartedSearx = true;
    proc.unref(); // Allow parent to exit independently

    // Don't wait for full startup — the TUI will probe Searx on first search.
    // If Searx isn't ready yet, the search falls back to Bing automatically.
    // The probe in checkSearxAvailable() (apiResearcher.ts) will find it once
    // it's ready (usually within 3-5 seconds of CLI launch).

    console.log(`[claude-killer] Searx starting in background (PID: ${proc.pid})...`);
    return true;
  } catch (err) {
    // Failed to start — not critical, search will use Bing fallback
    console.error(`[claude-killer] Searx auto-start failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Stop Searx if we started it. Called on CLI shutdown.
 * If the user started Searx manually (outside the CLI), we leave it running.
 */
export function autoStopSearx(): void {
  if (!weStartedSearx || !searxPid) return;

  try {
    // Kill the process group (Searx may spawn child processes)
    if (platform() === "win32") {
      spawnSync("taskkill", ["/PID", String(searxPid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
        timeout: 5000,
      });
    } else {
      // Send SIGTERM to the process group (negative PID)
      try {
        process.kill(-searxPid, "SIGTERM");
      } catch {
        // Fallback: kill just the process
        process.kill(searxPid, "SIGTERM");
      }
    }
    console.log(`[claude-killer] Searx stopped (PID: ${searxPid})`);
  } catch {
    // Process may have already exited — ignore
  }

  weStartedSearx = false;
  searxPid = null;
}

/**
 * Get Searx status for the /searx slash command.
 */
export function getSearxStatus(): {
  installed: boolean;
  running: boolean;
  weStarted: boolean;
  pid: number | null;
  url: string;
  dir: string;
} {
  return {
    installed: isSearxInstalled(),
    running: isSearxProcessRunning(),
    weStarted: weStartedSearx,
    pid: searxPid,
    url: SEARX_URL,
    dir: SEARX_DIR,
  };
}
