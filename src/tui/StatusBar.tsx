/**
 * StatusBar.tsx — Context window usage bar + session cost + effort level + tok/s.
 * Compact single-line format for inline display next to input.
 */

import React from "react";
import { Box, Text } from "ink";
import { colors } from "./theme.js";

interface StatusBarProps {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
  warnThreshold: number;
  compactThreshold: number;
  costPerKPrompt: number;
  costPerKCompletion: number;
  planMode: boolean;
  mcpCount: number;
  skillsCount: number;
  effortLabel?: string;
  tokensPerSecond?: number;
}

function formatTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

export function StatusBar({
  promptTokens,
  completionTokens,
  totalTokens,
  contextWindow,
  warnThreshold,
  compactThreshold,
  costPerKPrompt,
  costPerKCompletion,
  planMode,
  mcpCount,
  skillsCount,
  effortLabel,
  tokensPerSecond,
}: Readonly<StatusBarProps>) {
  const pct = contextWindow > 0 ? totalTokens / contextWindow : 0;
  const fillCount = Math.round(pct * 15);
  const emptyCount = 15 - fillCount;

  let barColor: string = colors.success;
  if (pct >= compactThreshold) barColor = colors.error;
  else if (pct >= warnThreshold) barColor = colors.warning;

  const fill = "█".repeat(fillCount);
  const empty = "░".repeat(emptyCount);

  let costStr = "";
  if (costPerKPrompt > 0 || costPerKCompletion > 0) {
    const cost =
      (promptTokens / 1000) * costPerKPrompt +
      (completionTokens / 1000) * costPerKCompletion;
    if (cost > 0) {
      costStr = ` $${cost.toFixed(3)}`;
    }
  }

  const modeTag = planMode ? " [PLAN]" : "";
  const effortTag = effortLabel ? ` ${effortLabel}` : "";
  const tpsTag = tokensPerSecond && tokensPerSecond > 0
    ? ` ${tokensPerSecond.toFixed(1)} tok/s`
    : "";

  return (
    <Box flexDirection="row">
      <Text color={colors.muted}>
        {formatTok(totalTokens)}/{formatTok(contextWindow)}
      </Text>
      <Text color={barColor}> {fill}{empty} </Text>
      <Text color={barColor}>{Math.round(pct * 100)}%</Text>
      {tpsTag && <Text color={colors.muted}>{tpsTag}</Text>}
      {effortTag && <Text color={colors.primary} bold>{effortTag}</Text>}
      <Text color={colors.warning}>{costStr}</Text>
      {modeTag && <Text color={colors.warning} bold>{modeTag}</Text>}
    </Box>
  );
}
