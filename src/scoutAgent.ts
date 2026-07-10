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
import { getModelInfo, modelSupportsTools } from "./modelRegistry.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";
// FIX-SCOUT (BH9 HIGH 2): extract resolveAndCheckPath into a shared utility
// so subAgents.ts and smallTaskAgent.ts use the same hard boundary.
import { resolveAndCheckPath, validateCwd } from "./pathSecurity.js";

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
  /** Max tool calls (default 50, max 100 — scout can explore deep UIs) */
  maxToolCalls?: number;
  /**
   * Optional callback fired BEFORE each tool call — lets the TUI show
   * what the scout is doing in real-time (same as main agent's onToolCall).
   * The toolName is prefixed with "scout:" so the user knows it's the
   * smaller model doing the work.
   */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /**
   * Optional callback fired AFTER each tool call completes — lets the TUI
   * show the result (or error) in real-time (same as main agent's onToolResult).
   */
  onToolResult?: (toolName: string, ok: boolean, resultStr: string) => void;
}

export interface ToolCallRecord {
  /** Nome da tool chamada (ler_arquivo, buscar_texto, etc) */
  tool: string;
  /** Argumentos passados para a tool */
  args: Record<string, unknown>;
  /** Resultado completo retornado pela tool (conteúdo do arquivo, resultados de busca, etc) */
  result: string;
  /** Se a tool executou com sucesso (não começou com [ERROR]) */
  success: boolean;
}

export interface ScoutResult {
  /** Resultados crus de cada tool call feita pelo scout */
  toolResults: ToolCallRecord[];
  /** Lista de arquivos inspecionados (paths resolvidos) */
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

/** Get the model ID to use for the scout (default: diffusiongemma-26b-a4b-it). */
export function getScoutModel(): string {
  return process.env.SCOUT_MODEL ?? "google/diffusiongemma-26b-a4b-it";
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

const SCOUT_SYSTEM_PROMPT = `You are a SCOUT sub-agent for Claude-Killer. Your ONLY job is to make read/search tool calls quickly.

YOU ARE FAST: You use a smaller, faster model. Your purpose is to execute read/search calls so the main (slower) model doesn't have to.

RULES:
- You have ONLY read tools: ler_arquivo, buscar_arquivos, buscar_texto, parse_ast.
- You CANNOT edit, write, or run commands. Just read and search.
- Do AT MOST 100 tool calls. Execute ALL the tasks given to you. Explore deeply if needed — navigate UIs, read nested files.
- You MUST call at least ONE tool before responding. Do NOT respond with "DONE" without making tool calls first.
- After ALL tool calls are done, respond with exactly: DONE
- The main agent will receive the FULL results of your tool calls (file contents, search results) directly.

CRITICAL: Start by calling the appropriate tool for each task. Do not explain what you will do — just do it.`;

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

// FIX-SCOUT (BH9 HIGH 2): resolveAndCheckPath has been extracted to
// src/pathSecurity.ts so subAgents.ts and smallTaskAgent.ts can share the
// same canonical implementation. See pathSecurity.ts for the algorithm
// (path.relative() + fs.realpathSync() with symlink-escape defense).
//
// Re-export for any external caller that imported it from this module.
export { resolveAndCheckPath } from "./pathSecurity.js";

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
      true, // disableThinking — scout doesn't need reasoning, just fast tool calls
    );

    const choice = response.choices?.[0];
    if (!choice) {
      log.warn(`[SCOUT] No choice in response (model=${scoutModel}). Response: ${JSON.stringify(response).slice(0, 200)}`);
      return { content: "", tool_calls: undefined, finish_reason: "error" };
    }

    const content = choice.message?.content ?? "";
    const toolCalls = choice.message?.tool_calls as unknown[] | undefined;
    const reasoning = (choice.message as any)?.reasoning_content ?? "";

    // BUG FIX (scout-no-results): Some reasoning models (DiffusionGemma 26B)
    // return ONLY reasoning_content with no content and no tool_calls on the
    // first call. The scout then sees empty content + no tool_calls → treats
    // it as "no useful response" → returns completed=false → "no results".
    // Fix: log the situation so we can diagnose, and treat reasoning-only
    // responses as "model is thinking, continue the loop" instead of error.
    if (!content && (!toolCalls || toolCalls.length === 0)) {
      log.warn(`[SCOUT] Model ${scoutModel} returned no content and no tool_calls. finish_reason=${choice.finish_reason}. reasoning_content=${reasoning.length} chars. Treating as 'thinking' — will retry.`);
      // Return with content="DONE" so the loop breaks and we return what we have
      // (which may be nothing — but at least we don't show "no results" error)
      return { content: "DONE", tool_calls: undefined, finish_reason: choice.finish_reason ?? "stop" };
    }

