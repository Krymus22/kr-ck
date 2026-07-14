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
// FEAT-SCOUT-MCP: MCP Roblox Studio read-only tools so the scout can find
// UIs, read scripts, and search the game tree directly via MCP.
import { getActiveMCPServers, getMCPToolDefinitions, callMCPTool } from "./extensions.js";
import { classifyMcpTool, extractToolName } from "./robloxMcpGuard.js";
import type OpenAI from "openai";

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

/**
 * Agent ID used for anti-recursion (CLAUDE_KILLER_AGENT_ID env var).
 * Set at the top of runScout and cleared in the finally block — same pattern
 * as smallTaskAgent.ts (SMALL_TASK_AGENT_ID) and orchestratorAgent.ts
 * (ORCHESTRATOR_AGENT_ID). §10.7 / §10.9.
 */
const SCOUT_AGENT_ID = "scout";

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
- You have read tools: ler_arquivo, buscar_arquivos, buscar_texto, parse_ast, and executar_comando_readonly (for safe read-only commands like ls, cat, git status, grep).
- You CANNOT edit, write, or run modifying commands (rm, mv, cp, echo >). Just read, search, and run safe read-only commands.
- Do AT MOST 100 tool calls. Execute ALL the tasks given to you. Explore deeply if needed — navigate UIs, read nested files.
- You MUST call at least ONE tool before responding. Do NOT respond with "DONE" without making tool calls first.
- After ALL tool calls are done, respond with exactly: DONE
- The main agent will receive the FULL results of your tool calls (file contents, search results) directly.

You also have access to MCP Roblox Studio tools (if connected): script_read, script_search, script_grep, search_game_tree, inspect_instance, console_output, get_studio_state.
Use these to find UIs, read scripts, and search the game tree in Roblox Studio.

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
  // FIX-MED-SCOUT-APP (S1-4 MED 4): §10.7 lists only "ler_arquivo, buscar_arquivos,
  // buscar_texto, parse_ast" for the scout. executar_comando_readonly added per
  // user request — read-only commands complement the read tools (ls, git status,
  // git log, wc, etc) and are constrained by the same allowlist used by the
  // orchestrator. Do NOT remove without confirming §10.7 is updated.
  {
    type: "function" as const,
    function: {
      name: "executar_comando_readonly",
      // FIX-MED-SCOUT-APP (S1-4 MED 5, S1-4 LOW 6): "find" was removed from the
      // allowlist (FIX-ORCH-CRIT CRITICAL 1 — find has -delete/-exec) but was
      // still listed here, misleading the model into calling it and getting
      // rejected. The list now matches READONLY_COMMAND_PREFIXES exactly.
      description: "Execute a READ-ONLY shell command (ls, cat, git status, git log, grep, wc, pwd, etc). NÃO pode executar comandos que modificam arquivos (rm, mv, cp, echo >, find, etc).",
      parameters: {
        type: "object",
        properties: {
          comando: { type: "string", description: "O comando read-only para executar" },
        },
        required: ["comando"],
      },
    },
  },
];

/**
 * Allowlist of read-only command prefixes. The scout can ONLY execute
 * commands that start with one of these. Any command not in this list
 * is rejected with an error message.
 *
 * SECURITY: this is an ALLOWLIST (not blocklist) — if a command is not
 * explicitly listed, it's rejected. This prevents the scout from running
 * destructive commands even if the model is prompt-injected.
 */
// FIX-ORCH-CRIT (CRITICAL 1): Removed echo (write when used with `>`), find
// (has -delete / -exec), env / printenv (dump API keys), and ps / top / lsof
// (leak process info). The allowlist now contains ONLY safe read-only commands.
const READONLY_COMMAND_PREFIXES = [
  "ls", "ll", "dir", "cat", "head", "tail", "wc", "grep", "rg",
  "git status", "git log", "git diff", "git branch", "git show", "git blame",
  "git remote", "git rev-parse", "git ls-files", "git stash list",
  "pwd", "which", "where", "whereis", "file", "stat", "du", "df",
  "npm ls", "npm list", "npm view", "npm info",
  "node --version", "npm --version", "npx --version",
  "rojo --version", "selene --version", "stylua --version",
  "wally --version", "tarmac --version",
  "hostname", "uname", "date", "cal",
];

