/**
 * TodoPanel.tsx - Visual todo list with status icons.
 */

import React from "react";
import { Box, Text } from "ink";
import { colors, icons } from "./theme.js";

export interface TodoItem {
  status: "pending" | "in_progress" | "completed";
  content: string;
  active_form: string;
}

interface TodoPanelProps {
  todos: TodoItem[];
}

export function TodoPanel({ todos }: Readonly<TodoPanelProps>) {
  if (todos.length === 0) return null;

  const innerWidth = 50;

  return (
    <Box flexDirection="column">
      <Text color={colors.muted}>{"-".repeat(innerWidth + 2)}</Text>
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

        return (
          <Box key={t.content}>
            <Text> </Text>
            {icon}
            <Text> {display}</Text>
          </Box>
        );
      })}
      <Text color={colors.muted}>{"-".repeat(innerWidth + 2)}</Text>
    </Box>
  );
}
