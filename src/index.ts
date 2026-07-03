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
import { setTuiMode } from "./logger.js";
import { initApiKeyPool, prewarmPool, getPoolSize, getPoolStats } from "./apiKeyPool.js";
import { startHeartbeat, stopHeartbeat } from "./heartbeat.js";
import { getProviderConfig, providerNeedsHeartbeat, providerUsesMultiKeyPool } from "./apiProvider.js";
import { autoStartSearx, autoStopSearx } from "./searxManager.js";
import OpenAI from "openai";

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
  seedUserConfig();

  // Sprint 2: Migrate old config format to new mode-based structure if needed.
  // This runs ONCE — after migration, the new structure is in place.
  try {
    const { runMigrationIfNeeded } = await import("./modeMigration.js");
    runMigrationIfNeeded();
  } catch (err) {
    // Migration is best-effort — don't crash on failure
    console.error(`[claude-killer] Migration check failed: ${(err as Error).message}`);
  }

  // Get provider config (NVIDIA or ZenMux)
  const providerConfig = getProviderConfig();
  console.log(`[claude-killer] API provider: ${providerConfig.name} | model: ${process.env.MODEL ?? "default"}`);

  // Initialize the API key pool (only for NVIDIA — ZenMux uses single key).
  // The pool is still initialized for ZenMux but with 1 key (no-op effectively).
  if (providerUsesMultiKeyPool()) {
    initApiKeyPool();
    // Prewarm all keys — fire-and-forget. Only needed for NVIDIA (cold start).
    prewarmPool().catch((err) => {
      console.error(`Prewarm failed: ${err.message}`);
    });
  }

  // Start heartbeat — ONLY for NVIDIA with single key (ZenMux has no cold start).
  // NVIDIA NIM free tier unloads models from GPU after 30-60 min of inactivity.
  // With multi-key pool, heartbeat is DISABLED because:
  //   1. The pool rotates keys during normal chat, keeping them warm
  //   2. Prewarm at startup already warms all keys
  //   3. Heartbeat on a single key (#0) was causing 429s by consuming
  //      that key's rate limit budget while the pool also uses it
  if (providerNeedsHeartbeat()) {
    if (getPoolSize() === 0 && process.env.NVIDIA_API_KEY) {
      // Single-key mode: heartbeat is useful to keep the model warm
      const heartbeatClient = new OpenAI({
        apiKey: process.env.NVIDIA_API_KEY,
        baseURL: providerConfig.baseUrl,
        timeout: 30_000,
      });
      startHeartbeat(heartbeatClient);
    } else if (getPoolSize() > 0) {
      console.log("[claude-killer] Multi-key pool active — heartbeat disabled (pool keeps keys warm)");
    }
  }

  // Check for tool updates in the background (non-blocking - don't delay startup)
  // If updates are available and auto-install is enabled, runs `rokit install`.
  performUpdateCheck().catch((err) => {
    // Never let updater errors crash the app
    console.error(`Tool updater check failed: ${err.message}`);
  });

  // Auto-start local Searx if installed (non-blocking).
  // Searx provides better search quality by aggregating Google + Bing + DDG.
  // If not installed, this is a no-op. If installed but not running, it
  // starts Searx in background — the TUI doesn't wait for it to be ready.
  // On first search, apiResearcher.ts probes localhost:8888 and uses Searx
  // if it's responding (usually ready within 3-5s of CLI launch).
  autoStartSearx().catch((err) => {
    // Searx is optional — never crash on failure
    console.error(`Searx auto-start failed: ${err.message}`);
  });

  // Load skills and start MCP servers before rendering
  await loadAllExtensions();

  // Enable TUI mode: suppresses console.log output from logger.toolCall,
  // logger.toolResult, logger.reply (which would break the Ink layout by
  // appearing ABOVE the TUI). Tool notifications are instead routed through
  // the agent's onToolCall/onToolResult callbacks → ChatDisplay "tool" messages.
  setTuiMode(true);
  // Also set env var so non-logger code (like App.tsx handleDreamCommand)
  // can check if TUI mode is active and suppress console.log.
  process.env.CLAUDE_KILLER_TUI_MODE = "1";

  // Render the Ink app
  const { unmount, waitUntilExit } = render(React.createElement(App));

  // Handle graceful shutdown
  const cleanup = () => {
    stopHeartbeat();
    autoStopSearx();
    setTuiMode(false);
    shutdownMCPServers();
    unmount();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await waitUntilExit();
  setTuiMode(false);
  autoStopSearx();
  shutdownMCPServers();
}

try {
  await main();
} catch (err) {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
}
