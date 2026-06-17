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

export { strategies };

export function smartCompact(maxTokens: number = 50000): { compacted: boolean; savedTokens: number } {
  const before = history.estimateTokens();

  if (before <= maxTokens) {
    return { compacted: false, savedTokens: 0 };
  }

  // IDEIA 3: When context is critically full AND effort allows, use the
  // model to produce a high-fidelity summary. This preserves architectural
  // decisions, unresolved bugs, and planned next steps - much better than
  // blind truncation. Mirrors Claude Code's compaction approach.
  if (shouldUseIntelligentCompaction() && before > maxTokens * 1.2) {
    const modelCompacted = modelBasedCompactionSync();
    if (modelCompacted.compacted) {
      log.success(`[COMPACTION] Model-based compaction saved ${modelCompacted.savedTokens} tokens`);
      return modelCompacted;
    }
    // If model-based failed (network, etc.), fall through to heuristics
  }

  // Apply heuristic compaction strategies
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
 * Note: this is a SYNCHRONOUS wrapper that kicks off the model call but doesn't
 * await it - actual model-based compaction happens via modelBasedCompactionAsync.
 * The sync version returns the cached result of the last successful async run,
 * or false if none exists yet. This keeps smartCompact's signature synchronous.
 */
function modelBasedCompactionSync(): { compacted: boolean; savedTokens: number } {
  // Kick off async compaction in the background - next call to smartCompact
  // will pick up the result. This avoids blocking the main loop.
  if (!modelCompactionInProgress) {
    modelCompactionInProgress = true;
    modelBasedCompactionAsync()
      .then((result) => { lastModelCompactionResult = result; })
      .catch((err) => log.warn(`[COMPACTION] Model-based failed: ${(err as Error).message}`))
      .finally(() => { modelCompactionInProgress = false; });
  }
  if (lastModelCompactionResult) {
    const r = lastModelCompactionResult;
    lastModelCompactionResult = null; // consume
    return r;
  }
  return { compacted: false, savedTokens: 0 };
}

let modelCompactionInProgress = false;
let lastModelCompactionResult: { compacted: boolean; savedTokens: number } | null = null;

async function modelBasedCompactionAsync(): Promise<{ compacted: boolean; savedTokens: number }> {
  const allMessages = history.getHistory();
  if (allMessages.length < 10) return { compacted: false, savedTokens: 0 };

  const systemMsg = allMessages[0];
  const cutoff = Math.floor(allMessages.length * 0.7);
  const toSummarize = allMessages.slice(1, cutoff);
  const toKeep = allMessages.slice(cutoff);

  if (toSummarize.length === 0) return { compacted: false, savedTokens: 0 };

  const beforeTokens = history.estimateTokens();

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
      { role: "system", content: `[CONTEXTO COMPACTADO POR IA - ${toSummarize.length} mensagens antigas resumidas preservando decisões arquiteturais, bugs não resolvidos e próximos passos]\n\n${summary}` } as any,
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
}

function buildSummaryPrompt(messages: any[]): string {
  // Render messages as a transcript the model can summarize
  const transcript = messages.map((m) => {
    const role = m.role?.toUpperCase() ?? "UNKNOWN";
    const content = renderMessageContent(m);
    return `[${role}]: ${content.slice(0, 800)}`;
  }).join("\n\n");

  return `Você está compactando o histórico de uma conversa entre um usuário e um agente de código (Claude-Killer).

Sua tarefa: produzir um resumo ESTRUTURADO que preserve TODA a informação crítica para a continuidade da tarefa.

Histórico a ser compactado:
${transcript}

Responda SOMENTE com o seguinte formato (sem preâmbulo):

## Decisões Arquiteturais Tomadas
- (liste cada decisão e por quê)

## Arquivos Modificados
- (caminho: o que mudou)

## Bugs Não Resolvidos
- (descrição + contexto)

## Próximos Passos Planejados
- (o que o agente ia fazer a seguir)

## Preferências/Restrições do Usuário
- (descobertas durante a conversa)

## Contexto Técnico Crítico
- (qualquer detalhe que seria perdido sem este resumo)

Se uma seção não tiver conteúdo, escreva "N/A". Seja conciso mas completo - outro agente vai continuar o trabalho baseado apenas neste resumo.`;
}

function renderMessageContent(m: any): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.tool_calls)) {
    const names = m.tool_calls.map((tc: any) => tc.function?.name).join(", ");
    return `[tool_calls: ${names}]`;
  }
  return JSON.stringify(m.content ?? "");
}
