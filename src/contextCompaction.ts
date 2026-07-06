/**
 * contextCompaction.ts - Intelligent context compaction: summarize old messages,
 * compress tool results, merge similar messages.
 *
 * IDEIA 3: Added "model-based compaction" strategy that calls the LLM to
 * produce a high-fidelity summary preserving architectural decisions,
 * unresolved bugs, and planned next steps. Mirrors Claude Code's approach
 * described in Anthropic's "Effective Context Engineering" article.
 */

import * as history from "./history.js";
import { chat } from "./apiClient.js";
import { shouldUseIntelligentCompaction } from "./effortLevels.js";
import * as log from "./logger.js";

export interface CompactionStrategy {
  name: string;
  shouldApply: (messages: any[]) => boolean;
  apply: (messages: any[]) => any[];
}

const strategies: CompactionStrategy[] = [
  {
    name: "remove-consecutive-same-role",
    shouldApply: (msgs) => msgs.some((m, i) => i > 0 && m.role === msgs[i - 1]?.role && m.role !== "system"),
    apply: (msgs) => {
      const result = [msgs[0]]; // keep system
      for (let i = 1; i < msgs.length; i++) {
        const prev = result.at(-1);
        const curr = msgs[i];
        if (curr.role === prev?.role && curr.role !== "system" && curr.role !== "user") {
          // Merge content
          if (typeof curr.content === "string" && typeof prev.content === "string") {
            prev.content = prev.content + "\n" + curr.content;
          }
        } else {
          result.push(curr);
        }
      }
      return result;
    },
  },
  {
    name: "compress-long-tool-results",
    shouldApply: (msgs) => msgs.some((m) => m.role === "tool" && typeof m.content === "string" && m.content.length > 2000),
    apply: (msgs) => {
      return msgs.map((m) => {
        if (m.role === "tool" && typeof m.content === "string" && m.content.length > 2000) {
          // Keep first 500 and last 500 chars
          const truncated = m.content.slice(0, 500) + "\n...[COMPACTED]...\n" + m.content.slice(-500);
          return { ...m, content: truncated };
        }
        return m;
      });
    },
  },
  {
    name: "merge-adjacent-tool-results",
    shouldApply: (msgs) => {
      let consecutive = 0;
      for (let i = 1; i < msgs.length; i++) {
        if (msgs[i].role === "tool" && msgs[i - 1]?.role === "tool") consecutive++;
        if (consecutive >= 3) return true;
      }
      return false;
    },
    apply: (msgs) => {
      const result: any[] = [];
      let i = 0;
      while (i < msgs.length) {
        if (msgs[i].role === "tool") {
          // Collect consecutive tool results
          const toolResults: any[] = [];
          while (i < msgs.length && msgs[i].role === "tool") {
            toolResults.push(msgs[i]);
            i++;
          }
          // Merge into a single summary
          if (toolResults.length > 2) {
            const summary = toolResults.map((t) => {
              const preview = typeof t.content === "string" ? t.content.slice(0, 100) : "";
              return `[${t.tool_call_id}]: ${preview}...`;
            }).join("\n");
            result.push({ ...toolResults[0], content: summary });
          } else {
            result.push(...toolResults);
          }
        } else {
          result.push(msgs[i]);
          i++;
        }
      }
      return result;
    },
  },
  {
    name: "remove-old-error-messages",
    shouldApply: (msgs) => {
      let errorCount = 0;
      return msgs.some((m) => {
        if (m.role === "tool" && typeof m.content === "string" && m.content.includes("[ERROR]")) {
          errorCount++;
          return errorCount > 5;
        }
        return false;
      });
    },
    apply: (msgs) => {
      const result: any[] = [];
      let errorCount = 0;
      for (const msg of msgs) {
        if (msg.role === "tool" && typeof msg.content === "string" && msg.content.includes("[ERROR]")) {
          errorCount++;
          if (errorCount > 3) continue; // skip old errors
        }
        result.push(msg);
      }
      return result;
    },
  },
];

