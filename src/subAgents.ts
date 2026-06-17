/**
 * subAgents.ts - In-process sub-agents for isolated exploration.
 *
 * IDEIA 5: Mirrors Claude Code's sub-agent pattern: spawn a child agent
 * with a CLEAN context window to do deep exploration (read N files, search
 * codebase), then return only a 1-2k token summary to the main agent.
 *
 * Implementation choice: SUB-AGENTS RUN IN-PROCESS, reusing the same
 * NVIDIA NIM API client and the same API key. They get their own:
 *   - Isolated history (separate Message[])
 *   - Their own system prompt (focused on the exploration task)
 *   - Read-only tools (ler_arquivo, buscar_texto, buscar_arquivos, parse_ast)
 *
 * They do NOT have:
 *   - Write access (no aplicar_diff, editar_arquivo, executar_comando)
 *   - Access to the main agent's history (clean slate)
 *   - Ability to spawn their own sub-agents (no recursion)
 *
 * Cost: 1 extra API call per sub-agent (input: focused prompt + tools output;
 * output: 1-2k token summary). Reuses the same NIM key - no extra billing.
 *
 * Activation: only when effort level is high/max (shouldUseSubAgents()).
 */

import { chat, isTransientNetworkErrorPublic, is429ErrorPublic, SUB_AGENT_MAX_CHAT_RETRIES } from "./apiClient.js";
import { getPoolSize } from "./apiKeyPool.js";
import { lerArquivo } from "./tools.js";
import { globSearch } from "./fileSearch.js";
import { grepSearch, formatGrepResults } from "./contentSearch.js";
import { parseFile } from "./lspAst.js";
import { shouldUseSubAgents } from "./effortLevels.js";
import * as log from "./logger.js";

const SUB_AGENT_SYSTEM_PROMPT = `You are a focused code-exploration sub-agent for Claude-Killer.
Your job: answer the main agent's question by reading code, then return a CONCISE summary.

RULES:
- You have ONLY read tools: ler_arquivo, buscar_arquivos, buscar_texto, parse_ast.
- You CANNOT edit, write, or run commands. Just read and report.
- Do AT MOST 8 tool calls. If you can't answer in 8, give your best guess.
- Return a summary of 500-2000 tokens. Be specific: file paths, line numbers, key code snippets.
- Format your final answer as:

## Summary
[concise answer to the main agent's question]

## Files Inspected
- [path]: [what's relevant there]

## Key Findings
- [bullet points with file:line references]

If you can't find the answer, say so explicitly - don't invent.`;

const SUB_AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "ler_arquivo",
      description: "Read a file's content. Returns the full text.",
      parameters: {
        type: "object",
        properties: { caminho: { type: "string", description: "File path to read." } },
        required: ["caminho"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "buscar_arquivos",
      description: "Find files by glob pattern (e.g. **/*.ts).",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string", description: "Glob pattern." } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "buscar_texto",
      description: "Grep for a regex pattern across files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex to search for." },
          path: { type: "string", description: "Directory or file to search in." },
          include: { type: "string", description: "File pattern filter." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "parse_ast",
      description: "Parse a source file and extract symbols (functions, classes, imports).",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File to parse." } },
        required: ["path"],
      },
    },
  },
];

interface SubAgentArgs {
  /** The exploration question to answer */
  question: string;
  /** Starting directory for the search (defaults to cwd) */
  cwd?: string;
  /** Max tool calls before giving up (default 8) */
  maxToolCalls?: number;
}

/**
 * Run a sub-agent to answer an exploration question.
 * Returns the sub-agent's final summary as a string.
 *
 * Returns null if sub-agents are disabled (effort too low) or if the
 * sub-agent failed to produce a useful answer.
 */
export async function runSubAgent(args: SubAgentArgs): Promise<string | null> {
  if (!shouldUseSubAgents()) {
    log.debug(`[SUB_AGENT] Skipped - effort level too low`);
    return null;
  }

  const cwd = args.cwd ?? process.cwd();
  const maxCalls = args.maxToolCalls ?? 8;
  const poolInfo = getPoolSize() > 0 ? ` (pool: ${getPoolSize()} keys)` : " (single key)";
  log.debug(`[SUB_AGENT] Starting: "${args.question.slice(0, 80)}..." (cwd=${cwd}, maxCalls=${maxCalls}${poolInfo})`);

  const initialHistory: SubAgentMessage[] = [
    { role: "system", content: SUB_AGENT_SYSTEM_PROMPT },
    { role: "user", content: `Working directory: ${cwd}\n\nQuestion: ${args.question}` },
  ];

  let subHistory = [...initialHistory];
  let callNum = 0;
  let consecutiveFailures = 0;

  while (callNum < maxCalls) {
    const checkpoint = [...subHistory];
    try {
      const response = await chatWithRetry(subHistory, callNum);
      const choice = response.choices[0];
      if (!choice) break;

      subHistory.push(choice.message as SubAgentMessage);
      consecutiveFailures = 0;

      const finalSummary = tryExtractFinalSummary(choice, callNum);
      if (finalSummary.done) return finalSummary.summary;

      for (const tc of choice.message.tool_calls ?? []) {
        const result = await executeSubAgentTool(tc.function.name, JSON.parse(tc.function.arguments), cwd);
        subHistory.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      callNum++;
    } catch (err) {
      const retryDecision = handleSubAgentError(err, callNum, consecutiveFailures);
      if (retryDecision.shouldRetry) {
        subHistory = [...checkpoint];
        consecutiveFailures = retryDecision.newConsecutiveFailures;
        await new Promise((r) => setTimeout(r, retryDecision.waitMs));
        continue;
      }
      log.error(`[SUB_AGENT] Giving up at call ${callNum + 1} after ${consecutiveFailures + 1} failures: ${(err as Error).message}`);
      return null;
    }
  }

  log.warn(`[SUB_AGENT] Hit maxToolCalls (${maxCalls}) without finishing`);
  return null;
}

type SubAgentMessage = { role: string; content: string; tool_call_id?: string; tool_calls?: any[] };

/**
 * If the choice represents the final answer (no more tool_calls), extract it.
 * Returns { done: true, summary } on success, { done: true, summary: null } on empty/invalid,
 * { done: false, summary: null } if there are still tool_calls to execute.
 */
function tryExtractFinalSummary(choice: any, callNum: number): { done: boolean; summary: string | null } {
  if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
    return { done: false, summary: null };
  }
  const summary = choice.message.content ?? "";
  if (!summary || summary.trim().length < 10) {
    log.warn(`[SUB_AGENT] Model returned empty/too-short summary`);
    return { done: true, summary: null };
  }
  log.debug(`[SUB_AGENT] Done in ${callNum + 1} calls (${summary.length} chars)`);
  return { done: true, summary };
}

