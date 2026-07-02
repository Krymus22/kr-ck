#!/usr/bin/env node
/**
 * postinstall-searx.cjs - npm postinstall hook to auto-install Searx.
 *
 * Detects the OS and chooses the best installation method:
 *
 *   Windows: Docker (SearxNG doesn't run natively on Windows due to
 *            Python dependency issues. Docker Desktop is required.)
 *
 *   Linux/macOS: Docker preferred (if available), Python fallback
 *
 * Behavior:
 *   - If SKIP_SEARX=1 env var is set → skip entirely (opt-out)
 *   - If Docker not found → skip with warning (Searx is optional)
 *   - If Searx already running → skip (idempotent)
 *   - If install succeeds → starts Searx automatically
 *   - If install fails → warn but DON'T fail npm install (exit 0)
 *   - Timeout: 5 minutes max (prevents hanging in CI/CD)
 *
 * Usage:
 *   npm install                              → auto-installs Searx
 *   SKIP_SEARX=1 npm install                 → skips Searx
 *   npm install --ignore-scripts             → skips all scripts including this
 */

const { execSync, spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SETUP_SCRIPT_DOCKER_SH = path.join(__dirname, "setup-searx-docker.sh");
const SETUP_SCRIPT_DOCKER_PS1 = path.join(__dirname, "setup-searx-docker.ps1");
const SETUP_SCRIPT_PYTHON = path.join(__dirname, "setup-searx.py");
const SEARX_DIR = path.join(os.homedir(), ".claude-killer", "searxng");
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[claude-killer] ${msg}`);
}

function logError(msg) {
  console.error(`[claude-killer] ${msg}`);
}

/**
 * Check if a command is available in PATH.
 */
function hasCommand(cmd) {
  try {
    if (process.platform === "win32") {
      execSync(`where ${cmd}`, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } else {
      execSync(`which ${cmd}`, {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Docker is available AND running.
 */
function isDockerAvailable() {
  if (!hasCommand("docker")) return false;
  try {
    execSync("docker info", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Searx container is already running.
 */
function isSearxContainerRunning() {
  try {
    const result = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", "claude-killer-searxng"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Check if Searx is already responding on localhost:8888.
 */
function isSearxResponding() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    // Use fetch (available in Node 18+) for a simple HTTP check
    const resp = require("node:http").get(
      `http://localhost:8888/search?q=test&format=json`,
      { signal: controller.signal, timeout: 3000 },
      (res) => {
        clearTimeout(timer);
        return res.statusCode === 200;
      }
    );
    resp.on("error", () => false);
    return false;
  } catch {
    return false;
  }
}

/**
 * Find Python 3 executable. Tries multiple names across platforms.
 */
function findPython3() {
  const candidates = ["python3", "python", "py"];
  for (const cmd of candidates) {
    try {
      const versionCmd = cmd === "py" ? [cmd, "-3", "--version"] : [cmd, "--version"];
      const result = spawnSync(versionCmd[0], versionCmd.slice(1), {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
      });
      if (result.status === 0 && result.stdout.includes("Python 3.")) {
        return cmd;
      }
    } catch {
      // Not found, try next
    }
  }
  return null;
}

// ─── Platform-specific installers ───────────────────────────────────────────

/**
 * Install Searx via Docker (preferred for Windows, works everywhere).
 * Runs the platform-specific Docker setup script.
 */
function installViaDocker() {
  log("Installing Searx via Docker...");

  if (process.platform === "win32") {
    // Windows: run PowerShell script
    if (!existsSync(SETUP_SCRIPT_DOCKER_PS1)) {
      logError("setup-searx-docker.ps1 not found — skipping.");
      return false;
    }
    try {
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${SETUP_SCRIPT_DOCKER_PS1}" -Yes`, {
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        stdio: "inherit",
        env: { ...process.env, SEARX_INSTALLING: "1" },
      });
      return true;
    } catch (err) {
      logError(`Docker install failed: ${err.message?.slice(0, 200) ?? "unknown error"}`);
      return false;
    }
  } else {
    // Linux/macOS: run shell script
    if (!existsSync(SETUP_SCRIPT_DOCKER_SH)) {
      logError("setup-searx-docker.sh not found — skipping.");
      return false;
    }
    try {
      execSync(`bash "${SETUP_SCRIPT_DOCKER_SH}" install`, {
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        stdio: "inherit",
        env: { ...process.env, SEARX_INSTALLING: "1" },
      });
      return true;
    } catch (err) {
      logError(`Docker install failed: ${err.message?.slice(0, 200) ?? "unknown error"}`);
      return false;
    }
  }
}

