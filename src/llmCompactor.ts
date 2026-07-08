/**
 * llmCompactor.ts - LLM-based context compaction.
 *
 * Uses the AI itself (via the same API client) to generate an intelligent
 * summary of the conversation, preserving:
 *   - Decisions made
 *   - Code written and why
 *   - Bugs found and fixed
 *   - Project context
 *   - Next steps planned
 *
 * This is inspired by Claude Code's auto-compaction, which uses Claude
 * itself to summarize conversation history when approaching context limits.
 * Reference: https://docs.anthropic.com/en/docs/claude-code/costs
 *
 * The old buildCompactionSummary() in history.ts was mechanical (regex-based)
 * and produced generic summaries. This module produces coherent, specific
 * summaries that the IA can actually use to continue the work.
 *
 * Usage:
 *   const summary = await llmCompact(messages, customInstruction);
 *   // summary is a string ready to be injected as a system message
 */

import type { Message } from "./history.js";
import { chat } from "./apiClient.js";
import { config } from "./config.js";

/**
 * Compact a list of messages into an intelligent summary using the LLM.
 *
 * @param messages The messages to compact (usually everything except
 *                 system prompt + last N recent messages)
 * @param customInstruction Optional user-provided instruction for what to
 *                          preserve (e.g., "focus on code changes and API decisions")
 * @returns A string containing the LLM-generated summary, or null if the
 *          LLM call fails (caller should fall back to mechanical compaction)
 */
export async function llmCompact(
  messages: Message[],
  customInstruction?: string,
): Promise<string | null> {
  if (messages.length === 0) return null;

  // Build the conversation text to summarize
  const conversationText = buildConversationText(messages);

  // If the conversation is too short, don't waste an API call
  if (conversationText.length < 500) {
    return null;
  }

  // Build the summarization prompt
  const summarizationPrompt = buildSummarizationPrompt(conversationText, customInstruction);

  try {
    const response = await chat(
      summarizationPrompt,
      undefined, // onStreamStart
      undefined, // onToken
      undefined, // onThinking
      undefined, // tools (no tools — we want a pure text summary)
    );

    const summary = response.choices?.[0]?.message?.content;
    if (!summary || summary.trim().length < 50) {
      return null;
    }

    return `[CONVERSATION MEMORY - LLM-generated summary of ${messages.length} messages]\n\n${summary.trim()}`;
  } catch (err) {
    console.error(`[LLM_COMPACT] Failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Build a text representation of the conversation for the LLM to summarize.
 * Filters out noise (long tool outputs, system messages) and keeps the
 * meaningful dialogue.
 */
function buildConversationText(messages: Message[]): string {
  const lines: string[] = [];

  for (const m of messages) {
    const role = m.role;
    const content = typeof m.content === "string" ? m.content : "";

    if (role === "user") {
      // Keep user messages (they're the goals/requests)
      if (content.length > 5) {
        lines.push(`USER: ${content.slice(0, 1000)}`);
      }
    } else if (role === "assistant") {
      // Keep assistant responses but truncate very long ones
      if (content.length > 20 && !content.startsWith("[TOOL")) {
        lines.push(`ASSISTANT: ${content.slice(0, 800)}`);
      }
      // Keep tool call names (not full arguments — too verbose)
      const toolCalls = (m as any).tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const name = tc?.function?.name;
          if (name) {
            // Include key args (path, query, comando) but not full content
            let args = "";
            try {
              const parsed = JSON.parse(tc?.function?.arguments ?? "{}");
              const keyArgs = ["path", "caminho", "query", "comando", "url", "pattern"];
              const argParts: string[] = [];
              for (const key of keyArgs) {
                if (parsed[key]) argParts.push(`${key}=${String(parsed[key]).slice(0, 100)}`);
              }
              args = argParts.length > 0 ? ` (${argParts.join(", ")})` : "";
            } catch { /* ignore */ }
            lines.push(`TOOL_CALL: ${name}${args}`);
          }
        }
      }
    } else if (role === "tool") {
      // Keep tool results but truncate (they can be very long)
      if (content.length > 10) {
        // Only keep first 200 chars of tool results — enough for context
        const truncated = content.slice(0, 200);
        lines.push(`TOOL_RESULT: ${truncated}`);
      }
    } else if (role === "system") {
      // Skip system messages (they're usually instructions, not conversation)
      // But keep TASK_STATE and Persistent Memory (they have context)
      if (content.startsWith("## TASK_STATE") || content.startsWith("## Persistent Memory")) {
        lines.push(`SYSTEM_CONTEXT: ${content.slice(0, 500)}`);
      }
    }
  }

  return lines.join("\n\n");
}

/**
 * Build the prompt that tells the LLM how to summarize the conversation.
 *
 * If customInstruction is provided (e.g., "focus on code changes and API decisions"),
 * it's incorporated into the prompt.
 */
function buildSummarizationPrompt(conversationText: string, customInstruction?: string): Message[] {
  const focusSection = customInstruction
    ? `\n\n## User's Custom Instruction\nThe user specifically asked to preserve: ${customInstruction}\nMake sure to prioritize this aspect in your summary.`
    : "";

  // ── Gap 5: Anti-drift — quote verbatim, don't paraphrase ───────────────
  // ── Gap 8: Expand to 9 sections (was 6) ────────────────────────────────
  const systemPrompt = `You are a conversation summarizer for an AI coding assistant (Claude-Killer).
Your job is to create a CONCISE but COMPLETE summary of the conversation that will
allow the AI to continue working after context compaction.

The summary must preserve:
1. **User's original intent**: What the user originally asked for — QUOTE their exact words
2. **Architectural decisions**: What was decided and why (architecture, approach, tools)
3. **Code changes**: What files were modified and what was done to them
4. **Bugs**: Any bugs found and how they were fixed (or are being fixed)
5. **Problem-solving logic chain**: The reasoning that led to decisions — WHY, not just WHAT
6. **All user messages**: Each user message preserved in order — QUOTE key phrases verbatim
7. **Current state**: What was being done EXACTLY before this compaction — the immediate task in progress
8. **Next steps**: What was planned to do next
9. **User preferences/constraints**: QUOTE exact words like "never", "always", "must" — don't paraphrase

CRITICAL RULES (anti-drift):
- DIRECTLY QUOTE key phrases from the user rather than paraphrasing.
- If user said "never use X", write "never use X" — do NOT soften to "prefers not to use X".
- If user said "always do Y", write "always do Y" — do NOT strengthen or weaken.
- Be SPECIFIC, not generic. "Edited GachaService.lua to add rarity system" not "made code changes"
- Preserve technical details: function names, API names, file paths, error messages
- Use markdown headers and bullet points for readability
- Keep it under 800 words — this is a SUMMARY, not a transcript
- If the conversation has code snippets that are important, include them (briefly)
- Don't include fluff like "The user then asked..." — just the facts${focusSection}

Output ONLY the summary, no preamble or explanation.`;

  const userPrompt = `Summarize this conversation for context preservation:

${conversationText}

Generate the summary now:`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

/**
 * Check if LLM compaction is available (API key configured).
 * Used to decide whether to attempt LLM compaction or fall back to mechanical.
 */
export async function isLlmCompactionAvailable(): Promise<boolean> {
  try {
    return !!(config.nvidiaApiKey || process.env.NVIDIA_API_KEY || config.nvidiaApiKeys);
  } catch {
    return false;
  }
}
