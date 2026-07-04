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

import React, { useState, useCallback, useRef, useMemo } from "react";
import { Box, Text, useInput, useApp } from "ink";
import TextInput from "ink-text-input";
import fs from "node:fs";
import path from "node:path";
import { runAgentLoop } from "../agent.js";
import * as history from "../history.js";
import * as todo from "../todo.js";

import { config } from "../config.js";
import { shutdownMCPServers, getActiveSkills, getActiveMCPServers } from "../extensions.js";
import { discoverExtensions, getAllExtensions } from "../extensionCenter.js";
import { setEffortLevel, getEffortLabel } from "../effortLevels.js";
import { getPoolSize, formatPoolStats } from "../apiKeyPool.js";
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
import { getLocalizedSlashCommands, getCommandI18n, detectLanguage, setLanguage, resetLanguageCache } from "../i18n.js";
// Sprint 10: Inbox organizer — /organize slash command + 'O' key in Hub
import { organizeInbox, formatOrganizeResult } from "../inboxOrganizer.js";
import { colors } from "./theme.js";
import { ChatDisplay, ChatMessage } from "./ChatDisplay.js";
import { StatusBar } from "./StatusBar.js";
import { TodoPanel, TodoItem } from "./TodoPanel.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { ExtensionHub } from "./ExtensionHub.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { ConfiguratorChat } from "./ConfiguratorChat.js";
import { useTerminalWidth } from "./useTerminal.js";
import type { AskUserQuestion, AskUserResponse } from "../askUser.js";
import { getSearxStatus } from "../searxManager.js";
import { loadConfig as loadDotfileConfig, updateConfig as updateDotfileConfig, saveConfig as saveDotfileConfig } from "../dotfileConfig.js";

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
];

type CommandResult = { handled: boolean; message?: string; exit?: boolean; openHub?: boolean; resetChat?: boolean; openConfigurator?: boolean; configuratorTool?: string | null; compactDone?: boolean; compactStarted?: boolean; compactInstruction?: string; compactResult?: { removed: number; beforeTokens: number; afterTokens: number; method?: string } };



function handleExitCommand(): CommandResult {
  shutdownMCPServers();
  return { handled: true, exit: true };
}

function handleHelpCommand(): CommandResult {
  const text = SLASH_COMMANDS.map((s) => `  ${s.cmd.padEnd(12)} ${s.desc}`).join("\n");
  return { handled: true, message: text };
}

