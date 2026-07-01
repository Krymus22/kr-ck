#!/usr/bin/env node
/**
 * postinstall-searx.js - npm postinstall hook to auto-install Searx.
 *
 * Runs automatically after `npm install`. Checks if Python 3 is available,
 * then calls the Python setup script in non-interactive mode (--yes).
 *
 * Behavior:
 *   - If SKIP_SEARX=1 env var is set → skip entirely (opt-out)
 *   - If Python 3 not found → skip with warning (Searx is optional)
 *   - If Searx already installed → skip (idempotent)
 *   - If install succeeds → starts Searx in background
 *   - If install fails → warn but DON'T fail npm install (exit 0)
 *   - Timeout: 5 minutes max (prevents hanging in CI/CD)
 *
 * Usage:
 *   npm install                              → auto-installs Searx
 *   SKIP_SEARX=1 npm install                 → skips Searx
 *   npm install --ignore-scripts             → skips all scripts including this
 */

const { execSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SETUP_SCRIPT = path.join(__dirname, "setup-searx.py");
const SEARX_DIR = path.join(os.homedir(), ".claude-killer", "searxng");
const SEARX_VENV = path.join(SEARX_DIR, ".venv", "bin", "python");
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[claude-killer] ${msg}`);
}

function logError(msg) {
  console.error(`[claude-killer] ${msg}`);
}

/**
 * Find Python 3 executable. Tries multiple names across platforms.
 * Returns the command name if found, null if not.
 */
function findPython3() {
  const candidates = ["python3", "python", "py"];
  for (const cmd of candidates) {
    try {
      // On Windows, `py -3 --version` is the official way
      const versionCmd = cmd === "py" ? [cmd, "-3", "--version"] : [cmd, "--version"];
      execSync(versionCmd.join(" "), {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      // Verify it's Python 3.x
      const out = execSync(versionCmd.join(" "), {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (out.includes("Python 3.")) {
        return cmd;
      }
    } catch {
      // Not found or wrong version, try next
    }
  }
  return null;
}

/**
 * Find git executable.
 */
function hasGit() {
  try {
    execSync("git --version", {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
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

  // Check if npm install was triggered by us (during Searx's own pip install)
  // to prevent infinite recursion. This shouldn't happen but safety first.
  if (process.env.SEARX_INSTALLING === "1") {
    return;
  }

  log("Checking for Searx local search (optional, improves web search quality)...");

  // Check if already installed
  if (existsSync(SEARX_VENV)) {
    log("Searx already installed. ✓");
    return;
  }

  // Check Python 3
  const pythonCmd = findPython3();
  if (!pythonCmd) {
    log("Python 3 not found — skipping Searx. (Optional: install Python 3.8+ then run: python3 scripts/setup-searx.py)");
    return;
  }

  // Check git
  if (!hasGit()) {
    log("Git not found — skipping Searx. (Required to clone SearxNG repository)");
    return;
  }

  // Check setup script exists
  if (!existsSync(SETUP_SCRIPT)) {
    logError("setup-searx.py not found — skipping Searx installation.");
    return;
  }

  // Run the Python setup script in non-interactive mode
  log("Installing Searx (this may take 1-3 minutes on first run)...");
  log(`  Python: ${pythonCmd}`);
  log(`  Location: ${SEARX_DIR}`);
  log("");

  try {
    // Build the command — `py -3` on Windows, `python3` elsewhere
    const args = pythonCmd === "py"
      ? ["py", "-3", SETUP_SCRIPT, "--yes"]
      : [pythonCmd, SETUP_SCRIPT, "--yes"];

    // Run with timeout — don't let it hang forever
    execSync(args.join(" "), {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      stdio: "inherit", // show output to user
      env: {
        ...process.env,
        SEARX_INSTALLING: "1",
      },
    });

    log("Searx installed successfully! ✓");
    log("  It will auto-start when you run the CLI.");
    log("  Use /searx in the CLI to check status.");
  } catch (err) {
    // Don't fail npm install — Searx is optional
    if (err.signal === "SIGTERM" || err.killed) {
      logError("Searx installation timed out (5 min). Skipping — will use Bing fallback.");
    } else {
      logError(`Searx installation failed: ${err.message?.slice(0, 200) ?? "unknown error"}`);
      logError("Skipping — Claude-Killer will use Bing scraping for web search.");
    }
    logError("You can retry later: python3 scripts/setup-searx.py");
    // Exit 0 — don't fail npm install
  }
}

main();
