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
import { getPoolSize } from "../apiKeyPool.js";
import {
  getAllModes,
  getActiveModeName,
  getMode,
  applyMode,
  deactivateMode,
  suggestMode,
  confirmAndSaveMode,
} from "../modes.js";
import { getLocalizedSlashCommands, getCommandI18n } from "../i18n.js";
import { colors } from "./theme.js";
import { ChatDisplay, ChatMessage } from "./ChatDisplay.js";
import { StatusBar } from "./StatusBar.js";
import { TodoPanel, TodoItem } from "./TodoPanel.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { ExtensionHub } from "./ExtensionHub.js";

// --- Types ------------------------------------------------------------------

type AppStatus = "idle" | "thinking" | "streaming";

// --- Slash command definitions ----------------------------------------------

// --- Slash command definitions (localized via i18n) --------------------------

// Re-computed lazily; refreshed on each render to pick up language changes.
function getSlashCommands(): Array<{ cmd: string; desc: string; subcommands?: string[] }> {
  return getLocalizedSlashCommands();
}

// Backward-compat: used by /help text and tests
const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = getSlashCommands().map((c) => ({
  cmd: c.cmd,
  desc: c.desc,
}));

type CommandResult = { handled: boolean; message?: string; exit?: boolean; openHub?: boolean; resetChat?: boolean };



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
  return { handled: true, message: "Histórico resetado." };
}

