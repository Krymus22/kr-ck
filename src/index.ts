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
  // After this, the user owns everything in ~/.claude-killer/ and can edit/delete freely.
  seedUserConfig();

  // Initialize the API key pool eagerly (instead of lazily on first chat() call).
  // This way the pool is ready before the user types anything.
  initApiKeyPool();

  // Prewarm all keys in the pool — fire-and-forget.
  // Sends a tiny "hi" request (max_tokens=1) to each key in parallel.
  // This establishes TLS sessions, warms the keepAlive connection pool,
  // and triggers the NVIDIA NIM server to load the model into GPU memory.
  // Without prewarm, the first real user request would pay all these costs
  // (200-500ms TLS + 5-30s model cold start = "millions of years").
  // With prewarm, the first real request is fast (model already warm).
  prewarmPool().catch((err) => {
    // Never let prewarm errors crash the app — first real request will warm naturally
    console.error(`Prewarm failed: ${err.message}`);
  });

  // Start background heartbeat to keep the model warm.
  // NVIDIA NIM free tier unloads models from GPU after 30-60 min of inactivity.
  // The heartbeat sends a tiny request every 5 min to reset the idle timer,
  // keeping the model loaded in VRAM. Without this, the first request after
  // a pause takes 5-60s (cold start); with heartbeat, it's ~600ms (warm).
  // Uses the first key in the pool (round-robin could be added later).
  if (getPoolSize() > 0) {
    const firstKeyStats = getPoolStats()[0];
    if (firstKeyStats) {
      // Create a dedicated client for the heartbeat (first key)
      // We can't access the pool's internal client directly, so we create one.
      // The pool's keepAlive agent is shared, so TLS session is reused.
      const heartbeatClient = new OpenAI({
        apiKey: firstKeyStats.keyPrefix === "" ? "" : (process.env.NVIDIA_API_KEYS?.split(",")[0] ?? process.env.NVIDIA_API_KEY ?? ""),
        baseURL: "https://integrate.api.nvidia.com/v1",
        timeout: 30_000, // 30s timeout for heartbeat (shorter than real requests)
      });
      startHeartbeat(heartbeatClient);
    }
  } else if (process.env.NVIDIA_API_KEY) {
    // Single-key mode: start heartbeat with the single key
    const heartbeatClient = new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: "https://integrate.api.nvidia.com/v1",
      timeout: 30_000,
    });
    startHeartbeat(heartbeatClient);
  }

  // Check for tool updates in the background (non-blocking - don't delay startup)
  // If updates are available and auto-install is enabled, runs `rokit install`.
  performUpdateCheck().catch((err) => {
    // Never let updater errors crash the app
    console.error(`Tool updater check failed: ${err.message}`);
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
    setTuiMode(false);
    shutdownMCPServers();
    unmount();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await waitUntilExit();
  setTuiMode(false);
  shutdownMCPServers();
}

try {
  await main();
} catch (err) {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
}
