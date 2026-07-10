/**
 * App.tsx - Main Ink application component.
 *
 * Layout:
 *   - Chat history (scrollable)
 *   - Thinking indicator
 *   - Task panel
 *   - Bottom bar: Input (left) + StatusBar (right)
 *   - Slash command autocomplete overlay when typing /
 */

import React, { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runAgentLoop } from "../agent.js";
import * as history from "../history.js";
import * as todo from "../todo.js";
import { clearReadPaths } from "../readBeforeWrite.js";
import { clearSessionFiles } from "../fileRehydration.js";
import { clearInvokedSkills } from "../skillTracker.js";
// State-leak cleanup: clearAllModuleState clears every module that keeps
// per-turn / per-session state at the module level. Called on /reset,
// /session new, /session load, auto-load, and the mode "new" context
// action — same reset points as clearReadPaths (§17.3.11). The individual
// clear* functions are still imported above because the existing reset
// points call them inline (legacy). The helper adds the additional clears
// (honesty, bugHunter, dataGuard, failureMemory, checkpoints,
// patternExtractor, activity) on top.
import { clearAllModuleState } from "../stateCleanup.js";

import { config } from "../config.js";
import { shutdownMCPServers, getActiveSkills, getActiveMCPServers } from "../extensions.js";
import { discoverExtensions, getAllExtensions } from "../extensionCenter.js";
import { setEffortLevel, getEffortLabel } from "../effortLevels.js";
import { getPoolSize, formatPoolStats, setPrewarmListener, type PrewarmEvent } from "../apiKeyPool.js";
import { setHeartbeatListener, type HeartbeatEvent } from "../heartbeat.js";
import { runSmallTask, isSmallTaskEnabled, getSmallTaskModel, consumePendingSmallTaskSummaries } from "../smallTaskAgent.js";
import { getRegistry as getExternalToolRegistry } from "../externalTools.js";
import {
  getAllModes,
  getActiveModeName,
  getActiveMode,
  getMode,
  applyMode,
  deactivateMode,
  suggestMode,
  confirmAndSaveMode,
} from "../modes.js";
import { getLocalizedSlashCommands, detectLanguage, setLanguage, resetLanguageCache } from "../i18n.js";
// Sprint 10: Inbox organizer — /organize slash command + 'O' key in Hub
import { organizeInbox, formatOrganizeResult } from "../inboxOrganizer.js";
import { colors } from "./theme.js";
import { ChatDisplay, ChatMessage } from "./ChatDisplay.js";
import { StatusBar } from "./StatusBar.js";
import { TodoPanel, TodoItem } from "./TodoPanel.js";
import { PlanPanel } from "./PlanPanel.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
// BUG FIX (bug-hunter-dataguard-invisible): import getActivitySnapshot so the
// ThinkingIndicator stays visible when Bug Hunter or DataGuard are running,
// even if the App status has already left "thinking"/"compacting". Without
// this, the user sees no feedback while these sub-agents review the code.
import { getActivitySnapshot } from "../activityTracker.js";
import { ExtensionHub } from "./ExtensionHub.js";
import { FolderBrowser } from "./FolderBrowser.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { ConfiguratorChat } from "./ConfiguratorChat.js";
import type { AskUserQuestion, AskUserResponse } from "../askUser.js";
import { getSearxStatus } from "../searxManager.js";
import { loadConfig as loadDotfileConfig, updateConfig as updateDotfileConfig, saveConfig as saveDotfileConfig } from "../dotfileConfig.js";
import { listSessions, deleteSession, renameSession, startSession, getLastSession, loadSessionMessages, setActiveSession, getActiveSessionId, updateSessionProjectCwd, updateSessionEffortLevel, updateSessionUsage, type SessionUsage } from "../session.js";
// Static import (no circular dep) — fixes the syncPlan() race condition.
// Previously syncPlan() used `await import("../planExecutor.js")` which
// scheduled a microtask that could fire AFTER createPlan() was called in
// the same tick, producing a transient render with `planSteps = []`
// before the plan appeared (flicker). The static import lets syncPlan
// read getPlan() synchronously, so setPlanSteps() reflects the new plan
// immediately. The createPlan() call site also calls syncPlan() right
// after, eliminating the race entirely.
import { getPlan as getPlanSync, createPlan as createPlanSync, type Plan as PlanShape } from "../planExecutor.js";

// --- Types ------------------------------------------------------------------

type AppStatus = "idle" | "thinking" | "streaming" | "compacting";

// --- Slash command definitions ----------------------------------------------

// --- Slash command definitions (localized via i18n) --------------------------

// Re-computed lazily; refreshed on each render to pick up language changes.
function getSlashCommands(): Array<{ cmd: string; desc: string; subcommands?: string[] }> {
  return getLocalizedSlashCommands();
}

// Backward-compat: used by /help text and tests
const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  ...getSlashCommands().map((c) => ({ cmd: c.cmd, desc: c.desc })),
  { cmd: "/buscar", desc: "Search for file on machine (tools, etc)" },
  { cmd: "/cd", desc: "Change working directory (project switcher)" },
  { cmd: "/session", desc: "Save/load/list/delete conversation sessions" },
];

type CommandResult = { handled: boolean; message?: string; exit?: boolean; openHub?: boolean; openFolderBrowser?: boolean; resetChat?: boolean; openConfigurator?: boolean; configuratorTool?: string | null; compactDone?: boolean; compactStarted?: boolean; compactInstruction?: string; compactResult?: { removed: number; beforeTokens: number; afterTokens: number; method?: string }; visualMessages?: ChatMessage[]; restoredUsage?: { lastPromptTokens: number; lastCompletionTokens: number; lastTotalTokens: number; sessionPromptTokens: number; sessionCompletionTokens: number; sessionCost: number } };



function handleExitCommand(): CommandResult {
  // Sessions are auto-saved (append-only JSONL). No explicit save needed.
  // Each message was already written to disk as it was added to history.
  shutdownMCPServers();
  return { handled: true, exit: true };
}

function handleHelpCommand(): CommandResult {
  const text = SLASH_COMMANDS.map((s) => `  ${s.cmd.padEnd(12)} ${s.desc}`).join("\n");
  return { handled: true, message: text };
}

function handleResetCommand(): CommandResult {
  history.resetHistory();
  // BUG FIX (BS-18): clear readBeforeWrite state too — otherwise the safety
  // gate is bypassed by stale paths from the previous session, allowing the
  // IA to edit files it hasn't read in the NEW session.
  clearReadPaths();
  clearSessionFiles();
  clearInvokedSkills();
  // State-leak cleanup: clear every module that keeps per-turn / per-session
  // state at the module level (bugHunter, honesty, dataGuard, failureMemory,
  // checkpoints, patternExtractor, activity). Fire-and-forget — the
  // synchronous resets above already completed; the async ones (bugHunter,
  // dataGuard, checkpoints) complete in the background before the next user
  // message. runAgentLoop ALSO resets per-turn state at the start of the next
  // turn, so any race here is bounded (defense-in-depth, not correctness).
  // See src/stateCleanup.ts for the full rationale.
  void clearAllModuleState();
  return { handled: true, message: "History reset." };
}

function handleHistoryCommand(): CommandResult {
  const summary = history.historySummary();
  const length = history.historyLength();
  return { handled: true, message: `History: ${length} messages (${summary})` };
}

function handleSkillsCommand(): CommandResult {
  const skills = getActiveSkills();
  if (skills.length === 0) return { handled: true, message: "Nenhuma skill carregada." };
  const text = skills.map((s) => `  * ${s.name}: ${s.description}`).join("\n");
  return { handled: true, message: `Skills:\n${text}` };
}

function handlePluginsCommand(): CommandResult {
  const servers = getActiveMCPServers();
  if (servers.length === 0) return { handled: true, message: "Nenhum servidor MCP ativo." };
  const text = servers.map((s) => `  * ${s}`).join("\n");
  return { handled: true, message: `MCP Servers:\n${text}` };
}

/**
 * /session — manage conversation sessions.
 *
 * Sessions are AUTO-SAVED (append-only JSONL). No /session save needed.
 * Each message is written to disk immediately as it's added to history.
 *
 * Subcommands:
 *   /session              — list sessions for current project
 *   /session list         — alias for /session
 *   /session load <id>    — load a saved session (replaces current)
 *   /session delete <id>  — delete a saved session
 *   /session rename <o> <n> — rename a session
 *   /session new          — start a new (empty) session
 */
function handleSessionCommand(arg: string | null): CommandResult {
  const subcommand = arg?.split(/\s+/)[0]?.toLowerCase() ?? "";

  // /session or /session list
  if (!subcommand || subcommand === "list") {
    const sessions = listSessions();
    const activeId = getActiveSessionId();
    if (sessions.length === 0) {
      return {
        handled: true,
        message: "No saved sessions for this project.\n\nSessions are auto-saved — just start chatting.",
      };
    }
    const lines = [`Sessions for this project (${sessions.length}):`, ""];
    for (const s of sessions.slice(0, 20)) {
      const date = s.lastModified.slice(0, 19).replace("T", " ");
      const active = s.id === activeId ? " ← active" : "";
      const summary = s.summary.length > 50 ? s.summary.slice(0, 50) + "..." : s.summary;
      lines.push(`  ${s.id}  ${date}  ${s.messageCount} msgs  ${summary}${active}`);
    }
    if (sessions.length > 20) {
      lines.push(`  ... and ${sessions.length - 20} more`);
    }
    lines.push("", "Usage:", "  /session load <id>          — load a session", "  /session delete <id>        — delete", "  /session rename <old> <new> — rename", "  /session new                — start fresh session");
    return { handled: true, message: lines.join("\n") };
  }

  // /session new — start a new empty session
  if (subcommand === "new") {
    history.resetHistory();
    // BUG FIX (BS-18): clear readBeforeWrite state — new session means
    // the IA hasn't read any files yet in this context.
    clearReadPaths();
    clearSessionFiles();
    clearInvokedSkills();
    // State-leak cleanup: clear all module-level state (bugHunter, honesty,
    // dataGuard, failureMemory, checkpoints, patternExtractor, activity).
    // See clearAllModuleState docstring in src/stateCleanup.ts for rationale.
    void clearAllModuleState();
    startSession();
    return { handled: true, resetChat: true, message: "[OK] New session started. Previous session is saved on disk." };
  }

  // /session load <id>
  if (subcommand === "load") {
    const id = arg!.split(/\s+/)[1];
    if (!id) return { handled: true, message: "Usage: /session load <id>" };
    const loaded = loadSessionMessages(id);
    if (!loaded) {
      return { handled: true, message: `[ERROR] Session not found: ${id}` };
    }
    // Set active session FIRST — prevents appendMessage from auto-creating
    // a new session file (double-write bug fix).
    setActiveSession(id);
    // Reset history and load directly (no re-persisting to session file).
    history.resetHistory();
    // BUG FIX (BS-18): clear readBeforeWrite state — the loaded session's
    // files may differ from the current read-paths set. The IA must re-read
    // files before editing in the loaded context.
    clearReadPaths();
    clearSessionFiles();
    clearInvokedSkills();
    // State-leak cleanup: clear all module-level state from the previous
    // session before loading the new one. The loaded session's bug-hunter
    // findings, claim store, failure memory, checkpoints, etc. must NOT
    // bleed into the loaded conversation's first turn.
    void clearAllModuleState();
    if (loaded.lastSnapshot && loaded.lastSnapshot.messages.length > 0) {
      // BUG FIX (BS-3): merge snapshot + postSnapshotMessages.
      // Previously: only loaded the snapshot, losing messages that arrived
      // AFTER compaction (including the user's last question). The IA would
      // respond to a question it couldn't see in context.
      // Now: snapshot (compacted state) + postSnapshotMessages (recent msgs).
      // This is guaranteed to fit because: snapshot was the IA's context
      // (fits), and postSnapshotMessages are new msgs added since (small).
      const merged = [
        ...loaded.lastSnapshot.messages,
        ...loaded.postSnapshotMessages,
      ];
      history.loadHistoryDirect(merged as any);
    } else {
      // No compaction — full message list IS what the IA had at shutdown.
      history.loadHistoryDirect(loaded.messages as any);
    }
    // Restore the loaded session's effort level (low/medium/high/max).
    // Each session remembers its own effort — switching sessions restores
    // the effort that was active when the loaded session was last used.
    // Only restore if the session has a valid effortLevel field; old
    // sessions (created before this feature) have null and we keep the
    // current level. The visual label is refreshed by handleSlashCommandFlow
    // which calls setEffortLabel(getEffortLabel()) after this returns.
    if (loaded.effortLevel) {
      setEffortLevel(loaded.effortLevel);
    }
    // BUG FIX (usage-not-restored): return usage data via restoredUsage so
    // handleSlashCommandFlow (inside the component) can call the setters.
    // We can't call them here because handleSessionCommand is a top-level
    // function without access to useState setters.
    const restoredUsage = loaded.usage ? {
      lastPromptTokens: loaded.usage.lastPromptTokens,
      lastCompletionTokens: loaded.usage.lastCompletionTokens,
      lastTotalTokens: loaded.usage.lastTotalTokens,
      sessionPromptTokens: loaded.usage.sessionPromptTokens,
      sessionCompletionTokens: loaded.usage.sessionCompletionTokens,
      sessionCost: loaded.usage.sessionCost,
    } : undefined;
    return {
      handled: true,
      resetChat: true,
      // Also populate visual messages — the caller (handleSlashCommandFlow)
      // will use resetChat to clear the visual state, then we need to
      // re-populate it with the loaded session's messages.
      visualMessages: convertSessionToVisualMessages(loaded.messages),
      restoredUsage,
      message: `[OK] Session loaded: ${id}\n${loaded.messages.length} messages restored${loaded.lastSnapshot ? ` (from ${loaded.lastSnapshot.method} compaction snapshot)` : ""}.${loaded.effortLevel ? `\nEffort restored to: ${loaded.effortLevel.toUpperCase()}` : ""}`,
    };
  }

  // /session delete <id>
  if (subcommand === "delete" || subcommand === "rm") {
    const id = arg!.split(/\s+/)[1];
    if (!id) return { handled: true, message: "Usage: /session delete <id>" };
    const ok = deleteSession(id);
    return { handled: true, message: ok ? `[OK] Session deleted: ${id}` : `[ERROR] Session not found: ${id}` };
  }

  // /session rename <old> <new>
  if (subcommand === "rename") {
    const parts = arg!.split(/\s+/);
    const oldId = parts[1];
    const newId = parts[2];
    if (!oldId || !newId) return { handled: true, message: "Usage: /session rename <old-id> <new-id>" };
    const ok = renameSession(oldId, newId);
    return { handled: true, message: ok ? `[OK] Session renamed: ${oldId} → ${newId}` : `[ERROR] Failed to rename` };
  }

  return { handled: true, message: `Unknown subcommand: "${subcommand}"\nUsage: /session [list|load|delete|rename|new]` };
}