export function compactIntelligently(messages: any[]): { messages: any[]; appliedStrategies: string[] } {
  const appliedStrategies: string[] = [];
  let result = [...messages];

  for (const strategy of strategies) {
    if (strategy.shouldApply(result)) {
      result = strategy.apply(result);
      appliedStrategies.push(strategy.name);
    }
  }

  return { messages: result, appliedStrategies };
}

export { strategies };

export async function smartCompact(maxTokens: number = 50000): Promise<{ compacted: boolean; savedTokens: number }> {
  const before = history.estimateTokens();

  if (before <= maxTokens) {
    return { compacted: false, savedTokens: 0 };
  }

  log.info(`[COMPACTION] Context at ${before} tokens (threshold ${maxTokens}) — compacting SYNCHRONOUSLY (agent paused)`);
  console.log(`[COMPACTION] Auto-compacting context (${before} tokens > ${maxTokens} threshold). The IA may lose some older context.`);

  // IDEIA 3: When context is critically full AND effort allows, use the
  // model to produce a high-fidelity summary. This preserves architectural
  // decisions, unresolved bugs, and planned next steps - much better than
  // blind truncation. Mirrors Claude Code's compaction approach.
  //
  // CRITICAL FIX: smartCompact is now ASYNC and BLOCKING. Previously it was
  // sync and kicked off compaction in the background (fire-and-forget), which
  // meant the agent continued with the un-compacted context AND a parallel
  // chat() call was running — doubling memory pressure and causing OOM kills.
  // Now: smartCompact awaits the compaction, the agent PAUSES until it's done.
  if (shouldUseIntelligentCompaction() && before > maxTokens * 1.2) {
    const modelCompacted = await modelBasedCompactionAsync();
    if (modelCompacted.compacted) {
      log.success(`[COMPACTION] Model-based compaction saved ${modelCompacted.savedTokens} tokens`);
      return modelCompacted;
    }
    // If model-based failed (network, etc.), fall through to heuristics
  }

  // Apply heuristic compaction strategies
  const messages = history.getHistory();
  const { messages: compacted, appliedStrategies } = compactIntelligently(messages);

  // BUG FIX: previously, `compacted` was computed by compactIntelligently but
  // NEVER applied to the live history — `history.replaceHistory(compacted)`
  // was missing. The function then reported "saved X tokens" based on the
  // compacted array's token count, but the actual history array was
  // unchanged, so the IA kept sending the full un-compacted context to the
  // API. Worse, the "remove-consecutive-same-role" strategy MUTATES the
  // original message objects (it concatenates `prev.content += curr.content`),
  // so the live history ended up with duplicated merged content while still
  // keeping the now-redundant second message. Now we actually replace
  // history with the compacted array when at least one strategy applied.
  if (appliedStrategies.length > 0) {
    history.replaceHistory(compacted as any);
  }

  // If compaction wasn't enough, fall back to aggressive compaction
  if (history.estimateTokens() > maxTokens) {
    const aggressiveResult = history.compactHistory();
    if (aggressiveResult) {
      log.success(`[COMPACTION] Aggressive compaction saved ${aggressiveResult.beforeTokens - aggressiveResult.afterTokens} tokens`);
      return { compacted: true, savedTokens: aggressiveResult.beforeTokens - aggressiveResult.afterTokens };
    }
  }

  const after = history.estimateTokens();
  const saved = before - after;
  if (saved > 0) {
    log.success(`[COMPACTION] Heuristic compaction saved ${saved} tokens`);
  }
  return { compacted: before > after, savedTokens: saved };
}