/** Decide whether to retry after an error, and how long to wait. */
function handleSubAgentError(err: unknown, callNum: number, consecutiveFailures: number): {
  shouldRetry: boolean;
  newConsecutiveFailures: number;
  waitMs: number;
} {
  const newConsecutive = consecutiveFailures + 1;
  const isTransient = isTransientNetworkErrorPublic(err) || is429ErrorPublic(err);
  log.warn(`[SUB_AGENT] Call ${callNum + 1} failed (attempt ${newConsecutive}/${SUB_AGENT_MAX_CHAT_RETRIES + 1}): ${(err as Error).message}`);

  if (!isTransient || newConsecutive > SUB_AGENT_MAX_CHAT_RETRIES) {
    return { shouldRetry: false, newConsecutiveFailures: newConsecutive, waitMs: 0 };
  }

  const waitMs = 1000 * (2 ** (newConsecutive - 1));
  log.warn(`[SUB_AGENT] Restoring checkpoint and retrying in ${waitMs}ms (call ${callNum + 1})`);
  return { shouldRetry: true, newConsecutiveFailures: newConsecutive, waitMs };
}

/**
 * Wrapper around chat() that re-throws transient errors for the outer loop to handle.
 * The inner chat() already retries ECONNRESET (8x) and 429 (4x) - this just classifies
 * the error for the outer retry loop.
 */
async function chatWithRetry(subHistory: any[], callNum: number) {
  try {
    return await chat(subHistory, undefined, undefined, undefined, SUB_AGENT_TOOLS);
  } catch (err) {
    if (!isTransientNetworkErrorPublic(err) && !is429ErrorPublic(err)) {
      throw err; // non-transient - let caller give up immediately
    }
    log.warn(`[SUB_AGENT] chat() exhausted inner retries at call ${callNum + 1}: ${(err as Error).message}`);
    throw err;
  }
}

async function executeSubAgentTool(name: string, args: any, cwd: string): Promise<string> {
  try {
    switch (name) {
      case "ler_arquivo": {
        const resolved = args.caminho?.startsWith("/") ? args.caminho : `${cwd}/${args.caminho}`;
        return await lerArquivo({ caminho: resolved });
      }
      case "buscar_arquivos": {
        const results = globSearch({ pattern: args.pattern ?? "**/*", cwd });
        return results.length > 0 ? results.join("\n") : "Nenhum arquivo encontrado.";
      }
      case "buscar_texto": {
        const searchPath = resolveSearchPath(args.path, cwd);
        const matches = grepSearch({
          pattern: args.pattern,
          path: searchPath,
          include: args.include,
        });
        return formatGrepResults(matches);
      }
      case "parse_ast": {
        const resolved = args.path?.startsWith("/") ? args.path : `${cwd}/${args.path}`;
        const result = await parseFile(resolved);
        return [
          `Language: ${result.language}`,
          `Lines: ${result.lineCount}`,
          `Symbols: ${result.symbols.length}`,
          ...result.symbols.map((s: any) => `  ${s.type} ${s.name} (line ${s.line})`),
        ].join("\n");
      }
      default:
        return `[ERRO] Ferramenta desconhecida: ${name}`;
    }
  } catch (err) {
    return `[ERRO] ${name} falhou: ${(err as Error).message}`;
  }
}

/**
 * Decide whether a user message looks like it would benefit from sub-agent exploration.
 * Heuristic: mentions multiple files, "understand how X works", "find all places that Y", etc.
 */
export function shouldDelegateToSubAgent(userMessage: string): boolean {
  if (!shouldUseSubAgents()) return false;
  const lower = userMessage.toLowerCase();
  const triggers = [
    "understand how",
    "entenda como",
    "find all",
    "encontre todos",
    "where is",
    "onde está",
    "trace through",
    "map the",
    "what does the",
    "how does",
    "explore",
    "investigate",
  ];
  return triggers.some((t) => lower.includes(t));
}

/** Resolve a possibly-relative path against the sub-agent's cwd. */
function resolveSearchPath(rawPath: any, cwd: string): string {
  if (!rawPath) return cwd;
  if (typeof rawPath !== "string") return cwd;
  if (rawPath.startsWith("/")) return rawPath;
  return `${cwd}/${rawPath}`;
}
