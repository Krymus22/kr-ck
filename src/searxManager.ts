/**
 * searxManager.ts - Auto-start/stop local Searx instance on CLI launch.
 *
 * Supports TWO installation methods:
 *
 *   1. Docker (preferred, especially for Windows):
 *      Container name: "claude-killer-searxng"
 *      Port: 8888 -> 8080 (container internal)
 *      The container has --restart unless-stopped, so it auto-starts
 *      when Docker Desktop starts. This module just checks if it's
 *      running and starts it if needed.
 *
 *   2. Python venv (Linux/macOS fallback when Docker is not available):
 *      Location: ~/.claude-killer/searxng/.venv
 *      Started via: python -m searx.webapp
 *      We track the PID and kill it on shutdown.
 *
 * Detection order in isSearxInstalled():
 *   1. Check if Docker container exists
 *   2. Check if Python venv exists
 *   If neither → not installed (skip silently)
 *
 * On CLI shutdown, stops the Searx process IF we started it.
 * Docker containers with --restart unless-stopped are NOT stopped
 * (they'll auto-restart with Docker Desktop).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { existsSync as fsExistsSync } from "node:fs";
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
const SEARX_PORT = 8888;
const SEARX_URL = `http://localhost:${SEARX_PORT}`;
const DOCKER_CONTAINER_NAME = "claude-killer-searxng";

/** Track if WE started Searx (so we know if we should stop it) */
let weStartedSearx = false;
let searxPid: number | null = null;
/** "docker" | "python" | null — which method was used to start */
let searxMethod: "docker" | "python" | null = null;

// ─── Docker helpers ─────────────────────────────────────────────────────────

/**
 * Check if Docker command is available.
 */