/**
 * IDEIA 3: Model-based compaction.
 *
 * Asks the LLM to summarize the oldest 70% of the conversation, preserving:
 *   - Architectural decisions made
 *   - Unresolved bugs and their context
 *   - Files modified and why
 *   - Next steps that were planned
 *   - User constraints/preferences discovered
 *
 * Returns a compaction result. If the model call fails, returns { compacted: false }
 * so the caller can fall back to heuristic compaction.
 *
 * CRITICAL FIX: This is now called SYNCHRONOUSLY (awaited) by smartCompact.
 * Previously it was fire-and-forget (background), which caused OOM kills
 * because the main chat() call ran in parallel with this one, doubling
 * memory pressure. Now the agent PAUSES while compaction runs.
 */
async function modelBasedCompactionAsync(): Promise<{ compacted: boolean; savedTokens: number }> {
  const allMessages = history.getHistory();
  if (allMessages.length < 10) return { compacted: false, savedTokens: 0 };

  const systemMsg = allMessages[0];
  const cutoff = Math.floor(allMessages.length * 0.7);
  const toSummarize = allMessages.slice(1, cutoff);
  const toKeep = allMessages.slice(cutoff);

  if (toSummarize.length === 0) return { compacted: false, savedTokens: 0 };

  const beforeTokens = history.estimateTokens();

  // Surface compaction activity — this can take 5-15s on a large context.
  const { pushActivity } = await import("./activityTracker.js");
  const done = pushActivity("compacting", `${allMessages.length} mensagens`);

  try {
    // Build a prompt that asks the model to produce a structured summary
    const summaryPrompt = buildSummaryPrompt(toSummarize);

    try {
      const response = await chat([
        systemMsg,
        { role: "user", content: summaryPrompt } as any,
      ]);
      const summary = response.choices[0]?.message?.content ?? "";
      if (!summary || summary.length < 50) {
        return { compacted: false, savedTokens: 0 };
      }

      // Replace the summarized portion with a single system message containing the summary
      const compactedHistory = [
        systemMsg,
        { role: "system", content: `[AI CONTEXT COMPACTED - ${toSummarize.length} old messages summarized preserving architectural decisions, unresolved bugs and next steps]\n\n${summary}` } as any,
        ...toKeep,
      ];

      // Replace history in-place
      history.replaceHistory(compactedHistory as any);
      const afterTokens = history.estimateTokens();
      log.debug(`[COMPACTION] Model-based: ${toSummarize.length} msgs -> 1 summary (${beforeTokens - afterTokens} tokens saved)`);
      return { compacted: true, savedTokens: beforeTokens - afterTokens };
    } catch (err) {
      log.warn(`[COMPACTION] Model-based call failed: ${(err as Error).message}`);
      return { compacted: false, savedTokens: 0 };
    }
  } finally {
    done();
  }
}

function buildSummaryPrompt(messages: any[]): string {
  // Render messages as a transcript the model can summarize
  const transcript = messages.map((m) => {
    const role = m.role?.toUpperCase() ?? "UNKNOWN";
    const content = renderMessageContent(m);
    return `[${role}]: ${content.slice(0, 800)}`;
  }).join("\n\n");

  return `You are compacting the history of a conversation between a user and a code agent (Claude-Killer).

Your task: produce a STRUCTURED summary that preserves ALL critical information for task continuity.

History to compact:
${transcript}

Respond ONLY with the following format (no preamble):

## Architectural Decisions Made
- (list each decision and why)

## Arquivos Modificados
- (caminho: o que mudou)

## Unresolved Bugs
- (description + context)

## Planned Next Steps
- (o que o agente ia fazer a seguir)

## User Preferences/Constraints
- (descobertas durante a conversa)

## Critical Technical Context
- (qualquer detalhe que seria perdido sem este resumo)

If a section has no content, write "N/A". Be concise but complete - another agent will continue based only on this summary.`;
}

function renderMessageContent(m: any): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.tool_calls)) {
    const names = m.tool_calls.map((tc: any) => tc.function?.name).join(", ");
    return `[tool_calls: ${names}]`;
  }
  return JSON.stringify(m.content ?? "");
}
