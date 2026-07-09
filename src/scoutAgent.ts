/**
 * scoutAgent.ts — Sub-agente "scout" com modelo menor para aceleração.
 *
 * PROBLEMA: O GLM 5.2 (modelo principal) é excelente mas lento no servidor
 * NVIDIA. Cada chamada de tool (ler_arquivo, buscar_texto, MCP) exige um
 * round-trip completo (IA → tool → IA), e o modelo grande é lento para
 * processar cada step.
 *
 * SOLUÇÃO: Quando a IA principal precisa fazer várias leituras/buscas (ex:
 * "ler 5 arquivos do Rojo + buscar UI no Roblox via MCP"), ela delega para
 * o scout — um sub-agente com modelo menor e rápido. O scout faz todas as
 * leituras, coleta os resultados, e retorna um summary estruturado. A IA
 * principal recebe o summary e pode pular direto para a edição.
 *
 * COMO USAR: A IA principal chama a tool `usar_scout` com objetivo + lista
 * de tarefas de leitura. O scout executa, retorna summary. A IA principal
 * usa o summary como contexto.
 *
 * FEATURE TOGGLE: Ativado via env var SCOUT_ENABLED=1 (ou /scout on).
 * Default: desativado (não interfere no fluxo existente).
 *
 * MODELO: SCOUT_MODEL env var (default: mistralai/mistral-medium-3.5-128b
 * — rápido, 128k context, suporta tools). Qualquer modelo do registry
 * com supportsTools=true pode ser usado.
 *
 * SEGURANÇA: O scout é READ-ONLY — só tem ler_arquivo, buscar_arquivos,
 * buscar_texto, parse_ast, e MCPs read. NÃO pode editar/escrever/executar.
 *
 * VISUAL: As tools chamadas pelo scout aparecem no chat com prefixo
 * "[scout]" para o usuário saber que foi o modelo menor que fez.
 */

import * as nodePath from "node:path";
import * as nodeFs from "node:fs";
import { config } from "./config.js";
import { getModelInfo, getModelMaxOutputTokens, modelSupportsTools, modelSupportsParallelTools } from "./modelRegistry.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";

// --- Types ------------------------------------------------------------------

export interface ScoutTask {
  /** Descrição do que ler/buscar (ex: "ler arquivo X", "buscar UI no Roblox") */
  description: string;
  /** Tipo de tarefa para o scout priorizar */
  type: "read_file" | "search_files" | "search_text" | "mcp_call" | "explore";
}

export interface ScoutArgs {
  /** Objetivo geral do scout (ex: "coletar contexto sobre o sistema de inventário") */
  objective: string;
  /** Lista de tarefas específicas de leitura/busca */
  tasks: ScoutTask[];
  /** Diretório base (default: cwd) */
  cwd?: string;
  /** Max tool calls (default 12) */
  maxToolCalls?: number;
}

export interface ScoutResult {
  /** Summary estruturado do que o scout encontrou */
  summary: string;
  /** Lista de arquivos inspecionados (path + relevância) */
  filesInspected: string[];
  /** Se o scout completou com sucesso */
  completed: boolean;
  /** Modelo usado */
  modelUsed: string;
  /** Número de tool calls feitas */
  toolCallCount: number;
  /** Erro se falhou */
  error?: string;
}

// --- Config -----------------------------------------------------------------

/** Whether the scout feature is enabled. */
export function isScoutEnabled(): boolean {
  return process.env.SCOUT_ENABLED === "1" || process.env.SCOUT_ENABLED === "true";
}

/** Get the model ID to use for the scout (default: mistral-medium-3.5). */
export function getScoutModel(): string {
  return process.env.SCOUT_MODEL ?? "mistralai/mistral-medium-3.5-128b";
}

/**
 * Validate that the scout model is usable (supports tools).
 * Returns error message if invalid, null if valid.
 */