function handleMcpCommand(arg: string | null): CommandResult {
  const subcommand = arg?.split(/\s+/)[0]?.toLowerCase() ?? "";

  // /mcp or /mcp list
  if (!subcommand || subcommand === "list") {
    const servers = getActiveMCPServers();
    const claudeJsonEnabled = process.env.CLAUDE_KILLER_LOAD_CLAUDE_JSON === "1";
    const lines: string[] = ["MCP Servers:"];
    if (servers.length === 0) {
      lines.push("  (none active)");
    } else {
      for (const s of servers) lines.push(`  * ${s}`);
    }
    lines.push(
      "",
      "Config locations (loaded at startup, in precedence order):",
      "  1. ./.mcp.json                                    (project-local, Claude Code format)",
      "  2. ~/.claude-killer/config.json -> mcpServers     (native dotfile)",
      `  3. ~/.claude.json -> mcpServers                   (Claude Code global) ${claudeJsonEnabled ? "[ENABLED]" : "[DISABLED — set CLAUDE_KILLER_LOAD_CLAUDE_JSON=1 to enable]"}`,
      "  4. ~/.claude-killer/plugins/*/plugin.json         (plugins)",
      "  5. ~/.claude-killer/modes/<mode>/mcps/*.json      (mode-specific)",
      "",
      "Usage:",
      "  /mcp add <name> <command> [args...]   — add server to ~/.claude-killer/config.json",
      "  /mcp remove <name>                    — remove server (searches all 3 config files)",
      "  /mcp list                             — list active servers",
      "",
      "Example:",
      '  /mcp add Roblox_Studio "C:\\Users\\kryst\\AppData\\Local\\Roblox\\Versions\\version-XXX\\StudioMCP.exe"',
      "  (restart CLI to load the new server)",
    );
    return { handled: true, message: lines.join("\n") };
  }

  // /mcp add <name> <command> [args...]
  if (subcommand === "add") {
    const rest = arg!.slice(3).trim(); // remove "add"
    const parts = rest.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return {
        handled: true,
        message: 'Usage: /mcp add <name> <command> [args...]\nExample: /mcp add Roblox_Studio cmd.exe /c %LOCALAPPDATA%\\Roblox\\mcp.bat',
      };
    }
    const [name, command, ...args] = parts;
    try {
      const current = loadDotfileConfig();
      const existingServers = current.mcpServers ?? {};
      const updated = updateDotfileConfig({
        mcpServers: {
          ...existingServers,
          [name!]: { command, args: args.length > 0 ? args : undefined },
        },
      });
      const total = Object.keys(updated.mcpServers ?? {}).length;
      return {
        handled: true,
        message:
          `[OK] MCP server "${name}" added to ~/.claude-killer/config.json\n` +
          `  command: ${command}\n` +
          `  args:    ${args.length > 0 ? args.join(" ") : "(none)"}\n` +
          `  total servers in config: ${total}\n\n` +
          `Restart the CLI to load it. (MCPs are spawned at startup.)`,
      };
    } catch (err) {
      return { handled: true, message: `Failed to add MCP server: ${(err as Error).message}` };
    }
  }

  // /mcp remove <name>
  if (subcommand === "remove" || subcommand === "rm" || subcommand === "delete") {
    const name = arg!.split(/\s+/)[1];
    if (!name) {
      return { handled: true, message: "Usage: /mcp remove <name>" };
    }
    const removedFrom: string[] = [];
    const errors: string[] = [];

    // 1. Try ~/.claude-killer/config.json
    try {
      const current = loadDotfileConfig();
      const existingServers = current.mcpServers ?? {};
      if (existingServers[name]) {
        delete existingServers[name];
        saveDotfileConfig({ ...current, mcpServers: existingServers });
        removedFrom.push("~/.claude-killer/config.json");
      }
    } catch (err) {
      errors.push(`~/.claude-killer/config.json: ${(err as Error).message}`);
    }

    // 2. Try ./.mcp.json (project-local)
    try {
      const projectMcpJson = path.join(process.cwd(), ".mcp.json");
      if (fs.existsSync(projectMcpJson)) {
        const raw = JSON.parse(fs.readFileSync(projectMcpJson, "utf8"));
        if (raw.mcpServers && raw.mcpServers[name]) {
          delete raw.mcpServers[name];
          fs.writeFileSync(projectMcpJson, JSON.stringify(raw, null, 2), "utf8");
          removedFrom.push("./.mcp.json");
        }
      }
    } catch (err) {
      errors.push(`./.mcp.json: ${(err as Error).message}`);
    }

    // 3. Try ~/.claude.json (Claude Code global format)
    try {
      const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
      const claudeJson = path.join(home, ".claude.json");
      if (fs.existsSync(claudeJson)) {
        const raw = JSON.parse(fs.readFileSync(claudeJson, "utf8"));
        if (raw.mcpServers && raw.mcpServers[name]) {
          delete raw.mcpServers[name];
          fs.writeFileSync(claudeJson, JSON.stringify(raw, null, 2), "utf8");
          removedFrom.push("~/.claude.json");
        }
      }
    } catch (err) {
      errors.push(`~/.claude.json: ${(err as Error).message}`);
    }

    if (removedFrom.length > 0) {
      return {
        handled: true,
        message:
          `[OK] MCP server "${name}" removed from:\n` +
          removedFrom.map((s) => `  - ${s}`).join("\n") +
          `\n\nRestart the CLI to unload it.`,
      };
    }
    return {
      handled: true,
      message:
        `MCP server "${name}" not found in any config file:\n` +
        `  - ~/.claude-killer/config.json\n` +
        `  - ./.mcp.json\n` +
        `  - ~/.claude.json\n` +
        (errors.length > 0 ? `\nErrors:\n${errors.map((e) => `  - ${e}`).join("\n")}` : ""),
    };
  }

  return {
    handled: true,
    message:
      `Unknown subcommand: "${subcommand}"\n` +
      `Usage: /mcp [list|add|remove]\n` +
      `  /mcp                    — list active servers + config locations\n` +
      `  /mcp add <name> <cmd> [args...]  — add server\n` +
      `  /mcp remove <name>      — remove server`,
  };
}

function handleCavemanCommand(arg: string | null): CommandResult {
  const validLevels = ["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"];
  if (!arg) {
    const current = history.getCavemanLevel();
    return { handled: true, message: `Caveman: ${current ?? "desativado"}\nUso: /caveman <lite|full|ultra|off>` };
  }
  // arg is now case-preserved by handleSlashCommand; levels are lowercase by convention.
  const normalized = arg.toLowerCase();
  if (normalized === "off" || normalized === "normal") {
    history.setCavemanLevel(null);
    return { handled: true, message: "Caveman desativado!" };
  }
  if (validLevels.includes(normalized)) {
    history.setCavemanLevel(normalized);
    return { handled: true, message: `Caveman ativado: ${normalized.toUpperCase()}` };
  }
  return { handled: true, message: `Invalid level. Use: ${validLevels.join(", ")} or off` };
}

function handleMemoryCommand(): CommandResult {
  const refreshed = history.reloadProjectMemory();
  if (!refreshed) return { handled: true, message: "Nenhum CLAUDE.md/AGENTS.md encontrado." };
  return { handled: true, message: `Project memory carregada:\n${refreshed}` };
}

function handleTodosCommand(): CommandResult {
  const bar = todo.renderTodoBar();
  return { handled: true, message: bar || "Lista vazia." };
}

function handlePlanCommand(): CommandResult {
  const current = history.isPlanMode();
  history.setPlanMode(!current);
  return {
    handled: true,
    message: current
      ? "Modo Plan DESATIVADO - ferramentas executadas normalmente."
      : "Modo Plan ATIVADO - modelo cria plano sem executar ferramentas.",
  };
}

function handleCompactCommand(arg: string | null): CommandResult {
  // /compact com mensagem = custom instruction (ex: /compact focus on code changes)
  // /compact vazio = compactação automática (preserva tudo importante)
  // A compactação real (LLM-based) é feita pelo caller (handleSlashCommandFlow)
  // que tem acesso aos setters do React.
  // NOTE: arg is the FULL string after `/compact ` (multi-word, case preserved).
  const customInstruction = arg?.trim() || undefined;

  return {
    handled: true,
    message: customInstruction
      ? `Compactando com foco em: ${customInstruction}\nAguarde... (a IA esta gerando o resumo)`
      : "Compactando contexto...\nAguarde... (a IA esta gerando o resumo inteligente)",
    compactStarted: true,
    compactInstruction: customInstruction,
  };
}

function handleDreamCommand(): CommandResult {
  import("../memory.js").then(({ runDream, getMemoryConfig }) => {
    const config = getMemoryConfig();
    runDream(config).then((result) => {
      // Use systemMessages (added to chat via setSystemMessages) instead of
      // console.log, which would break the Ink TUI by appearing ABOVE the layout.
      // Note: handleDreamCommand is a module-level function, so it can't call
      // setSystemMessages directly. Instead, we use a global event emitter
      // pattern — but for simplicity, we just return the message via the
      // CommandResult and let the caller add it to systemMessages.
      // For the async completion, we use console.error which goes to stderr
      // (less disruptive than stdout, but still not ideal in TUI mode).
      // The proper fix would be to pass a callback, but that's a larger refactor.
      if (!process.env.CLAUDE_KILLER_TUI_MODE) {
        console.log(`\n* Dream completo: ${result.reviewedSessions} sessões revisadas, ${result.extractedSkills} skills extraídas, ${result.deduplicatedEntries} duplicatas removidas.`);
      }
    }).catch((err) => {
      console.error(`Dream failed: ${(err as Error).message}`);
    });
  }).catch(() => {
    console.error("Failed to load memory module");
  });
  return { handled: true, message: "Running /dream - reviewing memory..." };
}

function handleDistillCommand(): CommandResult {
  import("../memory.js").then(({ runDistill, getMemoryConfig }) => {
    const config = getMemoryConfig();
    runDistill(config).then((result) => {
      if (!process.env.CLAUDE_KILLER_TUI_MODE) {
        console.log(`\n* Distill completo: ${result.skillsExtracted} skills extraídos.`);
      }
    }).catch((err) => {
      console.error(`Distill failed: ${(err as Error).message}`);
    });
  }).catch(() => {
    console.error("\nX Failed to load memory module");
  });
  return { handled: true, message: "Executando /distill - extraindo workflow skills..." };
}

function handleHubCommand(): CommandResult {
  return { handled: true, openHub: true };
}

// Sprint 9: /buscar <arquivo> — procura arquivo na máquina
function handleBuscarCommand(arg: string | null): CommandResult {
  if (!arg) {
    return { handled: true, message: "Usage: /buscar <filename>\nExample: /buscar selene\nSearches default folders first. If not found, asks to search entire machine." };
  }
  // The actual search is async — we return a message and the search
  // will be triggered by the system message flow.
  return {
    handled: true,
    message: `Searching "${arg}"...\nUse IA to search: "find ${arg} on my machine" or wait for mini chat integration.`,
  };
}

/**
 * /cd [path] — change working directory (similar to Claude Code's project picker).
 *
 * Without arg: shows current cwd + suggestions (subdirs + parent).
 * With arg: changes cwd to the given path (relative or absolute).
 *
 * Use cases:
 *   /cd                      → show current cwd + suggestions
 *   /cd src                  → enter src/ subfolder
 *   /cd ..                   → go to parent
 *   /cd C:\Users\kryst\jogo  → absolute path (Windows)
 *   /cd ~/projects           → home-relative
 *
 * After /cd, all subsequent file operations (editar_arquivo, executar_comando,
 * Bug Hunter, etc.) will use the new cwd.
 *
 * The IA can also call this when the user says "switch to my other project"
 * or "let's work on the roblox game".
 */
function handleCdCommand(arg: string | null): CommandResult {
  // /cd (sem arg) — abre o seletor visual interativo (FolderBrowser)
  if (!arg) {
    return { handled: true, openFolderBrowser: true };
  }

  // /cd ~ → home
  if (arg === "~") {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
    try {
      process.chdir(home);
      updateSessionProjectCwd(process.cwd());
      return { handled: true, message: `[OK] Working directory changed to:\n  ${process.cwd()}` };
    } catch (err) {
      return { handled: true, message: `[ERROR] Could not change to home: ${(err as Error).message}` };
    }
  }

  // /cd ~/path → expand home
  let targetPath = arg;
  if (arg.startsWith("~/") || arg.startsWith("~\\")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
    targetPath = path.join(home, arg.slice(2));
  }

  // Resolve path (relative to cwd if not absolute)
  const resolved = path.resolve(targetPath);

  // Verifica se existe e é diretório
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return { handled: true, message: `[ERROR] Not a directory: ${resolved}` };
    }
  } catch {
    return { handled: true, message: `[ERROR] Path does not exist: ${resolved}` };
  }

  // Tenta mudar o cwd
  try {
    process.chdir(resolved);
    const newCwd = process.cwd();
    updateSessionProjectCwd(newCwd);
    const lines = [
      `[OK] Working directory changed:`,
      `  ${newCwd}`,
      ``,
    ];
    // Detecta projetos no novo cwd
    if (fs.existsSync(path.join(newCwd, "default.project.json"))) {
      lines.push(`✓ Roblox project detected (default.project.json found)`);
    }
    if (fs.existsSync(path.join(newCwd, "package.json"))) {
      lines.push(`✓ Node.js project detected (package.json found)`);
    }
    // Lista subpastas do novo cwd
    try {
      const entries = fs.readdirSync(newCwd, { withFileTypes: true });
      const subdirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.startsWith("node_modules"))
        .slice(0, 10)
        .map((e) => e.name);
      if (subdirs.length > 0) {
        lines.push(``, `Subfolders:`, ...subdirs.map((d) => `  ${d}`));
      }
    } catch { /* ignore */ }
    // Recarrega project memory (CLAUDE.md/AGENTS.md do novo diretório)
    try {
      const memory = history.reloadProjectMemory();
      if (memory) {
        lines.push(``, `✓ Project memory reloaded (CLAUDE.md / AGENTS.md)`);
      }
    } catch { /* ignore */ }
    return { handled: true, message: lines.join("\n") };
  } catch (err) {
    return { handled: true, message: `[ERROR] Could not change directory: ${(err as Error).message}` };
  }
}

// Sprint 10: /organize — classifica e move arquivos do inbox/ do modo ativo
function handleOrganizeCommand(): CommandResult {
  const mode = getActiveMode();
  const modeName = mode?.name ?? null;

  if (!modeName) {
    return {
      handled: true,
      message: "Nenhum modo ativo. Ative um modo primeiro com /mode <nome>.",
    };
  }

  const result = organizeInbox(modeName);
  return { handled: true, message: formatOrganizeResult(result) };
}

// Sprint 11: /configurar [tool-name] — abre mini chat do configurador
function handleConfigurarCommand(arg: string | null): CommandResult {
  // The actual UI is opened via state — this just triggers it.
  // arg is a tool name — normalize to lowercase (tool names are lowercase by convention).
  const toolName = arg?.toLowerCase() ?? null;
  return {
    handled: true,
    message: toolName
      ? `Abrindo configurador for "${toolName}"...`
      : "Opening configurator... (use /configurar <tool-name> to configure a specific tool)",
    openConfigurator: true,
    configuratorTool: toolName,
  };
}

function handleToolsCommand(arg: string | null): CommandResult {
  const registry = getExternalToolRegistry();

  // Category is conventionally lowercase.
  const category = arg?.toLowerCase() ?? null;
  const tools = category ? registry.getByCategory(category as any) : registry.getAll();
  
  if (tools.length === 0) {
    return { handled: true, message: category ? `No tools in category "${category}".` : "No tools available." };
  }
  
  const installed = tools.filter((t: any) => registry.isInstalled(t.name));
  const notInstalled = tools.filter((t: any) => !registry.isInstalled(t.name));
  
  const lines: string[] = [
    `G Tools: ${tools.length} total (${installed.length} OK / ${notInstalled.length} X)`,
    ""
  ];
  
  if (installed.length > 0) {
    lines.push("OK Installeds:");
    installed.forEach((t: any) => {
      lines.push(`  * ${t.name} (${t.category}) - ${t.description.slice(0, 50)}`);
    });
    lines.push("");
  }
  
  if (notInstalled.length > 0) {
    lines.push("X Not installed:");
    notInstalled.forEach((t: any) => {
      lines.push(`  * ${t.name} (${t.category}) - ${t.description.slice(0, 50)}`);
    });
  }
  
  return { handled: true, message: lines.join("\n") };
}

