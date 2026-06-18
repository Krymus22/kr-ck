/**
 * TodoPanel.tsx — Visual todo list with status icons.
 *
 * Width-aware: separators adapt to terminal width instead of the old
 * hardcoded innerWidth=50. Also fixes:
 *   - Key collision: now uses index + content (was just content)
 *   - Truncation: long todo text wraps instead of overflowing
 */

import React from "react";
import { Box, Text } from "ink";
import { colors, icons } from "./theme.js";
import { useTerminalWidth, truncateStr } from "./useTerminal.js";

export interface TodoItem {
  status: "pending" | "in_progress" | "completed";
  content: string;
  active_form: string;
}

interface TodoPanelProps {
  todos: TodoItem[];
}

export function TodoPanel({ todos }: Readonly<TodoPanelProps>) {
  const termWidth = useTerminalWidth();
  // Reserve space for borders/padding; cap at 80 to keep panel compact on wide terminals.
  const innerWidth = Math.max(30, Math.min(termWidth - 4, 80));

  if (todos.length === 0) return null;

  return (
    <Box flexDirection="column">
      <Text color={colors.muted}>{"-".repeat(innerWidth)}</Text>
      <Box>
        <Text color={colors.primary} bold> [{todos.length} tasks]</Text>
      </Box>
      {todos.map((t, i) => {
        let icon: React.JSX.Element;
        if (t.status === "completed") {
          icon = <Text color={colors.success}>{icons.check}</Text>;
        } else if (t.status === "in_progress") {
          icon = <Text color={colors.secondary}>{icons.dot}</Text>;
        } else {
          icon = <Text color={colors.muted}>{icons.circle}</Text>;
        }

        const display =
          t.status === "in_progress" && t.active_form ? t.active_form : t.content;
        // Truncate to fit innerWidth minus 4 chars for " > <text>" prefix.
        const truncatedDisplay = truncateStr(display, innerWidth - 4);

        // FIX: use index + content to avoid key collision when two todos
        // have the same content (common in sub-tasks).
        return (
          <Box key={`todo-${i}-${t.content.slice(0, 20)}`}>
            <Text> </Text>
            {icon}
            <Text> {truncatedDisplay}</Text>
          </Box>
        );
      })}
      <Text color={colors.muted}>{"-".repeat(innerWidth)}</Text>
    </Box>
  );
}