    return {
      content,
      tool_calls: toolCalls,
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
      toolResults: [],
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
  //
  // FIX-SCOUT (BH9 HIGH 2): use the shared `validateCwd` utility from
  // pathSecurity.ts so the scout and sub-agent share the same boundary logic.
  const projectRoot = process.cwd();
  const cwdValidation = validateCwd(args.cwd, projectRoot);
  if (!cwdValidation.ok) {
    log.warn(`[SCOUT] ${cwdValidation.error} — blocking`);
    return {
      toolResults: [],
      filesInspected: [],
      completed: false,
      modelUsed: getScoutModel(),
      toolCallCount: 0,
      error: cwdValidation.error,
    };
  }
  const cwd = cwdValidation.cwd;
  // BUG FIX (maxToolCalls-clamp): clamp maxToolCalls to [1, 100] to prevent
  // DoS via prompt injection (model could pass maxToolCalls: 1000000).
  // Default is 50 (was 12 originally — bumped via commit 8803f76 so the
  // IA can request up to 100 calls for deep UI navigation in Roblox).
  // See BUSINESS_RULES.md §10.7 (FIX-SCOUT HIGH 1).
  const rawMaxCalls = args.maxToolCalls ?? 50;
  const maxCalls = Math.max(1, Math.min(100, typeof rawMaxCalls === "number" && !Number.isNaN(rawMaxCalls) ? rawMaxCalls : 50));
  const scoutModel = getScoutModel();

  // BUG FIX (input-validation): validate objective and tasks to avoid
  // TypeError if caller passes undefined/non-string/non-array.
  if (typeof args.objective !== "string" || args.objective.length === 0) {
    return {
      toolResults: [],
      filesInspected: [],
      completed: false,
      modelUsed: scoutModel,
      toolCallCount: 0,
      error: "Invalid objective (must be non-empty string)",
    };
  }
  if (!Array.isArray(args.tasks) || args.tasks.length === 0) {
    return {
      toolResults: [],
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
    // BUG FIX (raw-results): collect ALL tool results (file contents, search
    // results) to pass VERBATIM to the main agent. The scout does NOT
    // summarize — the main agent gets the full raw data so it can work with
    // it directly, skipping the slow round-trips of reading files itself.
    const toolResults: ToolCallRecord[] = [];

    const scoutStartTime = Date.now();

    while (callNum < maxCalls) {
      // BUG FIX (round 3 - global timeout): check if we've exceeded the
      // timeout. If so, return what we have so far (or timeout error).
      if (Date.now() - scoutStartTime > SCOUT_MAX_DURATION_MS) {
        log.warn(`[SCOUT] Timeout after ${callNum} calls (${Date.now() - scoutStartTime}ms > ${SCOUT_MAX_DURATION_MS}ms)`);
        // If we have tool results, return them — the main agent can still use partial data
        if (toolResults.length > 0) {
          break;
        }
        return {
          toolResults: [],
          filesInspected: [...filesInspected],
          completed: false,
          modelUsed: scoutModel,
          toolCallCount: callNum,
          error: `Scout timeout after ${SCOUT_MAX_DURATION_MS}ms`,
        };
      }

      callNum++;
      log.debug(`[SCOUT] Tool call round ${callNum}/${maxCalls}`);

      // TODO(BH9 MEDIUM 2): The timeout check above only fires BETWEEN
      // iterations — a single hung `chatWithScoutModel` call (e.g., the
      // OpenAI client's 5-min timeout, a stalled TCP connection, or a
      // model that streams tokens but never finishes) will block this
      // `await` until the SDK's own timeout fires, ignoring
      // SCOUT_MAX_DURATION_MS entirely. The proper fix mirrors
      // smallTaskAgent.ts:raceWithTimeout (~line 588) — wrap the call in
      // Promise.race against an AbortController-driven timeout promise so
      // the scout terminates promptly on timeout (the underlying call
      // continues in the background but the user sees the error and the
      // `finally` block runs `clearModelOverride`). Deferred because the
      // fix requires threading an AbortController through chatWithModel
      // → chat() → createStreamRequest, which is a larger change. Until
      // then, the per-iteration check at the top of the loop is the best
      // we can do, and the OpenAI client's own timeout (5 min) is the
      // hard ceiling.
      const response = await chatWithScoutModel(history, SCOUT_TOOLS);

      // BUG FIX (false-positive): if finish_reason is "error" (no choice),
      // return completed=false instead of treating empty content as summary.
      if (response.finish_reason === "error" || (!response.content && !response.tool_calls?.length)) {
        log.warn(`[SCOUT] API returned no useful response (finish_reason=${response.finish_reason})`);
        // If we already have tool results from previous rounds, return them
        if (toolResults.length > 0) {
          break;
        }
        return {
          toolResults: [],
          filesInspected: [...filesInspected],
          completed: false,
          modelUsed: scoutModel,
          toolCallCount: callNum,
          error: "API returned no useful response",
        };
      }

      // Add assistant message to history
      // BUG FIX (empty-content-400): NVIDIA API rejects assistant messages
      // with null/empty content ("Empty content is not allowed for assistant
      // messages"). When the model returns only tool_calls (no text), set
      // content to a non-empty placeholder so the next API call doesn't 400.
      history.push({
        role: "assistant",
        content: response.content || "(calling tools)",
        tool_calls: response.tool_calls,
      });

      // If no tool calls, the scout is done — BUT only if it made at least
      // one tool call. If it hasn't made any tool calls yet, nudge it.
      if (!response.tool_calls || response.tool_calls.length === 0) {
        if (toolResults.length === 0 && callNum < maxCalls) {
          // BUG FIX (scout-no-results): model responded without making any
          // tool calls. Nudge it to make at least one call before giving up.
          log.warn(`[SCOUT] Model responded without tool calls at round ${callNum}. Nudging...`);
          history.push({
            role: "user",
            content: "You MUST call at least one tool (ler_arquivo, buscar_arquivos, buscar_texto, or parse_ast) before responding. Make the tool call NOW.",
          });
          continue;
        }
        break;
      }

      // Execute each tool call and add results to history
      // BUG FIX (tcId-collision): use entries() to get index for unique tcId.
      for (const [tcIdx, tc] of (response.tool_calls as any[]).entries()) {
        const toolName = tc.function?.name ?? "unknown";
        const tcId = tc.id ?? `scout-tc-${callNum}-${tcIdx}-${Date.now()}`;
        let parsedArgs: Record<string, unknown> = {};
        try {
          // BUG FIX (malformed-json): some models generate arguments with
          // trailing characters after the JSON. Try strict parse first,
          // then fall back to extracting the JSON object.
          const argStr = tc.function?.arguments?.trim() || "{}";
          try {
            parsedArgs = JSON.parse(argStr);
          } catch {
            // Try extracting just the JSON object { ... }
            const firstBrace = argStr.indexOf("{");
            const lastBrace = argStr.lastIndexOf("}");
            if (firstBrace >= 0 && lastBrace > firstBrace) {
              parsedArgs = JSON.parse(argStr.slice(firstBrace, lastBrace + 1));
            } else {
              throw new Error("No valid JSON object found");
            }
          }
        } catch (parseErr) {
          const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          log.warn(`[SCOUT] Malformed JSON args for ${toolName}: ${parseMsg}`);
          const errResult = `[ERROR] Malformed JSON arguments: ${parseMsg}`;
          history.push({ role: "tool", tool_call_id: tcId, content: errResult });
          toolResults.push({ tool: toolName, args: {}, result: errResult, success: false });
          continue;
        }

        log.info(`[SCOUT] Tool: ${toolName}(${JSON.stringify(parsedArgs).slice(0, 80)})`);

        // BUG FIX (visual-feedback): fire onToolCall callback so the TUI shows
        // what the scout is doing in real-time. Prefix with "scout:" so the
        // user knows it's the smaller model, not the main agent.
        if (args.onToolCall) {
          try { args.onToolCall(`scout:${toolName}`, parsedArgs); } catch { /* callback error shouldn't break scout */ }
        }

        // Execute the tool
        let result: string;
        let success = false;
        try {
          result = await executeScoutTool(toolName, parsedArgs, cwd);
          success = !result.startsWith("[ERROR]");
        } catch (toolErr) {
          const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
          result = `[ERROR] ${toolName} internal error: ${errMsg}`;
        }

        // BUG FIX (visual-feedback): fire onToolResult callback so the TUI
        // shows the result (or error) in real-time. ALL calls appear visually
        // — including failed ones — so the user can see if the scout is
        // looping or hitting errors.
        if (args.onToolResult) {
          try { args.onToolResult(`scout:${toolName}`, success, result.slice(0, 200)); } catch { /* callback error shouldn't break scout */ }
        }

        // Track files inspected (resolved path, only on success)
        if (success) {
          const pathArg = parsedArgs.caminho ?? parsedArgs.path;
          if (typeof pathArg === "string") {
            try {
              const resolved = resolveAndCheckPath(pathArg, cwd);
              filesInspected.add(resolved);
            } catch { /* path resolution failed — don't track */ }
          }
        }

        // BUG FIX (raw-results): record the FULL tool result (file content,
        // search results, etc) — NOT a summary. The main agent gets this
        // verbatim so it has the actual data to work with.
        toolResults.push({
          tool: toolName,
          args: parsedArgs,
          result,
          success,
        });

        history.push({
          role: "tool",
          tool_call_id: tcId,
          content: result,
        });
      }
    }

    log.info(`[SCOUT] Completed: ${callNum} rounds, ${toolResults.length} tool calls, ${filesInspected.size} files inspected`);

    return {
      toolResults,
      filesInspected: [...filesInspected],
      completed: true,
      modelUsed: scoutModel,
      toolCallCount: toolResults.length,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error(`[SCOUT] Failed: ${errMsg}`);
    return {
      toolResults: [],
      filesInspected: [],
      completed: false,
      modelUsed: scoutModel,
      toolCallCount: 0,
      error: errMsg,
    };
  } finally {
    // BH9 MEDIUM 1 FIX: clear the model override as a safety net. The scout
    // calls chatWithModel (via chatWithScoutModel) which sets modelOverride
    // and clears it in its own `finally` block. But if chatWithModel is
    // still running when this function returns (e.g., the global timeout
    // fires between iterations and we exit early, or a tool-execution error
    // throws while a chat call is in flight), the override could leak into
    // subsequent main-agent chat() calls — silently routing them through
    // the scout's smaller model. Mirrors smallTaskAgent.ts:776.
    // Safe no-op when chatWithModel's own finally has already cleared it.
    try {
      const { clearModelOverride } = await import("./apiClient.js");
      clearModelOverride();
    } catch {
      // Dynamic import failed (test environment without apiClient mock) —
      // ignore; the override is module-level state that resets on reload.
    }
    scoutActivityDone();
  }
}

/**
 * Format the scout result for injection into the main agent's context.
 *
 * BUG FIX (raw-results): the scout does NOT summarize. It returns the FULL
 * raw results of every tool call (file contents, search results, AST output)
 * verbatim. The main agent gets the actual data — not a summary — so it can
 * work with it directly without re-reading files.
 *
 * Format:
 *   [SCOUT RESULTS — gathered by <model> (N tool calls)]
 *
 *   ## Tool Call 1: ler_arquivo
 *   Args: {"caminho": "src/foo.ts"}
 *   Result:
 *   <full file content>
 *
 *   ## Tool Call 2: buscar_texto
 *   Args: {"padrao": "SetAsync"}
 *   Result:
 *   <full search results>
 *   ...
 *
 *   ## Files Inspected (already read — no need to re-read)
 *   - path1
 *   - path2
 */
export function formatScoutResult(result: ScoutResult): string {
  if (!result.completed || result.toolResults.length === 0) {
    return `[SCOUT FAILED] Model: ${result.modelUsed}, Error: ${result.error ?? "no results"}. Continue with ler_arquivo/buscar_texto directly.`;
  }

  // BUG FIX (filter-errors): only include SUCCESSFUL tool results in the
  // formatted output that goes to the main agent. Failed calls (errors,
  // path traversal blocked, file not found, etc) are filtered out so the
  // main agent doesn't waste context window on useless error messages.
  // The user already saw ALL calls (including failures) in real-time via
  // the onToolCall/onToolResult callbacks — so nothing is hidden from the
  // user, only from the main agent's context.
  const successfulResults = result.toolResults.filter((tr) => tr.success);

  if (successfulResults.length === 0) {
    const failedCount = result.toolResults.length;
    return `[SCOUT] All ${failedCount} tool calls failed. The scout could not read any files or search any code. Continue with ler_arquivo/buscar_texto directly.`;
  }

  const resultsStr = successfulResults.map((tr, i) => {
    const argsStr = JSON.stringify(tr.args);
    return `## Tool Call ${i + 1}: ${tr.tool}\nArgs: ${argsStr}\nResult:\n${tr.result}`;
  }).join("\n\n---\n\n");

  const failedSummary = successfulResults.length < result.toolResults.length
    ? `\n\n(${result.toolResults.length - successfulResults.length} failed calls were filtered out — you saw them in the chat already)`
    : "";

  const filesList = result.filesInspected.length > 0
    ? `\n\n## Files Inspected by Scout (already read — no need to re-read)\n${result.filesInspected.map((f) => `- ${f}`).join("\n")}`
    : "";

  return `[SCOUT RESULTS — gathered by ${result.modelUsed} (${successfulResults.length} successful calls, ${result.toolResults.length} total)]

${resultsStr}
${filesList}${failedSummary}

[End of scout results — use these raw file contents and search results directly. Do NOT re-read these files.]`;
}

/**
 * Reset scout state (for tests).
 */
export function _resetScoutForTests(): void {
  // No module-level state to reset currently — this is here for future use
  // and to match the pattern of other modules (bugHunter, dataGuard, etc).
}