function handleToolInfoCommand(arg: string | null): CommandResult {
  if (!arg) {
    return { handled: true, message: "Uso: /toolinfo <nome_da_tool>" };
  }

  // Tool names are conventionally lowercase.
  const name = arg.toLowerCase();
  const registry = getExternalToolRegistry();
  const tool = registry.get(name);
  
  if (!tool) {
    return { handled: true, message: `Tool "${arg}" not found.` };
  }
  
  const installed = registry.isInstalled(tool.name);
  
  const lines: string[] = [
    `[T] ${tool.name}`,
    `   Description: ${tool.description}`,
    `   Categoria: ${tool.category}`,
    `   Comando: ${tool.command} ${tool.args.join(" ")}`,
    `   Status: ${installed ? "OK Installed" : "X Not installed"}`,
    "",
    "   Quando usar:"
  ];
  
  tool.context.whenToUse.forEach((pattern: string) => {
    lines.push(`     * ${pattern}`);
  });
  
  if (tool.context.examples.length > 0) {
    lines.push("", "   Exemplos:");
    tool.context.examples.forEach((example: string) => {
      lines.push(`     $ ${example}`);
    });
  }
  
  if (tool.flags.length > 0) {
    lines.push("", "   Flags:");
    tool.flags.forEach((flag: any) => {
      const required = flag.required ? " (required)" : "";
      const defaultVal = flag.default ? ` (default: ${flag.default})` : "";
      lines.push(`     --${flag.name.slice(2)} <${flag.type}>${required}${defaultVal}`);
    });
  }
  
  return { handled: true, message: lines.join("\n") };
}

const COMMAND_HANDLERS: Record<string, (arg: string | null) => CommandResult> = {
  "/exit": () => handleExitCommand(),
  "/quit": () => handleExitCommand(),
  "/q": () => handleExitCommand(),
  "/help": () => handleHelpCommand(),
  "/?": () => handleHelpCommand(),
  "/hub": () => handleHubCommand(),
  "/mode": (arg) => handleModeCommand(arg),
  "/reset": () => handleResetCommand(),
  "/history": () => handleHistoryCommand(),
  "/skills": () => handleSkillsCommand(),
  "/plugins": () => handlePluginsCommand(),
  "/mcp": (arg) => handleMcpCommand(arg),
  "/tools": (arg) => handleToolsCommand(arg),
  "/toolinfo": (arg) => handleToolInfoCommand(arg),
  "/effort": (arg) => handleEffortCommand(arg),
  "/pool": () => handlePoolCommand(),
  "/caveman": (arg) => handleCavemanCommand(arg),
  "/memory": () => handleMemoryCommand(),
  "/todos": () => handleTodosCommand(),
  "/plan": () => handlePlanCommand(),
  "/compact": (arg) => handleCompactCommand(arg),
  "/dream": () => handleDreamCommand(),
  "/distill": () => handleDistillCommand(),
  // Sprint 9: buscar arquivo na máquina
  "/buscar": (arg) => handleBuscarCommand(arg),
  // /cd — change working directory (similar to Claude Code's project picker)
  "/cd": (arg) => handleCdCommand(arg),
  "/session": (arg) => handleSessionCommand(arg),
  // Sprint 10: organizar inbox do modo ativo
  "/organize": () => handleOrganizeCommand(),
  // Sprint 11: configurar tools via mini chat
  "/configurar": (arg) => handleConfigurarCommand(arg),
  // i18n: trocar idioma em runtime
  "/lang": (arg) => handleLangCommand(arg),
  // Searx local search status/install
  "/searx": (arg) => handleSearxCommand(arg),
  // /small — run a small task with a smaller model (llama-3.1-8b default)
  "/small": (arg) => handleSmallCommand(arg),
};

function handleLangCommand(arg: string | null): CommandResult {
  if (!arg) {
    const current = detectLanguage();
    return { handled: true, message: `Idioma atual: ${current}\nUse: /lang pt-BR | en` };
  }
  // Accept case-insensitively (e.g. "pt-BR", "pt-br", "PT-BR" all map to "pt-BR").
  // Previously the global lowercasing in handleSlashCommand turned "pt-BR" into
  // "pt-br", which then failed the strict `valid.includes(arg)` check.
  const normalized = arg.toLowerCase() === "pt-br" ? "pt-BR" : arg.toLowerCase();
  const valid = ["pt-BR", "en"];
  if (!valid.includes(normalized)) {
    return { handled: true, message: `Invalid language: ${arg}\nOptions: pt-BR, en` };
  }
  setLanguage(normalized as any);
  resetLanguageCache();
  return { handled: true, message: `Idioma alterado para: ${normalized}` };
}

function handleSearxCommand(_arg: string | null): CommandResult {
  // /searx shows status only. Installation and startup are automatic:
  //   - Install: `npm install` runs postinstall → setup-searx.py --yes
  //   - Start:   CLI startup calls autoStartSearx() in index.ts
  //   - Stop:    CLI shutdown calls autoStopSearx() in cleanup
  // The /searx command exists only for the user to CHECK if it's working
  // (useful when search results are bad — confirms whether Searx or Bing
  // is being used as the backend).
  let status: { installed: boolean; running: boolean; method: "docker" | "python" | null; weStarted: boolean; pid: number | null; url: string; dir: string; dockerAvailable: boolean };
  try {
    status = getSearxStatus();
  } catch (err) {
    return {
      handled: true,
      message: `Searx: erro ao verificar status (${(err as Error).message}).\n` +
        `O Searx é opcional — a busca funciona via Bing como fallback.`,
    };
  }

  const lines = [
    "Searx Local Search (busca via Google + Bing + DDG):",
    `  Installed : ${status.installed ? "YES" : "NO"}`,
    `  Running   : ${status.running ? "YES" : "NO"}`,
    `  Method    : ${status.method ?? "N/A"}`,
    `  Docker    : ${status.dockerAvailable ? "available" : "not available"}`,
    `  URL       : ${status.url}`,
  ];

  if (!status.installed) {
    lines.push(
      "",
      "Para instalar (busca estável sem lixo):",
    );
    if (status.dockerAvailable) {
      lines.push(
        "  Docker (recomendado):",
        "    powershell scripts/setup-searx-docker.ps1   (Windows)",
        "    bash scripts/setup-searx-docker.sh           (Linux/macOS)",
      );
    } else {
      lines.push(
        "  Windows: instale Docker Desktop primeiro:",
        "    https://www.docker.com/products/docker-desktop",
        "  Depois: powershell scripts/setup-searx-docker.ps1",
        "",
        "  Linux/macOS (sem Docker):",
        "    python3 scripts/setup-searx.py",
      );
    }
    lines.push(
      "",
      "Apos instalar, reinicie a CLI. O Searx inicia automaticamente.",
    );
  } else if (!status.running) {
    lines.push(
      "",
      "Searx esta instalado mas nao esta rodando.",
      "Reinicie a CLI - o Searx inicia automaticamente no startup.",
      "Ou inicie manualmente:",
      status.method === "docker"
        ? "  docker start claude-killer-searxng"
        : "  python3 scripts/setup-searx.py --start",
    );
  } else {
    lines.push(
      "",
      "Searx ativo! As buscas estao usando Google + Bing + DDG.",
      `Metodo: ${status.method}`,
    );
  }

  return { handled: true, message: lines.join("\n") };
}

function handleEffortCommand(arg: string | null): CommandResult {
  if (!arg) {
    return { handled: true, message: `Effort atual: ${getEffortLabel()}\nUse: /effort low|medium|high|max` };
  }
  // Levels are lowercase by convention.
  const level = arg.toLowerCase();
  const valid = ["low", "medium", "high", "max"];
  if (!valid.includes(level)) {
    return { handled: true, message: `Invalid level: ${arg}\nOptions: low, medium, high, max` };
  }
  setEffortLevel(level as any);
  // Persist the new effort level to the active session's header so it's
  // restored when the session is loaded later (auto-load on startup OR
  // /session load). Without this, the effort level resets to default
  // (medium or env-var) every time the user restarts the app — even if
  // they were using /effort max in the previous session.
  // No-op if no session is active yet (lazy init will capture the current
  // level when startSession() runs on the first message).
  updateSessionEffortLevel(level as any);
  // Note: setEffortLevel() already updates the system prompt (history[0])
  // immediately via getSystemPrompt(), so the IA DOES get the new effort
  // on the next request. The visual label update is handled by
  // handleSlashCommandFlow which calls setEffortLabel after this returns.
  return { handled: true, message: `Effort alterado para: ${getEffortLabel()}` };
}

/**
 * /small <task> — runs a small task with a smaller model (default: llama-3.1-8b).
 * The task executes with a limited tool set (executar_comando, ler_arquivo,
 * buscar_arquivos, buscar_texto) and produces a concise summary. The summary
 * is shown in the chat AND injected into the main AI's context on the next
 * prompt.
 *
 * This is a "marker" command — it returns handled=false so the caller
 * (handleSlashCommandFlow) can run it asynchronously (since runSmallTask
 * is async and handleSlashCommand is sync). The actual execution happens
 * in handleSlashCommandFlow via a special case for "/small".
 */
function handleSmallCommand(arg: string | null): CommandResult {
  if (!arg || arg.trim() === "") {
    return {
      handled: true,
      message: "Uso: /small <tarefa>\n" +
        "Exemplo: /small lista os arquivos .ts e conta quantos são\n" +
        "Exemplo: /small roda git status e me diz o estado do repo\n" +
        "\nO small task usa um modelo menor (default: llama-3.1-8b) para " +
        "tarefas rápidas. O resumo é injetado no contexto da IA principal.",
    };
  }
  // Marker — handleSlashCommandFlow will detect this and run async
  return { handled: false, message: undefined };
}

function handleModeCommand(arg: string | null): CommandResult {
  const allModes = getAllModes();
  const activeName = getActiveModeName();

  // No arg: list all modes
  if (!arg) {
    if (allModes.length === 0) {
      return { handled: true, message: "No modes available. Use: /mode create <description>" };
    }
    const lines = allModes.map((m) => {
      const active = m.name === activeName ? " [ATIVO]" : "";
      const kind = m.builtIn ? "(built-in)" : "(user)";
      return `  ${m.name.padEnd(20)} ${kind.padEnd(12)} ${m.label}${active}`;
    });
    return {
      handled: true,
      message: `Available modes:\n${lines.join("\n")}\n\n` +
               `Ativo: ${activeName ?? "(nenhum)"}\n\n` +
               `Use: /mode <name> to activate | /mode off to deactivate | /mode create <description> to create new`,
    };
  }

  // /mode off - deactivate
  if (arg === "off" || arg === "none") {
    deactivateMode();
    return { handled: true, message: "Mode deactivated. No automatic validation active." };
  }

  // /mode create <description> - AI-assisted mode creation
  // Accept "/mode create" (bare, no description) → show "Empty description"
  // instead of falling through to "/mode <name>" which would show the
  // misleading "Mode 'create' not found" message.
  if (arg === "create" || arg === "new" || arg.startsWith("create ") || arg.startsWith("new ")) {
    const prompt = arg.replace(/^(create|new)(\s+)?/, "").trim();
    if (!prompt) {
      return { handled: true, message: "Empty description. Use: /mode create <what you want to do>" };
    }

    const all = getAllExtensions();
    const suggestion = suggestMode({
      prompt,
      availableTools: all.filter((e) => e.category === "tool").map((e) => e.id),
      availableSkills: all.filter((e) => e.category === "skill").map((e) => e.id),
      availableFeatures: all.filter((e) => e.category === "feature").map((e) => e.id),
    });

    return {
      handled: true,
      message:
        `Modo sugerido: ${suggestion.label} (${suggestion.name})\n\n` +
        `Reason: ${suggestion.reasoning}\n\n` +
        `Ferramentas a ativar (${suggestion.enableTools.length}):\n` +
        suggestion.enableTools.map((t) => `  - ${t}`).join("\n") + "\n\n" +
        `Skills a ativar (${suggestion.enableSkills.length}):\n` +
        (suggestion.enableSkills.length > 0
          ? suggestion.enableSkills.map((s) => `  - ${s}`).join("\n")
          : "  (nenhuma)") + "\n\n" +
        `Features a ativar (${suggestion.enableFeatures.length}):\n` +
        suggestion.enableFeatures.map((f) => `  - ${f}`).join("\n") + "\n\n" +
        `Settings:\n` +
        `  effort: ${suggestion.effortLevel}\n` +
        `  strictMode: ${suggestion.strictMode}\n` +
        `  readBeforeWrite: ${suggestion.readBeforeWrite}\n` +
        `  advancedThinking: ${suggestion.advancedThinking}\n` +
        (suggestion.luauValidation && suggestion.luauValidation.length > 0
          ? `  luauValidation: ${suggestion.luauValidation.length} regra(s)\n`
          : "") +
        `\nPara confirmar e ativar: /mode confirm ${suggestion.name}\n` +
        `Para cancelar: ignore esta mensagem`,
    };
  }

  // /mode confirm <name> - save and activate the suggested mode
  if (arg.startsWith("confirm ")) {
    const name = arg.replace(/^confirm\s+/, "").trim();
    const suggestion = suggestMode({
      prompt: name,
      availableTools: [],
      availableSkills: [],
      availableFeatures: [],
    });
    suggestion.name = name;
    const mode = confirmAndSaveMode(suggestion);
    return {
      handled: true,
      message: `Modo "${mode.name}" salvo em ~/.claude-killer/modes/${mode.name}.json\n\nPara ativar: /mode ${mode.name}`,
    };
  }

  // Parse: /mode <name> [new|keep]
  //   new  = ativa modo + limpa chat (contexto fresh)
  //   keep = ativa modo + mantém chat atual (default)
  // arg is the FULL string after `/mode ` (case preserved by handleSlashCommand).
  // modeName is conventionally lowercase; lowercase it for the getMode lookup so
  // users can type `/mode ROBLOX new` and still hit the "roblox" mode.
  const parts = arg.split(/\s+/).filter(Boolean);
  const modeName = (parts[0] ?? "").toLowerCase();
  const contextAction = parts[1]?.toLowerCase();  // "new" | "keep" | undefined

  if (!modeName) {
    return { handled: true, message: "Usage: /mode <name> [new|keep]" };
  }

  const mode = getMode(modeName);
  if (!mode) {
    return { handled: true, message: `Mode "${modeName}" not found. Use: /mode (no args) to list.` };
  }

  // If no context action specified, ask the user which they want
  if (!contextAction || (contextAction !== "new" && contextAction !== "keep")) {
    return {
      handled: true,
      message:
        `Ativando modo "${modeName}" (${mode.label})...\n\n` +
        `Choose an option:\n` +
        `  /mode ${modeName} new   -> Ativa modo + inicia chat novo (contexto limpo)\n` +
        `  /mode ${modeName} keep  -> Activate mode + keep current chat (same context)\n\n` +
        `Tools: ${((mode as any).enableTools ?? (mode as any).tools ?? []).length} | Skills: ${((mode as any).enableSkills ?? (mode as any).skills ?? []).length} | Features: ${mode.enableFeatures.length}\n` +
        `Effort: ${mode.effortLevel ?? "default"} | Strict: ${mode.strictMode ?? false} | ` +
        `Validation: ${(mode.luauValidation?.length ?? 0) + (mode.validation?.length ?? 0)} regra(s)`,
    };
  }

  // Activate the mode
  applyMode(modeName).then((result) => {
    if (!result.success) {
      // Log to stderr only (less disruptive than stdout in TUI mode)
      console.error(`[modes] Erro ao ativar: ${result.errors.join(", ")}`);
    }
    // Success is silent — the CommandResult message already tells the user
    // the mode was activated. No console.log needed.
  }).catch((err) => {
    console.error(`[modes] Falha: ${err.message}`);
  });

  // Handle context action
  if (contextAction === "new") {
    // Clear chat history (same as /reset)
    history.resetHistory();
    // BUG FIX (BS-18): clear readBeforeWrite state on context reset too.
    clearReadPaths();
    clearSessionFiles();
    clearInvokedSkills();
    // State-leak cleanup: clear all module-level state, same as /reset.
    void clearAllModuleState();
    return {
      handled: true,
      resetChat: true,
      message:
        `[OK] Modo "${modeName}" (${mode.label}) ativado!\n` +
        `[*] Chat reiniciado - contexto limpo.\n\n` +
        `Tools: ${((mode as any).enableTools ?? (mode as any).tools ?? []).length} | Skills: ${((mode as any).enableSkills ?? (mode as any).skills ?? []).length} | Features: ${mode.enableFeatures.length}\n` +
        `Effort: ${mode.effortLevel ?? "default"} | Strict: ${mode.strictMode ?? false}\n\n` +
        `Ready to start. What do you want to do?`,
    };
  }

  // contextAction === "keep"
  return {
    handled: true,
    message:
      `[OK] Modo "${modeName}" (${mode.label}) ativado!\n` +
      `[*] Chat mantido - contexto atual preservado.\n\n` +
      `Tools: ${((mode as any).enableTools ?? (mode as any).tools ?? []).length} | Skills: ${((mode as any).enableSkills ?? (mode as any).skills ?? []).length} | Features: ${mode.enableFeatures.length}\n` +
      `Effort: ${mode.effortLevel ?? "default"} | Strict: ${mode.strictMode ?? false}\n\n` +
      `As ferramentas do modo foram adicionadas. Continue conversando.`,
  };
}

