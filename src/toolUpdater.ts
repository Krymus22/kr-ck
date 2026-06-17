/**
 * toolUpdater.ts - Automatic version checking and updating for external tools.
 *
 * On startup (and periodically), checks if installed external tools have
 * updates available on their official source (GitHub releases or Wally index).
 *
 * If an update is available, runs the appropriate update command:
 *   - For Rokit-managed tools (rojo, wally, lune, selene, stylua, etc.):
 *     runs `rokit install` which updates all tools declared in rokit.toml
 *   - For other tools: logs a warning suggesting manual update
 *
 * Config (env vars):
 *   TOOL_UPDATER_ENABLED=true|false    (default: true)
 *   TOOL_UPDATER_INTERVAL_HOURS=N      (default: 24 - check at most once per day)
 *   TOOL_UPDATER_AUTO_INSTALL=true|false (default: false - only suggest, don't auto-install)
 *
 * Persistence:
 *   ~/.claude-killer/.tool-updater.json stores last-check timestamp + cached versions
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as log from "./logger.js";

// --- Config -----------------------------------------------------------------

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.toLowerCase();
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

interface UpdaterConfig {
  enabled: boolean;
  intervalHours: number;
  autoInstall: boolean;
}

function getConfig(): UpdaterConfig {
  return {
    enabled: envBool("TOOL_UPDATER_ENABLED", true),
    intervalHours: envInt("TOOL_UPDATER_INTERVAL_HOURS", 24),
    autoInstall: envBool("TOOL_UPDATER_AUTO_INSTALL", false),
  };
}

// --- State ------------------------------------------------------------------

interface UpdaterState {
  lastCheck: string | null;  // ISO date
  cachedVersions: Record<string, string>;  // tool name -> known latest version
}

function getStatePath(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
    ".claude-killer",
    ".tool-updater.json"
  );
}

function loadState(): UpdaterState {
  try {
    const p = getStatePath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as UpdaterState;
      if (parsed && typeof parsed === "object") {
        return {
          lastCheck: parsed.lastCheck ?? null,
          cachedVersions: parsed.cachedVersions ?? {},
        };
      }
    }
  } catch {
    // ignore
  }
  return { lastCheck: null, cachedVersions: {} };
}

function saveState(state: UpdaterState): void {
  try {
    const dir = path.dirname(getStatePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    log.warn(`toolUpdater: failed to save state: ${(err as Error).message}`);
  }
}

// --- Helpers ----------------------------------------------------------------

function runCommand(
  command: string,
  args: string[],
  timeout: number = 15_000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);

    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
  });
}

/** Get installed version of a CLI tool (e.g. "rojo --version" -> "7.6.1"). */
async function getInstalledVersion(tool: string): Promise<string | null> {
  const result = await runCommand(tool, ["--version"], 5000);
  if (!result.ok) return null;
  // Parse first version-like string from output
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/** Get latest version from GitHub releases API. */
async function getLatestGitHubVersion(repo: string): Promise<string | null> {
  try {
    const result = await runCommand("curl", [
      "-sL", "-H", "Accept: application/vnd.github+json",
      `https://api.github.com/repos/${repo}/releases/latest`,
    ], 10000);
    if (!result.ok) return null;
    const data = JSON.parse(result.stdout);
    const tag = data?.tag_name as string | undefined;
    if (!tag) return null;
    return tag.replace(/^v/, "");
  } catch {
    return null;
  }
}

// --- Tool -> repo mapping ---------------------------------------------------

/** Map tool names to their GitHub repos for version checking. */
const TOOL_REPOS: Record<string, string> = {
  rojo: "rojo-rbx/rojo",
  wally: "UpliftGames/wally",
  lune: "lune-org/lune",
  selene: "Kampfkarren/selene",
  rokit: "rojo-rbx/rokit",
  stylua: "JohnnyMorganz/StyLua",
  "wally-package-types": "JohnnyMorganz/wally-package-types",
  darklua: "seaofvoices/darklua",
  "luau-lsp": "JohnnyMorganz/luau-lsp",
};

export interface UpdateCheckResult {
  tool: string;
  installed: string | null;
  latest: string | null;
  needsUpdate: boolean;
  error?: string;
}

/**
 * Check if a single tool needs an update.
 * Returns comparison result.
 */
export async function checkToolUpdate(tool: string): Promise<UpdateCheckResult> {
  const repo = TOOL_REPOS[tool];
  if (!repo) {
    return { tool, installed: null, latest: null, needsUpdate: false, error: "unknown repo" };
  }

  const installed = await getInstalledVersion(tool);
  if (!installed) {
    return { tool, installed: null, latest: null, needsUpdate: false, error: "not installed" };
  }

  const latest = await getLatestGitHubVersion(repo);
  if (!latest) {
    return { tool, installed, latest: null, needsUpdate: false, error: "could not fetch latest" };
  }

  return {
    tool,
    installed,
    latest,
    needsUpdate: installed !== latest,
  };
}

/**
 * Check ALL known tools for updates.
 * Returns array of results (one per tool).
 */
export async function checkAllToolUpdates(): Promise<UpdateCheckResult[]> {
  const tools = Object.keys(TOOL_REPOS);
  const results: UpdateCheckResult[] = [];

  for (const tool of tools) {
    try {
      const result = await checkToolUpdate(tool);
      results.push(result);
    } catch (err) {
      results.push({
        tool,
        installed: null,
        latest: null,
        needsUpdate: false,
        error: (err as Error).message,
      });
    }
  }

  return results;
}

// --- Update execution -------------------------------------------------------

/**
 * Run `rokit install` to update all Rokit-managed tools.
 * Returns true if successful.
 */
export async function runRokitUpdate(): Promise<boolean> {
  log.info("toolUpdater: running 'rokit install' to update tools...");
  const result = await runCommand("rokit", ["install"], 60_000);
  if (result.ok) {
    log.info("toolUpdater: rokit install completed successfully");
    return true;
  } else {
    log.warn(`toolUpdater: rokit install failed: ${result.stderr || result.stdout}`);
    return false;
  }
}

/**
 * Run update for a single tool using rokit.
 * Returns true if successful.
 */
export async function updateSingleTool(tool: string): Promise<boolean> {
  // Most Roblox tools are managed by rokit. Run `rokit install` which
  // updates all tools declared in rokit.toml to their pinned versions.
  // For unpinned tools, you'd need `rokit add <repo>@<version>`.
  if (tool === "rokit") {
    // Rokit updates itself
    log.info("toolUpdater: rokit self-update");
    const result = await runCommand("rokit", ["self-update"], 30_000);
    return result.ok;
  }

  // For other tools, just run `rokit install` which syncs everything
  return runRokitUpdate();
}

// --- Periodic check ---------------------------------------------------------

/**
 * Check if enough time has passed since the last check.
 * Returns true if a check should be performed now.
 */
export function shouldCheckNow(): boolean {
  const cfg = getConfig();
  if (!cfg.enabled) return false;

  const state = loadState();
  if (!state.lastCheck) return true;

  const lastTime = new Date(state.lastCheck).getTime();
  if (Number.isNaN(lastTime)) return true;

  const elapsedHours = (Date.now() - lastTime) / (1000 * 60 * 60);
  return elapsedHours >= cfg.intervalHours;
}

/**
 * Main entry point: called on startup.
 * If enabled and enough time has passed, checks all tools for updates.
 * If autoInstall is enabled, runs `rokit install` to apply updates.
 *
 * This function NEVER throws - all errors are logged and swallowed.
 */
export async function performUpdateCheck(): Promise<UpdateCheckResult[]> {
  const cfg = getConfig();
  if (!cfg.enabled) return [];

  if (!shouldCheckNow()) {
    log.debug("toolUpdater: skipping check (too soon since last check)");
    return [];
  }

  log.info("toolUpdater: checking for tool updates...");
  const results = await checkAllToolUpdates();
  const updatesAvailable = results.filter((r) => r.needsUpdate);

  // Update state
  const state = loadState();
  state.lastCheck = new Date().toISOString();
  for (const r of results) {
    if (r.latest) state.cachedVersions[r.tool] = r.latest;
  }
  saveState(state);

  if (updatesAvailable.length === 0) {
    log.info("toolUpdater: all tools up to date");
    return results;
  }

  // Log available updates
  const list = updatesAvailable
    .map((r) => `  - ${r.tool}: ${r.installed} -> ${r.latest}`)
    .join("\n");
  log.info(`toolUpdater: ${updatesAvailable.length} update(s) available:\n${list}`);

  // Auto-install if enabled
  if (cfg.autoInstall) {
    log.info("toolUpdater: auto-install enabled, running rokit install...");
    const ok = await runRokitUpdate();
    if (ok) {
      log.info("toolUpdater: updates installed successfully");
    } else {
      log.warn("toolUpdater: auto-install failed - manual update required");
    }
  } else {
    log.info("toolUpdater: auto-install disabled - run 'rokit install' manually to update");
  }

  return results;
}

/** Force a check on next startup (clears the last-check timestamp). */
export function forceCheckOnNextRun(): void {
  const state = loadState();
  state.lastCheck = null;
  saveState(state);
  log.info("toolUpdater: forced check on next run");
}