function handleResetCommand(): CommandResult {
  history.resetHistory();
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
 * BUG FIX (BUG 3C): /mcp slash command for managing MCP servers.
 *
 * Subcommands:
 *   /mcp                 — list active MCP servers + supported config locations
 *   /mcp list            — alias for /mcp
 *   /mcp add <name> <command> [args...]
 *                         — add MCP server to ~/.claude-killer/config.json
 *   /mcp remove <name>   — remove MCP server from ~/.claude-killer/config.json
 *
 * Note: adding/removing requires a CLI restart to take effect (MCPs are loaded
 * at startup). This is the same UX as Claude Code's `claude mcp add`.
 */
function handleMcpCommand(arg: string | null): CommandResult {
  const subcommand = arg?.split(/\s+/)[0]?.toLowerCase() ?? "";

  // /mcp or /mcp list
  if (!subcommand || subcommand === "list") {
    const servers = getActiveMCPServers();
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
      "  2. ~/.claude-killer/config.json → mcpServers      (native dotfile)",
      "  3. ~/.claude.json → mcpServers                    (Claude Code global)",
      "  4. ~/.claude-killer/plugins/*/plugin.json         (plugins)",
      "  5. ~/.claude-killer/modes/<mode>/mcps/*.json      (mode-specific)",
      "",
      "Usage:",
      "  /mcp add <name> <command> [args...]   — add server to ~/.claude-killer/config.json",
      "  /mcp remove <name>                    — remove server",
      "  /mcp list                             — list active servers",
      "",
      "Example:",
      '  /mcp add Roblox_Studio cmd.exe /c %LOCALAPPDATA%\\Roblox\\mcp.bat',
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
  // Sprint 10: organizar inbox do modo ativo
  "/organize": () => handleOrganizeCommand(),
  // Sprint 11: configurar tools via mini chat
  "/configurar": (arg) => handleConfigurarCommand(arg),
  // i18n: trocar idioma em runtime
  "/lang": (arg) => handleLangCommand(arg),
  // Searx local search status/install
  "/searx": (arg) => handleSearxCommand(arg),
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
  return { handled: true, message: `Effort alterado para: ${getEffortLabel()}` };
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

// --- App Component ----------------------------------------------------------

export function App() {
  const { exit } = useApp();

  // -- State --------------------------------------------------------------
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AppStatus>("idle");
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [lastUsage, setLastUsage] = useState<{
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null>(null);
  const [tokensPerSecond, setTokensPerSecond] = useState(0);

  // Cumulative session totals — track across ALL turns, not just the last one.
  // BUG FIX (audit issue #4): StatusBar was showing last-turn cost/tokens but
  // the docstring claimed "session cost". Users saw $0.001 after 50 turns.
  // Now we accumulate prompt + completion tokens AND cost across the session.
  const [sessionPromptTokens, setSessionPromptTokens] = useState(0);
  const [sessionCompletionTokens, setSessionCompletionTokens] = useState(0);
  const [sessionCost, setSessionCost] = useState(0);
  const [effortLabel, setEffortLabel] = useState(getEffortLabel());
  const [systemMessages, setSystemMessages] = useState<string[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [showHub, setShowHub] = useState(false);

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

  // -- Update todos from shared state -------------------------------------
  const syncTodos = useCallback(() => {
    const current = todo.getTodos();
    setTodos([...current]);
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
        setStatus("streaming");
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated.at(-1);
          if (last?.role === "assistant" && last?.isStreaming) {
            return updated;
          }
          return [...updated, { role: "assistant", content: "", isStreaming: true }];
        });
      },
      (token: string) => {
        streamContent += token;
        tokenCount++;
        // Update tok/s every 10 tokens — based on THIS stream's token count
        // and THIS stream's elapsed time only (both reset on onStreamStart).
        if (tokenCount % 10 === 0 && streamStartTime > 0) {
          const elapsed = (Date.now() - streamStartTime) / 1000;
          if (elapsed > 0) setTokensPerSecond(Math.round(tokenCount / elapsed * 10) / 10);
        }
        setMessages((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === "assistant" && updated[i].isStreaming) {
              updated[i] = { ...updated[i], content: streamContent };
              break;
            }
          }
          return [...updated];
        });
      },
      () => {
        setStatus("thinking");
      },
      (usage) => {
        setLastUsage(usage);
        // Accumulate session totals so StatusBar shows cumulative cost/tokens
        // instead of just the last-turn values.
        setSessionPromptTokens((prev) => prev + usage.prompt_tokens);
        setSessionCompletionTokens((prev) => prev + usage.completion_tokens);
        setSessionCost((prev) =>
          prev
          + (usage.prompt_tokens / 1000) * config.costPerKPrompt
          + (usage.completion_tokens / 1000) * config.costPerKCompletion
        );
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

  const handleSlashCommandFlow = useCallback((trimmed: string): boolean => {
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
      if (result.openHub) {
        setShowHub(true);
      }
      if (result.openConfigurator) {
        setConfiguratorTool(result.configuratorTool ?? null);
        setShowConfigurator(true);
      }
      if (result.resetChat) {
        setMessages([]);
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
  }, [exit]);

  // -- Submit handler -----------------------------------------------------
  const handleSubmit = useCallback(
    async (value: string) => {
      let trimmedValue = value.trim();
      if (!trimmedValue || isProcessing.current) {
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
      } catch (err) {
        // CRITICAL FIX: show error as a VISIBLE chat message, not just
        // systemMessages (which may be hidden/scrolled away). Without this,
        // the user sees the input field reappear with no explanation —
        // looks like "the CLI died silently".
        const errMsg = (err as Error).message ?? String(err);
        const errStack = (err as Error).stack?.split("\n").slice(0, 3).join("\n") ?? "";
        setMessages((prev) => {
          // Replace any in-progress streaming message with the error
          const withoutStreaming = prev.filter((m) => !m.isStreaming);
          return [...withoutStreaming, {
            role: "assistant" as const,
            content: `❌ **Erro na execução:**\n\n\`\`\`\n${errMsg}\n${errStack}\n\`\`\`\n\nO agente foi interrompido. Você pode tentar novamente ou reformular sua mensagem.`,
            isError: true,
          }];
        });
        setSystemMessages((prev) => [...prev, `Error: ${errMsg}`]);
      } finally {
        isProcessing.current = false;
        setStatus("idle");
        syncTodos();
      }
    },
    [exit, syncTodos, showAutocomplete, acMatches, acIndex, hasSpace]
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

    // If hub is open, don't process other keys here
    if (showHub) return;

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
  const termWidth = useTerminalWidth();
  const bannerWidth = Math.max(40, Math.min(termWidth - 2, 80));
  return (
    <Box flexDirection="column" padding={1}>
      {/* Banner */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.primary} bold>{"=".repeat(bannerWidth)}</Text>
        <Text color={colors.primary} bold> Claude-Killer . Ink TUI</Text>
        <Text color={colors.muted}> Model: {config.model}</Text>
        <Text color={colors.muted}> Type /help for commands . Ctrl+E for Hub . setas p/ navegar</Text>
        <Text color={colors.primary} bold>{"=".repeat(bannerWidth)}</Text>
      </Box>

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

      {/* System messages */}
      {/* BUG FIX (audit issue #6): use index + first 10 chars of message as key
          instead of just the message content. The old key={`sys-${msg}`}
          collided when the same system message was shown twice (e.g., user
          ran /reset twice), causing React key warnings and stale re-renders. */}
      {systemMessages.map((msg, i) => (
        <Box key={`sys-${i}-${msg.slice(0, 10)}`} flexDirection="column" marginBottom={1}>
          <Text color={colors.success}>{msg}</Text>
        </Box>
      ))}

      {/* Chat history */}
      <Box flexDirection="column" flexGrow={1}>
        <ChatDisplay messages={messages} />
      </Box>

      {/* Thinking indicator (also shows during compaction) */}
      <ThinkingIndicator
        active={status === "thinking" || status === "compacting"}
        label={status === "compacting" ? "COMPACTANDO" : undefined}
      />

      {/* Task panel */}
      <TodoPanel todos={todos} />

      {/* Autocomplete dropdown */}
      {showAutocomplete && acMatches.length > 0 && (
        <Box marginBottom={1}>
          <Autocomplete query={input} selectedIndex={acIndex} onSelect={(cmd) => setInput(cmd + " ")} />
        </Box>
      )}

      {/* Bottom bar: Input (left) + Status (right) */}
      <Box flexDirection="row" marginTop={1}>
        {/* Input section - hidden when Hub is open to prevent key leaks */}
        <Box flexGrow={1}>
          {showHub ? (
            <Text color={colors.muted}>[ Hub aberto - pressione Esc for fechar ]</Text>
          ) : (
            <>
              <Text color={colors.primary} bold>{"> "}</Text>
              <TextInput
                value={input}
                onChange={handleChange}
                onSubmit={handleSubmit}
                placeholder={status === "idle" ? "Digite sua mensagem..." : ""}
              />
            </>
          )}
        </Box>

        {/* Status bar section (right side) */}
        {lastUsage && (
          <Box marginLeft={2}>
            <StatusBar
              promptTokens={lastUsage.prompt_tokens}
              completionTokens={lastUsage.completion_tokens}
              totalTokens={lastUsage.total_tokens}
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
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