function isDockerAvailable(): boolean {
  try {
    const result = spawnSync("docker", ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if Docker daemon is running.
 */
function isDockerRunning(): boolean {
  if (!isDockerAvailable()) return false;
  try {
    const result = spawnSync("docker", ["info"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Try to find and launch Docker Desktop on Windows.
 * Returns true if the executable was found and launched.
 */
function launchDockerDesktopWindows(): boolean {
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const candidates = [
    "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe",
    "C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe",
    path.join(os.homedir(), "AppData", "Local", "Docker", "Docker Desktop.exe"),
  ];
  for (const exe of candidates) {
    if (existsSync(exe)) {
      try {
        spawn(exe, [], {
          detached: true,
          stdio: "ignore",
          shell: false,
        }).unref();
        return true;
      } catch {
        // Try next candidate
      }
    }
  }
  return false;
}

/**
 * Try to launch Docker Desktop on macOS.
 * Uses `open -a Docker` which is the standard way.
 */
function launchDockerDesktopMacOS(): boolean {
  try {
    spawn("open", ["-a", "Docker"], {
      detached: true,
      stdio: "ignore",
      shell: false,
    }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure Docker daemon is running. If Docker is installed but the daemon
 * is not running, try to start Docker Desktop automatically.
 *
 * This handles the common case where the user has Docker Desktop installed
 * but hasn't launched it yet (or it crashed). Instead of failing, we:
 *   1. Detect the OS
 *   2. Launch Docker Desktop (Windows: .exe, macOS: open -a Docker)
 *   3. Wait up to 90 seconds for the daemon to be ready
 *   4. Return true if ready, false if timeout/failure
 *
 * On Linux, Docker daemon is usually a systemd service. We can't start
 * it without sudo, so we just return false and let the caller warn.
 *
 * @returns true if Docker daemon is running (was already or we started it)
 */
async function ensureDockerRunning(): Promise<boolean> {
  // Already running? Great.
  if (isDockerRunning()) return true;

  // Docker not installed at all
  if (!isDockerAvailable()) return false;

  // Docker is installed but daemon not running — try to start it
  console.log("[claude-killer] Docker daemon not running. Attempting to start Docker Desktop...");

  let launched = false;
  if (platform() === "win32") {
    launched = launchDockerDesktopWindows();
  } else if (platform() === "darwin") {
    launched = launchDockerDesktopMacOS();
  } else {
    // Linux: Docker daemon is a systemd service, needs sudo
    // We can try `systemctl start docker` but it usually needs root
    console.log("[claude-killer] On Linux, start Docker daemon manually: sudo systemctl start docker");
    return false;
  }

  if (!launched) {
    console.log("[claude-killer] Could not find Docker Desktop executable.");
    return false;
  }

  console.log("[claude-killer] Docker Desktop starting. Waiting for daemon (up to 90s)...");

  // Wait for daemon to be ready — poll every 2 seconds, up to 90 seconds
  // Docker Desktop can take 30-60 seconds to fully start on slower machines
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (isDockerRunning()) {
      console.log(`[claude-killer] Docker daemon is ready (took ~${(i + 1) * 2}s).`);
      return true;
    }
    // Print progress dots every 10 seconds
    if (i > 0 && i % 5 === 0) {
      console.log(`[claude-killer]   still waiting... (${(i + 1) * 2}s)`);
    }
  }

  console.log("[claude-killer] Docker daemon did not start within 90 seconds.");
  console.log("[claude-killer] Please start Docker Desktop manually and re-run.");
  return false;
}

/**
 * Check if the Searx Docker container exists.
 */
function dockerContainerExists(): boolean {
  if (!isDockerAvailable()) return false;
  try {
    const result = spawnSync("docker", ["inspect", DOCKER_CONTAINER_NAME], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Check if the Searx Docker container is running.
 */
function dockerContainerRunning(): boolean {
  if (!dockerContainerExists()) return false;
  try {
    const result = spawnSync(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", DOCKER_CONTAINER_NAME],
      {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      }
    );
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Start the Docker container if it exists but is stopped.
 */
function startDockerContainer(): boolean {
  if (!dockerContainerExists()) return false;
  if (dockerContainerRunning()) return true;
  try {
    const result = spawnSync("docker", ["start", DOCKER_CONTAINER_NAME], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ─── Python helpers ─────────────────────────────────────────────────────────

/**
 * Check if Searx is installed via Python venv.
 */
function pythonSearxInstalled(): boolean {
  return existsSync(SEARX_VENV_PYTHON) && existsSync(SEARX_SETTINGS);
}

/**
 * Check if a Searx process is already running by looking for the port.
 */
function isSearxProcessRunning(): boolean {
  try {
    if (platform() === "win32") {
      const result = spawnSync("netstat", ["-ano"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      if (result.status !== 0 || !result.stdout) return false;
      return result.stdout.includes(`:${SEARX_PORT}`);
    } else {
      const lsofResult = spawnSync("lsof", ["-i", `:${SEARX_PORT}`, "-t"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      if (lsofResult.status === 0 && lsofResult.stdout.trim().length > 0) {
        return true;
      }
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

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check if Searx is installed (either via Docker or Python).
 */
export function isSearxInstalled(): boolean {
  // Docker takes priority
  if (dockerContainerExists()) return true;
  // Python fallback
  return pythonSearxInstalled();
}

/**
 * Check if Searx is currently running and responding with JSON.
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
    const data = (await resp.json()) as any;
    return data && typeof data === "object" && "results" in data;
  } catch {
    return false;
  }
}

/**
 * Get the path to the platform-specific Docker setup script.
 * Returns the PowerShell script on Windows, shell script on Unix.
 * Returns null if the script doesn't exist.
 */
function getDockerSetupScriptPath(): string | null {
  const projectRoot = process.cwd();
  if (platform() === "win32") {
    const ps1 = path.join(projectRoot, "scripts", "setup-searx-docker.ps1");
    return fsExistsSync(ps1) ? ps1 : null;
  } else {
    const sh = path.join(projectRoot, "scripts", "setup-searx-docker.sh");
    return fsExistsSync(sh) ? sh : null;
  }
}

/**
 * Start Searx in background if it's installed but not running.
 * Non-blocking — returns immediately. The actual startup takes 2-5
 * seconds, but the TUI doesn't wait.
 *
 * Logic:
 *   1. If Docker container exists → start it (fast, ~1s)
 *   2. If Python venv exists → spawn python -m searx.webapp (slower)
 *   3. If neither → not installed, skip
 *
 * @returns true if Searx is running (was already or we started it),
 *          false if not installed or failed to start
 */
export async function autoStartSearx(): Promise<boolean> {
  // Already running — nothing to do
  if (await isSearxRunning()) {
    return true;
  }

  // Method 1: Docker container
  if (dockerContainerExists()) {
    // CRITICAL: Docker Desktop might not be running. If not, use the same
    // setup script that postinstall uses — it starts Docker Desktop, waits
    // for the daemon, and starts the container. This is more reliable than
    // trying to start Docker Desktop directly from Node.js.
    if (!isDockerRunning()) {
      console.log("[claude-killer] Docker daemon not running. Starting via setup script...");

      // Try the platform-specific setup script (same as postinstall)
      const scriptPath = getDockerSetupScriptPath();
      if (scriptPath) {
        try {
          const result = spawnSync(
            platform() === "win32" ? "powershell" : "bash",
            platform() === "win32"
              ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Start"]
              : [scriptPath, "start"],
            {
              encoding: "utf8",
              timeout: 120_000, // 2 minutes — Docker Desktop can take 60-90s to start
              stdio: ["ignore", "pipe", "pipe"],
              shell: false,
            }
          );
          if (result.status === 0) {
            console.log("[claude-killer] Searx Docker container started via setup script.");
            searxMethod = "docker";
            return true;
          }
          console.error(`[claude-killer] Setup script failed (exit ${result.status}): ${result.stderr?.slice(0, 200)}`);
        } catch (err) {
          console.error(`[claude-killer] Setup script error: ${(err as Error).message}`);
        }

        // Fallback: try ensureDockerRunning + startDockerContainer directly
        const dockerReady = await ensureDockerRunning();
        if (!dockerReady) {
          console.error("[claude-killer] Docker daemon is not running. Searx container cannot start.");
          console.error("[claude-killer] Start Docker Desktop manually, then re-run the CLI.");
          return false;
        }
      } else {
        const dockerReady = await ensureDockerRunning();
        if (!dockerReady) {
          console.error("[claude-killer] Docker daemon is not running. Searx container cannot start.");
          return false;
        }
      }
    }

    // Docker daemon is running — just start the container
    if (!dockerContainerRunning()) {
      console.log(`[claude-killer] Starting Searx Docker container...`);
      const started = startDockerContainer();
      if (started) {
  // INVARIANT: Docker containers should NOT be stopped by CLI (they have --restart unless-stopped)
  if (searxMethod === "docker") {
    const { invariant: _invDocker } = require("./invariants.js");
    _invDocker(false, "DOCKER_SHOULD_NOT_STOP", "CLI tentou parar container Docker — containers com --restart unless-stopped não devem ser parados", { searxMethod, searxPid });
  }
        weStartedSearx = false; // Docker manages itself (--restart unless-stopped)
        searxMethod = "docker";
        console.log(`[claude-killer] Searx Docker container started.`);
        return true;
      }
      console.error(`[claude-killer] Failed to start Searx Docker container.`);
      return false;
    }
    // Container is running but Searx isn't responding yet — wait
    searxMethod = "docker";
    return true;
  }

  // Method 2: Python venv
  if (!pythonSearxInstalled()) {
    return false;
  }

  // Another process might be starting it — don't spawn a duplicate
  if (isSearxProcessRunning()) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await isSearxRunning()) {
      return true;
    }
    return false;
  }

  // Start Searx via Python
  try {
    const { openSync } = await import("node:fs");
    const logPath = path.join(SEARX_DIR, "searx.log");
    const logFd = openSync(logPath, "w");
    const proc = spawn(SEARX_VENV_PYTHON, ["-m", "searx.webapp"], {
      cwd: SEARX_DIR,
      stdio: ["ignore", logFd, logFd],
      detached: true,
      env: {
        ...process.env,
        SEARXNG_SETTINGS_PATH: SEARX_SETTINGS,
      },
    });

    searxPid = proc.pid ?? null;
    weStartedSearx = true;
    searxMethod = "python";
    proc.unref();

    console.log(`[claude-killer] Searx starting via Python (PID: ${proc.pid})...`);
    return true;
  } catch (err) {
    console.error(`[claude-killer] Searx auto-start failed: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Stop Searx if we started it. Called on CLI shutdown.
 *
 * Docker containers with --restart unless-stopped are NOT stopped
 * (they'll auto-restart with Docker Desktop, which is desired).
 *
 * Only Python-started Searx is stopped on shutdown.
 */
export function autoStopSearx(): void {
  if (!weStartedSearx || searxMethod !== "python" || !searxPid) return;

  try {
    if (platform() === "win32") {
      spawnSync("taskkill", ["/PID", String(searxPid), "/T", "/F"], {
        stdio: "ignore",
        shell: false,
        timeout: 5000,
      });
    } else {
      try {
        process.kill(-searxPid, "SIGTERM");
      } catch {
        process.kill(searxPid, "SIGTERM");
      }
    }
    console.log(`[claude-killer] Searx stopped (PID: ${searxPid})`);
  } catch {
    // Process may have already exited — ignore
  }

  weStartedSearx = false;
  searxPid = null;
  searxMethod = null;
}

/**
 * Get Searx status for the /searx slash command.
 */
export function getSearxStatus(): {
  installed: boolean;
  running: boolean;
  method: "docker" | "python" | null;
  weStarted: boolean;
  pid: number | null;
  url: string;
  dir: string;
  dockerAvailable: boolean;
} {
  const dockerExists = dockerContainerExists();
  const dockerRunning = dockerContainerRunning();
  const pythonInstalled = pythonSearxInstalled();

  return {
    installed: dockerExists || pythonInstalled,
    running: dockerRunning || isSearxProcessRunning(),
    method: dockerExists ? "docker" : (pythonInstalled ? "python" : null),
    weStarted: weStartedSearx,
    pid: searxPid,
    url: SEARX_URL,
    dir: SEARX_DIR,
    dockerAvailable: isDockerAvailable(),
  };
}
