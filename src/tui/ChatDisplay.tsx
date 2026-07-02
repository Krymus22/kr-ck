/**
 * ChatDisplay.tsx - Renders the conversation history with styled messages.
 *
 * All messages use a single leading space (" ") for consistent left margin
 * alignment. Without this, the assistant content starts at column 1 while
 * the user content starts at column 2, making the conversation look jagged.
 *
 * Message types:
 *   - user:      what the user typed (cyan label "você:")
 *   - assistant: what the model replied (violet label "Claude-Killer:")
 *   - tool:      tool calls + results (grey, indented, with icon)
 *                — shown in CHRONOLOGICAL ORDER mixed with user/assistant
 *   - system:    filtered out (internal context, not shown to user)
 */

import React from "react";
import { Box, Text } from "ink";
import { colors, icons } from "./theme.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  isStreaming?: boolean;
  /** For tool messages: the tool name (e.g., "ler_arquivo"). */
  toolName?: string;
  /** For tool messages: whether this is the call (false) or the result (true). */
  isResult?: boolean;
  /** For tool messages: whether the tool succeeded (only for isResult=true). */
  ok?: boolean;
  /** For assistant messages: whether this is an error message (displayed in red). */
  isError?: boolean;
}

interface ChatDisplayProps {
  messages: ChatMessage[];
  maxVisible?: number;
}

/**
 * Truncate a long string to fit in the terminal, preserving the start and end.
 * Examples:
 *   truncateMiddle("hello world this is a long string", 20) → "hello wor…ng string"
 */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1; // 1 char for the ellipsis
  const start = Math.ceil(keep * 0.6);
  const end = Math.floor(keep * 0.4);
  return s.slice(0, start) + "…" + s.slice(s.length - end);
}

/**
 * Format tool args for display. Shows the most relevant field (path, comando, query)
 * in a compact single-line format.
 */
function formatToolArgs(args: Record<string, unknown>): string {
  const path = args.path ?? args.caminho ?? args.filePath;
  if (typeof path === "string") return truncateMiddle(path, 50);
  const cmd = args.comando ?? args.command;
  if (typeof cmd === "string") return truncateMiddle(cmd, 50);
  const query = args.query ?? args.consulta ?? args.questao;
  if (typeof query === "string") return truncateMiddle(query, 50);
  const json = JSON.stringify(args);
  return truncateMiddle(json, 50);
}

/**
 * Format tool result for display. Truncates long outputs to keep the chat readable.
 */
function formatToolResult(resultStr: string): string {
  // Take only the first 3 lines and truncate to 200 chars total
  const lines = resultStr.split("\n").slice(0, 3);
  const joined = lines.join("\n");
  return truncateMiddle(joined, 200);
}

/**
 * Truncate messages to fit the terminal height.
 * Shows the last N messages to keep context visible.
 */
export function ChatDisplay({ messages, maxVisible = 50 }: Readonly<ChatDisplayProps>) {
  const visible = messages.slice(-maxVisible);

  return (
    <Box flexDirection="column">
      {visible.map((msg, i) => {
        if (msg.role === "system") return null;

        // Tool messages: render with icon, indented, grey
        if (msg.role === "tool") {
          const label = msg.isResult
            ? (msg.ok ? `${icons.check} ${msg.toolName ?? "tool"}` : `${icons.cross} ${msg.toolName ?? "tool"}`)
            : `${icons.arrow} ${msg.toolName ?? "tool"}(${formatToolArgs(parseArgsSafe(msg.content))})`;
          return (
            <Box key={`${msg.role}-${i}`} flexDirection="column">
              <Text color={msg.isResult ? (msg.ok ? colors.success : colors.error) : colors.muted}>
                {"  "}{label}
              </Text>
              {msg.isResult && (
                <Text color={colors.muted}>{"    "}{formatToolResult(msg.content)}</Text>
              )}
            </Box>
          );
        }

        if (msg.role === "user") {
          return (
            <Box key={`${msg.role}-${i}`} flexDirection="column">
              <Text color={colors.primary} bold> you:</Text>
              <Text color={colors.white}> {msg.content}</Text>
              <Text></Text>
            </Box>
          );
        }

        // assistant - note the leading space in content for alignment
        return (
          <Box key={`${msg.role}-${i}`} flexDirection="column">
            <Text color={msg.isError ? colors.error : colors.secondary} bold> {msg.isError ? "❌ Erro:" : "Claude-Killer:"}</Text>
            <Text color={msg.isError ? colors.error : colors.white}> {msg.content}</Text>
            {msg.isStreaming ? null : <Text></Text>}
          </Box>
        );
      })}
    </Box>
  );
}

/** Safely parse args stored as JSON string in msg.content (for tool call messages). */
function parseArgsSafe(content: string): Record<string, unknown> {
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}