function isReadOnlyCommand(comando: string): boolean {
  const trimmed = comando.trim().toLowerCase();
  // FIX-ORCH-S1 (HIGH 6): REJECT sudo commands entirely (don't strip).
  // Previously the code stripped a leading `sudo ` and then ran the rest of
  // the command — which means `sudo cat /etc/shadow` was treated as
  // `cat /etc/shadow` and ALLOWED. Stripping is the wrong direction: sudo
  // is a privilege-escalation primitive and any command requiring it is by
  // definition not a safe read-only command. Reject outright.
  if (trimmed.startsWith("sudo ")) {
    return false;
  }
  const withoutSudo = trimmed;

  // FIX-ORCH-CRIT (CRITICAL 1): REJECT shell metacharacters to prevent
  // injection. The previous prefix-only check passed `ls; rm -rf /`,
  // `cat foo > file`, `echo x > ~/.bashrc`, etc. Block any of:
  // ; & | ` $ < > && || $( ${ \n \r
  if (/[;&|`$<>]|&&|\|\||\$\(|\$\{|\n|\r/.test(withoutSudo)) {
    return false;
  }

  // FIX-ORCH-S1 (CRITICAL 3): Reject commands that read sensitive files.
  // Even though `cat` is in the read-only allowlist, `cat /proc/self/environ`,
  // `cat ~/.ssh/id_rsa`, `cat .env`, `cat /etc/shadow` etc. leak credentials
  // (API keys, SSH private keys, password hashes). This mirrors the rationale
  // used to remove `env`/`printenv` from the allowlist (defense-in-depth
  // against credential exfiltration via the read-only command channel).
  const SENSITIVE_PATH_PATTERNS = [
    /\/proc\/self\/(environ|cmdline|status)/,
    /\/etc\/(shadow|passwd)/,
    /\.ssh\//,
    /\.env\b/,
    /id_rsa/,
    /authorized_keys/,
  ];
  if (SENSITIVE_PATH_PATTERNS.some(p => p.test(withoutSudo))) {
    return false;
  }

  return READONLY_COMMAND_PREFIXES.some(prefix =>
    withoutSudo.startsWith(prefix + " ") || withoutSudo === prefix
  );
}

/**
 * Get MCP tools that are classified as "read" (read-only).
 * These are added to the scout's tool set so it can read Roblox Studio
 * instances, search the game tree, etc.
 *
 * FEAT-SCOUT-MCP: enables the scout to call MCP Roblox Studio read-only
 * tools (script_read, script_search, script_grep, search_game_tree,
 * inspect_instance, console_output, get_studio_state) to find UIs, read
 * scripts, and search the game tree directly via the connected MCP server.
 *
 * Tools are filtered via robloxMcpGuard.classifyMcpTool — only "read"
 * tools pass through. Write/execute/playtest/session tools are excluded
 * (the scout is READ-ONLY by design).
 */
function getMCPReadTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const allMcpTools = getMCPToolDefinitions();
  return allMcpTools.filter(tool => {
    // Extract the tool name (format: "serverName__toolName") and classify
    // it. classifyMcpTool expects the bare name (e.g. "script_read"), so we
    // strip the server prefix via extractToolName first.
    const prefixedName = tool.function.name;
    const bareName = extractToolName(prefixedName);
    const classification = classifyMcpTool(bareName);
    return classification === "read";
  });
}

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
async function executeScoutTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  // FIX-MED-SCOUT-APP (S1-4 LOW 7): pass the active tool set so the MCP
  // dispatch can verify the model isn't hallucinating a tool name. The
  // previous `toolName.includes("__")` check would happily dispatch ANY
  // string containing "__" to callMCPTool — including hallucinated names
  // that aren't actually registered on any MCP server (e.g. "foo__bar").
  // See the default-case comment below for the new logic.
  allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [],
): Promise<string> {
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
      case "executar_comando_readonly": {
        const comando = String(args.comando ?? "");
        if (!comando) return "[ERROR] No command provided";
        if (!isReadOnlyCommand(comando)) {
          // FIX-MED-SCOUT-APP (S1-4 MED 5, S1-4 LOW 6): "find" is no longer in
          // the allowlist (FIX-ORCH-CRIT CRITICAL 1 — find has -delete/-exec).
          // Don't list it as an example here or the model will keep trying.
          return `[ERROR] Command not in read-only allowlist: "${comando.slice(0, 50)}". Only read-only commands are allowed (ls, cat, git status, grep, wc, pwd, etc).`;
        }
        const { executarComando } = await import("./tools.js");
        const result = await executarComando({
          comando,
          cwd,
          timeoutMs: 15000, // 15s for scout (faster than main agent's 60s)
          background: false,
        });
        rawResult = typeof result === "string" ? result : String(result);
        break;
      }
      default: {
        // FEAT-SCOUT-MCP: Check if this is an MCP tool (format: "serverName__toolName").
        // MCP tools are prefixed with the server name and two underscores, e.g.
        // "Roblox_Studio__script_read". If the tool name matches this pattern,
        // delegate to callMCPTool — the actual tool execution happens in the
        // MCP server process (e.g. the Roblox Studio plugin).
        //
        // FIX-MED-SCOUT-APP (S1-4 LOW 7): the previous check was a fragile
        // `toolName.includes("__")`. ANY string containing "__" was dispatched
        // to callMCPTool — including hallucinated names that aren't registered
        // on any MCP server (e.g. "foo__bar", "evil__exfil"). The new logic
        // first verifies the tool is actually in the active tool set (which is
        // SCOUT_TOOLS + getMCPReadTools(), computed once at the top of runScout
        // and passed in as `allTools`). Only if it's a known tool AND contains
        // "__" do we treat it as an MCP dispatch. This closes the hallucination
        // gap without breaking legitimate MCP calls.
        const isKnownTool = allTools.some(t => t.function.name === toolName);
        if (toolName.includes("__") && isKnownTool) {
          // FIX-ORCH-CRIT (CRITICAL 2): Re-classify MCP tool — only "read"
          // tools are allowed in the scout. getMCPReadTools() filters the tool
          // LIST shown to the model, but the model can still HALLUCINATE a
          // write/execute tool name (e.g. "Roblox_Studio__multi_edit"). Without
          // this re-check, callMCPTool would happily execute the write tool,
          // bypassing the read-only restriction entirely. Re-run the classifier
          // and reject anything that is not strictly "read".
          const classification = classifyMcpTool(extractToolName(toolName));
          if (classification !== "read") {
            return `[ERROR] MCP tool ${toolName} is classified as "${classification}" — only read-only MCP tools are allowed in scout.`;
          }
          try {
            const result = await callMCPTool(toolName, args);
            rawResult = typeof result === "string" ? result : JSON.stringify(result);
          } catch (err) {
            rawResult = `[ERROR] MCP tool ${toolName} failed: ${(err as Error).message}`;
          }
          break;
        }
        return `[ERROR] Unknown tool: ${toolName}`;
      }
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
      undefined, // onStreamStart
      undefined, // onToken
      undefined, // onThinking
      true,      // §17.13 rule 119: isScout=true — activate SCOUT_EXCLUDE_KEY_INDEX
    );

    const choice = response.choices?.[0];
    if (!choice) {
      log.warn(`[SCOUT] No choice in response (model=${scoutModel}). Response: ${JSON.stringify(response).slice(0, 200)}`);
      return { content: "", tool_calls: undefined, finish_reason: "error" };
    }

    const content = choice.message?.content ?? "";
    const toolCalls = choice.message?.tool_calls as unknown[] | undefined;
    const reasoning = (choice.message as any)?.reasoning_content ?? "";

    // FIX-MED-SEC (S1-7 MED): Previously, when a reasoning model returned
    // ONLY reasoning_content (no content, no tool_calls), we MASKED the
    // empty response as content="DONE" so the scout loop would "break and
    // return what we have". That was buggy: when there were no prior tool
    // results, the loop nudged the model maxCalls times, then broke and
    // returned `completed: true` with `toolResults: []` — a SILENT FAILURE.
    // The orchestrator/main agent then treated the scout as "succeeded with
    // no data" and had no signal to fall back to direct tool calls.
    //
    // Now we return the empty response as-is. The false-positive check in
    // runScout (just below the chatWithScoutModel call) catches this case
    // and returns `completed: false` with a clear error, so the caller can
    // fall back to direct ler_arquivo/buscar_texto calls. This matches the
    // behavior the bug report requests: "if the model responds with no
    // tool calls AND no content, return completed:false with an error
    // instead of completed:true". The "DONE" sentinel is still honored
    // when the model itself emits content="DONE" (it's truthy, so the
    // false-positive check doesn't trigger).
    if (!content && (!toolCalls || toolCalls.length === 0)) {
      log.warn(
        `[SCOUT] Model ${scoutModel} returned no content and no tool_calls. ` +
          `finish_reason=${choice.finish_reason}. reasoning_content=${reasoning.length} chars. ` +
          `Returning empty response — runScout will treat as no useful response.`,
      );
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

// --- Scout internal summary (§17.13 rule 114) --------------------------------

/**
 * Threshold below which we DON'T summarize — small files are already cheap
 * to keep in context. 2KB = ~500 tokens, not worth an extra LLM call.
 */
const SCOUT_SUMMARY_THRESHOLD_BYTES = 2048;

/**
 * Max tokens for the scout's internal summary of a file. Keep it tiny —
 * this is just enough for the scout to remember "what was this file about"
 * without blowing up its own context window.
 */
const SCOUT_SUMMARY_MAX_TOKENS = 100;

/**
 * Generate a SHORT internal summary of a file result for the scout's own
 * context. This is SEPARATE from the raw result that goes to the main agent.
 *
 * Why: without this, reading 10 files of 8KB each fills the scout's context
 * with 80KB of file content. The scout can't reason about what to read next
 * because its context is full. With summaries, each file takes ~200 bytes
 * in the scout's context, so it can explore 50+ files without overflow.
 *
 * The RAW content is still returned to the main agent via toolResults —
 * the summary is ONLY for the scout's internal history.
 *
 * §17.13 rule 114: scout summary is INTERNAL only. toolResults always
 * contains the RAW content for the main agent.
 *
 * @param result  The raw tool result (file content, search results, etc)
 * @param toolName  The tool that produced this result (for context)
 * @returns  A short summary (1-2 sentences) or the original result if small
 */
async function summarizeForScoutContext(result: string, toolName: string): Promise<string> {
  // Don't summarize small results — not worth the LLM call
  if (result.length < SCOUT_SUMMARY_THRESHOLD_BYTES) {
    return result;
  }

  // Don't summarize errors — pass through
  if (result.startsWith("[ERROR]")) {
    return result;
  }

  try {
    const scoutModel = getScoutModel();
    const { chatWithModel } = await import("./apiClient.js");

    const summaryPrompt = [
      {
        role: "system" as const,
        content: `You are a code summarizer. Summarize the following ${toolName} result in 1-2 sentences. Focus on: what it contains, key names/identifiers, and overall structure. Be extremely concise. Do NOT include code snippets — just describe what's there.`,
      },
      {
        role: "user" as const,
        content: result.slice(0, 12000), // cap input to avoid huge summarization calls
      },
    ];

    const response = await chatWithModel(
      summaryPrompt as any,
      [], // BH-403-SCOUT-SUMMARY HIGH-1 fix: pass [] (not undefined) so createStreamRequest
      // sends tools: [] instead of defaulting to TOOL_DEFINITIONS. Without this,
      // every summarizer call ships the full ~21-tool main-agent set (~2-4K wasted
      // tokens) AND the model might emit tool_calls instead of a summary.
      scoutModel,
      true, // disableThinking — fast summary
      undefined, // onStreamStart
      undefined, // onToken
      undefined, // onThinking
      true,      // §17.13 rule 119: isScout=true — summarizer is part of scout, exclude reserved key
    );

    const summary = response.choices?.[0]?.message?.content?.trim() ?? "";
    if (summary.length === 0) {
      // Fallback: use truncated raw
      return result.slice(0, 500) + `\n[... ${result.length - 500} chars total — summarized failed, truncated]`;
    }

    // Mark as summary so the scout knows this isn't the full content
    return `[INTERNAL SUMMARY — full content (${result.length} chars) sent to main agent]\n${summary}`;
  } catch (err) {
    // Summarization failed — fall back to truncated raw
    const errMsg = err instanceof Error ? err.message : String(err);
    log.debug(`[SCOUT] Summary generation failed (${errMsg}), using truncated raw`);
    return result.slice(0, 500) + `\n[... ${result.length - 500} chars total — summary failed: ${errMsg}]`;
  }
}

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

  // FIX-MED-SCOUT-APP (S1-4 HIGH 1): Anti-recursion guard. Set
  // CLAUDE_KILLER_AGENT_ID = "scout" so that any nested sub-agent (small task,
  // planner, coder, orchestrator) that checks this env var sees we're already
  // inside a scout run and refuses to recurse. Mirrors smallTaskAgent.ts:611-612.
  //
  // The ID is set AFTER the feature-gate / model / cwd / input validations
  // above (so a skipped scout doesn't pollute the env var) but BEFORE the tool
  // loop (so any tool call that triggers a nested agent is blocked). Cleared in
  // the `finally` below — same pattern as smallTaskAgent.ts:808-816.
  //
  // §10.7 "Anti-recursão": scout não pode ser chamado de dentro de sub-agentes.
  // §10.9 "Anti-recursão ajustada": scout blocks "scout", "sub-agent",
  // "small-task-agent" — permits "planner", "coder", "orchestrator".
  const prevAgentId = process.env.CLAUDE_KILLER_AGENT_ID;
  process.env.CLAUDE_KILLER_AGENT_ID = SCOUT_AGENT_ID;

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

    // FEAT-SCOUT-MCP: Combine scout's built-in read-only tools with any
    // active MCP Roblox Studio read-only tools (script_read, script_search,
    // script_grep, search_game_tree, inspect_instance, console_output,
    // get_studio_state). Computed ONCE before the loop — MCP server/tool
    // list doesn't change mid-run, and recomputing per iteration wastes
    // cycles. If no MCP servers are active, this is just SCOUT_TOOLS.
    const allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
      ...SCOUT_TOOLS,
      ...getMCPReadTools(),
    ];
    log.debug(`[SCOUT] Tool set: ${allTools.length} tools (${SCOUT_TOOLS.length} built-in + ${allTools.length - SCOUT_TOOLS.length} MCP read)`);

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
      const response = await chatWithScoutModel(history, allTools);

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
            content: "You MUST call at least one tool (ler_arquivo, buscar_arquivos, buscar_texto, parse_ast, or executar_comando_readonly) before responding. Make the tool call NOW.",
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
          result = await executeScoutTool(toolName, parsedArgs, cwd, allTools);
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

        // §17.13 rule 114: scout internal summary.
        // For the scout's OWN context (history), use a short summary instead
        // of the raw result. This prevents context overflow when reading many
        // files. The RAW result is already in toolResults (above) for the
        // main agent.
        //
        // summarizeForScoutContext() skips small results (< 2KB) and errors,
        // so it only fires an LLM call when the result is large enough to
        // matter. Each summary is ~100 tokens, so the scout can explore
        // 50+ files without blowing its 256k context window.
        const internalSummary = await summarizeForScoutContext(result, toolName);
        history.push({
          role: "tool",
          tool_call_id: tcId,
          content: internalSummary,
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
    // FIX-MED-SCOUT-APP (S1-4 HIGH 1): Restore the previous agent ID. If it
    // was undefined, DELETE the env var (setting process.env.X = undefined
    // sets the STRING "undefined", which is truthy and would trigger the
    // anti-recursion guard on the next call). Mirrors smallTaskAgent.ts:808-816.
    if (prevAgentId === undefined) {
      delete process.env.CLAUDE_KILLER_AGENT_ID;
    } else {
      process.env.CLAUDE_KILLER_AGENT_ID = prevAgentId;
    }

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
