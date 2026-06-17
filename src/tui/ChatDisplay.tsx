/**
 * ChatDisplay.tsx - Renders the conversation history with styled messages.
 */

import React from "react";
import { Box, Text } from "ink";
import { colors } from "./theme.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  isStreaming?: boolean;
}

interface ChatDisplayProps {
  messages: ChatMessage[];
  maxVisible?: number;
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

        if (msg.role === "user") {
          return (
            <Box key={`${msg.role}-${i}`} flexDirection="column">
              <Text color={colors.primary} bold> você:</Text>
              <Text color={colors.white}> {msg.content}</Text>
              <Text></Text>
            </Box>
          );
        }

        // assistant
        return (
          <Box key={`${msg.role}-${i}`} flexDirection="column">
            <Text color={colors.secondary} bold> Claude-Killer:</Text>
            <Text color={colors.white}>{msg.content}</Text>
            {msg.isStreaming ? null : <Text></Text>}
          </Box>
        );
      })}
    </Box>
  );
}