function handlePoolCommand(): CommandResult {
  const size = getPoolSize();
  if (size === 0) {
    return { handled: true, message: "Pool: modo single-key (configure NVIDIA_API_KEYS for multi-key)" };
  }
  return { handled: true, message: formatPoolStats() };
}

function handleSlashCommand(input: string): CommandResult {
  // NOTE: pass the FULL argument string (everything after the command token)
  // to the handler — not just the first whitespace-separated token. Several
  // commands take multi-word args (e.g. `/mode roblox new`, `/mode create
  // <description with spaces>`, `/compact focus on code changes`, `/buscar
  // FileName.txt`). Case is preserved here; each handler lowercases its arg
  // if/when it needs to.
  const trimmed = input.trim();
  const firstSpace = trimmed.search(/\s/);
  const cmd = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const arg = firstSpace === -1 ? null : trimmed.slice(firstSpace + 1).trim() || null;

  const handler = COMMAND_HANDLERS[cmd];
  if (handler) return handler(arg);
  return { handled: false };
}

// --- @-mention expansion ----------------------------------------------------

const MAX_AT_FILE_BYTES = 200 * 1024;

function expandAtMentions(input: string): string {
  const re = /@((?:\.{0,2}\/)?(?:[\w.\-/\\]+(?::\d{1,5}(?:-\d{1,5})?)?))/g;
  return input.replaceAll(re, (match, raw) => {
    const rangeMatch = raw.match(/^(.+):(\d+)(?:-(\d+))?$/);
    const actualPath = rangeMatch ? rangeMatch[1]! : raw;
    const startLine = rangeMatch ? Number.parseInt(rangeMatch[2], 10) : null;
    const endLine = rangeMatch?.[3] ? Number.parseInt(rangeMatch[3], 10) : null;

    const abs = path.isAbsolute(actualPath) ? actualPath : path.resolve(process.cwd(), actualPath);

    if (!fs.existsSync(abs)) return match;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return match;
    if (stat.size > MAX_AT_FILE_BYTES) return match;

    let content = fs.readFileSync(abs, "utf8");
    const totalLines = content.split("\n").length;
    if (startLine !== null) {
      const lines = content.split("\n");
      const s = Math.max(1, startLine);
      const e = Math.min(totalLines, endLine ?? s);
      content = lines.slice(s - 1, e).join("\n");
    }
    return `\n\`\`\`@${actualPath}\n${content}\n\`\`\`\n`;
  });
}

// --- InputBox Component (memoized to prevent re-render during streaming) ----
//
// BUG FIX (input-travado): During streaming, the App re-renders 12x/second
// (setMessages throttle) + 5x/second (ThinkingIndicator setSnapshot/setDots).
// Each App re-render re-renders the TextInput, which can reset the terminal
// cursor position — making the input appear "locked" while the AI is working.
// The user types but nothing appears (or appears with a big delay).
//
// Fix: extract the TextInput (and its prompt ">") into a separate component
// memoized with React.memo. This component ONLY re-renders when its props
// change (input value, placeholder, overlay state) — NOT when messages,
// status, todos, or any other App state changes. The TextInput's internal
// cursor position is preserved across App re-renders.
//
// The handleChange and handleSubmit callbacks are already useCallback'd in
// App, so they're stable references — React.memo's shallow comparison works
// correctly.

interface InputBoxProps {
  value: string;
  onChange: (val: string) => void;
  onSubmit: (val: string) => void;
  placeholder: string;
  overlayOpen: boolean;
}

const InputBox = React.memo(function InputBox({
  value,
  onChange,
  onSubmit,
  placeholder,
  overlayOpen,
}: Readonly<InputBoxProps>) {
  if (overlayOpen) {
    return <Text color={colors.muted}>[ Overlay aberto - pressione Esc para fechar ]</Text>;
  }
  return (
    <>
      <Text color={colors.primary} bold>{"> "}</Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder={placeholder}
      />
    </>
  );
});

// --- Autocomplete Component -------------------------------------------------

const AUTOCOMPLETE_PAGE_SIZE = 8;  // max items visible at once

interface AutocompleteProps {
  query: string;
  selectedIndex: number;
  onSelect: (cmd: string) => void;
}

function Autocomplete({ query, selectedIndex, onSelect }: Readonly<AutocompleteProps>) {
  // Determine if we're in "command" mode (typing /xxx) or "subcommand" mode (/xxx + space + yyy)
  // Use query (not trimmed) for space detection - trailing space matters
  const trimmed = query.trim();
  const hasSpace = query.includes(" ");

  // Get matches: either commands or subcommands of the selected command
  const matches = useMemo(() => {
    if (!trimmed.startsWith("/")) return [];

    if (!hasSpace) {
      // Command mode: show all commands matching the prefix
      const lower = trimmed.toLowerCase();
      return getSlashCommands()
        .filter((s) => s.cmd.startsWith(lower))
        .map((s) => ({ label: s.cmd, desc: s.desc, isSubcommand: false }));
    }

    // Subcommand mode: parse "/cmd subprefix" from original query (preserves trailing space)
    const spaceIdx = query.indexOf(" ");
    const cmdPart = query.slice(0, spaceIdx).toLowerCase();
    const subPart = query.slice(spaceIdx + 1).trim().toLowerCase();

    const cmd = getSlashCommands().find((s) => s.cmd === cmdPart);
    if (!cmd || !cmd.subcommands || cmd.subcommands.length === 0) return [];

    return cmd.subcommands
      .filter((sub) => sub.startsWith(subPart))
      .map((sub) => ({ label: sub, desc: "", isSubcommand: true }));
  }, [query, trimmed, hasSpace]);

  if (matches.length === 0) return null;

  // Pagination: show only AUTOCOMPLETE_PAGE_SIZE items, with the selected one in view
  const total = matches.length;
  let startIdx = 0;
  if (total > AUTOCOMPLETE_PAGE_SIZE) {
    // Keep selected item visible - center it if possible
    const halfPage = Math.floor(AUTOCOMPLETE_PAGE_SIZE / 2);
    if (selectedIndex < halfPage) {
      startIdx = 0;
    } else if (selectedIndex > total - halfPage - 1) {
      startIdx = total - AUTOCOMPLETE_PAGE_SIZE;
    } else {
      startIdx = selectedIndex - halfPage;
    }
  }
  const endIdx = Math.min(startIdx + AUTOCOMPLETE_PAGE_SIZE, total);
  const visibleMatches = matches.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.muted} paddingLeft={1} paddingRight={1}>
      {visibleMatches.map((m, i) => {
        const actualIdx = startIdx + i;
        const isSelected = actualIdx === selectedIndex;
        return (
          <Box key={`${m.label}-${actualIdx}`}>
            <Text color={isSelected ? colors.primary : colors.muted} bold={isSelected}>
              {isSelected ? "> " : "  "}
            </Text>
            <Text color={isSelected ? colors.primary : colors.white} bold={isSelected}>
              {m.isSubcommand ? "  " + m.label : m.label.padEnd(14)}
            </Text>
            {!m.isSubcommand && (
              <Text color={colors.muted}> {m.desc}</Text>
            )}
          </Box>
        );
      })}
      {total > AUTOCOMPLETE_PAGE_SIZE && (
        <Text color={colors.muted} dimColor>
          {" "}(mostrando {startIdx + 1}-{endIdx} de {total} - use ↑↓ for navegar)
        </Text>
      )}
    </Box>
  );
}

// --- Session → Visual message conversion -----------------------------------

/**
 * Convert raw session messages (from JSONL file) to ChatMessage[] for
 * visual display in the terminal.
 *
 * Session file stores messages in API format:
 *   - user:      { role: "user", content: "..." }
 *   - assistant: { role: "assistant", content: "...", tool_calls: [...] }
 *   - tool:      { role: "tool", tool_call_id: "...", content: "..." }
 *
 * Visual display needs a flat list of ChatMessage objects, where tool calls
 * and tool results are SEPARATE entries (so the user sees them individually
 * in the terminal). This function "explodes" assistant messages that contain
 * tool_calls into: [assistant text message] + [tool call message] entries.
 *
 * BUG FIX (thinking-vazando): Tool results in the session file only store
 * tool_call_id (not toolName). Previously this function used the literal
 * string "tool" as toolName for ALL tool results — which meant the
 * ChatDisplay filter that hides `pensar` tool results (`msg.toolName === "pensar"`)
 * never matched during session reload, causing thinking content to leak
 * into the visible chat.
 *
 * Fix: build a tool_call_id → toolName lookup from all assistant messages'
 * tool_calls arrays, then resolve the real toolName for each tool result.
 * This ensures the "pensar" filter works on session reload just like it
 * does during the live session.
 */
/** @internal — exported for testing the session-reload thinking-leak fix. */
export function convertSessionToVisualMessages(sessionMsgs: unknown[]): ChatMessage[] {
  // Build a tool_call_id → toolName lookup from all assistant tool_calls.
  // This lets us resolve the real tool name for tool result messages,
  // which only store tool_call_id (not the name) in the session file.
  const toolNameById = new Map<string, string>();
  for (const raw of sessionMsgs) {
    const m = raw as Record<string, unknown>;
    if (m.role === "assistant") {
      const tcs = m.tool_calls as Array<{ id?: string; function?: { name?: string } }> | undefined;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          if (tc.id && tc.function?.name) {
            toolNameById.set(tc.id, tc.function.name);
          }
        }
      }
    }
  }

  const visual: ChatMessage[] = [];
  for (const raw of sessionMsgs) {
    const m = raw as Record<string, unknown>;
    if (m.role === "user") {
      // BUG FIX (content-array): content can be a string OR an array of
      // content parts ([{type:"text", text:"..."}]) per the OpenAI spec.
      // Previously only string was handled — array content was silently
      // dropped, making the visual history empty.
      const content = m.content;
      let textContent = "";
      if (typeof content === "string") {
        textContent = content;
      } else if (Array.isArray(content)) {
        // Extract text from content parts array
        for (const part of content) {
          if (typeof part === "object" && part !== null && "text" in part) {
            textContent += String((part as Record<string, unknown>).text);
          }
        }
      }
      visual.push({ role: "user", content: textContent });
    } else if (m.role === "assistant") {
      // Add text content if present (some assistant messages are ONLY
      // tool_calls with no text, or have content as null for reasoning models)
      const content = m.content;
      let hasTextContent = false;
      if (typeof content === "string" && content.length > 0) {
        visual.push({ role: "assistant", content });
        hasTextContent = true;
      } else if (Array.isArray(content)) {
        // Content parts array — extract text
        let textContent = "";
        for (const part of content) {
          if (typeof part === "object" && part !== null && "text" in part) {
            textContent += String((part as Record<string, unknown>).text);
          }
        }
        if (textContent.length > 0) {
          visual.push({ role: "assistant", content: textContent });
          hasTextContent = true;
        }
      }
      // BUG FIX (content-null-hidden): For reasoning models (GLM 5.2, DeepSeek),
      // content is null when the model only produced reasoning_content + tool_calls.
      // Previously, no assistant bubble was shown — the historical turn disappeared
      // from the chat. Now we add a placeholder so the user sees the assistant
      // was active, even if there's no visible text.
      const toolCalls = m.tool_calls as Array<{
        id?: string;
        type?: string;
        function: { name: string; arguments: string };
      }> | undefined;
      if (!hasTextContent && Array.isArray(toolCalls) && toolCalls.length > 0) {
        // Assistant only made tool calls (no text) — add a placeholder
        const toolNames = toolCalls.map(tc => tc.function?.name ?? "tool").join(", ");
        visual.push({ role: "assistant", content: `*[usando ferramentas: ${toolNames}]*` });
      }
      // Explode tool_calls into individual visual tool call messages
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          visual.push({
            role: "tool",
            content: tc.function?.arguments ?? "{}",
            toolName: tc.function?.name ?? "tool",
            isResult: false,
          });
        }
      }
    } else if (m.role === "tool") {
      // Tool result — resolve the real toolName from the lookup map
      // (built from preceding assistant tool_calls). Falls back to "tool"
      // only if the tool_call_id can't be found (shouldn't happen normally).
      const tcId = m.tool_call_id as string | undefined;
      const resolvedName = (tcId && toolNameById.get(tcId)) ?? "tool";
      visual.push({
        role: "tool",
        content: String(m.content ?? ""),
        toolName: resolvedName,
        isResult: true,
        ok: true,
      });
    }
    // system messages are skipped (not shown in chat display)
  }
  return visual;
}

// --- Plan step extraction (Gap 3) -----------------------------------------

/**
 * Extract numbered steps from a plan response.
 *
 * When plan mode is active, the IA outputs a markdown plan like:
 *   1. Read the file
 *   2. Edit the function
 *   3. Run tests
 *   ===END PLAN===
 *
 * This function extracts the step descriptions (without the number prefix)
 * so they can be passed to planExecutor.createPlan(steps).
 *
 * Supports: `1.`, `1)`, `1:`, `-`, `*` prefixes. Takes text before
 * ===END PLAN=== and extracts all list items.
 */
export function extractPlanSteps(response: string): string[] {
  // Get text before ===END PLAN===
  const endIdx = response.indexOf("===END PLAN===");
  const planText = endIdx >= 0 ? response.slice(0, endIdx) : response;

  const steps: string[] = [];
  const lines = planText.split("\n");
  // Match: "1. step", "1) step", "1: step", "- step", "* step"
  const stepRegex = /^\s*(?:\d+[.):]\s+|[-*]\s+)(.+)$/;

  for (const line of lines) {
    const match = line.match(stepRegex);
    if (match && match[1] && match[1].trim().length > 0) {
      steps.push(match[1].trim());
    }
  }
  return steps;
}

// --- App Component ----------------------------------------------------------