function handleHistoryCommand(): CommandResult {
  const summary = history.historySummary();
  const length = history.historyLength();
  return { handled: true, message: `Histórico: ${length} mensagens (${summary})` };
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

function handleCavemanCommand(arg: string | null): CommandResult {
  const validLevels = ["lite", "full", "ultra", "wenyan-lite", "wenyan-full", "wenyan-ultra"];
  if (!arg) {
    const current = history.getCavemanLevel();
    return { handled: true, message: `Caveman: ${current ?? "desativado"}\nUso: /caveman <lite|full|ultra|off>` };
  }
  if (arg === "off" || arg === "normal") {
    history.setCavemanLevel(null);
    return { handled: true, message: "Caveman desativado!" };
  }
  if (validLevels.includes(arg)) {
    history.setCavemanLevel(arg);
    return { handled: true, message: `Caveman ativado: ${arg.toUpperCase()}` };
  }
  return { handled: true, message: `Nível inválido. Use: ${validLevels.join(", ")} ou off` };
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

function handleCompactCommand(): CommandResult {
  const result = history.compactHistory();
  if (!result) return { handled: true, message: "Nada para compactar." };
  return {
    handled: true,
    message: `Compactado: ${result.removed} msgs removidas, ${result.beforeTokens} -> ${result.afterTokens} tokens.`,
  };
}

function handleDreamCommand(): CommandResult {
  import("../memory.js").then(({ runDream, getMemoryConfig }) => {
    const config = getMemoryConfig();
    runDream(config).then((result) => {
      console.log(`\n* Dream completo: ${result.reviewedSessions} sessões revisadas, ${result.extractedSkills} skills extraídas, ${result.deduplicatedEntries} duplicatas removidas.`);
    }).catch((err) => {
      console.error(`\nX Dream falhou: ${(err as Error).message}`);
    });
  }).catch(() => {
    console.error("\nX Failed to load memory module");
  });
  return { handled: true, message: "Executando /dream - revisando memória..." };
}

function handleDistillCommand(): CommandResult {
  import("../memory.js").then(({ runDistill, getMemoryConfig }) => {
    const config = getMemoryConfig();
    runDistill(config).then((result) => {
      console.log(`\n* Distill completo: ${result.skillsExtracted} skills extraídos.`);
    }).catch((err) => {
      console.error(`\nX Distill falhou: ${(err as Error).message}`);
    });
  }).catch(() => {
    console.error("\nX Failed to load memory module");
  });
  return { handled: true, message: "Executando /distill - extraindo workflow skills..." };
}

function handleHubCommand(): CommandResult {
  return { handled: true, openHub: true };
}

function handleToolsCommand(arg: string | null): CommandResult {
  const { getRegistry } = require("../externalTools.js");
  const registry = getRegistry();
  
  const category = arg;
  const tools = category ? registry.getByCategory(category) : registry.getAll();
  
  if (tools.length === 0) {
    return { handled: true, message: category ? `Nenhuma tool na categoria "${category}".` : "Nenhuma tool disponível." };
  }
  
  const installed = tools.filter((t: any) => registry.isInstalled(t.name));
  const notInstalled = tools.filter((t: any) => !registry.isInstalled(t.name));
  
  const lines: string[] = [
    `G Tools: ${tools.length} total (${installed.length} OK / ${notInstalled.length} X)`,
    ""
  ];
  
  if (installed.length > 0) {
    lines.push("OK Instaladas:");
    installed.forEach((t: any) => {
      lines.push(`  * ${t.name} (${t.category}) - ${t.description.slice(0, 50)}`);
    });
    lines.push("");
  }
  
  if (notInstalled.length > 0) {
    lines.push("X Não instaladas:");
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
  
  const { getRegistry } = require("../externalTools.js");
  const registry = getRegistry();
  const tool = registry.get(arg);
  
  if (!tool) {
    return { handled: true, message: `Tool "${arg}" não encontrada.` };
  }
  
  const installed = registry.isInstalled(tool.name);
  
  const lines: string[] = [
    `[T] ${tool.name}`,
    `   Descrição: ${tool.description}`,
    `   Categoria: ${tool.category}`,
    `   Comando: ${tool.command} ${tool.args.join(" ")}`,
    `   Status: ${installed ? "OK Instalada" : "X Não instalada"}`,
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
      const required = flag.required ? " (obrigatório)" : "";
      const defaultVal = flag.default ? ` (padrão: ${flag.default})` : "";
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
  "/tools": (arg) => handleToolsCommand(arg),
  "/toolinfo": (arg) => handleToolInfoCommand(arg),
  "/effort": (arg) => handleEffortCommand(arg),
  "/pool": () => handlePoolCommand(),
  "/caveman": (arg) => handleCavemanCommand(arg),
  "/memory": () => handleMemoryCommand(),
  "/todos": () => handleTodosCommand(),
  "/plan": () => handlePlanCommand(),
  "/compact": () => handleCompactCommand(),
  "/dream": () => handleDreamCommand(),
  "/distill": () => handleDistillCommand(),
};

function handleEffortCommand(arg: string | null): CommandResult {
  if (!arg) {
    return { handled: true, message: `Effort atual: ${getEffortLabel()}\nUse: /effort low|medium|high|max` };
  }
  const valid = ["low", "medium", "high", "max"];
  if (!valid.includes(arg)) {
    return { handled: true, message: `Nível inválido: ${arg}\nOpções: low, medium, high, max` };
  }
  setEffortLevel(arg as any);
  return { handled: true, message: `Effort alterado para: ${getEffortLabel()}` };
}

function handleModeCommand(arg: string | null): CommandResult {
  const allModes = getAllModes();
  const activeName = getActiveModeName();

  // No arg: list all modes
  if (!arg) {
    if (allModes.length === 0) {
      return { handled: true, message: "Nenhum modo disponível. Use: /mode create <descrição>" };
    }
    const lines = allModes.map((m) => {
      const active = m.name === activeName ? " [ATIVO]" : "";
      const kind = m.builtIn ? "(built-in)" : "(user)";
      return `  ${m.name.padEnd(20)} ${kind.padEnd(12)} ${m.label}${active}`;
    });
    return {
      handled: true,
      message: `Modos disponíveis:\n${lines.join("\n")}\n\n` +
               `Ativo: ${activeName ?? "(nenhum)"}\n\n` +
               `Use: /mode <nome> para ativar | /mode off para desativar | /mode create <descrição> para criar novo`,
    };
  }

  // /mode off - deactivate
  if (arg === "off" || arg === "none") {
    deactivateMode();
    return { handled: true, message: "Modo desativado. Nenhuma validação automática ativa." };
  }

  // /mode create <description> - AI-assisted mode creation
  if (arg.startsWith("create ") || arg.startsWith("new ")) {
    const prompt = arg.replace(/^(create|new)\s+/, "").trim();
    if (!prompt) {
      return { handled: true, message: "Descrição vazia. Use: /mode create <o que você quer fazer>" };
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
        `Razão: ${suggestion.reasoning}\n\n` +
        `Ferramentas a ativar (${suggestion.enableTools.length}):\n` +
        suggestion.enableTools.map((t) => `  - ${t}`).join("\n") + "\n\n" +
        `Skills a ativar (${suggestion.enableSkills.length}):\n` +
        (suggestion.enableSkills.length > 0
          ? suggestion.enableSkills.map((s) => `  - ${s}`).join("\n")
          : "  (nenhuma)") + "\n\n" +
        `Features a ativar (${suggestion.enableFeatures.length}):\n` +
        suggestion.enableFeatures.map((f) => `  - ${f}`).join("\n") + "\n\n" +
        `Configurações:\n` +
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
  const parts = arg.split(/\s+/).filter(Boolean);
  const modeName = parts[0]!;
  const contextAction = parts[1]?.toLowerCase();  // "new" | "keep" | undefined

  const mode = getMode(modeName);
  if (!mode) {
    return { handled: true, message: `Modo "${modeName}" não encontrado. Use: /mode (sem args) para listar.` };
  }

  // If no context action specified, ask the user which they want
  if (!contextAction || (contextAction !== "new" && contextAction !== "keep")) {
    return {
      handled: true,
      message:
        `Ativando modo "${modeName}" (${mode.label})...\n\n` +
        `Escolha uma opção:\n` +
        `  /mode ${modeName} new   → Ativa modo + inicia chat novo (contexto limpo)\n` +
        `  /mode ${modeName} keep  → Ativa modo + mantém chat atual (mesmo contexto)\n\n` +
        `Tools: ${mode.enableTools.length} | Skills: ${mode.enableSkills.length} | Features: ${mode.enableFeatures.length}\n` +
        `Effort: ${mode.effortLevel ?? "default"} | Strict: ${mode.strictMode ?? false} | ` +
        `Validation: ${(mode.luauValidation?.length ?? 0) + (mode.validation?.length ?? 0)} regra(s)`,
    };
  }

  // Activate the mode
  applyMode(modeName).then((result) => {
    if (result.success) {
      console.log(`[modes] Modo "${modeName}" ativado: ${result.toolsEnabled.length} tools, ${result.featuresEnabled.length} features`);
    } else {
      console.error(`[modes] Erro ao ativar: ${result.errors.join(", ")}`);
    }
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
        `✅ Modo "${modeName}" (${mode.label}) ativado!\n` +
        `🧹 Chat reiniciado - contexto limpo.\n\n` +
        `Tools: ${mode.enableTools.length} | Skills: ${mode.enableSkills.length} | Features: ${mode.enableFeatures.length}\n` +
        `Effort: ${mode.effortLevel ?? "default"} | Strict: ${mode.strictMode ?? false}\n\n` +
        `Pronto para começar. O que você quer fazer?`,
    };
  }

  // contextAction === "keep"
  return {
    handled: true,
    message:
      `✅ Modo "${modeName}" (${mode.label}) ativado!\n` +
      `💬 Chat mantido - contexto atual preservado.\n\n` +
      `Tools: ${mode.enableTools.length} | Skills: ${mode.enableSkills.length} | Features: ${mode.enableFeatures.length}\n` +
      `Effort: ${mode.effortLevel ?? "default"} | Strict: ${mode.strictMode ?? false}\n\n` +
      `As ferramentas do modo foram adicionadas. Continue conversando.`,
  };
}

function handlePoolCommand(): CommandResult {
  const size = getPoolSize();
  if (size === 0) {
    return { handled: true, message: "Pool: modo single-key (configure NVIDIA_API_KEYS para multi-key)" };
  }
  const { formatPoolStats } = require("../apiKeyPool.js");
  return { handled: true, message: formatPoolStats() };
}

function handleSlashCommand(input: string): CommandResult {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1]?.toLowerCase() || null;

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
          {" "}(mostrando {startIdx + 1}-{endIdx} de {total} - use ↑↓ para navegar)
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
  const [effortLabel, setEffortLabel] = useState(getEffortLabel());
  const [systemMessages, setSystemMessages] = useState<string[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [showHub, setShowHub] = useState(false);

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

    const response = await runAgentLoop(
      fullInput,
      () => {
        streamStarted = true;
        streamStartTime = Date.now();
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
        // Update tok/s every 10 tokens
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
        // Final tok/s calculation
        if (streamStartTime > 0 && usage.completion_tokens > 0) {
          const elapsed = (Date.now() - streamStartTime) / 1000;
          if (elapsed > 0) setTokensPerSecond(Math.round(usage.completion_tokens / elapsed * 10) / 10);
        }
        // Refresh effort label (might have changed via /effort)
        setEffortLabel(getEffortLabel());
      }
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
    const result = handleSlashCommand(trimmed);
    if (result.exit) {
      exit();
      return true;
    }
    if (result.handled) {
      if (result.openHub) {
        setShowHub(true);
      }
      if (result.resetChat) {
        setMessages([]);
      }
      if (result.message) {
        setSystemMessages((prev) => [...prev, result.message!]);
      }
      isProcessing.current = false;
      setStatus("idle");
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
      if (showAutocomplete && acMatches.length > 0) {
        const selected = acMatches[acIndex];
    if (selected?.label) {
          if (hasSpace) {
            // Subcommand selected - build the full command + subcommand and continue to execute
            const spaceIdx = trimmedValue.indexOf(" ");
            const cmdPart = trimmedValue.slice(0, spaceIdx);
            trimmedValue = `${cmdPart} ${selected.label}`;
            setInput(trimmedValue);
            setAcIndex(0);
            // Fall through to actual command execution below
          } else {
            // Command selected - add space so user can type subcommand
            setInput(selected.label + " ");
            setAcIndex(0);
            return;
          }
        }
      }

      setInput("");
      setAcIndex(0);
      isProcessing.current = true;
      setStatus("thinking");

      // Handle slash commands
      if (trimmedValue.startsWith("/")) {
        const exitCalled = handleSlashCommandFlow(trimmedValue);
        if (exitCalled) return;
      }

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
        setSystemMessages((prev) => [...prev, `Erro: ${(err as Error).message}`]);
        setMessages((prev) => prev.filter((m) => !m.isStreaming));
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
  return (
    <Box flexDirection="column" padding={1}>
      {/* Banner */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.primary} bold>{"=".repeat(50)}</Text>
        <Text color={colors.primary} bold> Claude-Killer . Ink TUI</Text>
        <Text color={colors.muted}> Model: {config.model}</Text>
        <Text color={colors.muted}> Type /help for commands . Ctrl+E for Hub . ^v to navigate</Text>
        <Text color={colors.primary} bold>{"=".repeat(50)}</Text>
      </Box>

      {/* Extension Hub overlay */}
      {showHub && (
        <Box marginBottom={1}>
          <ExtensionHub onClose={() => setShowHub(false)} />
        </Box>
      )}

      {/* System messages */}
      {systemMessages.map((msg, i) => (
        <Box key={`sys-${msg}`} flexDirection="column" marginBottom={1}>
          <Text color={colors.success}>{msg}</Text>
        </Box>
      ))}

      {/* Chat history */}
      <Box flexDirection="column" flexGrow={1}>
        <ChatDisplay messages={messages} />
      </Box>

      {/* Thinking indicator */}
      <ThinkingIndicator active={status === "thinking"} />

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
            <Text color={colors.muted}>[ Hub aberto - pressione Esc para fechar ]</Text>
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
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
