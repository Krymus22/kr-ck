/**
 * contextCompaction.ts — Intelligent context compaction: summarize old messages,
 * compress tool results, merge similar messages.
 */

import * as history from "./history.js";

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
        if (m.role === "tool" && typeof m.content === "string" && m.content.includes("[ERRO]")) {
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
        if (msg.role === "tool" && typeof msg.content === "string" && msg.content.includes("[ERRO]")) {
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

export function smartCompact(maxTokens: number = 50000): { compacted: boolean; savedTokens: number } {
  const before = history.estimateTokens();

  if (before <= maxTokens) {
    return { compacted: false, savedTokens: 0 };
  }

  // Apply compaction strategies
  const messages = history.getHistory();
  const { messages: compacted } = compactIntelligently(messages);

  // If compaction wasn't enough, fall back to aggressive compaction
  if (history.estimateTokens(compacted as any) > maxTokens) {
    const aggressiveResult = history.compactHistory();
    if (aggressiveResult) {
      return { compacted: true, savedTokens: aggressiveResult.beforeTokens - aggressiveResult.afterTokens };
    }
  }

  const after = history.estimateTokens(compacted as any);
  return { compacted: before > after, savedTokens: before - after };
}