export function validateScoutModel(): string | null {
  const modelId = getScoutModel();
  const info = getModelInfo(modelId);
  if (info.id === "unknown") {
    return `Scout model "${modelId}" not in registry. Set SCOUT_MODEL to a known model.`;
  }
  if (!modelSupportsTools(modelId)) {
    return `Scout model "${modelId}" does not support tools. Choose a model with supportsTools=true.`;
  }
  return null;
}

// --- System prompt ----------------------------------------------------------

const SCOUT_SYSTEM_PROMPT = `You are a SCOUT sub-agent for Claude-Killer. Your job: quickly gather context by reading files and searching code, then return a CONCISE summary for the main agent.

YOU ARE FAST: You use a smaller, faster model. Be efficient — don't over-explore.

RULES:
- You have ONLY read tools: ler_arquivo, buscar_arquivos, buscar_texto, parse_ast.
- You CANNOT edit, write, or run commands. Just read and report.
- Do AT MOST 12 tool calls. If you can't answer in 12, give your best guess.
- Be SPECIFIC: file paths, line numbers, key code snippets, function signatures.
- Don't repeat what you already found — summarize concisely.

FORMAT YOUR FINAL ANSWER AS:

## Summary
[concise answer to the main agent's objective — what you found, key insights]

## Files Inspected
- [path]: [what's relevant there, key line numbers]

## Key Findings
- [bullet points with file:line references, code snippets if useful]

## Recommendations
- [what the main agent should do next with this context]

If you can't find something, say so explicitly — don't invent.`;

// --- Read-only tools (same as subAgents READ_ONLY mode) ---------------------

const SCOUT_TOOLS = [
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
      description: "Search file contents with regex (grep).",
      parameters: {
        type: "object",
        properties: {
          padrao: { type: "string", description: "Regex pattern to search." },
          caminho: { type: "string", description: "Directory to search (default: cwd)." },
        },
        required: ["padrao"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "parse_ast",
      description: "Parse a file's AST and return symbols (functions, classes, etc).",
      parameters: {
        type: "object",
        properties: { caminho: { type: "string", description: "File path to parse." } },
        required: ["caminho"],
      },
    },
  },
];

// --- Tool executor (read-only, inline) --------------------------------------

/**
 * Resolve a path relative to cwd and enforce a boundary check so the scout
 * cannot read files outside the project directory (defense-in-depth against
 * path traversal: ../../../etc/passwd, absolute paths, symlinks, etc).
 *
 * BUG FIX (round 3 - symlink escape): use fs.realpathSync() to resolve
 * symlinks BEFORE checking the boundary. Without this, a symlink inside the
 * project pointing to /etc/passwd would bypass the lexical check.
 *
 * Returns the resolved real path, or throws if the path escapes cwd.
 */
function resolveAndCheckPath(rawPath: string, cwd: string): string {
  const resolved = nodePath.resolve(cwd, rawPath);
  const normalizedCwd = nodePath.resolve(cwd);
  // Use path.relative to robustly check if resolved is within cwd.
  const relative = nodePath.relative(normalizedCwd, resolved);
  if (relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    throw new Error(`Path traversal blocked: "${rawPath}" resolves outside project directory (${resolved})`);
  }
  // BUG FIX (symlink-escape): resolve symlinks with realpath and re-check.
  // A symlink inside the project could point to /etc/passwd — realpath
  // follows it and we verify the REAL target is still within cwd.
  try {
    const realPath = nodeFs.realpathSync(resolved);
    const realRelative = nodePath.relative(normalizedCwd, realPath);
    if (realRelative.startsWith("..") || nodePath.isAbsolute(realRelative)) {
      throw new Error(`Symlink escape blocked: "${rawPath}" resolves to "${realPath}" (outside project)`);
    }
    return realPath;
  } catch (err) {
    // If realpath fails (file doesn't exist), re-throw path traversal errors
    // but let other errors (ENOENT) pass through to the tool executor.
    if (err instanceof Error && err.message.includes("blocked")) {
      throw err;
    }
    // File doesn't exist yet — return the resolved path (tool will handle ENOENT)
    return resolved;
  }
}

