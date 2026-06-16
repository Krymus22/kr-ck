/**
 * App.tsx — Main Ink application component.
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
import { discoverExtensions } from "../extensionCenter.js";
import { colors } from "./theme.js";
import { ChatDisplay, ChatMessage } from "./ChatDisplay.js";
import { StatusBar } from "./StatusBar.js";
import { TodoPanel, TodoItem } from "./TodoPanel.js";
import { ThinkingIndicator } from "./ThinkingIndicator.js";
import { ExtensionHub } from "./ExtensionHub.js";

// ─── Types ──────────────────────────────────────────────────────────────────

type AppStatus = "idle" | "thinking" | "streaming";

// ─── Slash command definitions ──────────────────────────────────────────────

const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: "/help", desc: "Show help" },
  { cmd: "/hub", desc: "Extension Hub (control center)" },
  { cmd: "/reset", desc: "Clear history" },
  { cmd: "/history", desc: "History summary" },
  { cmd: "/skills", desc: "List skills" },
  { cmd: "/plugins", desc: "List MCP servers" },
  { cmd: "/tools", desc: "List external tools" },
  { cmd: "/toolinfo", desc: "Show tool details" },
  { cmd: "/caveman", desc: "Toggle caveman mode" },
  { cmd: "/memory", desc: "Show project memory" },
  { cmd: "/todos", desc: "Show todo list" },
  { cmd: "/plan", desc: "Toggle plan mode" },
  { cmd: "/compact", desc: "Compact context" },
  { cmd: "/dream", desc: "Review & compress memory" },
  { cmd: "/distill", desc: "Extract workflow skills" },
  { cmd: "/exit", desc: "Exit" },
];

type CommandResult = { handled: boolean; message?: string; exit?: boolean; openHub?: boolean };



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
  const text = skills.map((s) => `  • ${s.name}: ${s.description}`).join("\n");
  return { handled: true, message: `Skills:\n${text}` };
}

function handlePluginsCommand(): CommandResult {
  const servers = getActiveMCPServers();
  if (servers.length === 0) return { handled: true, message: "Nenhum servidor MCP ativo." };
  const text = servers.map((s) => `  • ${s}`).join("\n");
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
      ? "Modo Plan DESATIVADO — ferramentas executadas normalmente."
      : "Modo Plan ATIVADO — modelo cria plano sem executar ferramentas.",
  };
}

function handleCompactCommand(): CommandResult {
  const result = history.compactHistory();
  if (!result) return { handled: true, message: "Nada para compactar." };
  return {
    handled: true,
    message: `Compactado: ${result.removed} msgs removidas, ${result.beforeTokens} → ${result.afterTokens} tokens.`,
  };
}

function handleDreamCommand(): CommandResult {
  import("../memory.js").then(({ runDream, getMemoryConfig }) => {
    const config = getMemoryConfig();
    runDream(config).then((result) => {
      console.log(`\n✦ Dream completo: ${result.reviewedSessions} sessões revisadas, ${result.extractedSkills} skills extraídas, ${result.deduplicatedEntries} duplicatas removidas.`);
    }).catch((err) => {
      console.error(`\n✗ Dream falhou: ${(err as Error).message}`);
    });
  }).catch(() => {
    console.error("\n✗ Failed to load memory module");
  });
  return { handled: true, message: "Executando /dream — revisando memória..." };
}

function handleDistillCommand(): CommandResult {
  import("../memory.js").then(({ runDistill, getMemoryConfig }) => {
    const config = getMemoryConfig();
    runDistill(config).then((result) => {
      console.log(`\n✦ Distill completo: ${result.skillsExtracted} skills extraídos.`);
    }).catch((err) => {
      console.error(`\n✗ Distill falhou: ${(err as Error).message}`);
    });
  }).catch(() => {
    console.error("\n✗ Failed to load memory module");
  });
  return { handled: true, message: "Executando /distill — extraindo workflow skills..." };
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
    `📊 Tools: ${tools.length} total (${installed.length} ✅ / ${notInstalled.length} ❌)`,
    ""
  ];
  
  if (installed.length > 0) {
    lines.push("✅ Instaladas:");
    installed.forEach((t: any) => {
      lines.push(`  • ${t.name} (${t.category}) — ${t.description.slice(0, 50)}`);
    });
    lines.push("");
  }
  
  if (notInstalled.length > 0) {
    lines.push("❌ Não instaladas:");
    notInstalled.forEach((t: any) => {
      lines.push(`  • ${t.name} (${t.category}) — ${t.description.slice(0, 50)}`);
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
    `🔧 ${tool.name}`,
    `   Descrição: ${tool.description}`,
    `   Categoria: ${tool.category}`,
    `   Comando: ${tool.command} ${tool.args.join(" ")}`,
    `   Status: ${installed ? "✅ Instalada" : "❌ Não instalada"}`,
    "",
    "   Quando usar:"
  ];
  
  tool.context.whenToUse.forEach((pattern: string) => {
    lines.push(`     • ${pattern}`);
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
  "/reset": () => handleResetCommand(),
  "/history": () => handleHistoryCommand(),
  "/skills": () => handleSkillsCommand(),
  "/plugins": () => handlePluginsCommand(),
  "/tools": (arg) => handleToolsCommand(arg),
  "/toolinfo": (arg) => handleToolInfoCommand(arg),
  "/caveman": (arg) => handleCavemanCommand(arg),
  "/memory": () => handleMemoryCommand(),
  "/todos": () => handleTodosCommand(),
  "/plan": () => handlePlanCommand(),
  "/compact": () => handleCompactCommand(),
  "/dream": () => handleDreamCommand(),
  "/distill": () => handleDistillCommand(),
};

function handleSlashCommand(input: string): CommandResult {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts[1]?.toLowerCase() || null;

  const handler = COMMAND_HANDLERS[cmd];
  if (handler) return handler(arg);
  return { handled: false };
}

// ─── @-mention expansion ────────────────────────────────────────────────────

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

// ─── Autocomplete Component ─────────────────────────────────────────────────

interface AutocompleteProps {
  query: string;
  selectedIndex: number;
  onSelect: (cmd: string) => void;
}

function Autocomplete({ query, selectedIndex, onSelect }: Readonly<AutocompleteProps>) {
  const matches = useMemo(() => {
    if (!query.startsWith("/")) return [];
    const lower = query.toLowerCase();
    return SLASH_COMMANDS.filter((s) => s.cmd.startsWith(lower));
  }, [query]);

  if (matches.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={colors.muted} paddingLeft={1} paddingRight={1}>
      {matches.map((m, i) => (
        <Box key={m.cmd}>
          <Text color={i === selectedIndex ? colors.primary : colors.muted} bold={i === selectedIndex}>
            {i === selectedIndex ? "❯ " : "  "}
          </Text>
          <Text color={i === selectedIndex ? colors.primary : colors.white} bold={i === selectedIndex}>
            {m.cmd.padEnd(14)}
          </Text>
          <Text color={colors.muted}>{m.desc}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ─── App Component ──────────────────────────────────────────────────────────

export function App() {
  const { exit } = useApp();

  // ── State ──────────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<AppStatus>("idle");
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [lastUsage, setLastUsage] = useState<{
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } | null>(null);
  const [systemMessages, setSystemMessages] = useState<string[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [showHub, setShowHub] = useState(false);

  const isProcessing = useRef(false);

  // ── Autocomplete state ─────────────────────────────────────────────────
  const showAutocomplete = input.startsWith("/") && input.length > 0 && !input.includes(" ");
  const acMatches = useMemo(() => {
    if (!showAutocomplete) return [];
    const lower = input.toLowerCase();
    return SLASH_COMMANDS.filter((s) => s.cmd.startsWith(lower));
  }, [input, showAutocomplete]);

  // ── Discover extensions on mount ────────────────────────────────────
  useMemo(() => {
    discoverExtensions();
  }, []);

  // ── Update todos from shared state ─────────────────────────────────────
  const syncTodos = useCallback(() => {
    const current = todo.getTodos();
    setTodos([...current]);
  }, []);

  // ── Submit handler ─────────────────────────────────────────────────────
  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isProcessing.current) {
        setInput("");
        return;
      }

      // If autocomplete is showing and user hits Enter, use selected command
      if (showAutocomplete && acMatches.length > 0) {
        const selected = acMatches[acIndex];
        if (selected) {
          setInput(selected.cmd + " ");
          setAcIndex(0);
          return;
        }
      }

      setInput("");
      setAcIndex(0);
      isProcessing.current = true;
      setStatus("thinking");

      // Handle slash commands
      if (trimmed.startsWith("/")) {
        const result = handleSlashCommand(trimmed);
        if (result.exit) {
          exit();
          return;
        }
        if (result.handled) {
          if (result.openHub) {
            setShowHub(true);
          }
          if (result.message) {
            setSystemMessages((prev) => [...prev, result.message!]);
          }
          isProcessing.current = false;
          setStatus("idle");
          return;
        }
        // Unknown command — fall through to agent
      }

      // Add user message to display
      const userMsg: ChatMessage = { role: "user", content: trimmed };
      setMessages((prev) => [...prev, userMsg]);

      // Expand @-mentions
      const expanded = expandAtMentions(trimmed);

      // Plan mode suffix
      const planSuffix = history.isPlanMode()
        ? "\n\n[PLAN MODE IS ACTIVE] You must NOT call any tools. Output a step-by-step plan as markdown. End with ===END PLAN==="
        : "";
      const fullInput = expanded + planSuffix;

      try {
        let streamContent = "";
        let streamStarted = false;

        const response = await runAgentLoop(
          fullInput,
          () => {
            streamStarted = true;
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
          }
        );

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
    [exit, syncTodos, showAutocomplete, acMatches, acIndex]
  );

  // ── Input change handler ───────────────────────────────────────────────
  const handleChange = useCallback((val: string) => {
    setInput(val);
    setAcIndex(0);
  }, []);

  // ── Keyboard navigation for autocomplete + global shortcuts ───────────
  useInput((inputChar, key) => {
    // Ctrl+E opens Extension Hub
    if (key.ctrl && inputChar === "e") {
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

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" padding={1}>
      {/* Banner */}
      <Box flexDirection="column" marginBottom={1}>
        <Text color={colors.primary} bold>{"═".repeat(50)}</Text>
        <Text color={colors.primary} bold> Claude-Killer · Ink TUI</Text>
        <Text color={colors.muted}> Model: {config.model}</Text>
        <Text color={colors.muted}> Type /help for commands · Ctrl+E for Hub · ↑↓ to navigate</Text>
        <Text color={colors.primary} bold>{"═".repeat(50)}</Text>
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
        {/* Input section */}
        <Box flexGrow={1}>
          <Text color={colors.primary} bold>❯ </Text>
          <TextInput
            value={input}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder={status === "idle" ? "Digite sua mensagem..." : ""}
          />
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
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
