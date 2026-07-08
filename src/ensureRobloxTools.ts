/**
 * ensureRobloxTools.ts - Ensures Roblox development tools are installed.
 *
 * When roblox mode is active, selene (Luau linter) and stylua (formatter)
 * are REQUIRED — without them, the fileValidator blocks all .luau writes.
 * This module checks if they're installed and warns the user if not.
 *
 * It does NOT auto-install (that would be intrusive). It just warns.
 */

import * as log from "./logger.js";
import { execSync } from "node:child_process";

interface ToolStatus {
  name: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  required: boolean;
  installUrl: string;
}

/**
 * Check if a binary is available in PATH.
 */
function checkBinary(name: string): { path: string | null; version: string | null } {
  // BUG FIX: previously used a single `which ${name} 2>/dev/null || where ${name} 2>/dev/null`
  // command for both POSIX and Windows. That has two problems on Windows:
  //   1. `which` is not a cmd.exe builtin, so the first half always errors.
  //   2. `2>/dev/null` is BASH syntax. cmd.exe interprets it as "redirect
  //      stderr to a file named `dev\null` in the cwd", creating a stray
  //      `dev\` directory and `null` file as a side effect on every check.
  // Use a platform-specific command: `where` (with `2>nul`) on Windows,
  // `which` (with `2>/dev/null`) on POSIX. `execSync` defaults to cmd.exe
  // on Windows and /bin/sh on POSIX, so the syntax matches each shell.
  const isWin = process.platform === "win32";
  const checkCmd = isWin
    ? `where ${name} 2>nul`
    : `which ${name} 2>/dev/null`;
  try {
    const path = execSync(checkCmd, {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!path) return { path: null, version: null };

    // Try to get version
    let version: string | null = null;
    try {
      version = execSync(`${name} --version 2>${isWin ? "nul" : "/dev/null"}`, {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // version check failed — binary exists but --version not supported
    }
    return { path, version };
  } catch {
    return { path: null, version: null };
  }
}

/**
 * Check all Roblox tools and return their status.
 */
export function checkRobloxTools(): ToolStatus[] {
  const tools: Array<{ name: string; cmd: string; required: boolean; installUrl: string }> = [
    { name: "selene", cmd: "selene", required: true, installUrl: "https://github.com/Kampfkarren/selene/releases" },
    { name: "stylua", cmd: "stylua", required: true, installUrl: "https://github.com/JohnnyMorganz/StyLua/releases" },
    { name: "rojo", cmd: "rojo", required: false, installUrl: "https://github.com/rojo-rbx/rojo/releases" },
    { name: "lune", cmd: "lune", required: false, installUrl: "https://github.com/lune-org/lune/releases" },
  ];

  return tools.map(t => {
    const { path, version } = checkBinary(t.cmd);
    return {
      name: t.name,
      installed: path !== null,
      path,
      version,
      required: t.required,
      installUrl: t.installUrl,
    };
  });
}

/**
 * Log a warning if required Roblox tools are missing.
 * Called when roblox mode is activated.
 */
export function warnIfMissingTools(): void {
  const tools = checkRobloxTools();
  const missing = tools.filter(t => !t.installed);

  if (missing.length === 0) {
    log.success("[ROBLOX] All Roblox tools installed: " +
      tools.filter(t => t.installed).map(t => t.name).join(", "));
    return;
  }

  const missingRequired = missing.filter(t => t.required);
  const missingOptional = missing.filter(t => !t.required);

  if (missingRequired.length > 0) {
    log.warn(`[ROBLOX] REQUIRED tools missing: ${missingRequired.map(t => t.name).join(", ")}`);
    log.warn("[ROBLOX] Without these tools, the fileValidator will BLOCK all .luau writes.");
    log.warn("[ROBLOX] Install them:");
    for (const t of missingRequired) {
      log.warn(`  ${t.name}: ${t.installUrl}`);
    }
  }

  if (missingOptional.length > 0) {
    log.debug(`[ROBLOX] Optional tools missing: ${missingOptional.map(t => t.name).join(", ")}`);
    for (const t of missingOptional) {
      log.debug(`  ${t.name}: ${t.installUrl}`);
    }
  }
}
