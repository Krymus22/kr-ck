/**
 * index.ts - CLI entry point for Claude-Killer (Ink TUI edition).
 *
 * Responsibilities:
 *  - Force UTF-8 encoding on Windows (chcp + console mode + env vars)
 *  - Set LANG/LC_ALL for child processes on all platforms
 *  - Load extensions (skills + MCP servers)
 *  - Render the Ink TUI application
 *  - Handle graceful shutdown
 */

// Polyfill for ESM entry point shebang
// #!/usr/bin/env node

import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { loadAllExtensions, shutdownMCPServers } from "./extensions.js";
import { execSync } from "node:child_process";
import { seedUserConfig } from "./configSeeder.js";
import { performUpdateCheck } from "./toolUpdater.js";
import { registerShutdownHandlers } from "./gracefulShutdown.js";

// --- Force UTF-8 everywhere ------------------------------------------------
// Without this, Windows terminals (cmd.exe, PowerShell, Windows Terminal)
// display accented chars (á, é, í, õ, ç, ê) as garbage like "├¡" or "Ã©".
//
// Layered approach:
//   1. chcp 65001 - sets console code page for cmd.exe children
//   2. SetConsoleOutputCP via reg query - tries to set for current console
//   3. LANG/LC_ALL env vars - for child processes (curl, rojo, etc.)
//   4. process.stdout.setDefaultEncoding - tells Node to write UTF-8 bytes

if (process.platform === "win32") {
  // Layer 1: chcp 65001 for cmd.exe
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch {
    // PowerShell or non-cmd shell - chcp may not work, but won't throw
  }

  // Layer 2: Try setting console output CP via PowerShell as fallback.
  // This works even when chcp doesn't (e.g. when stdin is redirected).
  try {
    execSync(
      `powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::InputEncoding = [System.Text.Encoding]::UTF8"`,
      { stdio: "ignore" }
    );
  } catch {
    // PowerShell not available or failed - continue
  }
}

// Layer 3: Set LANG/LC_ALL on ALL platforms for child processes.
// On Linux/macOS this is the standard way to set locale.
// On Windows it's used by ports of Unix tools (git, curl, etc.)
process.env.LANG ??= process.platform === "win32" ? "en_US.UTF-8" : "pt_BR.UTF-8";
process.env.LC_ALL ??= process.env.LANG;
// Also force Python (if invoked as child) to use UTF-8
process.env.PYTHONIOENCODING ??= "utf-8";

// Layer 4: Force Node stdio to UTF-8.
// On Node 18+ this also affects how strings are encoded when written to stdout.
try {
  // setDefaultEncoding is on Socket/Tty streams
  if (process.stdout && typeof (process.stdout as any).setDefaultEncoding === "function") {
    (process.stdout as any).setDefaultEncoding("utf8");
  }
  if (process.stderr && typeof (process.stderr as any).setDefaultEncoding === "function") {
    (process.stderr as any).setDefaultEncoding("utf8");
  }
} catch {
  // ignore - not critical
}

// --- Entry Point ---------------------------------------------------------

async function main(): Promise<void> {
  // Register graceful shutdown handlers (SIGINT, SIGTERM, SIGHUP, uncaughtException)
  registerShutdownHandlers();

  // Seed bundled defaults (Roblox CLI tools, library skills, modes) on first run.
  // After this, the user owns everything in ~/.claude-killer/ and can edit/delete freely.
  seedUserConfig();

  // Check for tool updates in the background (non-blocking - don't delay startup)
  // If updates are available and auto-install is enabled, runs `rokit install`.
  performUpdateCheck().catch((err) => {
    // Never let updater errors crash the app
    console.error(`Tool updater check failed: ${err.message}`);
  });

  // Load skills and start MCP servers before rendering
  await loadAllExtensions();

  // Render the Ink app
  const { unmount, waitUntilExit } = render(React.createElement(App));

  // Handle graceful shutdown
  const cleanup = () => {
    shutdownMCPServers();
    unmount();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await waitUntilExit();
  shutdownMCPServers();
}

try {
  await main();
} catch (err) {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
}
