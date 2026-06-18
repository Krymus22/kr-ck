/**
 * StatusBar.tsx - Context window usage bar + session cost + effort level + tok/s.
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
  if (n >= 1000) {
    const k = n / 1000;
    // Show "1k" instead of "1.0k" for round numbers; "1.5k" for fractions.
    return k === Math.floor(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  return `${n}`;
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
  // Clamp fillCount to [0, 15] so emptyCount never goes negative.
  // Without this, when totalTokens > contextWindow (e.g., user has more
  // tokens than the context window), emptyCount becomes negative and
  // "-".repeat(-8) throws RangeError, breaking the entire StatusBar.
  const fillCount = Math.max(0, Math.min(15, Math.round(pct * 15)));
  const emptyCount = Math.max(0, 15 - fillCount);

  let barColor: string = colors.success;
  if (pct >= compactThreshold) barColor = colors.error;
  else if (pct >= warnThreshold) barColor = colors.warning;

  const fill = "#".repeat(fillCount);
  const empty = "-".repeat(emptyCount);

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