/** Max bytes for a single tool result before truncation (prevents context overflow). */
const MAX_TOOL_RESULT_BYTES = 8192;

/**
 * Truncate a tool result string to MAX_TOOL_RESULT_BYTES to prevent the
 * scout's history from overflowing the model's context window.
 * Appends a truncation notice if truncated.
 */
function truncateResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_BYTES) return result;
  const truncated = result.slice(0, MAX_TOOL_RESULT_BYTES);
  const omitted = result.length - MAX_TOOL_RESULT_BYTES;
  return truncated + `\n\n[... truncated ${omitted} chars to fit context window ...]`;
}

/**
 * Execute a read-only tool call for the scout.
 * Returns the result string.
 */
async function executeScoutTool(toolName: string, args: Record<string, unknown>, cwd: string): Promise<string> {
  try {
    // Lazy import to avoid circular deps at module load
    const { lerArquivo } = await import("./tools.js");
    const { globSearch } = await import("./fileSearch.js");
    const { grepSearch, formatGrepResults } = await import("./contentSearch.js");
    const { parseFile } = await import("./lspAst.js");

    // BUG FIX (round 3 - context overflow): truncate all tool results to
    // MAX_TOOL_RESULT_BYTES to prevent the scout's history from overflowing
    // the model's context window. Without this, reading a 100KB file 3 times
    // would exceed the 128k context window.
    let rawResult: string;
    switch (toolName) {
      case "ler_arquivo":
      case "read_file":
      case "read": {
        const path = String(args.caminho ?? args.path ?? "");
        if (!path) return "[ERROR] No path provided";
        const resolved = resolveAndCheckPath(path, cwd);
        rawResult = await lerArquivo({ caminho: resolved });
        break;
      }
      case "buscar_arquivos":
      case "find_files":
      case "glob":
      case "list_files": {
        const pattern = String(args.pattern ?? args.padrao ?? "**/*");
        const results = globSearch({ pattern, cwd });
        rawResult = results.length > 0
          ? results.slice(0, 50).join("\n")
          : "(no files found)";
        break;
      }
      case "buscar_texto":
      case "buscar_conteudo":
      case "grep":
      case "search": {
        const pattern = String(args.padrao ?? args.pattern ?? args.query ?? "");
        if (!pattern) return "[ERROR] No search pattern provided";
        const searchPath = String(args.caminho ?? args.path ?? cwd);
        const resolved = resolveAndCheckPath(searchPath, cwd);
        const results = grepSearch({ pattern, path: resolved });
        rawResult = formatGrepResults(results);
        break;
      }
      case "parse_ast": {
        const path = String(args.caminho ?? args.path ?? "");
        if (!path) return "[ERROR] No path provided";
        const resolved = resolveAndCheckPath(path, cwd);
        const result = await parseFile(resolved);
        rawResult = typeof result === "string" ? result : JSON.stringify(result);
        break;
      }
      default:
        return `[ERROR] Unknown tool: ${toolName}`;
    }
    return truncateResult(rawResult);
  } catch (err) {
    // BUG FIX (error-handling): use instanceof Error to avoid TypeError if
    // the thrown value is not an Error (some libs throw strings/objects).
    const errMsg = err instanceof Error ? err.message : String(err);
    return `[ERROR] ${toolName} failed: ${errMsg}`;
  }
}

// --- Chat with model (saves/restores config.model) -------------------------

/**
 * Call the API with a DIFFERENT model than config.model.
 *
 * This temporarily swaps config.model, config.maxTokens, and the thinking
 * mode flags so the request goes to the scout model. After the call (success
 * or error), the original values are restored.
 *
 * The scout model must support tools (checked by validateScoutModel).
 */
