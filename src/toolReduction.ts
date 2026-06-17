/**
 * toolReduction.ts - Dynamically reduce tools sent to the model.
 *
 * Vercel proved: removing 80% of tools from an agent increased success
 * rate from 80% to 100%. Too many tools confuse the model.
 *
 * Strategy:
 *   1. Classify the user's request (read, write, search, test, git, etc.)
 *   2. Send ONLY the tools relevant to that classification
 *   3. Always include core tools (ler_arquivo, pensar, etc.)
 *   4. Include contextual tools based on detected intent
 *
 * Integration:
 *   - agent.ts: filter getMergedTools() result before sending to chat()
 */

import type { OpenAI } from "openai";

// --- Types ------------------------------------------------------------------

export type TaskIntent =
  | "read"        // Just reading/exploring code
  | "write"       // Editing/writing files
  | "search"      // Searching across codebase
  | "test"        // Running tests
  | "git"         // Git operations
  | "explore"     // Sub-agent exploration
  | "general";    // Default: include all tools

export interface ToolFilterConfig {
  intent: TaskIntent;
  coreTools: string[];       // Always included
  intentTools: string[];     // Included for this specific intent
  excludedTools: string[];   // Excluded for this intent
}

// --- Intent detection ------------------------------------------------------

const INTENT_PATTERNS: Array<{ intent: TaskIntent; patterns: RegExp[] }> = [
  {
    intent: "write",
    patterns: [
      /\b(edit|editar|change|mudar|add|adicionar|remove|remover|fix|corrigir|create|criar|implement|implementar|refactor|refatorar)/i,
    ],
  },
  {
    intent: "test",
    patterns: [
      /\b(tests?|testes?|spec|vitest|jest|pytest|coverage)/i,
    ],
  },
  {
    intent: "git",
    patterns: [
      /\b(git|commit|push|pull|branch|merge|stash|diff|checkout)/i,
    ],
  },
  {
    intent: "search",
    patterns: [
      /\b(find|encontrar|search|buscar|where|onde|grep|list all|liste todos)/i,
    ],
  },
  {
    intent: "explore",
    patterns: [
      /\b(explore|explorar|investigate|investigar|understand how)/i,
      /\b(sub-?agent|map the|trace through)/i,
    ],
  },
  {
    intent: "read",
    patterns: [
      /\b(read|ler|ver|mostra|show|what|o que|qual|list|liste)/i,
      /\b(como funciona|how does|understand|entender)/i,
    ],
  },
];

/**
 * Detect the user's intent from their message.
 */
export function detectIntent(userMessage: string): TaskIntent {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(userMessage)) {
        return intent;
      }
    }
  }
  return "general";
}

// --- Tool filtering --------------------------------------------------------

const CORE_TOOLS = new Set([
  "ler_arquivo",
  "pensar",
  "atualizar_estado",
  "ler_estado",
  "marcar_feito",
  "criar_plano",
  "marcar_passo",
]);

const INTENT_TOOL_MAP: Record<TaskIntent, Set<string>> = {
  read: new Set(["ler_arquivo", "ler_arquivo_avancado", "parse_ast", "buscar_arquivos", "buscar_conteudo", "pensar"]),
  write: new Set(["ler_arquivo", "aplicar_diff", "editar_arquivo", "editar_multi_arquivos", "desfazer_edicao", "listar_backups", "pensar", "atualizar_estado", "criar_plano", "marcar_passo"]),
  search: new Set(["buscar_arquivos", "buscar_conteudo", "ler_arquivo", "parse_ast", "pensar"]),
  test: new Set(["executar_testes", "executar_comando", "sugerir_fixes", "ler_arquivo", "pensar"]),
  git: new Set(["git_status", "git_diff", "git_log", "git_commit", "git_blame", "git_show", "git_branch", "git_checkout", "executar_comando"]),
  explore: new Set(["ler_arquivo", "buscar_arquivos", "buscar_conteudo", "parse_ast", "executar_paralelo", "pesquisar_api_atualizada", "pensar"]),
  general: new Set(),  // Empty = include all
};

/**
 * Filter tools based on detected intent.
 *
 * For "general" intent, returns all tools (no filtering).
 * For specific intents, returns only core + intent-specific tools.
 *
 * @returns Filtered tool list
 */
export function filterToolsByIntent(
  allTools: OpenAI.Chat.Completions.ChatCompletionTool[],
  intent: TaskIntent
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (intent === "general") {
    return allTools;  // Don't filter for general tasks
  }

  const allowedTools = INTENT_TOOL_MAP[intent] ?? new Set<string>();

  // Always include core tools
  for (const core of CORE_TOOLS) {
    allowedTools.add(core);
  }

  // Also include external tools (they're mode-specific, always relevant)
  const filtered = allTools.filter((tool) => {
    const name = tool.function.name;
    if (!name) return false;

    // Always include core tools
    if (CORE_TOOLS.has(name)) return true;

    // Include if in intent-specific set
    if (allowedTools.has(name)) return true;

    // Include external tools (tool:* from mode config)
    if (name.startsWith("tool:")) return true;

    // Include think tool
    if (name === "pensar") return true;

    // Include safety/research tools if they exist
    if (name === "pesquisar_api_atualizada") return true;

    // Exclude everything else
    return false;
  });

  return filtered;
}

/**
 * Get a summary of tool filtering for logging.
 */
export function getFilterSummary(
  totalTools: number,
  filteredTools: number,
  intent: TaskIntent
): string {
  const reduction = totalTools - filteredTools;
  const pct = totalTools > 0 ? Math.round((reduction / totalTools) * 100) : 0;
  return `Intent: ${intent} | Tools: ${filteredTools}/${totalTools} (-${pct}%)`;
}