export function App() {
  const { exit } = useApp();

  // -- Auto-load last session on startup (like Claude Code) ------------------
  // Checks for the most recent session file for the current project directory.
  // If found, loads it. If not, DON'T create a session yet — session is
  // auto-created on first message (lazy init in appendMessage).
  //
  // BUG FIX (double-write + contexto-expandido):
  //   1. Previously, loading called addUserMessage/addRawAssistantMessage/
  //      addToolResult, which internally called tryAppendToSession. Since
  //      activeSessionPath wasn't set yet, appendMessage auto-created a NEW
  //      session file and wrote all loaded messages to it — DUPLICATING the
  //      entire conversation on disk every time the app started.
  //   2. Previously, ALL messages from the JSONL were loaded into the IA's
  //      context — including messages that had been compacted away in memory.
  //      This could exceed the context window on load.
  //
  //   Fix:
  //   - Call setActiveSession() FIRST, so appendMessage doesn't auto-create.
  //   - Use loadHistoryDirect() (bypasses tryAppendToSession entirely).
  //   - If a compaction snapshot exists, load the SNAPSHOT into IA context
  //     (exact compacted state — guaranteed to fit). Load ALL messages into
  //     the visual `messages` state for display.
  //   - If no snapshot (no compaction happened), load all messages into IA
  //     context directly (they fit — they were the IA's context at shutdown).
  // Ref to hold loaded visual messages — populated during session load
  // (in the useState initializer below) and consumed by useEffect to
  // populate the `messages` state after the first render.
  const loadedVisualMessagesRef = useRef<ChatMessage[]>([]);
  // BUG FIX (folderbrowser-over-session): track whether a session was
  // successfully loaded, even if convertSessionToVisualMessages returns
  // an empty array. This prevents the FolderBrowser from opening when
  // a session IS loaded but has no visual messages (ex: all system msgs).
  const loadedSessionIdRef = useRef<string | null>(null);
  // Flag to show FolderBrowser on startup if no session was loaded
  const needsFolderBrowserRef = useRef(false);
  // BUG FIX (FIX-TDZ): usage/tokens/cost captured during the useState
  // initializer below. The setters (setLastUsage, setSessionPromptTokens,
  // setSessionCompletionTokens, setSessionCost) and refs
  // (sessionPromptTokensRef, sessionCompletionTokensRef) are declared LATER
  // in this component, so calling them from the initializer throws a TDZ
  // ReferenceError — which the outer try/catch silently swallows, ALSO
  // skipping `loadedVisualMessagesRef.current = ...` (empty chat) and
  // `process.chdir(last.projectCwd)` (wrong dir). The values are stashed
  // here and applied in a useEffect after mount (when the const bindings
  // are live).
  const pendingUsageRestoreRef = useRef<SessionUsage | null>(null);

  useState(() => {
    try {
      const last = getLastSession();
      if (last) {
        // ── Load session BEFORE chdir (race-condition fix) ──────────────
        // `loadSessionMessages` and `setActiveSession` use `process.cwd()`
        // (via `getProjectSessionDir`) to locate the session file. The
        // session file lives in the hash of the cwd at the time
        // `startSession` was called — NOT necessarily in `last.projectCwd`.
        //
        // Scenario that breaks if we chdir FIRST:
        //   1. User runs claude-killer from /startup. Session is saved in
        //      hash(/startup).
        //   2. User runs `/cd /project`. `updateSessionProjectCwd` rewrites
        //      the header's projectCwd to /project, but the session FILE is
        //      still in hash(/startup).
        //   3. On next startup (cwd=/startup), `getLastSession` correctly
        //      finds the session in hash(/startup) and returns
        //      projectCwd=/project.
        //   4. If we `process.chdir(/project)` BEFORE `loadSessionMessages`,
        //      the lookup uses hash(/project) — and returns null because
        //      the file is in hash(/startup). The session is silently
        //      dropped and the FolderBrowser opens (wrong behavior).
        //
        // Fix: load messages + setActiveSession FIRST (uses original cwd),
        // THEN chdir to projectCwd so subsequent tools run in the right dir.
        // §17.3.10 (setActiveSession before loadHistoryDirect) is preserved.
        const loaded = loadSessionMessages(last.id);
        if (loaded && loaded.messages.length > 0) {
          // Set active session FIRST — prevents appendMessage from
          // auto-creating a new session file (double-write bug fix).
          // §17.3.10: must be before loadHistoryDirect.
          setActiveSession(last.id);
          // BUG FIX (folderbrowser-over-session): record that a session was
          // loaded so the FolderBrowser doesn't open even if visual messages
          // are empty (ex: all system messages after compaction).
          loadedSessionIdRef.current = last.id;
          // BUG FIX (BS-18): clear readBeforeWrite state on auto-load too.
          // §17.3.11: clearReadPaths on auto-load.
          clearReadPaths();
          clearSessionFiles();
          clearInvokedSkills();
          // State-leak cleanup: clear all module-level state on auto-load too.
          // The last session's bug-hunter findings, claim store, failure
          // memory, etc. must NOT bleed into the auto-loaded conversation's
          // first turn. Fire-and-forget — see clearAllModuleState docstring.
          void clearAllModuleState();

          // ── IA context: use snapshot if available, else full messages ──
          if (loaded.lastSnapshot && loaded.lastSnapshot.messages.length > 0) {
            // BUG FIX (BS-3): merge snapshot + postSnapshotMessages.
            // Previously: only loaded the snapshot, losing messages that
            // arrived AFTER compaction (including the user's last question).
            // Now: snapshot (compacted state) + postSnapshotMessages (recent).
            const merged = [
              ...loaded.lastSnapshot.messages,
              ...loaded.postSnapshotMessages,
            ];
            history.loadHistoryDirect(merged as any);
          } else {
            // No compaction happened — the full message list IS what the
            // IA had at shutdown. Load directly (no re-persisting).
            history.loadHistoryDirect(loaded.messages as any);
          }

          console.error(`[SESSION] Resumed: ${last.id} (${loaded.messages.length} messages${loaded.lastSnapshot ? `, snapshot from ${loaded.lastSnapshot.method} compaction` : ""})`);

          // ── Restore effort level from session header ──────────────
          // The session's effort level (low/medium/high/max) is stored in
          // the header so each session remembers its own effort. Without
          // this, loading a previous session would silently reset effort
          // to the default (medium) — the user's /effort max from the
          // previous session would be lost.
          // Only restore if the session has a valid effortLevel field;
          // old sessions (created before this feature) have null and we
          // keep the current level (env var / localStorage / default).
          if (loaded.effortLevel) {
            setEffortLevel(loaded.effortLevel);
            console.error(`[SESSION] Restored effort level: ${loaded.effortLevel}`);
          }

          // ── Restore usage/tokens/cost from session header ────────────
          // BUG FIX (usage-not-restored): the StatusBar showed 0 tokens / 0%
          // after loading a session until the next IA response arrived.
          // Now we restore lastUsage + cumulative session totals from the
          // session header so the context bar and cost display are accurate
          // immediately. Old sessions without usage field → null → keep 0.
          //
          // BUG FIX (FIX-TDZ): the four setters (setLastUsage,
          // setSessionPromptTokens, setSessionCompletionTokens, setSessionCost)
          // and the two refs (sessionPromptTokensRef, sessionCompletionTokensRef)
          // are all declared LATER in this component (after this useState
          // initializer). `const` bindings are in the Temporal Dead Zone until
          // their declaration executes, so calling any of them here throws
          // `ReferenceError: Cannot access '...' before initialization`. The
          // outer try/catch silently swallows the error — which ALSO skips
          // `loadedVisualMessagesRef.current = ...` (chat appears EMPTY) and
          // `process.chdir(last.projectCwd)` (wrong directory). Fix: stash
          // the usage here, apply setters + refs in a useEffect after mount.
          if (loaded.usage) {
            const u = loaded.usage;
            pendingUsageRestoreRef.current = u;
            console.error(`[SESSION] Restored usage: lastTotal=${u.lastTotalTokens}, sessionPrompt=${u.sessionPromptTokens}, cost=$${u.sessionCost.toFixed(4)}`);
          }

          // ── Visual messages: convert ALL messages for display ──────
          // The user sees the FULL conversation history (including messages
          // that were compacted away from the IA's context). This is
          // separate from the IA's context — visual is for the USER, IA
          // context is for the MODEL.
          loadedVisualMessagesRef.current = convertSessionToVisualMessages(loaded.messages);
        }
        // If session has 0 messages, don't load it and don't create new —
        // lazy init will handle it on first real message.

        // ── Restore project directory from session header ─────────────
        // The session remembers which directory the user was working in.
        // Restore it via process.chdir() so all tools/validators run in
        // the correct project, NOT in the claude-killer install directory.
        // MUST run AFTER loadSessionMessages + setActiveSession above,
        // otherwise the cwd change breaks the session-file lookup (the
        // file lives in the ORIGINAL cwd's hash dir, not projectCwd's).
        if (last.projectCwd) {
          try {
            process.chdir(last.projectCwd);
            console.error(`[SESSION] Restored project directory: ${last.projectCwd}`);
          } catch {
            console.error(`[SESSION] Could not restore project directory: ${last.projectCwd} — dir may not exist`);
          }
        }
      }
      // Don't call startSession() here — let appendMessage create it lazily
      // when the first real message is sent. This avoids empty session files.
    } catch {
      // Session load failure should not prevent app from starting
    }

    // ── If no session was loaded, show FolderBrowser so user can pick a project ──
    // The claude-killer is typically installed in its own directory, so
    // process.cwd() points to the install dir, NOT the user's project.
    // By showing FolderBrowser on startup, the user selects their project
    // directory, which is then saved in the session header (projectCwd)
    // and restored on next startup.
    //
    // BUG FIX (folderbrowser-over-session): previously, the check was only
    // `!loadedVisualMessagesRef.current.length`. If convertSessionToVisualMessages
    // returned an empty array (ex: all messages are system messages, or the
    // session had compaction snapshots but no regular user/assistant messages),
    // the FolderBrowser would open EVEN THOUGH the session was loaded
    // successfully. Now we also check if a session was actually loaded
    // (loadedSessionIdRef) — if a session WAS loaded, don't show FolderBrowser
    // regardless of whether visual messages were produced.
    if (!loadedVisualMessagesRef.current.length && !loadedSessionIdRef.current) {
      // Will be shown via state — see showFolderBrowser below
      // We can't call setShowFolderBrowser here (it's defined later in the
      // component), so we use a ref flag instead.
      needsFolderBrowserRef.current = true;
    }

    return true; // useState initializer must return something
  });

  // -- State --------------------------------------------------------------
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Populate visual messages from loaded session (after first render).
  // The session was loaded in the useState initializer above; the ref holds
  // the converted visual messages. This effect runs once on mount.
  useEffect(() => {
    // BUG FIX (history-not-loading): always call setMessages when a session
    // was loaded, even if convertSessionToVisualMessages returned empty.
    // Previously, the guard `length > 0` skipped setMessages when the visual
    // array was empty — leaving the chat blank even though the session loaded
    // successfully. Now we call setMessages whenever a session was loaded
    // (loadedSessionIdRef is set), regardless of visual array length.
    if (loadedSessionIdRef.current) {
      setMessages(loadedVisualMessagesRef.current);
    } else if (loadedVisualMessagesRef.current.length > 0) {
      // Fallback: visual messages without session ID (shouldn't happen, but
      // keeps backward compatibility)
      setMessages(loadedVisualMessagesRef.current);
    }
    // Show FolderBrowser on startup if no session was loaded
    if (needsFolderBrowserRef.current) {
      setShowFolderBrowser(true);
      needsFolderBrowserRef.current = false;
    }
  }, []);

  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AppStatus>("idle");
  const [todos, setTodos] = useState<TodoItem[]>([]);
  // Plan state — synced from planExecutor.getPlan() on each turn
  const [planSteps, setPlanSteps] = useState<Array<{ description: string; done: boolean }>>([]);
  const [lastUsage, setLastUsage] = useState<{
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null>(null);
  const [tokensPerSecond, setTokensPerSecond] = useState(0);

  // ── Sidequest: messages typed while IA is working ──────────────────────
  // Only the setter is used — the state value itself is never read because
  // the always-fresh `sidequestsRef` is read instead (avoids stale-closure
  // bugs in the memoized handleSubmit). The setter is still needed to trigger
  // re-renders that flush the ⚡ indicator.
  const [, setSidequests] = useState<string[]>([]);
  // Ref mirror of `sidequests`. The `handleSubmit` finally block reads this
  // ref instead of the state because `handleSubmit` is memoized via
  // useCallback WITHOUT `sidequests` in its deps array (intentionally —
  // adding it would recreate the callback when a sidequest arrives mid-flight,
  // but the in-flight invocation still holds the OLD closure, so the new
  // value would never be seen by the running finally block).
  //
  // BUG FIX (sidequest-stale-closure): previously the finally block read the
  // `sidequests` STATE directly. Since `sidequests` was captured at the time
  // `handleSubmit` was memoized (always `[]` at first render), the
  // `if (sidequests.length > 0)` check was ALWAYS false — the sidequest
  // injection NEVER fired. Sidequests were silently dropped (visible as ⚡ in
  // the chat but never sent to the agent). The ref is read fresh on every
  // access, so the finally block sees sidequests queued at any point.
  const sidequestsRef = useRef<string[]>([]);

  // ─── Streaming throttle (scroll-steal fix) ─────────────────────────────
  // BUG FIX (scroll-roubo): Without throttling, setMessages was called on
  // EVERY token from the API, causing Ink to re-render the entire chat
  // display 30-100 times per second. Each re-render writes a full frame to
  // stdout, and the terminal auto-scrolls to follow the cursor — making it
  // impossible for the user to scroll UP to read previous content while the
  // AI is streaming (the terminal kept yanking back to the bottom).
  //
  // Fix: throttle setMessages calls to at most once per STREAM_FLUSH_INTERVAL ms.
  // streamContent is a ref (mutated on every token), so we never lose data —
  // we just batch the React state updates. The final flush is guaranteed by
  // the trailing setTimeout scheduled when a token arrives within the throttle
  // window.
  const STREAM_FLUSH_INTERVAL = 80; // ms — ~12 updates/sec, smooth enough
  const lastStreamFlushRef = useRef(0);
  const streamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // streamContentRef mirrors the local streamContent variable but persists
  // across the setTimeout closure. We need it because the trailing flush
  // fires later, after the local streamContent may have been mutated again.
  const streamContentRef = useRef("");

  // Cumulative session totals — track across ALL turns, not just the last one.
  // BUG FIX (audit issue #4): StatusBar was showing last-turn cost/tokens but
  // the docstring claimed "session cost". Users saw $0.001 after 50 turns.
  // Now we accumulate prompt + completion tokens AND cost across the session.
  const [sessionPromptTokens, setSessionPromptTokens] = useState(0);
  const [sessionCompletionTokens, setSessionCompletionTokens] = useState(0);
  const [sessionCost, setSessionCost] = useState(0);
  // Refs mirroring the cumulative session totals. The onUsage callback reads
  // these (not the state) because state values are captured at callback
  // creation time (stale closure). The refs are always current.
  // Used by updateSessionUsage() to persist accurate cumulative totals.
  const sessionPromptTokensRef = useRef(0);
  const sessionCompletionTokensRef = useRef(0);
  // Keep refs in sync with state via effect
  useEffect(() => { sessionPromptTokensRef.current = sessionPromptTokens; }, [sessionPromptTokens]);
  useEffect(() => { sessionCompletionTokensRef.current = sessionCompletionTokens; }, [sessionCompletionTokens]);
  // BUG FIX (FIX-TDZ): apply the usage/tokens/cost that were captured during
  // the useState initializer (pendingUsageRestoreRef). The setters + refs
  // couldn't be called from the initializer because they're declared later in
  // the component (Temporal Dead Zone). This effect runs once after mount,
  // when all const bindings are live. The refs are set directly here (in
  // addition to the state setters above) so onUsage can read accurate values
  // if the user sends a message right away — without waiting for the
  // [sessionPromptTokens] / [sessionCompletionTokens] ref-sync effects to
  // commit after the state update propagates.
  useEffect(() => {
    const u = pendingUsageRestoreRef.current;
    if (u) {
      setLastUsage({
        prompt_tokens: u.lastPromptTokens,
        completion_tokens: u.lastCompletionTokens,
        total_tokens: u.lastTotalTokens,
      });
      setSessionPromptTokens(u.sessionPromptTokens);
      setSessionCompletionTokens(u.sessionCompletionTokens);
      setSessionCost(u.sessionCost);
      // Sync refs immediately so onUsage reads accurate values before the
      // next React commit flushes the [session*] ref-sync effects above.
      sessionPromptTokensRef.current = u.sessionPromptTokens;
      sessionCompletionTokensRef.current = u.sessionCompletionTokens;
      pendingUsageRestoreRef.current = null;
    }
  }, []);
  const [effortLabel, setEffortLabel] = useState(getEffortLabel());
  const [systemMessages, setSystemMessages] = useState<string[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [showHub, setShowHub] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);

  // ── Heartbeat + Prewarm event listeners ────────────────────────────────
  // Since commit 50898c8, log.* calls are suppressed in TUI mode (to prevent
  // scroll-stealing during streaming). Heartbeat and prewarm used log.info/
  // log.success/log.debug to show their results, so their messages disappeared.
  // We now register event listeners that push the results as systemMessages
  // (same mechanism used by /compact, /cd, etc.). This way the user sees the
  // messages WITHOUT re-introducing scroll-stealing (systemMessages are part
  // of the Ink render, not console.log).
  useEffect(() => {
    const handleHeartbeat = (event: HeartbeatEvent) => {
      switch (event.type) {
        case "first_success":
          setSystemMessages((prev) => [
            ...prev,
            `🔥 Heartbeat ativo — modelo aquecido em ${event.elapsed}ms (${event.modelState === "warm" ? "warm" : "cold"})`,
          ]);
          break;
        case "state_change":
          setSystemMessages((prev) => [
            ...prev,
            `🔥 Heartbeat: modelo ${event.from} → ${event.to} (${event.elapsed}ms)`,
          ]);
          break;
        case "failure":
          // Only show failures from the 3rd consecutive onward (first 2 are likely transient)
          if (event.consecutiveFailures >= 3) {
            setSystemMessages((prev) => [
              ...prev,
              `⚠️ Heartbeat falhou (${event.consecutiveFailures}x consecutivas): ${event.error.slice(0, 80)}`,
            ]);
          }
          break;
        case "auto_stopped":
          setSystemMessages((prev) => [
            ...prev,
            `❌ Heartbeat desativado após ${event.consecutiveFailures} falhas consecutivas`,
          ]);
          break;
      }
    };

    const handlePrewarm = (event: PrewarmEvent) => {
      switch (event.type) {
        case "complete":
          setSystemMessages((prev) => [
            ...prev,
            `🔥 Prewarm completo — ${event.ok} key(s) aquecida(s) em ${event.elapsed}ms`,
          ]);
          break;
        case "partial":
          setSystemMessages((prev) => [
            ...prev,
            `⚠️ Prewarm parcial — ${event.ok}/${event.total} key(s) aquecida(s) em ${event.elapsed}ms`,
          ]);
          break;
        case "all_failed":
          setSystemMessages((prev) => [
            ...prev,
            `❌ Prewarm falhou — ${event.total} key(s) não aqueceram em ${event.elapsed}ms (primeira requisição será lenta)`,
          ]);
          break;
      }
    };

    setHeartbeatListener(handleHeartbeat);
    setPrewarmListener(handlePrewarm);

    return () => {
      setHeartbeatListener(null);
      setPrewarmListener(null);
    };
  }, []);

  // Sprint 1: AskUser — estado de pergunta pendente
  // Quando a IA chama perguntar_usuario, essa state é setada e o QuestionPrompt
  // é renderizado. O agent loop pausa (await) até o usuário responder.
  const [pendingQuestion, setPendingQuestion] = useState<AskUserQuestion | null>(null);
  const questionResolverRef = useRef<((response: AskUserResponse) => void) | null>(null);

  // Sprint 11: Configurator chat state
  const [showConfigurator, setShowConfigurator] = useState(false);
  const [configuratorTool, setConfiguratorTool] = useState<string | null>(null);

  const isProcessing = useRef(false);

  // -- Autocomplete state -------------------------------------------------
  // Show autocomplete while typing /xxx OR after a space (for subcommands like /effort low|medium|high|max).
  // Hide only when input doesn't start with / or when there's a second space (subcommand already complete).
  // Note: use input (not trimmed) for hasSpace detection - trailing space matters!
  //   "/effort"    -> no space, command mode
  //   "/effort "   -> 1 space, subcommand mode (user just pressed space)
  //   "/effort low"-> 1 space, subcommand mode with partial input
  //   "/effort low extra" -> 2+ tokens, hide autocomplete
  const trimmed = input.trim();
  const hasSpace = input.includes(" ");
  const hasSecondSpace = hasSpace && trimmed.split(" ").filter(Boolean).length > 2;
  const showAutocomplete = input.startsWith("/") && input.length > 0 && !hasSecondSpace;

  const acMatches = useMemo(() => {
    if (!showAutocomplete) return [];
    if (!trimmed.startsWith("/")) return [];

    if (!hasSpace) {
      // Command mode: match command prefix
      const lower = trimmed.toLowerCase();
      return getSlashCommands()
        .filter((s) => s.cmd.startsWith(lower))
        .map((s) => ({ label: s.cmd, desc: s.desc }));
    }

    // Subcommand mode: /cmd subprefix
    // Use original input (not trimmed) to detect the space position correctly
    // when user types "/effort " (trailing space, trimmed would lose it)
    const spaceIdx = input.indexOf(" ");
    const cmdPart = input.slice(0, spaceIdx).toLowerCase();
    const subPart = input.slice(spaceIdx + 1).trim().toLowerCase();  // trim subPart for matching

    const cmd = getSlashCommands().find((s) => s.cmd === cmdPart);
    if (!cmd || !cmd.subcommands || cmd.subcommands.length === 0) return [];

    return cmd.subcommands
      .filter((sub) => sub.startsWith(subPart))
      .map((sub) => ({ label: sub, desc: "" }));
  }, [input, showAutocomplete, trimmed, hasSpace]);

  // -- Discover extensions on mount ------------------------------------
  useMemo(() => {
    // Initialize external tools registry BEFORE discovering extensions
    // so the Hub can see all available tools (Roblox, Python, etc.)
    import("../externalTools.js").then((mod) => {
      mod.initializeTools().then(() => {
        discoverExtensions();
      }).catch(() => {
        // If init fails, still discover what we can
        discoverExtensions();
      });
    }).catch(() => {
      discoverExtensions();
    });
  }, []);

  // -- Update todos and plan from shared state --------------------------------
  const syncTodos = useCallback(() => {
    const current = todo.getTodos();
    setTodos([...current]);
  }, []);

  // Sync plan steps from planExecutor (synchronous — static import).
  //
  // BUG FIX (syncPlan-race): previously this used `import("../planExecutor.js").then(...)`,
  // which scheduled a microtask that could resolve AFTER `createPlan()` was
  // called in the same handleSubmit tick (the explicit `await import()` for
  // createPlan came AFTER syncPlan but both queued on the same microtask
  // queue, so syncPlan's `.then()` ran FIRST with the OLD plan state —
  // setPlanSteps([]) — then createPlan ran, then the finally-block syncPlan
  // re-read the new plan). The result was a transient render with no plan
  // panel between the "create" and "sync" calls (visual flicker / plan
  // appears to disappear and reappear).
  //
  // The static import makes getPlan() synchronous, so setPlanSteps() reflects
  // the current plan state immediately. The createPlan() call site (in
  // handleSubmit) also calls syncPlan() right after to push the new plan
  // into React state without waiting for the next tick.
  const syncPlan = useCallback(() => {
    try {
      const plan: PlanShape | null = getPlanSync();
      if (plan) {
        setPlanSteps(plan.steps.map((s) => ({ description: s.description, done: s.done })));
      } else {
        setPlanSteps([]);
      }
    } catch {
      // planExecutor should always be available (static import), but be
      // defensive in case the module failed to load.
      setPlanSteps([]);
    }
  }, []);

  // -- Streaming helpers (extracted to reduce handleSubmit complexity) ---
  const runStreaming = useCallback(async (fullInput: string) => {
    let streamContent = "";
    let streamStarted = false;
    let streamStartTime = 0;
    let tokenCount = 0;

    // BUG FIX: reset tokensPerSecond at the start of each turn so we don't
    // show stale values from the previous turn (which could be misleading
    // if the current turn has no streaming, e.g., slash commands).
    setTokensPerSecond(0);

    const response = await runAgentLoop(
      fullInput,
      () => {
        streamStarted = true;
        // BUG FIX: reset streamStartTime AND tokenCount on EVERY stream
        // start. The agent may call chat() multiple times in one turn
        // (e.g., after tool calls). Without resetting tokenCount, it would
        // accumulate tokens across all streams, but streamStartTime would
        // only reflect the latest stream — producing absurd tok/s values
        // like 500 tok/s (tokenCount=100 from 3 streams, elapsed=0.2s
        // from the last stream only).
        streamStartTime = Date.now();
        tokenCount = 0;
        // BUG FIX (log-desaparece): reset streamContent on EVERY stream start.
        // Without this, streamContent accumulates across all streams in the
        // same agent turn — the second stream's content includes the first
        // stream's content, making the message show duplicated/garbled text.
        streamContent = "";
        // BUG FIX (scroll-roubo): reset throttle state for the new stream.
        // Also cancel any trailing flush from the previous stream so it
        // doesn't fire after we've already cleared streamContentRef and
        // write stale content into the new streaming message.
        streamContentRef.current = "";
        lastStreamFlushRef.current = 0;
        if (streamFlushTimerRef.current !== null) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        setStatus("streaming");
        // BUG FIX (log-desaparece): finalize any previous streaming message
        // before starting a new one. Without this, the first streaming message
        // keeps isStreaming=true forever, causing visual glitches (missing
        // empty line separator, content freeze).
        setMessages((prev) => {
          const updated = prev.map((m) =>
            m.role === "assistant" && m.isStreaming
              ? { ...m, isStreaming: false }
              : m,
          );
          const last = updated.at(-1);
          if (last?.role === "assistant" && last?.isStreaming) {
            return updated;
          }
          return [...updated, { role: "assistant", content: "", isStreaming: true }];
        });
      },
      (token: string) => {
        streamContent += token;
        streamContentRef.current = streamContent;
        // BUG FIX (tok/s-aleatorio): don't count empty tokens (heartbeats/
        // keep-alive chunks) in tokenCount. NVIDIA NIM sends onToken("")
        // as keep-alive during reasoning — counting them inflates tok/s.
        if (token.length > 0) tokenCount++;
        // Update tok/s every 10 tokens — based on THIS stream's token count
        // and THIS stream's elapsed time only (both reset on onStreamStart).
        if (tokenCount % 10 === 0 && streamStartTime > 0) {
          const elapsed = (Date.now() - streamStartTime) / 1000;
          if (elapsed > 0) setTokensPerSecond(Math.round(tokenCount / elapsed * 10) / 10);
        }
        // ─── Throttled flush (scroll-steal fix) ───────────────────────────
        // Instead of calling setMessages on every token (which caused Ink to
        // re-render 30-100x/sec and steal the terminal scroll), we batch
        // updates to at most one per STREAM_FLUSH_INTERVAL ms.
        //
        // - If enough time has passed since the last flush → flush now.
        // - Otherwise, ensure a trailing flush is scheduled (so the latest
        //   content is never lost — it'll appear after at most INTERVAL ms).
        // - streamContentRef.current is read inside the flush (not the local
        //   streamContent) because the trailing setTimeout fires later, by
        //   which point streamContent may have grown further.
        const now = Date.now();
        const sinceLast = now - lastStreamFlushRef.current;
        if (sinceLast >= STREAM_FLUSH_INTERVAL) {
          lastStreamFlushRef.current = now;
          const snapshot = streamContentRef.current;
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === "assistant" && updated[i].isStreaming) {
                updated[i] = { ...updated[i], content: snapshot };
                break;
              }
            }
            return [...updated];
          });
        } else if (streamFlushTimerRef.current === null) {
          // Schedule a trailing flush for the remaining time in the window.
          const wait = STREAM_FLUSH_INTERVAL - sinceLast;
          streamFlushTimerRef.current = setTimeout(() => {
            streamFlushTimerRef.current = null;
            lastStreamFlushRef.current = Date.now();
            const snap = streamContentRef.current;
            setMessages((prev) => {
              const updated = [...prev];
              for (let i = updated.length - 1; i >= 0; i--) {
                if (updated[i].role === "assistant" && updated[i].isStreaming) {
                  updated[i] = { ...updated[i], content: snap };
                  break;
                }
              }
              return [...updated];
            });
          }, wait);
        }
      },
      () => {
        // ─── Stream ended — flush any pending throttled content ───────────
        // BUG FIX (scroll-roubo): the trailing setTimeout may still be
        // pending when the stream ends. Cancel it and do one final
        // synchronous flush so the user sees the complete message.
        if (streamFlushTimerRef.current !== null) {
          clearTimeout(streamFlushTimerRef.current);
          streamFlushTimerRef.current = null;
        }
        const finalSnap = streamContentRef.current;
        if (finalSnap.length > 0) {
          setMessages((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              if (updated[i].role === "assistant" && updated[i].isStreaming) {
                updated[i] = { ...updated[i], content: finalSnap };
                break;
              }
            }
            return [...updated];
          });
        }
        // Reset throttle state for the next stream in this same agent turn.
        lastStreamFlushRef.current = 0;
        setStatus("thinking");
      },
      (usage) => {
        setLastUsage(usage);
        // Accumulate session totals so StatusBar shows cumulative cost/tokens
        // instead of just the last-turn values.
        setSessionPromptTokens((prev) => prev + usage.prompt_tokens);
        setSessionCompletionTokens((prev) => prev + usage.completion_tokens);
        setSessionCost((prev) => {
          const newCost = prev
            + (usage.prompt_tokens / 1000) * config.costPerKPrompt
            + (usage.completion_tokens / 1000) * config.costPerKCompletion;
          // BUG FIX (usage-not-persisted): persist usage to the session header
          // so the next session load shows accurate token/cost values
          // immediately — without waiting for the next IA response.
          // We do this inside the setSessionCost updater so we have access
          // to the NEW cumulative cost (not the stale `prev` from closure).
          // The other cumulative values are computed from the current usage
          // + the refs below (which we can't use here). Instead, we read
          // them via functional updates too — but since updateSessionUsage
          // needs ALL values at once, we compute them here.
          // sessionPromptTokens/sessionCompletionTokens haven't been updated
          // yet (React batches), so we add usage to the current values.
          // This is safe because setSessionCost runs after the other setters
          // were CALLED (but not yet committed) — we use the pre-update
          // values + usage to compute the post-update totals.
          try {
            updateSessionUsage({
              lastPromptTokens: usage.prompt_tokens,
              lastCompletionTokens: usage.completion_tokens,
              lastTotalTokens: usage.total_tokens,
              // Note: these cumulative values use the pre-update session
              // totals + this turn's usage. Since React batches state
              // updates, the sessionPromptTokens state hasn't been committed
              // yet when this runs — but we can compute the post-update value
              // by adding usage to whatever the state was at the start of
              // this callback. We use a ref to get the latest committed value.
              sessionPromptTokens: sessionPromptTokensRef.current + usage.prompt_tokens,
              sessionCompletionTokens: sessionCompletionTokensRef.current + usage.completion_tokens,
              sessionCost: newCost,
            });
          } catch { /* session persistence is best-effort */ }
          return newCost;
        });
        // Final tok/s calculation — uses THIS stream's elapsed time
        // (streamStartTime was reset on the last onStreamStart).
        if (streamStartTime > 0 && usage.completion_tokens > 0) {
          const elapsed = (Date.now() - streamStartTime) / 1000;
          if (elapsed > 0) setTokensPerSecond(Math.round(usage.completion_tokens / elapsed * 10) / 10);
        }
        // Refresh effort label (might have changed via /effort)
        setEffortLabel(getEffortLabel());
      },
      // onToolCall: add a "tool" message to the chat in chronological order.
      // This replaces the old behavior where tool calls were printed via
      // console.log (which broke the Ink TUI by appearing ABOVE the layout).
      (toolName: string, args: Record<string, unknown>) => {
        setMessages((prev) => [
          ...prev,
          {
            role: "tool",
            content: JSON.stringify(args),
            toolName,
            isResult: false,
          },
        ]);
      },
      // onToolResult: add a "tool result" message with success/error status.
      (toolName: string, ok: boolean, resultStr: string) => {
        setMessages((prev) => [
          ...prev,
          {
            role: "tool",
            content: resultStr,
            toolName,
            isResult: true,
            ok,
          },
        ]);
      },
      // Sprint 1: AskUser — IA faz pergunta, agent pausa, usuário responde
      (question: AskUserQuestion) => {
        return new Promise<AskUserResponse>((resolve) => {
          questionResolverRef.current = resolve;
          setPendingQuestion(question);
        });
      },
      // allowUserQuestions: true (chat principal sempre pode perguntar)
      true,
    );

    return { response, streamStarted };
  }, []);

  const finalizeMessage = useCallback((response: string, streamStarted: boolean) => {
    // BUG FIX (scroll-roubo): cancel any pending trailing flush from the
    // throttle — finalizeMessage writes the complete response below, so a
    // late flush would just overwrite with the same (or stale) content.
    if (streamFlushTimerRef.current !== null) {
      clearTimeout(streamFlushTimerRef.current);
      streamFlushTimerRef.current = null;
    }
    lastStreamFlushRef.current = 0;
    setMessages((prev) => {
      const updated = [...prev];
      for (let i = updated.length - 1; i >= 0; i--) {
        if (updated[i].role === "assistant" && updated[i].isStreaming) {
          updated[i] = { role: "assistant", content: response, isStreaming: false };
          break;
        }
      }
      if (!streamStarted) {
        updated.push({ role: "assistant", content: response, isStreaming: false });
      }
      return [...updated];
    });
  }, []);

  // ── Sidequest draining ─────────────────────────────────────────────────
  // BUG FIX (BH-SMALL-2 / sidequest-stuck-during-async-slash): previously
  // only handleSubmit's finally block drained the sidequest queue. Async
  // slash commands (/small, /compact) bypass handleSubmit's finally by
  // returning early, so sidequests typed by the user DURING a /small or
  // /compact run were left stuck in sidequestsRef.current — visually shown
  // as ⚡ in the chat but never sent to the IA until the user happened to
  // submit ANOTHER normal message (whose finally would finally drain them).
  //
  // Fix: extract the draining logic into this stable useCallback so /small
  // and /compact can call it from their own finally blocks. handleSubmit
  // also uses it (replacing the inline loop) so the logic lives in ONE place.
  const drainSidequests = useCallback(async () => {
    // Loop until the ref is empty. Each iteration snapshots the ref, clears
    // it, injects the queued sidequests into the agent history, and re-runs
    // the agent loop. Sidequests that arrive during the inner runStreaming
    // are picked up by the next loop iteration.
    while (sidequestsRef.current.length > 0) {
      const queued = sidequestsRef.current.slice();
      sidequestsRef.current = [];
      setSidequests([]);
      try {
        // Expand @-mentions in each sidequest (same as main path).
        const expandedQueued = queued.map((sq) => expandAtMentions(sq));
        // Add plan mode suffix if active (so IA doesn't call tools).
        const planSuffix = history.isPlanMode()
          ? "\n\n[PLAN MODE IS ACTIVE] You must NOT call any tools. Output a step-by-step plan as markdown. End with ===END PLAN==="
          : "";
        const sidequestInput = expandedQueued
          .map((sq) => `[USER SIDEQUEST] ${sq}`)
          .join("\n\n") + planSuffix;
        const { response, streamStarted } = await runStreaming(sidequestInput);
        finalizeMessage(response, streamStarted);
        syncTodos();
        syncPlan();
      } catch (err) {
        const errMsg = (err as Error).message ?? String(err);
        setMessages((prev) => {
          const withoutStreaming = prev.filter((m) => !m.isStreaming);
          return [...withoutStreaming, {
            role: "assistant" as const,
            content: `❌ Sidequest error: ${errMsg}`,
            isError: true,
          }];
        });
        // Stop processing further queued sidequests — if the agent loop
        // failed (e.g., API error), continuing would just cascade failures.
        // Clear any sidequests queued during the failed run so they don't
        // get stuck in the ref forever.
        sidequestsRef.current = [];
        setSidequests([]);
        break;
      }
    }
  }, [runStreaming, finalizeMessage, syncTodos, syncPlan]);

  const handleSlashCommandFlow = useCallback((trimmed: string): boolean => {
    // ── /small <task> — special async handling ────────────────────────────
    // handleSmallCommand returns { handled: false } when there's an argument,
    // signaling that the task should be run asynchronously here.
    if (trimmed.startsWith("/small ") || trimmed === "/small") {
      const arg = trimmed.slice("/small".length).trim();
      const smallResult = handleSlashCommand(trimmed);
      if (smallResult.handled) {
        // No argument — show usage
        if (smallResult.message) {
          setSystemMessages((prev) => [...prev, smallResult.message!]);
        }
        isProcessing.current = false;
        setStatus("idle");
        return true;
      }
      // Has argument — run the small task asynchronously
      if (!isSmallTaskEnabled()) {
        setSystemMessages((prev) => [...prev, "⚠️ Small task desabilitado via SMALL_TASK_ENABLED=0"]);
        isProcessing.current = false;
        setStatus("idle");
        return true;
      }
      const cwd = process.cwd();
      const task = arg;
      // Show "⚡ small task: <task>" in chat
      setSystemMessages((prev) => [...prev, `⚡ small task: ${task}`]);
      setStatus("thinking");
      isProcessing.current = true;
      (async () => {
        try {
          const result = await runSmallTask(task, cwd, {
            onToolCall: (toolName, args) => {
              // Show tool calls in chat (like main agent).
              //
              // BUG FIX (BH-SMALL-2 / dead-code-and-cast): the previous
              // version computed `const argsStr = JSON.stringify(args).slice(0, 80)`
              // but never used it, AND set a `ts: Date.now()` field that does
              // NOT exist on the ChatMessage interface — it only compiled
              // because of the `as ChatMessage` cast, which silently bypassed
              // TypeScript's excess-property check. Both removed.
              setMessages((prev) => [...prev, {
                role: "tool",
                content: JSON.stringify(args),
                toolName: `small:${toolName}`,
                isResult: false,
              } as ChatMessage]);
            },
            onToolResult: (_toolName, result, ok) => {
              setMessages((prev) => [...prev, {
                role: "tool",
                content: result,
                toolName: `small:${_toolName}`,
                isResult: true,
                ok,
              } as ChatMessage]);
            },
          });
          if (result.ok) {
            setSystemMessages((prev) => [...prev, `⚡ small result: ${result.summary}`]);
          } else {
            setSystemMessages((prev) => [...prev, `⚠️ small falhou: ${result.error ?? "erro desconhecido"}`]);
          }
        } catch (err) {
          const msg = (err as Error).message ?? String(err);
          setSystemMessages((prev) => [...prev, `⚠️ small erro: ${msg}`]);
        } finally {
          // BUG FIX (BH-SMALL-2 / sidequest-stuck-during-async-slash):
          // /small bypasses handleSubmit's finally block (which normally
          // drains the sidequest queue). Drain sidequests here so messages
          // typed by the user during /small are sent to the IA promptly
          // instead of getting stuck in sidequestsRef until the next normal
          // submit. drainSidequests handles its own errors internally
          // (showing them as assistant error messages), so the outer try
          // is just defensive.
          try {
            await drainSidequests();
          } catch { /* drainSidequests handles its own errors */ }
          isProcessing.current = false;
          setStatus("idle");
        }
      })();
      return true;
    }
    let result: CommandResult;
    try {
      result = handleSlashCommand(trimmed);
    } catch (err) {
      // SAFETY NET: any slash command that throws (e.g., /searx calling
      // execSync that fails on some Windows configs) should NOT crash
      // the entire CLI. Show the error as a system message instead.
      const errMsg = (err as Error).message ?? String(err);
      setSystemMessages((prev) => [...prev, `Erro no comando "${trimmed}": ${errMsg}`]);
      isProcessing.current = false;
      setStatus("idle");
      return true;
    }
    if (result.exit) {
      exit();
      return true;
    }
    if (result.handled) {
      // BUG FIX: Refresh effort label immediately after any slash command.
      // /effort changes the level via setEffortLevel() which updates the
      // system prompt instantly, but the visual label (effortLabel state)
      // was only refreshed inside onUsage (after next IA response).
      // Now it updates right after the command is processed.
      setEffortLabel(getEffortLabel());
      if (result.openHub) {
        setShowHub(true);
      }
      if (result.openFolderBrowser) {
        setShowFolderBrowser(true);
      }
      if (result.openConfigurator) {
        setConfiguratorTool(result.configuratorTool ?? null);
        setShowConfigurator(true);
      }
      if (result.resetChat) {
        // If visualMessages were provided (e.g., from /session load), use
        // them instead of clearing. Otherwise, clear the chat.
        setMessages(result.visualMessages ?? []);
      }
      // BUG FIX (usage-not-restored): apply restored usage from /session load
      // so the StatusBar shows accurate token/cost values immediately.
      if (result.restoredUsage) {
        const u = result.restoredUsage;
        setLastUsage({
          prompt_tokens: u.lastPromptTokens,
          completion_tokens: u.lastCompletionTokens,
          total_tokens: u.lastTotalTokens,
        });
        setSessionPromptTokens(u.sessionPromptTokens);
        setSessionCompletionTokens(u.sessionCompletionTokens);
        setSessionCost(u.sessionCost);
        // Sync refs immediately so onUsage (if user sends a message right
        // away) reads accurate cumulative values.
        sessionPromptTokensRef.current = u.sessionPromptTokens;
        sessionCompletionTokensRef.current = u.sessionCompletionTokens;
      }
      // /compact agora é assíncrono (LLM-based). Mostra status "compacting"
      // enquanto a IA gera o resumo. O resultado aparece como system message
      // quando termina.
      if (result.compactStarted) {
        setStatus("compacting");
        if (result.message) {
          setSystemMessages((prev) => [...prev, result.message!]);
        }
        // Executa a compactação assíncrona (LLM-based)
        const instruction = result.compactInstruction;
        (async () => {
          try {
            const { compactHistoryAsync } = await import("../history.js");
            const compactResult = await compactHistoryAsync(instruction);
            if (!compactResult) {
              setSystemMessages((prev) => [...prev, "Nada para compactar (contexto muito curto)."]);
              return;
            }
            const methodLabel = compactResult.method === "llm" ? "LLM (IA gerou resumo inteligente)" : "mecanico (fallback)";
            const msg = `Contexto compactado!\n` +
              `  - ${compactResult.removed} mensagens removidas\n` +
              `  - Tokens: ${compactResult.beforeTokens.toLocaleString()} -> ${compactResult.afterTokens.toLocaleString()} (-${(compactResult.beforeTokens - compactResult.afterTokens).toLocaleString()})\n` +
              `  - Economia: ${((1 - compactResult.afterTokens / compactResult.beforeTokens) * 100).toFixed(1)}%\n` +
              `  - Metodo: ${methodLabel}` +
              (instruction ? `\n  - Foco: ${instruction}` : "");
            setSystemMessages((prev) => [...prev, msg]);
            // Atualiza a barra de contexto imediatamente
            setLastUsage({
              prompt_tokens: compactResult.afterTokens,
              completion_tokens: 0,
              total_tokens: compactResult.afterTokens,
            });
          } catch (err) {
            setSystemMessages((prev) => [...prev, `Erro na compactacao: ${(err as Error).message}`]);
          } finally {
            // BUG FIX (BH-SMALL-2 / sidequest-stuck-during-async-slash):
            // /compact has the same shape as /small — it runs an async IIFE
            // that bypasses handleSubmit's finally. Drain sidequests here so
            // user messages typed during compaction are processed.
            try {
              await drainSidequests();
            } catch { /* drainSidequests handles its own errors */ }
            isProcessing.current = false;
            setStatus("idle");
          }
        })();
        return true; // NÃO setar isProcessing = false aqui
      }
      if (result.message) {
        setSystemMessages((prev) => [...prev, result.message!]);
      }
      isProcessing.current = false;
      return true;
    }
    return false;
  }, [exit, drainSidequests]);

  // -- Submit handler -----------------------------------------------------
  const handleSubmit = useCallback(
    async (value: string) => {
      let trimmedValue = value.trim();
      if (!trimmedValue) {
        setInput("");
        return;
      }

      // ── Sidequest: if IA is processing, queue the message ──
      if (isProcessing.current) {
        if (trimmedValue.startsWith("/")) {
          // BUG FIX (sidequest-silent-drop): slash commands during processing
          // were silently dropped with no feedback — the user typed "/help"
          // and nothing happened, looking like the input was broken. Now we
          // surface a system message so the user knows it was ignored and
          // why (and what to do instead).
          setSystemMessages((prev) => [...prev,
            `Comando "${trimmedValue}" ignorado — a IA está processando. Aguarde terminar ou reformule sem "/".`,
          ]);
          setInput("");
          return;
        }
        // Update BOTH the ref (source of truth for the finally block) and the
        // state (for re-render of any component that might display the queue).
        sidequestsRef.current = [...sidequestsRef.current, trimmedValue];
        setSidequests(sidequestsRef.current);
        // NOTE: no `as any` needed — `isSidequest` is a declared field on
        // ChatMessage (see ChatDisplay.tsx interface). The previous cast
        // bypassed TypeScript safety for no reason.
        setMessages((prev) => [...prev, { role: "user", content: trimmedValue, isSidequest: true }]);
        setInput("");
        return;
      }

      // If autocomplete is showing and user hits Enter, use selected match.
      // - For commands (/effort): complete the command + add space for subcommand typing
      // - For subcommands (low/medium/high/max): complete the full input and submit
      // - BUG FIX: if the user typed the full command already (e.g., "/hub" matches
      //   selected.label "/hub"), submit immediately instead of adding a space and
      //   forcing the user to press Enter twice.
      // - BUG FIX: /mode has TWO arguments (/mode roblox new) — autocomplete
      //   was replacing "roblox" with the subcommand match. Now we only use
      //   autocomplete for commands with exactly ONE argument (/effort low).
      if (showAutocomplete && acMatches.length > 0) {
        const selected = acMatches[acIndex];
    if (selected?.label) {
          const spaceCount = (trimmedValue.match(/\s/g) ?? []).length;
          if (hasSpace && spaceCount === 1) {
            // Single-argument command (e.g., "/effort low") — autocomplete the subcommand
            const spaceIdx = trimmedValue.indexOf(" ");
            const cmdPart = trimmedValue.slice(0, spaceIdx);
            trimmedValue = `${cmdPart} ${selected.label}`;
            setInput(trimmedValue);
            setAcIndex(0);
            // Fall through to actual command execution below
          } else if (selected.label === trimmedValue) {
            // User typed the full command (e.g., "/hub" === "/hub") — submit immediately.
            setAcIndex(0);
            // Fall through to actual command execution below
          } else if (!hasSpace) {
            // Command selected - add space so user can type subcommand
            setInput(selected.label + " ");
            setAcIndex(0);
            return;
          } else {
            // Multi-argument command (e.g., "/mode roblox new") —
            // user already typed the full command, just submit it.
            setAcIndex(0);
            // Fall through to actual command execution below
          }
        }
      }

      setInput("");
      setAcIndex(0);
      isProcessing.current = true;

      // Handle slash commands — set status AFTER, not before.
      // Slash commands handle their own status (idle, compacting, etc.)
      // Setting "thinking" before slash commands causes the "pensando..."
      // indicator to stay forever if the command doesn't set idle.
      if (trimmedValue.startsWith("/")) {
        const exitCalled = handleSlashCommandFlow(trimmedValue);
        if (exitCalled) return;
      }

      // Only set "thinking" for non-slash commands (actual IA requests)
      setStatus("thinking");

      // Add user message to display
      const userMsg: ChatMessage = { role: "user", content: trimmedValue };
      setMessages((prev) => [...prev, userMsg]);

      // Expand @-mentions
      const expanded = expandAtMentions(trimmedValue);

      // Plan mode suffix
      const planSuffix = history.isPlanMode()
        ? "\n\n[PLAN MODE IS ACTIVE] You must NOT call any tools. Output a step-by-step plan as markdown. End with ===END PLAN==="
        : "";
      const fullInput = expanded + planSuffix;

      try {
        const { response, streamStarted } = await runStreaming(fullInput);
        finalizeMessage(response, streamStarted);
        syncTodos();
        syncPlan();

        // ── Gap 3: Parse ===END PLAN=== to populate planExecutor ──────────
        // When plan mode is active and IA outputs a plan ending with
        // ===END PLAN===, extract the numbered steps and call createPlan().
        // This connects the /plan mode (which appends a suffix) with the
        // planExecutor (which tracks step completion and blocks finish).
        // Previously: ===END PLAN=== was never parsed — planExecutor state
        // stayed null, hasIncompletePlan() always returned false, so
        // checkPlanCompletion() never blocked. The two systems were
        // completely decoupled.
        //
        // BUG FIX (syncPlan-race): use the statically-imported createPlanSync
        // (no `await import()`) AND call syncPlan() immediately after, so the
        // plan appears in the TUI in the SAME React commit. Previously the
        // dynamic import + missing immediate syncPlan() caused a one-tick
        // delay where planSteps was still [] right after creation.
        if (history.isPlanMode() && response.includes("===END PLAN===")) {
          try {
            const steps = extractPlanSteps(response);
            if (steps.length > 0) {
              createPlanSync(steps);
              setSystemMessages((prev) => [...prev,
                `[PLAN] Plano criado com ${steps.length} passo(s). Modo Plan desativado — execute os passos agora.`,
              ]);
              // Auto-disable plan mode after plan is created
              history.setPlanMode(false);
              // Push the new plan into React state immediately — no flicker.
              syncPlan();
            }
          } catch { /* planExecutor not available */ }
        }
      } catch (err) {
        // CRITICAL FIX: show error as a VISIBLE chat message, not just
        // systemMessages (which may be hidden/scrolled away). Without this,
        // the user sees the input field reappear with no explanation —
        // looks like "the CLI died silently".
        //
        // §17.4.21: error messages MUST be plain text (no MarkdownRenderer).
        // The previous version embedded `**bold**` and ``` code fences ```
        // in the content AND routed it through MarkdownRenderer — both
        // violated the rule. Now the content is plain text (the label
        // "❌ Erro:" is rendered separately by ChatDisplay in red bold),
        // and ChatDisplay renders isError messages with plain <Text>.
        const errMsg = (err as Error).message ?? String(err);
        const errStack = (err as Error).stack?.split("\n").slice(0, 3).join("\n") ?? "";
        const errContent = errStack
          ? `Erro na execução:\n\n${errMsg}\n${errStack}\n\nO agente foi interrompido. Você pode tentar novamente ou reformular sua mensagem.`
          : `Erro na execução:\n\n${errMsg}\n\nO agente foi interrompido. Você pode tentar novamente ou reformular sua mensagem.`;
        setMessages((prev) => {
          // Replace any in-progress streaming message with the error
          const withoutStreaming = prev.filter((m) => !m.isStreaming);
          return [...withoutStreaming, {
            role: "assistant" as const,
            content: errContent,
            isError: true,
          }];
        });
        setSystemMessages((prev) => [...prev, `Error: ${errMsg}`]);
      } finally {
        // ── Sidequest injection ──
        //
        // BUG FIX (sidequest-stale-closure + race): the original code read
        // the `sidequests` STATE here, but handleSubmit's closure captured
        // the value at memoization time (always `[]` on first render) — so
        // the injection NEVER fired. Even with a fresh read, a single
        // `if (sidequests.length > 0)` would miss sidequests queued DURING
        // the inner runStreaming (since isProcessing.current stays true
        // throughout, the user can keep typing sidequests).
        //
        // BUG FIX (BH-SMALL-2 / sidequest-stuck-during-async-slash): the
        // draining logic was previously inlined here. It has been extracted
        // into `drainSidequests` so that /small and /compact (which bypass
        // handleSubmit's finally) can drain the queue from their own finally
        // blocks. This call is now a one-liner; see drainSidequests for the
        // implementation and the per-sidequest error-handling rationale
        // (sidequest-double-send, sidequest-no-at-mention,
        // sidequest-no-plan-suffix, missing-syncPlan).
        await drainSidequests();
        isProcessing.current = false;
        setStatus("idle");
        syncTodos();
        syncPlan();
      }
    },
    [exit, syncTodos, showAutocomplete, acMatches, acIndex, hasSpace, drainSidequests]
  );

  // -- Input change handler -----------------------------------------------
  const handleChange = useCallback((val: string) => {
    setInput(val);
    setAcIndex(0);
  }, []);

  // -- Keyboard navigation for autocomplete + global shortcuts -----------
  useInput((inputChar, key) => {
    // Ctrl+E opens Extension Hub - must clear input to prevent 'e' leak
    if (key.ctrl && inputChar === "e") {
      setInput("");
      setShowHub((prev) => !prev);
      return;
    }

    // If hub is open, don't process other keys here.
    // BUG FIX: also bail out when ConfiguratorChat or QuestionPrompt is open.
    // These overlays register their own useInput handlers AND the main
    // TextInput is hidden (see render section), but if the App's input state
    // still starts with "/" (left over from before the overlay opened),
    // showAutocomplete would be true and arrow/tab keys here would navigate
    // the autocomplete — stealing keystrokes from the overlay (e.g. pressing
    // Up in QuestionPrompt would ALSO move the autocomplete cursor).
    if (showHub || showFolderBrowser || showConfigurator || pendingQuestion) return;

    if (!showAutocomplete || acMatches.length === 0) return;

    if (key.upArrow) {
      setAcIndex((prev) => (prev > 0 ? prev - 1 : acMatches.length - 1));
    } else if (key.downArrow) {
      setAcIndex((prev) => (prev < acMatches.length - 1 ? prev + 1 : 0));
    } else if (key.tab) {
      // Tab cycles through matches
      setAcIndex((prev) => (prev < acMatches.length - 1 ? prev + 1 : 0));
    }
  });

  // -- Render -------------------------------------------------------------
  // Banner: printed ONCE via process.stdout.write BEFORE Ink renders (see
  // index.ts). It lives in the terminal scrollback buffer, NOT in the live
  // view. This is mandated by §8.4 / §17.2.9: if the banner were in the live
  // view, every re-render (12x/sec during streaming) would move the cursor
  // to the top, stealing the user's scroll position.
  //
  // Previously App.tsx had a fallback that rendered the banner in the live
  // view when CLAUDE_KILLER_BANNER_PRINTED != "1" (e.g. in tests). This
  // fallback was removed (FIX-TUI Bug 1) because it re-introduced the
  // scroll-steal bug whenever index.ts failed to set the env var. The
  // banner in index.ts is now ALWAYS printed unconditionally before render().

  return (
    <Box flexDirection="column" padding={1}>
      {/* Extension Hub overlay */}
      {showHub && (
        <Box marginBottom={1}>
          <ExtensionHub
            onClose={() => setShowHub(false)}
            onMessage={(msg) => setSystemMessages((prev) => [...prev, msg])}
            onConfigure={(toolName) => {
              setShowHub(false);
              setConfiguratorTool(toolName ?? null);
              setShowConfigurator(true);
            }}
          />
        </Box>
      )}

      {/* Folder Browser overlay (opened by /cd without args) */}
      {showFolderBrowser && (
        <Box marginBottom={1}>
          <FolderBrowser
            initialPath={process.cwd()}
            onSelect={(selectedPath) => {
              try {
                process.chdir(selectedPath);
                const newCwd = process.cwd();
                updateSessionProjectCwd(newCwd);
                // Recarrega project memory do novo diretório
                try {
                  history.reloadProjectMemory();
                } catch { /* ignore */ }
                // Detecta tipo de projeto
                const hasRoblox = fs.existsSync(path.join(newCwd, "default.project.json"));
                const hasNode = fs.existsSync(path.join(newCwd, "package.json"));
                const parts = [`[OK] Working directory changed to: ${newCwd}`];
                if (hasRoblox) parts.push("✓ Roblox project detected (default.project.json)");
                if (hasNode) parts.push("✓ Node.js project detected (package.json)");
                try {
                  const mem = history.reloadProjectMemory();
                  if (mem) parts.push("✓ Project memory reloaded (CLAUDE.md / AGENTS.md)");
                } catch { /* ignore */ }
                setSystemMessages((prev) => [...prev, parts.join("\n")]);
              } catch (err) {
                setSystemMessages((prev) => [...prev, `[ERROR] Could not change directory: ${(err as Error).message}`]);
              }
              setShowFolderBrowser(false);
            }}
            onCancel={() => setShowFolderBrowser(false)}
          />
        </Box>
      )}

      {/* Sprint 1: AskUser — pergunta interativa da IA */}
      {pendingQuestion && (
        <QuestionPrompt
          question={pendingQuestion}
          onRespond={(response: AskUserResponse) => {
            setPendingQuestion(null);
            if (questionResolverRef.current) {
              questionResolverRef.current(response);
              questionResolverRef.current = null;
            }
          }}
        />
      )}

      {/* Sprint 11: Configurator chat — mini chat pra configurar tools */}
      {showConfigurator && (
        <ConfiguratorChat
          toolName={configuratorTool}
          onClose={() => {
            setShowConfigurator(false);
            setConfiguratorTool(null);
          }}
          onMessage={(msg) => setSystemMessages((prev) => [...prev, msg])}
        />
      )}

      {/* System messages — slash command output, mode changes, etc.
          These are transient and stay in the live view. They're below the
          chat history in render order but appear above it visually because
          they're rendered first. During streaming they DON'T cause cursor
          jumps because they're below the banner (which is now static). */}
      {systemMessages.map((msg, i) => (
        <Box key={`sys-${i}-${msg.slice(0, 10)}`} flexDirection="column" marginBottom={1}>
          <Text color={colors.success}>{msg}</Text>
        </Box>
      ))}

      {/* Chat history
          NO flexGrow — the chat-history Box is exactly as tall as its content.
          This means the input box sits RIGHT BELOW the chat (no empty gap
          between last message and input), and the StatusBar sits right below
          the input. Any remaining terminal space is at the very bottom (below
          the StatusBar), which is just the terminal background — not a "gap
          between messages".

          BUG FIX (black-gap + scroll-steal): previously this Box had
          flexGrow={1} to pin the input to the bottom of the terminal. That
          created a large empty space inside this Box (between chat content
          and input) — the "black gap" the user saw. Adding
          justifyContent="flex-end" moved the gap to the TOP of this Box,
          but caused scroll-steal during typing (every keystroke re-rendered
          the live frame including the empty space, and any layout shift
          made the terminal briefly scroll up to older chat). Removing
          flexGrow entirely eliminates both issues: no gap, no scroll-steal.
          The input now floats right below the chat (like Claude Code). */}
      <Box flexDirection="column">
        <ChatDisplay messages={messages} />
      </Box>

      {/* Thinking indicator (also shows during compaction)
          BUG FIX (bug-hunter-dataguard-invisible): the indicator is now also
          active when the activity tracker has a non-empty stack (Bug Hunter
          or DataGuard running). Previously, when the agent loop finished
          (status left "thinking") but Bug Hunter/DataGuard started, the
          indicator disappeared — the user had NO visual feedback that a
          review was in progress. Now it stays visible as long as ANY
          activity is on the stack. */}
      <ThinkingIndicator
        active={status === "thinking" || status === "streaming" || status === "compacting" || getActivitySnapshot().current !== null}
        label={status === "compacting" ? "COMPACTANDO" : undefined}
      />

      {/* Task panel */}
      <TodoPanel todos={todos} />
      {planSteps.length > 0 && <PlanPanel steps={planSteps} />}

      {/* Autocomplete dropdown
          BUG FIX (scroll-steal-autocomplete): previously the wrapper Box was
          conditionally rendered (`showAutocomplete && acMatches.length > 0`),
          which meant the Autocomplete box MOUNTED/UNMOUNTED as the user typed
          (e.g., typing "/h" → 2 matches, "/he" → 1 match, "/hex" → 0 matches
          → box disappears). Each mount/unmount changed the total frame height,
          causing the terminal to scroll up briefly (scroll-steal).
          Fix: always render the wrapper Box when showAutocomplete is true
          (user is typing a "/" command). The Autocomplete component itself
          returns null when there are 0 matches, but the Box wrapper stays
          mounted — keeping the frame height stable. */}
      {showAutocomplete && (
        <Box marginBottom={1}>
          <Autocomplete query={input} selectedIndex={acIndex} onSelect={(cmd) => setInput(cmd + " ")} />
        </Box>
      )}

      {/* Bottom section: Input (top) + Status (bottom), stacked vertically to
          prevent input text from overlapping the status bar when it wraps. */}
      <Box flexDirection="column" marginTop={1}>
        {/* Input row */}
        <Box flexDirection="row">
          <Box flexGrow={1}>
            {/*
              BUG FIX (input-travado): the TextInput is now wrapped in a
              memoized InputBox component. During streaming, the App
              re-renders 12x/second (setMessages) + 5x/second
              (ThinkingIndicator). Without memoization, each re-render
              re-rendered the TextInput, resetting the terminal cursor and
              making the input appear "locked". The memoized InputBox only
              re-renders when its props change (value, placeholder,
              overlayOpen), preserving the cursor position.

              overlayOpen: hide the main TextInput whenever ANY overlay that
              captures keyboard input is open (Hub, FolderBrowser,
              ConfiguratorChat, QuestionPrompt). Previously only Hub and
              FolderBrowser were checked, so when ConfiguratorChat or
              QuestionPrompt was open, the main TextInput was still mounted
              and receiving stdin — causing every keystroke to go to BOTH
              the overlay's useInput handler AND the main TextInput's
              onChange.
            */}
            <InputBox
              value={input}
              onChange={handleChange}
              onSubmit={handleSubmit}
              placeholder={status === "idle" ? "Digite sua mensagem..." : "Digite uma sidequest..."}
              overlayOpen={showHub || showFolderBrowser || showConfigurator || !!pendingQuestion}
            />
          </Box>
        </Box>

        {/* Status bar row (below input, not beside it).
            Right-aligned: the StatusBar itself uses justifyContent="flex-end"
            with width="100%" so all its content (tokens, bar, %, effort, cost,
            MCPs, Skills, PLAN tag) is pushed to the right edge of the screen.
            
            BUG FIX (cold-start): StatusBar was hidden until first IA response
            because of `lastUsage &&` guard. Now always renders — uses 0 values
            when no usage data yet, so the bar/effort/activity are visible
            immediately on startup. */}
        <Box marginTop={0} width="100%">
          <StatusBar
            promptTokens={lastUsage?.prompt_tokens ?? 0}
            completionTokens={lastUsage?.completion_tokens ?? 0}
            totalTokens={lastUsage?.total_tokens ?? 0}
            contextWindow={config.contextWindowTokens}
            warnThreshold={config.contextWarnThreshold}
            compactThreshold={config.contextCompactThreshold}
            costPerKPrompt={config.costPerKPrompt}
            costPerKCompletion={config.costPerKCompletion}
            planMode={history.isPlanMode()}
            mcpCount={getActiveMCPServers().length}
            skillsCount={getActiveSkills().length}
            effortLabel={effortLabel}
              tokensPerSecond={tokensPerSecond}
              // Cumulative session totals — passed separately from lastUsage
              // so the StatusBar can show both last-turn and session-wide values.
              sessionPromptTokens={sessionPromptTokens}
              sessionCompletionTokens={sessionCompletionTokens}
              sessionCost={sessionCost}
              activityStatus={status}
            />
          </Box>
      </Box>
    </Box>
  );
}
