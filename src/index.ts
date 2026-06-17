/**
 * index.ts - CLI entry point for Claude-Killer (Ink TUI edition).
 *
 * Responsibilities:
 *  - Set UTF-8 encoding on Windows (chcp 65001)
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

// --- Force UTF-8 on Windows ----------------------------------------------
// Windows cmd.exe defaults to cp1252 which breaks Unicode characters.
// Setting chcp 65001 enables UTF-8 so icons and symbols render correctly.
if (process.platform === "win32") {
  try {
    execSync("chcp 65001", { stdio: "ignore" });
  } catch {
    // If chcp fails (e.g. not in cmd.exe), continue anyway.
  }
}

// --- Entry Point ---------------------------------------------------------

async function main(): Promise<void> {
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