/**
 * Install Searx via Python (fallback for Linux/macOS without Docker).
 */
function installViaPython() {
  log("Installing Searx via Python (Docker not available)...");

  const pythonCmd = findPython3();
  if (!pythonCmd) {
    log("Python 3 not found — skipping Searx. (Optional: install Python 3.8+ or Docker)");
    return false;
  }

  if (!existsSync(SETUP_SCRIPT_PYTHON)) {
    logError("setup-searx.py not found — skipping Searx installation.");
    return false;
  }

  log(`  Python: ${pythonCmd}`);
  log(`  Location: ${SEARX_DIR}`);
  log("");

  try {
    const args = pythonCmd === "py"
      ? ["py", "-3", SETUP_SCRIPT_PYTHON, "--yes"]
      : [pythonCmd, SETUP_SCRIPT_PYTHON, "--yes"];

    execSync(args.join(" "), {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      stdio: "inherit",
      env: {
        ...process.env,
        SEARX_INSTALLING: "1",
      },
    });
    return true;
  } catch (err) {
    if (err.signal === "SIGTERM" || err.killed) {
      logError("Searx installation timed out (5 min). Skipping — will use Bing fallback.");
    } else {
      logError(`Searx installation failed: ${err.message?.slice(0, 200) ?? "unknown error"}`);
    }
    return false;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  // Check opt-out env var
  if (process.env.SKIP_SEARX === "1" || process.env.SKIP_SEARX === "true") {
    log("SKIP_SEARX=1 — skipping Searx installation.");
    return;
  }

  // Prevent recursion (during Searx's own pip install)
  if (process.env.SEARX_INSTALLING === "1") {
    return;
  }

  log("Checking for Searx local search (optional, improves web search quality)...");

  // Already running? Skip.
  if (isSearxContainerRunning()) {
    log("Searx container is already running. ✓");
    return;
  }

  // Determine installation strategy based on platform
  const isWindows = process.platform === "win32";
  const dockerAvailable = isDockerAvailable();

  if (isWindows) {
    // Windows: Docker is the ONLY reliable method (Python doesn't work natively)
    if (!dockerAvailable) {
      log("Windows detected but Docker is not available — skipping Searx.");
      log("(SearxNG doesn't run natively on Windows. Install Docker Desktop:");
      log(" https://www.docker.com/products/docker-desktop)");
      log("Or run manually later: powershell scripts/setup-searx-docker.ps1");
      return;
    }

    log("Windows + Docker detected — installing Searx via Docker...");
    const success = installViaDocker();
    if (success) {
      log("Searx installed successfully! ✓");
      log("  The Docker container starts automatically with Docker Desktop.");
      log("  Use /searx in the CLI to check status.");
    } else {
      logError("Searx installation via Docker failed. Claude-Killer will use Bing fallback.");
      logError("You can retry later: powershell scripts/setup-searx-docker.ps1");
    }
  } else {
    // Linux/macOS: prefer Docker, fall back to Python
    if (dockerAvailable) {
      log("Docker detected — installing Searx via Docker...");
      const success = installViaDocker();
      if (success) {
        log("Searx installed successfully! ✓");
        return;
      }
      logError("Docker install failed, trying Python fallback...");
    }

    // Python fallback
    const success = installViaPython();
    if (success) {
      log("Searx installed successfully! ✓");
      log("  It will auto-start when you run the CLI.");
      log("  Use /searx in the CLI to check status.");
    } else {
      logError("Searx installation failed. Claude-Killer will use Bing scraping for web search.");
      logError("You can retry later: python3 scripts/setup-searx.py");
    }
  }
}

main();