async function chatWithScoutModel(
  messages: unknown[],
  tools: unknown[],
): Promise<{ content: string; tool_calls: unknown[] | undefined; finish_reason: string }> {
  const scoutModel = getScoutModel();

  try {
    // Dynamic import to avoid circular dependency
    const { chatWithModel } = await import("./apiClient.js");

    log.debug(`[SCOUT] Calling ${scoutModel} with ${messages.length} messages`);

    const response = await chatWithModel(
      messages as any,
      tools as any,
      scoutModel,
    );

    const choice = response.choices?.[0];
    if (!choice) {
      return { content: "", tool_calls: undefined, finish_reason: "error" };
    }

    return {
      content: choice.message?.content ?? "",
      tool_calls: choice.message?.tool_calls as unknown[] | undefined,
      finish_reason: choice.finish_reason ?? "stop",
    };
  } catch (err) {
    log.debug(`[SCOUT] chatWithModel failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// --- Main entry point -------------------------------------------------------

/**
 * Run the scout sub-agent to gather context using a smaller, faster model.
 *
 * The scout:
 * 1. Receives the objective + tasks from the main agent
 * 2. Calls read-only tools (ler_arquivo, buscar_texto, etc) up to maxToolCalls times
 * 3. Returns a structured summary for the main agent
 *
 * Returns null if scout is disabled or fails to produce useful output.
 */
export async function runScout(args: ScoutArgs): Promise<ScoutResult | null> {
  // Feature gate
  if (!isScoutEnabled()) {
    log.debug("[SCOUT] Skipped — feature disabled (set SCOUT_ENABLED=1)");
    return null;
  }

  // Validate model
  const modelError = validateScoutModel();
  if (modelError) {
    log.warn(`[SCOUT] Model validation failed: ${modelError}`);
    return {
      summary: "",
      filesInspected: [],
      completed: false,
      modelUsed: getScoutModel(),
      toolCallCount: 0,
      error: modelError,
    };
  }

  // BUG FIX (cwd-bypass): validate that cwd is within the project directory.
  // Without this, a prompt-injected model could pass cwd: "/etc" and the
  // boundary check would allow reading any file in /etc.
  const projectRoot = process.cwd();
  const rawCwd = args.cwd ?? projectRoot;
  // Resolve and validate cwd is within projectRoot
  const resolvedCwd = nodePath.resolve(rawCwd);
  const cwdRelative = nodePath.relative(projectRoot, resolvedCwd);
  if (cwdRelative.startsWith("..") || nodePath.isAbsolute(cwdRelative)) {
    log.warn(`[SCOUT] cwd "${rawCwd}" is outside project directory — blocking`);
    return {
      summary: "",
      filesInspected: [],
      completed: false,
      modelUsed: getScoutModel(),
      toolCallCount: 0,
      error: `cwd "${rawCwd}" is outside project directory`,
    };
  }
  const cwd = resolvedCwd;
  // BUG FIX (maxToolCalls-clamp): clamp maxToolCalls to [1, 50] to prevent
  // DoS via prompt injection (model could pass maxToolCalls: 1000000).
  const rawMaxCalls = args.maxToolCalls ?? 12;
  const maxCalls = Math.max(1, Math.min(50, typeof rawMaxCalls === "number" && !Number.isNaN(rawMaxCalls) ? rawMaxCalls : 12));
  const scoutModel = getScoutModel();

  // BUG FIX (input-validation): validate objective and tasks to avoid
  // TypeError if caller passes undefined/non-string/non-array.
  if (typeof args.objective !== "string" || args.objective.length === 0) {
    return {
      summary: "",
      filesInspected: [],
      completed: false,
      modelUsed: scoutModel,
      toolCallCount: 0,
      error: "Invalid objective (must be non-empty string)",
    };
  }
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    return {
      summary: "",
      filesInspected: [],
      completed: false,
      modelUsed: scoutModel,
      toolCallCount: 0,
      error: "Invalid tasks (must be non-empty array)",
    };
  }

  log.info(`[SCOUT] Starting scout (${scoutModel}): "${args.objective.slice(0, 80)}..." (${args.tasks.length} tasks, maxCalls=${maxCalls})`);

  // Surface scout activity in the TUI
  const shortObj = args.objective.length > 60 ? args.objective.slice(0, 59) + "…" : args.objective;
  const scoutActivityDone = pushActivity("subagent", `scout: ${shortObj}`);

  // BUG FIX (round 3 - global timeout): wrap the entire scout in a timeout
  // to prevent it from running for hours in pathological cases (slow model +
  // max calls). Default 120s (2 min) — override via SCOUT_MAX_DURATION_MS.
  const SCOUT_MAX_DURATION_MS = parseInt(process.env.SCOUT_MAX_DURATION_MS ?? "120000", 10);

  try {
    // Build initial history with objective + tasks
    const tasksStr = args.tasks.map((t, i) => `${i + 1}. [${t.type}] ${t.description}`).join("\n");
    const initialHistory = [
      { role: "system", content: SCOUT_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Working directory: ${cwd}\n\nObjective: ${args.objective}\n\nTasks:\n${tasksStr}\n\nGather context efficiently. Use the tools to read files and search code. When done, return your summary in the specified format.`,
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let history: any[] = [...initialHistory];
    let callNum = 0;
    const filesInspected = new Set<string>();
    let finalSummary = "";

    const scoutStartTime = Date.now();

    while (callNum < maxCalls) {
      // BUG FIX (round 3 - global timeout): check if we've exceeded the
      // timeout. If so, return what we have so far (or timeout error).
      if (Date.now() - scoutStartTime > SCOUT_MAX_DURATION_MS) {
        log.warn(`[SCOUT] Timeout after ${callNum} calls (${Date.now() - scoutStartTime}ms > ${SCOUT_MAX_DURATION_MS}ms)`);
        // If we have any summary content, return it; otherwise timeout error
        if (finalSummary || history.length > 0) {
          const lastAssistant = [...history].reverse().find((m: any) => m.role === "assistant");
          finalSummary = finalSummary || lastAssistant?.content || "[SCOUT] Timed out before producing a summary.";
          break;
        }
        return {
          summary: "",
          filesInspected: [...filesInspected],
          completed: false,
          modelUsed: scoutModel,
          toolCallCount: callNum,
          error: `Scout timeout after ${SCOUT_MAX_DURATION_MS}ms`,
        };
      }

      callNum++;
      log.debug(`[SCOUT] Tool call round ${callNum}/${maxCalls}`);

      const response = await chatWithScoutModel(history, SCOUT_TOOLS);

      // BUG FIX (false-positive): if finish_reason is "error" (no choice),
      // return completed=false instead of treating empty content as summary.
      if (response.finish_reason === "error" || (!response.content && !response.tool_calls?.length)) {
        log.warn(`[SCOUT] API returned no useful response (finish_reason=${response.finish_reason})`);
        return {
          summary: "",
          filesInspected: [...filesInspected],
          completed: false,
          modelUsed: scoutModel,
          toolCallCount: callNum,
          error: "API returned no useful response",
        };
      }

      // Add assistant message to history
      history.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });

      // If no tool calls, this is the final summary
      if (!response.tool_calls || response.tool_calls.length === 0) {
        finalSummary = response.content;
        break;
      }

      // Execute each tool call and add results to history
      // BUG FIX (tcId-collision): use entries() to get index for unique tcId.
      for (const [tcIdx, tc] of (response.tool_calls as any[]).entries()) {
        const toolName = tc.function?.name ?? "unknown";
        // BUG FIX (tool_call_id): validate tc.id — if missing, generate a
        // synthetic ID so the API doesn't reject the next request with 400.
        // Include tcIdx to avoid collision when multiple tool_calls in the
        // same round lack IDs.
        const tcId = tc.id ?? `scout-tc-${callNum}-${tcIdx}-${Date.now()}`;
        let parsedArgs: Record<string, unknown> = {};
        try {
          // BUG FIX (empty-arguments): treat empty string as "{}" (some
          // providers return arguments: "" in streaming/partial tool calls).
          const argStr = tc.function?.arguments?.trim() || "{}";
          parsedArgs = JSON.parse(argStr);
        } catch (parseErr) {
          // BUG FIX (instanceof-error): use instanceof Error for safe access.
          const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          log.warn(`[SCOUT] Malformed JSON args for ${toolName}: ${parseMsg}`);
          history.push({
            role: "tool",
            tool_call_id: tcId,
            content: `[ERROR] Malformed JSON arguments: ${parseMsg}`,
          });
          continue;
        }

        log.info(`[SCOUT] Tool: ${toolName}(${JSON.stringify(parsedArgs).slice(0, 80)})`);

        // BUG FIX (tool-exception-aborts): wrap executeScoutTool in local
        // try/catch so a single tool failure doesn't abort the entire scout.
        let result: string;
        let success = false;
        try {
          result = await executeScoutTool(toolName, parsedArgs, cwd);
          success = !result.startsWith("[ERROR]");
        } catch (toolErr) {
          const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
          result = `[ERROR] ${toolName} internal error: ${errMsg}`;
        }

        // BUG FIX (filesInspected-timing): only track files AFTER successful
        // execution, and store the resolved path (not raw). Previously, paths
        // that failed (traversal blocked, file not found) were tracked as
        // "inspected" — misleading the main agent.
        if (success) {
          const pathArg = parsedArgs.caminho ?? parsedArgs.path;
          if (typeof pathArg === "string") {
            try {
              const resolved = resolveAndCheckPath(pathArg, cwd);
              filesInspected.add(resolved);
            } catch {
              // path resolution failed — don't track
            }
          }
        }

        history.push({
          role: "tool",
          tool_call_id: tcId,
          content: result,
        });
      }

      // BUG FIX (dead-code): removed the unreachable `finish_reason === "stop"
      // && !tool_calls?.length` check — it was already handled by the
      // `!response.tool_calls` break above.
    }

    // If we ran out of calls without a final summary, use the last content
    if (!finalSummary && history.length > 0) {
      const lastAssistant = [...history].reverse().find((m: any) => m.role === "assistant");
      finalSummary = lastAssistant?.content ?? "[SCOUT] Ran out of tool calls without producing a summary.";
    }

    log.info(`[SCOUT] Completed: ${callNum} calls, ${filesInspected.size} files inspected`);

    return {
      summary: finalSummary,
      filesInspected: [...filesInspected],
      completed: true,
      modelUsed: scoutModel,
      toolCallCount: callNum,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`[SCOUT] Failed: ${errMsg}`);
    return {
      summary: "",
      filesInspected: [],
      completed: false,
      modelUsed: scoutModel,
      toolCallCount: 0,
      error: errMsg,
    };
  } finally {
    scoutActivityDone();
  }
}

/**
 * Format the scout result for injection into the main agent's context.
 * Returns a string that can be added as a system message.
 */
export function formatScoutResult(result: ScoutResult): string {
  if (!result.completed) {
    return `[SCOUT FAILED] Model: ${result.modelUsed}, Error: ${result.error ?? "unknown"}. Continue with ler_arquivo/buscar_texto directly.`;
  }

  const filesList = result.filesInspected.length > 0
    ? `\n\n## Files Inspected by Scout (already read \u2014 no need to re-read)\n${result.filesInspected.map((f) => `- ${f}`).join("\n")}\n`
    : "";

  return `[SCOUT CONTEXT — gathered by ${result.modelUsed} (${result.toolCallCount} tool calls)]

${result.summary}
${filesList}
[End of scout context — use this to proceed directly to editing without re-reading these files]`;
}

/**
 * Reset scout state (for tests).
 */
export function _resetScoutForTests(): void {
  // No module-level state to reset currently — this is here for future use
  // and to match the pattern of other modules (bugHunter, dataGuard, etc).
}
