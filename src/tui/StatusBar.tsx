/**
 * StatusBar.tsx — Context window usage bar + session cost + effort level + tok/s.
 * Compact single-line format for inline display next to input.
 *
 * Layout: [tokens] [bar] [%] [tok/s] [effort] [$sessionCost] [turnCost] [MCPs:N] [Skills:N] [PLAN]
 *
 * Cost display:
 *   - $sessionCost (warning color) — CUMULATIVE across the whole session
 *   - turnCost (muted, in parens) — last-turn cost, useful to see per-request spend
 *
 * Token display:
 *   - The 15-char bar reflects CURRENT context window usage (last turn's total
 *     tokens / contextWindow). This is what determines when auto-compact triggers.
 *   - Cumulative session tokens are NOT shown in the bar (they'd always hit 100%
 *     after a few turns) but the turn count and totals are tracked in App.tsx.
 */

import React from "react";
import { Box, Text } from "ink";
import { colors } from "./theme.js";

interface StatusBarProps {
  /** Last-turn prompt tokens (from API usage object). */
  promptTokens: number;
  /** Last-turn completion tokens. */
  completionTokens: number;
  /** Last-turn total tokens (prompt + completion). */
  totalTokens: number;
  /** Model's context window size in tokens. */
  contextWindow: number;
  /** Threshold (0-1) of context window that triggers auto-compact. */
  warnThreshold: number;
  /** Threshold (0-1) of context window that triggers warning color. */
  compactThreshold: number;
  /** Cost per 1k prompt tokens (USD). */
  costPerKPrompt: number;
  /** Cost per 1k completion tokens (USD). */
  costPerKCompletion: number;
  /** Whether plan mode is active (shows [PLAN] tag). */
  planMode: boolean;
  /** Number of active MCP servers — rendered as [MCPs:N]. */
  mcpCount: number;
  /** Number of active skills — rendered as [Skills:N]. */
  skillsCount: number;
  /** Effort level label (LOW/MEDIUM/HIGH/MAX). */
  effortLabel?: string;
  /** Tokens per second from the last stream (0 if not streaming). */
  tokensPerSecond?: number;
  /** Cumulative session-wide prompt tokens (all turns). */
  sessionPromptTokens?: number;
  /** Cumulative session-wide completion tokens (all turns). */
  sessionCompletionTokens?: number;
  /** Cumulative session cost in USD (all turns). */
  sessionCost?: number;
}

function formatTok(n: number): string {
  // Millions: 1M, 1.5M, 2M (not 1000k, 1500k)
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return m === Math.floor(m) ? `${m}M` : `${m.toFixed(1)}M`;
  }
  // Thousands: 1k, 1.5k, 10k, 100k, 999k (not 1.0k, 153.6k)
  if (n >= 1000) {
    const k = n / 1000;
    if (k >= 100) {
      // For 100k+, round to integer (100k, 154k, 999k)
      return `${Math.round(k)}k`;
    }
    // For 1k-99k, show one decimal only if not round (1k, 1.5k, 10k, 50.5k)
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
  sessionPromptTokens = 0,
  sessionCompletionTokens = 0,
  sessionCost = 0,
}: Readonly<StatusBarProps>) {
  // Bar reflects CURRENT context usage (last turn), not cumulative.
  // Cumulative would always max out the bar after a few turns.
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

  // Turn cost = last-turn prompt + completion cost
  let turnCostStr = "";
  if (costPerKPrompt > 0 || costPerKCompletion > 0) {
    const turnCost =
      (promptTokens / 1000) * costPerKPrompt +
      (completionTokens / 1000) * costPerKCompletion;
    if (turnCost > 0) {
      turnCostStr = ` (+$${turnCost.toFixed(3)})`;
    }
  }

  // Session cost (cumulative across all turns) — primary cost display.
  // Falls back to turn cost if session tracking not enabled.
  let sessionCostStr = "";
  if (sessionCost > 0) {
    // Format: $0.123 for small, $1.50 for medium, $12.34 for large
    sessionCostStr = sessionCost < 1
      ? `$${sessionCost.toFixed(3)}`
      : `$${sessionCost.toFixed(2)}`;
  }

  const modeTag = planMode ? " [PLAN]" : "";
  const effortTag = effortLabel ? ` ${effortLabel}` : "";
  const tpsTag = tokensPerSecond && tokensPerSecond > 0
    ? ` ${tokensPerSecond.toFixed(1)} tok/s`
    : "";
  // Show MCPs and Skills counts (audit issue #4: previously these props were
  // declared but never rendered). Hidden when 0 to keep the bar compact.
  const mcpTag = mcpCount > 0 ? ` M:${mcpCount}` : "";
  const skillsTag = skillsCount > 0 ? ` S:${skillsCount}` : "";
  // Show cumulative session tokens as a subtle hint that the bar reflects
  // only the current turn, not the whole session.
  const sessionTokTag = (sessionPromptTokens + sessionCompletionTokens) > 0
    ? ` ses:${formatTok(sessionPromptTokens + sessionCompletionTokens)}`
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
      {sessionCostStr && <Text color={colors.warning}> ${sessionCostStr}</Text>}
      {turnCostStr && <Text color={colors.muted}>{turnCostStr}</Text>}
      {sessionTokTag && <Text color={colors.muted}>{sessionTokTag}</Text>}
      {mcpTag && <Text color={colors.secondary}>{mcpTag}</Text>}
      {skillsTag && <Text color={colors.secondary}>{skillsTag}</Text>}
      {modeTag && <Text color={colors.warning} bold>{modeTag}</Text>}
    </Box>
  );
}
