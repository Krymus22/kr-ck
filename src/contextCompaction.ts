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
import { buildRehydrationMessage } from "./fileRehydration.js";
import { buildSkillReInjectionMessage } from "./skillTracker.js";

/**
 * Prefixes that MUST survive any compaction (BUSINESS_RULES.md §6.4 + §6.6).
 * Mirrors the list in history.ts compactHistoryAsync/compactHistory.
 * Kept in sync so modelBasedCompactionAsync preserves the same critical context.
 */
const PRESERVE_PREFIXES = [
  "## TASK_STATE",
  "## Persistent Memory",
  "[CONVERSATION MEMORY",  // accumulated summaries from previous compactions
  "[PLAN",                  // Gap 3: preserve plan state across compaction
  "[SESSION CONTINUATION",  // Gap 2: preserve continuation message
  "## Recently Modified Files",  // Gap 1: preserve re-hydrated files
  "## Invoked Skills",           // Gap 9: preserve re-injected skills
];

/**
 * Number of recent messages to keep untouched when injecting post-compaction
 * system messages. Mirrors COMPACT_KEEP_RECENT in history.ts
 * (§6.6: "COMPACT_KEEP_RECENT = 6 — NÃO reduzir").
 */
const POST_COMPACT_KEEP_RECENT = 6;

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
      // Bug fix (Bug Hunter #2b): previously `result = [msgs[0]]` stored a
      // reference to the ORIGINAL system message, and the merge below mutated
      // `prev.content` in-place — leaking merged content into the caller's
      // array (live history). Now we shallow-copy every message we keep so
      // mutations stay inside the returned array.
      if (msgs.length === 0) return [];
      const result: any[] = [{ ...msgs[0] }]; // keep (copy of) system
      for (let i = 1; i < msgs.length; i++) {
        const prev = result.at(-1);
        const curr = msgs[i];
        if (curr.role === prev?.role && curr.role !== "system" && curr.role !== "user") {
          // Merge content (prev is already a copy — safe to mutate)
          if (typeof curr.content === "string" && typeof prev.content === "string") {
            prev.content = prev.content + "\n" + curr.content;
          }
        } else {
          // Push a copy so future merges don't mutate the caller's object
          result.push({ ...curr });
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
        // Bug fix (Bug Hunter #2): BUSINESS_RULES.md §6.2 says "3+ tools seguidos → merge".
        // With N consecutive tools there are N-1 adjacent pairs, so 3 tools = 2 pairs.
        // Previously `consecutive >= 3` required 4+ tools (3 pairs), which violated the rule.
        // Now `consecutive >= 2` triggers at exactly 3 tools (2 pairs), matching the rule.
        if (consecutive >= 2) return true;
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
          // Bug fix (Bug Hunter #2): BUSINESS_RULES.md §6.2 says "mantém só primeiros 3 [ERROR]".
          // The apply() keeps first 3 and drops 4+. shouldApply must trigger at 4+ errors
          // (so the apply actually has something to remove). Previously `errorCount > 5`
          // required 6+ errors, leaving 4-5 errors unpruned — violating the rule.
          return errorCount > 3;
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
  // BUG FIX (Bug Hunter: scroll stealing during streaming): the previous
  // `console.log` here wrote directly to stdout BETWEEN Ink renders, causing
  // the terminal to scroll and stealing the user's scroll position during
  // streaming. In TUI mode, the activityTracker already shows
  // "Compactando contexto…" via the ThinkingIndicator, so this redundant
  // console.log is removed entirely. (log.info above is gated by tuiMode.)

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
  let compacted = false;
  let savedTokens = 0;

  if (shouldUseIntelligentCompaction() && before > maxTokens * 1.2) {
    const modelCompacted = await modelBasedCompactionAsync();
    if (modelCompacted.compacted) {
      log.success(`[COMPACTION] Model-based compaction saved ${modelCompacted.savedTokens} tokens`);
      compacted = true;
      savedTokens = modelCompacted.savedTokens;
    }
    // If model-based failed (network, etc.), fall through to heuristics
  }

  if (!compacted) {
    // Apply heuristic compaction strategies
    const messages = history.getHistory();
    const { messages: compactedMsgs, appliedStrategies } = compactIntelligently(messages);

    // BUG FIX: previously, `compacted` was computed by compactIntelligently but
    // NEVER applied to the live history — `history.replaceHistory(compacted)`
    // was missing. The function then reported "saved X tokens" based on the
    // compacted array's token count, but the actual history array was
    // unchanged, so the IA kept sending the full un-compacted context to the
    // API. Now we actually replace history with the compacted array when at
    // least one strategy applied.
    if (appliedStrategies.length > 0) {
      history.replaceHistory(compactedMsgs as any);
    }

    // If compaction wasn't enough, fall back to aggressive compaction
    if (history.estimateTokens() > maxTokens) {
      const aggressiveResult = history.compactHistory();
      if (aggressiveResult) {
        log.success(`[COMPACTION] Aggressive compaction saved ${aggressiveResult.beforeTokens - aggressiveResult.afterTokens} tokens`);
        compacted = true;
        savedTokens = aggressiveResult.beforeTokens - aggressiveResult.afterTokens;
      }
    }

    if (!compacted) {
      const after = history.estimateTokens();
      savedTokens = before - after;
      compacted = before > after;
      if (savedTokens > 0) {
        log.success(`[COMPACTION] Heuristic compaction saved ${savedTokens} tokens`);
      }
    }
  }

  // ── §6.3 + §6.6: Post-compaction re-hydration ─────────────────────────
  // BUSINESS_RULES.md §6.3: after compaction, 3 system messages MUST be
  // injected before the recent messages:
  //   1. [SESSION CONTINUATION] (Gap 2)
  //   2. ## Recently Modified Files (Gap 1 — fileRehydration)
  //   3. ## Invoked Skills (Gap 9 — skillTracker)
  // §6.6: "Mensagem de continuação: sempre injetada após compactação."
  // Previously smartCompact returned immediately after compacting, skipping
  // this step (only the manual /compact path via compactHistoryAsync did it).
  // Bug fix (Bug Hunter #2b): now smartCompact injects them too.
  if (compacted) {
    injectPostCompactionMessages();
  }

  return { compacted, savedTokens };
}

/**
 * Inject the 3 post-compaction system messages (§6.3) into the live history:
 *   1. [SESSION CONTINUATION] — tells IA to keep working without asking user
 *   2. ## Recently Modified Files — re-hydrated file contents (fileRehydration)
 *   3. ## Invoked Skills — re-injected skill contents (skillTracker)
 *
 * Idempotent: skips any message that is already present (e.g., from a
 * previous compaction pass). Inserted BEFORE the last POST_COMPACT_KEEP_RECENT
 * messages so the recent context stays contiguous.
 */
function injectPostCompactionMessages(): void {
  const currentHistory = history.getHistory();
  if (currentHistory.length === 0) return;

  const toInject: any[] = [];

  const hasContinuation = currentHistory.some(
    (m: any) => typeof m.content === "string" && m.content.startsWith("[SESSION CONTINUATION")
  );
  if (!hasContinuation) {
    toInject.push({
      role: "system",
      content: "[SESSION CONTINUATION] This session was continued from a previous conversation that ran out of context. The summary above covers the earlier portion. Continue working on the last task you were doing — do NOT ask the user what to do next. Pick up where you left off and keep working until the task is complete or you need user input.",
    });
  }

  try {
    const rehydrationMsg = buildRehydrationMessage();
    if (rehydrationMsg) {
      const hasRehydration = currentHistory.some(
        (m: any) => typeof m.content === "string" && m.content.startsWith("## Recently Modified Files")
      );
      if (!hasRehydration) {
        toInject.push({ role: "system", content: rehydrationMsg });
      }
    }
  } catch (err) {
    log.debug(`[COMPACTION] Failed to re-hydrate files: ${(err as Error).message}`);
  }

  try {
    const skillMsg = buildSkillReInjectionMessage();
    if (skillMsg) {
      const hasSkills = currentHistory.some(
        (m: any) => typeof m.content === "string" && m.content.startsWith("## Invoked Skills")
      );
      if (!hasSkills) {
        toInject.push({ role: "system", content: skillMsg });
      }
    }
  } catch (err) {
    log.debug(`[COMPACTION] Failed to re-inject skills: ${(err as Error).message}`);
  }

  if (toInject.length === 0) return;

  // Insert before the last POST_COMPACT_KEEP_RECENT messages (recent context).
  // If history is shorter, insert before the last message (preserving the
  // most recent user/assistant turn as the immediate context).
  const insertIdx = Math.max(1, currentHistory.length - POST_COMPACT_KEEP_RECENT);
  const newHistory = [
    ...currentHistory.slice(0, insertIdx),
    ...toInject,
    ...currentHistory.slice(insertIdx),
  ];
  history.replaceHistory(newHistory);
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

      // ── §6.4 + §6.6: Preserve PRESERVE_PREFIXES messages ─────────────────
      // Bug fix (Bug Hunter #2b): previously modelBasedCompactionAsync DROPPED
      // any system message in the toSummarize range that started with a
      // PRESERVE_PREFIX (TASK_STATE, [PLAN, [SESSION CONTINUATION], ## Recently
      // Modified Files, ## Invoked Skills, etc.). That violated §6.6:
      // "PRESERVE_PREFIXES — TODOS os prefixes acima devem sobreviver compaction."
      // Now we lift them out of toSummarize and re-insert them between systemMsg
      // and the new compaction-summary message (mirroring compactHistoryAsync).
      const preservedSystem: any[] = [];
      const seenContents = new Set<string>();
      for (const m of toSummarize) {
        if (m.role !== "system") continue;
        const content = typeof m.content === "string" ? m.content : "";
        if (!PRESERVE_PREFIXES.some((p) => content.startsWith(p))) continue;
        if (seenContents.has(content)) continue; // dedupe
        seenContents.add(content);
        preservedSystem.push(m);
      }

      // Replace the summarized portion with a single system message containing the summary
      const compactedHistory = [
        systemMsg,
        ...preservedSystem,
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

  // ── Gap 5: Anti-drift — quote verbatim, don't paraphrase ───────────────
  // ── Gap 8: Expand to 9 sections (was 6) ────────────────────────────────
  return `You are compacting the history of a conversation between a user and a code agent (Claude-Killer).

Your task: produce a STRUCTURED summary that preserves ALL critical information for task continuity.

History to compact:
${transcript}

Respond ONLY with the following format (no preamble):

## User's Original Intent
- (what the user originally asked for — QUOTE their exact words when possible)

## Architectural Decisions Made
- (list each decision and why)

## Arquivos Modificados
- (caminho: o que mudou)

## Unresolved Bugs
- (description + context)

## Problem-Solving Logic Chain
- (the reasoning that led to decisions — WHY, not just WHAT)

## All User Messages Summary
- (each user message preserved in order — QUOTE key phrases verbatim, don't paraphrase)

## Planned Next Steps
- (o que o agente ia fazer a seguir)

## Currently Working On
- (what was being done EXACTLY before this compaction — the immediate task in progress)

## User Preferences/Constraints
- (descobertas durante a conversa — QUOTE exact words like "never", "always", "must")

## Critical Technical Context
- (qualquer detalhe que seria perdido sem este resumo)

CRITICAL RULES (Gap 5 — anti-drift):
- DIRECTLY QUOTE key phrases from the user rather than paraphrasing.
- If user said "never use X", write "never use X" — do NOT soften to "prefers not to use X".
- If user said "always do Y", write "always do Y" — do NOT strengthen or weaken.
- Preserve exact technical terms: function names, file paths, API names, error messages.
- Do not summarize user constraints — quote them verbatim.

If a section has no content, write "N/A". Be concise but complete — another agent will continue based ONLY on this summary.`;
}

function renderMessageContent(m: any): string {
  // Bug fix (Bug Hunter #2b): previously this returned `m.content` immediately
  // when it was a string, DROPPING any `tool_calls` on the same message. The
  // summarizer therefore never saw which tools the agent called (only the
  // tool RESULTS in separate tool-role messages). Now we append tool_call
  // names so the summary can preserve the "Problem-Solving Logic Chain".
  const parts: string[] = [];
  if (typeof m.content === "string" && m.content.length > 0) {
    parts.push(m.content);
  }
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
    const names = m.tool_calls
      .map((tc: any) => tc?.function?.name)
      .filter(Boolean)
      .join(", ");
    if (names) parts.push(`[tool_calls: ${names}]`);
  }
  if (parts.length > 0) return parts.join(" | ");
  // Fallback: object/array content (rare) — stringify so we don't lose it
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
}
