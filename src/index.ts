/**
 * index.ts - CLI entry point for Claude-Killer (Ink TUI edition).
 *
 * Responsibilities:
 *  - Force UTF-8 encoding on ALL platforms (Windows + Linux + macOS)
 *  - Load extensions (skills + MCP servers)
 *  - Render the Ink TUI application
 *  - Handle graceful shutdown
 */

// Polyfill for ESM entry point shebang
// #!/usr/bin/env node

// MUST be the very first import — it patches process.stdout/stderr to emit
// UTF-8 bytes on Windows, sets LANG/LC_ALL on Linux/macOS, and forces Python
// children to UTF-8. Any console.log before this runs may misrender on
// Windows terminals with legacy code pages.
import { forceUtf8Environment } from "./utf8Safety.js";

import React from "react";
import { render } from "ink";
import { App } from "./tui/App.js";
import { loadAllExtensions, shutdownMCPServers } from "./extensions.js";
import { seedUserConfig } from "./configSeeder.js";
import { performUpdateCheck } from "./toolUpdater.js";
import { registerShutdownHandlers } from "./gracefulShutdown.js";

// --- Force UTF-8 everywhere (must run before any console output) ----------
// Without this, terminals display accented chars (á, é, í, õ, ç, ê) as
// garbage like "├¡" or "Ã©". This happens on:
//   - Windows cmd.exe (defaults to CP437 or CP1252) — even after `chcp 65001`
//     in some terminal hosts (Git Bash, ConEmu, Cmder)
//   - Linux containers without `locale-gen pt_BR.UTF-8` (glibc falls back
//     to the C/POSIX locale = ASCII)
//   - macOS when LANG is unset
//
// The fix is layered (see utf8Safety.ts for details):
//   1. (Windows only) `chcp 65001` + `SetConsoleOutputCP(65001)` via PowerShell
//   2. (Windows only) Patch process.stdout/stderr.write to always emit UTF-8
//      bytes (Buffer.from(str, 'utf8')) — bypasses the console code page
//   3. (All platforms) Probe `locale -a` for any UTF-8 locale, prefer
//      pt_BR.UTF-8 → en_US.UTF-8 → C.UTF-8 → C.utf8 (case variations matter)
//   4. (All platforms) Force Python children to UTF-8 via PYTHONIOENCODING
//      and PYTHONUTF8=1
//   5. (All platforms) Force Node stdio to UTF-8 via setDefaultEncoding
const _utf8Result = forceUtf8Environment();
if (_utf8Result.fallbackUsed) {
  // Don't crash — just warn the user. They may need to run
  // `sudo locale-gen pt_BR.UTF-8` for full UTF-8 support on old glibc.
  console.error(
    `[claude-killer] WARNING: no UTF-8 locale found on this system.\n` +
    `  Using fallback "${_utf8Result.chosen}". Accented chars may not render\n` +
    `  correctly. To fix permanently on Debian/Ubuntu:\n` +
    `    sudo sed -i 's/# pt_BR.UTF-8/pt_BR.UTF-8/' /etc/locale.gen && sudo locale-gen\n`
  );
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
