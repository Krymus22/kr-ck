/**
 * agent.ts - The core agentic query loop.
 *
 * Orchestrates the full ReAct-style cycle:
 *   User message -> API call -> tool execution (if needed) -> repeat -> final reply
 *
 * Also handles the auto-heal sub-loop for escrever_arquivo:
 *   guardrail fail -> inject error -> retry API -> up to MAX_HEAL_RETRIES times
 *
 * Architecture:
 *   runAgentLoop(userInput)
 *     +-- sendAndProcess()               <- recursive until no more tool calls
 *           +-- chat(history)            <- throttled API call
 *           +-- dispatchToolCall()       <- routes to all tools via handler table
 *           |     +-- [escrever] healLoop() <- up to 3 retries on guardrail fail
 *           +-- recurse until finish_reason === "stop"
 */

import OpenAI from "openai";
import { chat, TOOL_DEFINITIONS } from "./apiClient.js";
import * as history from "./history.js";
import { executePreToolCallHooks, executePostToolCallHooks } from "./hooks.js";
import { getMCPToolDefinitions, callMCPTool } from "./extensions.js";
import * as log from "./logger.js";
import { config } from "./config.js";
import { readFileAdvanced } from "./fileRead.js";
import { editFile, type EditOperation } from "./fileEdit.js";
import { globSearch } from "./fileSearch.js";
import { grepSearch, formatGrepResults } from "./contentSearch.js";
import { gitStatus, gitDiff, gitLog, gitCommit, gitBlame, gitShow, gitBranch, gitCheckout } from "./gitTool.js";
import { multiFileEdit, type FileEditRequest } from "./multiFileEdit.js";
import { saveSession, loadSession, listSessions } from "./session.js";
import { parseFile } from "./lspAst.js";
import { withRetry, isRetryableError } from "./retry.js";
import { readOnlyCache, shouldCacheResult } from "./toolCache.js";
import { executeParallelTools, type ParallelToolCall } from "./parallelTools.js";
import { startSession, endSession, recordToolCall, recordMessage } from "./telemetry.js";
import { smartCompact } from "./contextCompaction.js";
import {
  getMemoryConfig,
  ensureMemoryDirs,
  injectMemory,
  formatInjectedMemory,
  createCheckpoint,
  saveSessionTrace,
  shouldWriteCheckpoint,
  type FileChange,
  type SessionTrace,
} from "./memory.js";
import { runTests, formatTestResult, suggestFixes, formatFixSuggestions } from "./testRunner.js";
import {
  getRegistry,
  getDetector,
  getExecutor,
  getSuggester,
  initializeTools,
  type Tool,
} from "./externalTools.js";
import { executeTrigger, type TriggerContext } from "./extensionCenter.js";
import { think, THINK_TOOL_DEFINITION } from "./thinkTool.js";
import {
  ASK_USER_TOOL_DEFINITION,
  handleAskUser,
  setAskUserCallback,
  clearAskUserCallback,
  type AskUserCallback,
} from "./askUser.js";
import {
  loadActiveManifests,
  generateFunctionCallsFromManifests,
  executeFromManifest,
  isManifestTool,
  type ToolManifest,
} from "./manifestLoader.js";
import { pushActivity, withActivity, clearActivity } from "./activityTracker.js";
import {
  shouldBlockForFalsePromise,
  resetFalsePromiseCounter,
} from "./promiseDetector.js";
import { checkReadBeforeWrite, recordRead } from "./readBeforeWrite.js";
import { validateToolCall, formatValidationErrors } from "./toolSchemaValidation.js";
import { desfazerEdicao, listarBackups, aplicarDiff, executarComando, lerArquivo } from "./tools.js";
import { pokaYokeCheck, EXPANDED_TOOL_DESCRIPTIONS } from "./pokaYoke.js";
import { runQualityGate, resetGateState, isStrictModeEnabled } from "./strictQualityGate.js";
import { getActiveMode as getActiveModeFromModes } from "./modes.js";
import { getContextInjection, resetContextInjection } from "./contextInjector.js";
import { shouldSelfValidate, injectSelfValidationPrompt, resetSelfValidation } from "./selfValidation.js";
import { getEffortLevel, setEffortLevel } from "./effortLevels.js";
import { runSubAgent } from "./subAgents.js";
import { generateTestSuggestionForFile, resetAutoTestSuggestions } from "./autoTestGenerator.js";
import { formatPoolStats, getPoolSize } from "./apiKeyPool.js";
import {
  initTaskStateFromUserMessage,
  updateTaskState,
  readTaskState,
  getTaskStateSummary,
  appendTaskStateItem,
  type TaskState,
} from "./taskState.js";

type ToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
type ToolResult = { resultStr: string; usedHeal: boolean };

// --- Memory State -------------------------------------------------------------

const memoryConfig = getMemoryConfig();
ensureMemoryDirs(memoryConfig);

let sessionFileChanges: FileChange[] = [];
let sessionToolsUsed: string[] = [];
let sessionStartTime = "";
let lastCheckpointTokens = 0;
/** Paths touched by write tools in the current turn - used by the strict quality gate */
let turnTouchedFiles: Set<string> = new Set();
/** Counter of stop_reason hits in the current turn (for quality gate loop) */
let turnStopHits = 0;
/** Max stops per turn (safety) */
const MAX_STOPS_PER_TURN = 12;

/**
 * Tool call/result callbacks set by runAgentLoop at the start of each turn.
 * Stored at module level (instead of being passed through sendAndProcess →
 * handleChatResponse → processToolCalls → dispatchToolCall) to avoid
 * threading them through every recursive call. They're reset to undefined
 * at the end of runAgentLoop so they don't leak across turns.
 */
let currentOnToolCall: ((toolName: string, args: Record<string, unknown>) => void) | undefined;
let currentOnToolResult: ((toolName: string, ok: boolean, resultStr: string) => void) | undefined;

// Sprint 3: Cache of manifests for the active mode.
// Refreshed on each runAgentLoop call.
let activeManifests: ToolManifest[] = [];

/**
 * Sub-agent concurrency limiter (semaphore).
 *
 * With 4 API keys:
 *   - 1 key for main agent
 *   - 2 keys for sub-agents (MAX_CONCURRENT_SUB_AGENTS=2)
 *   - 1 key always free for delayed hedging backup
 *
 * This prevents the model from spawning 5 sub-agents that would exhaust
 * all keys, leaving no room for hedging.
 *
 * Configurable via MAX_CONCURRENT_SUB_AGENTS env var.
 * Default depends on provider: NVIDIA=2, ZenMux=10.
 */
import { getProviderMaxSubAgents } from "./apiProvider.js";
const MAX_CONCURRENT_SUB_AGENTS = parseInt(
  process.env.MAX_CONCURRENT_SUB_AGENTS ?? String(getProviderMaxSubAgents()),
  10
);
let activeSubAgents = 0;
const subAgentWaitQueue: Array<() => void> = [];

async function acquireSubAgentSlot(): Promise<void> {
  if (activeSubAgents < MAX_CONCURRENT_SUB_AGENTS) {
    activeSubAgents++;
    log.debug(`[SUB_AGENT_LIMIT] Acquired slot (${activeSubAgents}/${MAX_CONCURRENT_SUB_AGENTS})`);
    return;
  }
  // Wait for a slot
  await new Promise<void>((resolve) => {
    subAgentWaitQueue.push(() => {
      activeSubAgents++;
      log.debug(`[SUB_AGENT_LIMIT] Acquired slot after wait (${activeSubAgents}/${MAX_CONCURRENT_SUB_AGENTS})`);
      resolve();
    });
  });
}

function releaseSubAgentSlot(): void {
  activeSubAgents--;
  const next = subAgentWaitQueue.shift();
  if (next) {
    next();
  } else {
    log.debug(`[SUB_AGENT_LIMIT] Released slot (${activeSubAgents}/${MAX_CONCURRENT_SUB_AGENTS})`);
  }
}

// --- Helpers ------------------------------------------------------------------

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function asString(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "symbol") return String(val);
  if (typeof val === "object") return JSON.stringify(val);
  return fallback;
}

function getMergedTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const mcpTools = getMCPToolDefinitions();
  const externalTools = getExternalToolDefinitions();

  const allTools = [...TOOL_DEFINITIONS, ...externalTools];
  allTools.push(THINK_TOOL_DEFINITION);
  allTools.push(ASK_USER_TOOL_DEFINITION);

  if (mcpTools.length > 0) {
    allTools.push(...mcpTools);
  }

  // 3.8 Poka-Yoke: append expanded descriptions (with examples + edge cases)
  // to the tool definitions so the model has concrete guidance.
  for (const tool of allTools) {
    const name = tool.function.name;
    const extra = EXPANDED_TOOL_DESCRIPTIONS[name];
    if (extra) {
      tool.function.description = (tool.function.description ?? "") + extra;
    }
  }

  return allTools;
}

/**
 * Public accessor for the merged tool list (used by sub-agents).
 * Includes TOOL_DEFINITIONS + external tools + think tool + MCP tools,
 * all with poka-yoke expanded descriptions.
 *
 * Sprint A bug fix: recarrega activeManifests se estiver vazio. Antes,
 * chamar getMergedToolsPublic() ANTES de runAgentLoop() retornava lista
 * sem manifest tools (rojo_build, selene_lint, etc) porque
 * activeManifests só era setado dentro de runAgentLoop. Isso causava
 * bug onde sub-agentes não viam as tools de manifest.
 */
export function getMergedToolsPublic(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  // Sprint A: ensure activeManifests is loaded
  if (activeManifests.length === 0) {
    try {
      activeManifests = loadActiveManifests();
      log.debug(`[AGENT] getMergedToolsPublic: loaded ${activeManifests.length} manifests (lazy)`);
    } catch (err) {
      log.debug(`[AGENT] getMergedToolsPublic: failed to load manifests: ${(err as Error).message}`);
    }
  }
  return getMergedTools();
}

/**
 * Public accessor for the tool dispatcher (used by sub-agents).
 * Delegates to the internal dispatchToolCall function.
 *
 * The sub-agent passes the same tool calls it would to the main dispatcher,
 * and gets back the same result. This means sub-agents have access to ALL
 * tools (write, edit, git, test, etc) with full safety checks (read-before-
 * write, schema validation, poka-yoke, etc).
 *
 * The sub-agent inherits the file lock from the same module - so if both
 * the main agent and a sub-agent try to edit the same file, one will wait.
 */
export async function dispatchToolCallPublic(
  toolCall: ToolCall,
  healRetry: number = 0
): Promise<ToolResult> {
  // Sprint A: ensure activeManifests is loaded (otherwise manifest tools
  // like rojo_build/selene_lint would be unknown to dispatchToolCall)
  if (activeManifests.length === 0) {
    try {
      activeManifests = loadActiveManifests();
      log.debug(`[AGENT] dispatchToolCallPublic: loaded ${activeManifests.length} manifests (lazy)`);
    } catch (err) {
      log.debug(`[AGENT] dispatchToolCallPublic: failed to load manifests: ${(err as Error).message}`);
    }
  }
  return dispatchToolCall(toolCall, healRetry);
}

function getExternalToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];

  // Sprint 3: Generate specific function calls from manifests (rojo_build, wally_install, etc.)
  // These replace the old generic `executar_tool` for tools that have manifests.
  const manifestTools = generateFunctionCallsFromManifests(
    activeManifests,
    getActiveModeFromModes()?.name ?? null,
  );
  tools.push(...manifestTools);

  // Keep old generic tools as fallback (for tools without manifests)
  tools.push(
    {
      type: "function",
      function: {
        name: "listar_tools",
        description: "List all available external tools, optionally filtered by category",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", description: "Filter by category: roblox, python, node, rust, go, docker" }
          }
        }
      }
    },
  );

  return tools;
}

function alreadyInHistory(toolCallId: string): boolean {
  const lastMsg = history.getHistory().at(-1) as { role?: string; tool_call_id?: string } | undefined;
  return lastMsg?.role === "tool" && lastMsg?.tool_call_id === toolCallId;
}

// --- Tool Handlers ------------------------------------------------------------

type ToolHandler = (
  args: Record<string, unknown>,
  toolCall: ToolCall,
  healRetry: number,
) => Promise<ToolResult>;

const toolHandlers: Record<string, ToolHandler> = {
  // Sprint 1: AskUser — IA faz pergunta, agent pausa, usuário responde
  "perguntar_usuario": async (args) => {
    return handleAskUser(args);
  },

  "ler_arquivo": async (args) => {
    // Sprint C: merged ler_arquivo + ler_arquivo_avancado into one tool.
    // Supports offset/limit/grep (optional) + backwards compat with caminho.
    const filePath = asString(args.path ?? args.caminho);
    const { readFileAdvanced } = await import("./fileRead.js");
    const result = readFileAdvanced({
      path: filePath,
      offset: args.offset as number | undefined,
      limit: args.limit as number | undefined,
      grep: args.grep as string | undefined,
      contextLines: args.contextLines as number | undefined,
    });
    return { resultStr: result, usedHeal: false };
  },

  "executar_comando": async (args) => {
    const result = await executarComando({ comando: asString(args.comando) });
    return { resultStr: result, usedHeal: false };
  },

  "editar_arquivo": async (args) => {
    const filePath = asString(args.path ?? args.caminho);
    // Sprint C bug fix (BUG-R): salvar backup no rollbackStore ANTES de editar.
    // Antes, desfazer_edicao não encontrava backup porque editar_arquivo nunca
    // chamava saveBackup — só fazia .bak file se options.backup=true (que não
    // era passado). Agora salva no rollbackStore automaticamente.
    try {
      const { saveBackup } = await import("./rollbackStore.js");
      const resolved = await import("node:path").then((p) => p.resolve(filePath));
      if (await import("node:fs").then((fs) => fs.existsSync(resolved))) {
        const content = await import("node:fs").then((fs) => fs.readFileSync(resolved, "utf8"));
        saveBackup(resolved, content, "editar_arquivo");
      }
    } catch {
      // rollbackStore não disponível — não bloqueia o edit
    }

    // Sprint C bug fix (BUG-T): algumas IAs (especialmente Llama) passam
    // 'edits' como string JSON em vez de array nativo. Auto-parse se string.
    let edits = args.edits as EditOperation[] | undefined;
    if (typeof edits === "string") {
      try {
        edits = JSON.parse(edits);
      } catch {
        // não é JSON válido — deixa como está pra schema validation pegar
      }
    }
    if (edits && Array.isArray(edits)) {
      const result = await editFile(
        filePath,
        edits,
        { createIfMissing: args.createIfMissing === true || args.createIfMissing === "true" }
      );
      readOnlyCache.invalidate("ler_arquivo", { caminho: args.path ?? args.caminho });
      return { resultStr: result, usedHeal: false };
    }
    const edit: EditOperation = {
      search: asString(args.search ?? args.oldString),
      replace: asString(args.replace ?? args.newString),
      all: args.all === true || args.all === "true",
    };
    const result = await editFile(
      filePath,
      [edit],
      { createIfMissing: args.createIfMissing === true || args.createIfMissing === "true" }
    );
    return { resultStr: result, usedHeal: false };
  },

  "buscar_arquivos": async (args) => {
    const results = globSearch({
      pattern: asString(args.pattern ?? args.glob, "**/*"),
      cwd: args.cwd as string | undefined,
      maxDepth: args.maxDepth as number | undefined,
      ignore: args.ignore as string[] | undefined,
    });
    const output = results.length > 0 ? results.join("\n") : "Nenhum arquivo encontrado.";
    return { resultStr: output, usedHeal: false };
  },

  "buscar_texto": async (args) => {
    const matches = grepSearch({
      pattern: asString(args.pattern),
      path: args.path as string | undefined,
      include: args.include as string | undefined,
      ignore: args.ignore as string[] | undefined,
      maxResults: args.maxResults as number | undefined,
      contextLines: args.contextLines as number | undefined,
      caseInsensitive: args.caseInsensitive as boolean | undefined,
      wholeWord: args.wholeWord as boolean | undefined,
    });
    const output = formatGrepResults(matches);
    return { resultStr: output, usedHeal: false };
  },

  "git_status": async (args) => {
    const status = await gitStatus(args.cwd as string | undefined);
    const output = [
      `Branch: ${status.branch}`,
      status.ahead > 0 ? `Ahead: ${status.ahead}` : "",
      status.behind > 0 ? `Behind: ${status.behind}` : "",
      status.staged.length > 0 ? `Staged: ${status.staged.join(", ")}` : "",
      status.modified.length > 0 ? `Modified: ${status.modified.join(", ")}` : "",
      status.untracked.length > 0 ? `Untracked: ${status.untracked.join(", ")}` : "",
      status.conflicted.length > 0 ? `Conflicted: ${status.conflicted.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    return { resultStr: output ?? "Clean working tree.", usedHeal: false };
  },

  "git_diff": async (args) => {
    const result = await gitDiff(
      args.cwd as string | undefined,
      args.file as string | undefined,
      args.staged as boolean | undefined
    );
    return { resultStr: result ?? "No changes.", usedHeal: false };
  },

  "git_log": async (args) => {
    const result = await gitLog(
      args.cwd as string | undefined,
      (args.count as number) ?? 10,
      args.file as string | undefined
    );
    return { resultStr: result, usedHeal: false };
  },

  "git_commit": async (args) => {
    const result = await gitCommit(
      asString(args.message),
      args.cwd as string | undefined,
      args.files as string[] | undefined
    );
    readOnlyCache.invalidate("git_status");
    readOnlyCache.invalidate("git_log");
    return { resultStr: result, usedHeal: false };
  },

  "git_blame": async (args) => {
    const result = await gitBlame(
      asString(args.file ?? args.filePath),
      args.cwd as string | undefined,
      args.startLine as number | undefined,
      args.endLine as number | undefined
    );
    return { resultStr: result, usedHeal: false };
  },

  "git_show": async (args) => {
    const result = await gitShow(asString(args.commitHash), args.cwd as string | undefined);
    return { resultStr: result, usedHeal: false };
  },

  "git_branch": async (args) => {
    const result = await gitBranch(args.cwd as string | undefined);
    return { resultStr: result, usedHeal: false };
  },

  "git_checkout": async (args) => {
    const result = await gitCheckout(asString(args.branch), args.cwd as string | undefined);
    return { resultStr: result, usedHeal: false };
  },

  "editar_multi_arquivos": async (args) => {
    const requests = args.requests as FileEditRequest[] | undefined;
    if (!requests || !Array.isArray(requests)) {
      return { resultStr: "[ERRO] 'requests' array is required", usedHeal: false };
    }
    const result = multiFileEdit(requests);
    const errorList = result.errors.map((e) => `${e.file}: ${e.error}`).join("; ");
    const output = result.success
      ? `[SUCESSO] Editados: ${result.filesEdited.join(", ")}`
      : `[ERRO] Falhas: ${errorList}`;
    return { resultStr: output, usedHeal: false };
  },

  "parse_ast": async (args) => {
    const result = await parseFile(asString(args.path ?? args.filePath));
    const output = [
      `Language: ${result.language}`,
      `Lines: ${result.lineCount}`,
      `Symbols: ${result.symbols.length}`,
      ...result.symbols.map((s: { type: string; name: string; line: number; exported: boolean }) => `  ${s.type} ${s.name} (line ${s.line})${s.exported ? " [exported]" : ""}`),
      `Imports: ${result.imports.length}`,
      ...result.imports.map((i: { module: string }) => `  ${i.module}`),
    ].join("\n");
    return { resultStr: output, usedHeal: false };
  },

  "executar_testes": async (args) => {
    const dir = asString(args.dir, process.cwd());
    const filePath = args.path ? asString(args.path) : undefined;
    const result = await runTests(dir, filePath);
    return { resultStr: formatTestResult(result), usedHeal: false };
  },

  "sugerir_fixes": async (args) => {
    const dir = asString(args.dir, process.cwd());
    const result = await runTests(dir);
    const suggestions = suggestFixes(result);
    return { resultStr: formatFixSuggestions(suggestions), usedHeal: false };
  },

  // --- External Tools ----------------------------------------------------

  "listar_tools": async (args) => {
    const registry = getRegistry();
    const category = args.category ? asString(args.category) : undefined;
    
    const tools = category ? registry.getByCategory(category as any) : registry.getAll();
    const installed = tools.filter(t => registry.isInstalled(t.name));
    const notInstalled = tools.filter(t => !registry.isInstalled(t.name));
    
    const output = [
      `G Total: ${tools.length} tools`,
      `OK Instaladas: ${installed.length}`,
      `X Não instaladas: ${notInstalled.length}`,
      "",
      "Tools instaladas:",
      ...installed.map(t => `  * ${t.name} (${t.category}) - ${t.description}`),
      "",
      "Tools não instaladas:",
      ...notInstalled.map(t => `  * ${t.name} (${t.category}) - ${t.description}`)
    ].filter(Boolean).join("\n");
    
    return { resultStr: output, usedHeal: false };
  },

  "adicionar_tool": async (args) => {
    const registry = getRegistry();
    
    const newTool: Tool = {
      name: asString(args.name),
      description: asString(args.description),
      category: "custom",
      command: asString(args.command),
      args: (args.args as string[]) ?? [],
      flags: (args.flags as any[]) ?? [],
      detection: {
        method: "binary",
        check: asString(args.check_command, `${asString(args.command)} --version`)
      },
      context: {
        whenToUse: (args.when_to_use as string[]) ?? [],
        examples: (args.examples as string[]) ?? []
      },
      outputParser: "raw"
    };
    
    const result = registry.addTool(newTool);
    return { resultStr: result.message, usedHeal: false };
  },

  "sugerir_tool": async (args) => {
    const suggester = getSuggester();
    const message = asString(args.message);
    
    const suggestions = suggester.suggest(message);
    
    if (suggestions.length === 0) {
      return { resultStr: "Nenhuma tool sugerida para esta mensagem.", usedHeal: false };
    }
    
    const output = [
      "Q Tools sugeridas:",
      ...suggestions.slice(0, 5).map((s, i) => 
        `${i + 1}. ${s.tool.name} (${s.tool.category}) - Confiança: ${(s.confidence * 100).toFixed(0)}%\n   Motivo: ${s.reason}`
      )
    ].join("\n");
    
    return { resultStr: output, usedHeal: false };
  },

  "detectar_tools": async (args) => {
    const detector = getDetector();
    const message = args.message ? asString(args.message) : "";
    const dir = args.dir ? asString(args.dir) : undefined;
    
    const detection = detector.detect(message, dir);
    
    const output = [
      "Q Detecção de Tools:",
      "",
      "Por intenção:",
      detection.intent ? `  * ${detection.intent.tool}` : "  * Nenhuma",
      "",
      "Por contexto do projeto:",
      detection.context.length > 0 
        ? detection.context.map(t => `  * ${t.name} (${t.category})`).join("\n")
        : "  * Nenhuma"
    ].join("\n");
    
    return { resultStr: output, usedHeal: false };
  },

  // --- Think Tool (3.1) ----------------------------------------------------
  "pensar": async (args) => {
    const result = await think({
      pensamento: asString(args.pensamento),
      categoria: asString(args.categoria, "general"),
    });
    // Update task state based on thinking category
    if (args.categoria === "planning" && asString(args.pensamento).length > 20) {
      // Heuristic: capture planning thoughts as a decision
      const snippet = asString(args.pensamento).slice(0, 200).replaceAll("\n", " ");
      appendTaskStateItem("decisions", `[plan] ${snippet}`);
    }
    return { resultStr: result.message, usedHeal: false };
  },

  // --- Rollback Tools (3.3) ------------------------------------------------
  "desfazer_edicao": async (args) => {
    const result = desfazerEdicao({ caminho: asString(args.caminho ?? args.path) });
    return { resultStr: result, usedHeal: false };
  },

  "listar_backups": async (args) => {
    const result = listarBackups({ caminho: args.caminho ? asString(args.caminho) : undefined });
    return { resultStr: result, usedHeal: false };
  },

  // --- Task State Tools (3.7) ----------------------------------------------
  "atualizar_estado": async (args) => {
    const patch: Partial<TaskState> = {};
    if (args.title) patch.title = asString(args.title);
    if (Array.isArray(args.done)) patch.done = args.done as string[];
    if (Array.isArray(args.todo)) patch.todo = args.todo as string[];
    if (Array.isArray(args.decisions)) patch.decisions = args.decisions as string[];
    if (Array.isArray(args.bugs)) patch.bugs = args.bugs as string[];
    if (Array.isArray(args.dependencies)) patch.dependencies = args.dependencies as string[];
    if (args.notes) patch.notes = asString(args.notes);
    const updated = updateTaskState(patch);
    return {
      resultStr: `[SUCESSO] TASK_STATE.md atualizado em ${updated.updatedAt}.\n` +
        `Done: ${updated.done.length} | Todo: ${updated.todo.length} | Decisions: ${updated.decisions.length} | Bugs: ${updated.bugs.length}`,
      usedHeal: false,
    };
  },

  "marcar_feito": async (args) => {
    const item = asString(args.item);
    if (!item) {
      return { resultStr: "[ERRO] 'item' é obrigatório (substring do item em todo).", usedHeal: false };
    }
    const { markTaskItemDone } = await import("./taskState.js");
    const updated = markTaskItemDone(item);
    return {
      resultStr: `[SUCESSO] Item movido para 'done': "${item}".\nTodo restante: ${updated.todo.length}`,
      usedHeal: false,
    };
  },

  "pesquisar_api_atualizada": async (args) => {
    const nome = asString(args.nome);
    const linguagem = asString(args.linguagem);
    if (!nome || !linguagem) {
      return {
        resultStr: "[ERRO] 'nome' e 'linguagem' são obrigatórios. Exemplo: pesquisar_api_atualizada({nome: 'TweenService:Create', linguagem: 'roblox'}).",
        usedHeal: false,
      };
    }
    const contexto = asString(args.contexto ?? "");
    const forcarRefresh = args.forcar_refresh === true;
    try {
      const { researchApi, formatResearchResult } = await import("./apiResearcher.js");
      const result = await researchApi({
        apiName: nome,
        language: linguagem,
        context: contexto || undefined,
        forceRefresh: forcarRefresh,
      });
      const formatted = formatResearchResult(result);
      // "error" in result check
      return {
        resultStr: formatted,
        usedHeal: false,
      };
    } catch (err) {
      return {
        resultStr: `[ERRO] Falha ao pesquisar API "${nome}": ${(err as Error).message}`,
        usedHeal: false,
      };
    }
  },

  "escrever_spec": async (args) => {
    const nome = asString(args.nome);
    const descricao = asString(args.descricao);
    if (!nome || !descricao) {
      return { resultStr: "[ERRO] 'nome' e 'descricao' são obrigatórios.", usedHeal: false };
    }
    const { createSpec, formatSpec } = await import("./specFirst.js");
    createSpec({
      name: nome,
      description: descricao,
      inputs: (args.inputs as any[]) ?? [],
      outputs: (args.outputs as any[]) ?? [],
      edgeCases: (args.edgeCases as string[]) ?? [],
      constraints: (args.constraints as string[]) ?? [],
    });
    return { resultStr: `[SUCESSO] Spec criada.\n\n${formatSpec()}`, usedHeal: false };
  },

  "criar_tdd": async (args) => {
    const arquivoTeste = asString(args.arquivo_teste);
    const arquivoImpl = asString(args.arquivo_impl);
    const linguagem = asString(args.linguagem);
    if (!arquivoTeste || !arquivoImpl || !linguagem) {
      return { resultStr: "[ERRO] 'arquivo_teste', 'arquivo_impl' e 'linguagem' são obrigatórios.", usedHeal: false };
    }
    const { registerTDD, formatTDD } = await import("./tddMode.js");
    registerTDD(arquivoTeste, arquivoImpl, linguagem, (args.casos as string[]) ?? []);
    return { resultStr: `[SUCESSO] TDD registrado.\n\n${formatTDD()}`, usedHeal: false };
  },

  "ler_estado": async () => {
    const summary = getTaskStateSummary();
    return {
      resultStr: summary ?? "[INFO] Nenhum TASK_STATE.md encontrado. Use atualizar_estado para criar.",
      usedHeal: false,
    };
  },

  // --- IDEIA 5: Sub-agent for isolated exploration ------------------------
  "explorar_subagente": async (args) => {
    const question = asString(args.questao ?? args.question);
    if (!question) {
      return { resultStr: "[ERRO] 'questao' é obrigatória (pergunta para o sub-agente explorar).", usedHeal: false };
    }
    const cwd = args.cwd ? asString(args.cwd) : undefined;
    const maxCalls = args.max_tool_calls as number | undefined;

    // Limit concurrent sub-agents to MAX_CONCURRENT_SUB_AGENTS (default 2).
    // With 4 API keys: 1 main agent + 2 sub-agents = 3 keys used, 1 free for hedging.
    // This semaphore prevents the model from spawning 5 sub-agents that would
    // exhaust all keys and leave no room for hedging.
    await acquireSubAgentSlot();
    try {
      const result = await runSubAgent({ question, cwd, maxToolCalls: maxCalls });
    if (result === null) {
      return {
        resultStr: "[INFO] Sub-agente não executou (effort level muito baixo ou falhou). Use effort=high ou max para habilitar.",
        usedHeal: false,
      };
    }
    return { resultStr: result, usedHeal: false };
    } finally {
      releaseSubAgentSlot();
    }
  },

  // --- Multi-key pool status (IDEIA Fase 1) ------------------------------
  // Sprint C bug fix (BUG-S): todo_write estava definido em TOOL_DEFINITIONS
  // mas NÃO tinha handler. IA via a tool, chamava, e recebia "Ferramenta
  // desconhecida". Agora delega para todo.todoWrite().
  "todo_write": async (args) => {
    const { todoWrite } = await import("./todo.js");
    const items = args.items;
    if (!Array.isArray(items)) {
      return { resultStr: "[ERRO] 'items' deve ser um array.", usedHeal: false };
    }
    const result = todoWrite(items as any);
    return { resultStr: result, usedHeal: false };
  },

};

// --- Tool Dispatcher ----------------------------------------------------------

/**
 * Map tool name -> JSON Schema (used for argument validation).
 * Built once at startup from TOOL_DEFINITIONS + THINK_TOOL_DEFINITION + MCP tools.
 */
function getToolSchemaMap(): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const all = getMergedTools();
  for (const t of all) {
    if (t?.function?.name && t?.function?.parameters) {
      map.set(t.function.name, t.function.parameters as Record<string, unknown>);
    }
  }
  return map;
}

async function dispatchToolCall(
  toolCall: ToolCall,
  healRetry: number = 0
): Promise<ToolResult> {
  const name = toolCall.function.name;
  const startTime = Date.now();

  const rawArgs = parseArgs(toolCall.function.arguments);
  const finalArgs = await resolvePreCallHooks(name, rawArgs);
  if (finalArgs === null) {
    // Pre-hook skipped - the override is already in resultOverride
    const preResult = await executePreToolCallHooks(name, rawArgs);
    return { resultStr: preResult.resultOverride ?? `[HOOK] Tool "${name}" skipped by pre-hook.`, usedHeal: false };
  }

  // -- Run gate chain: schema -> poka-yoke -> read-before-write ------------
  const gateBlock = runDispatchGates(name, finalArgs);
  if (gateBlock) {
    // Notify TUI of the tool call (even if blocked) and the block result
    if (currentOnToolCall) {
      try { currentOnToolCall(name, finalArgs); } catch { /* TUI errors must not break the agent */ }
    }
    if (currentOnToolResult) {
      try { currentOnToolResult(name, false, gateBlock); } catch { /* ignore */ }
    }
    return { resultStr: gateBlock, usedHeal: false };
  }

  // Notify TUI that a tool call is starting (before execution).
  // This lets the TUI add a "tool" message to the chat in chronological order.
  if (currentOnToolCall) {
    try { currentOnToolCall(name, finalArgs); } catch { /* TUI errors must not break the agent */ }
  }

  // -- Track reads + touched files ---------------------------------------
  trackFileAccess(name, finalArgs);

  // -- Cache check -------------------------------------------------------
  const cached = shouldCacheResult(name) ? readOnlyCache.get(name, finalArgs) : null;
  if (cached !== null) {
    recordToolCall(name, Date.now() - startTime, true);
    if (currentOnToolResult) {
      try { currentOnToolResult(name, true, cached); } catch { /* ignore */ }
    }
    return { resultStr: cached, usedHeal: false };
  }

  // -- Execute handler ---------------------------------------------------
  const result = await executeHandler(name, finalArgs, toolCall, healRetry);

  if (shouldCacheResult(name)) {
    readOnlyCache.set(name, finalArgs, result.resultStr);
  }
  recordToolCall(name, Date.now() - startTime, true);

  const postResult = await executePostToolCallHooks(name, finalArgs, result.resultStr);
  if (postResult.modifiedResult) {
    result.resultStr = postResult.modifiedResult;
  }

  // Notify TUI that the tool call completed (with success or error).
  // The TUI adds a "tool result" message to the chat.
  if (currentOnToolResult) {
    const resultStrSafe = result.resultStr ?? "";
    const ok = !resultStrSafe.startsWith("[ERRO") && !resultStrSafe.startsWith("[BLOQUEADO") && !resultStrSafe.startsWith("[HOOK]");
    try { currentOnToolResult(name, ok, resultStrSafe); } catch { /* ignore */ }
  }

  // -- IDEIA 1: Auto-inject TASK_STATE context before next decision ------
  // Anthropic's Fable 5 reads its own notes before each decision; we
  // replicate this by appending a compact state snapshot to write/command
  // tool results so the model re-aligns with its plan.
  const ctxInjection = getContextInjection(name);
  if (ctxInjection) {
    result.resultStr += ctxInjection;
  }

  // Safe version of resultStr for null-safe checks (mocks may return undefined)
  const resultStrSafe = result.resultStr ?? "";

  // -- IDEIA 7: After successful file edits, suggest generating a test ---
  // Skip Luau/Roblox and other unsupported extensions explicitly.
  if (WRITE_FILE_TOOLS.has(name) && !resultStrSafe.startsWith("[ERRO") && !resultStrSafe.startsWith("[BLOQUEADO")) {
    const editedPath = asString(finalArgs.caminho ?? finalArgs.path ?? finalArgs.filePath ?? "");
    if (editedPath) {
      const testSuggestion = generateTestSuggestionForFile(editedPath);
      if (testSuggestion) {
        result.resultStr += testSuggestion;
      }
    }
  }

  // -- IDEIA 14: Record failures for failure memory ---
  // When a write/edit tool fails, record the error so the AI sees it
  // before the next edit attempt (avoids repeating the same mistake).
  if (resultStrSafe.startsWith("[ERRO") || resultStrSafe.startsWith("[BLOQUEADO")) {
    try {
      const { recordFailure } = await import("./failureMemory.js");
      const filePath = asString(finalArgs.caminho ?? finalArgs.path ?? finalArgs.filePath ?? "");
      recordFailure(name, resultStrSafe.slice(0, 200), filePath || undefined);
    } catch { /* failureMemory not available */ }
  }

  // -- IDEIA 14: Inject failure memory before edit tool calls ---
  // So the AI sees recent mistakes before attempting another edit.
  if (WRITE_FILE_TOOLS.has(name)) {
    try {
      const { getRecentFailures } = await import("./failureMemory.js");
      const failures = getRecentFailures();
      if (failures) {
        result.resultStr = `${failures}\n\n${result.resultStr}`;
      }
    } catch { /* failureMemory not available */ }
  }

  return result;
}

/** Returns the (possibly modified) args, or null if the pre-hook skipped the call. */
async function resolvePreCallHooks(name: string, rawArgs: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const preResult = await executePreToolCallHooks(name, rawArgs);
  if (preResult.skip) return null;
  return preResult.modifiedArgs ?? rawArgs;
}

/** Run schema validation, poka-yoke, and read-before-write gates. Returns an error string if blocked, else null. */
function runDispatchGates(name: string, args: Record<string, unknown>): string | null {
  // Sprint C bug fix (BUG-T): auto-parse args que algumas IAs (Llama) passam
  // como string JSON em vez de tipo nativo. Faz isso ANTES do schema gate.
  autoParseArgs(name, args);

  const schemaBlock = runSchemaGate(name, args);
  if (schemaBlock) return schemaBlock;

  const pyResult = pokaYokeCheck(name, args);
  if (!pyResult.ok) return pyResult.error ?? "[POKA-YOKE] Blocked.";

  const rbwResult = checkReadBeforeWrite(name, args);
  if (!rbwResult.allowed) return rbwResult.message ?? "[BLOCKED] Read-before-write check failed.";

  return null;
}

/**
 * Sprint C (BUG-T): Auto-parse args que algumas IAs passam como string JSON.
 * - editar_arquivo: 'edits' deve ser array mas IA passa como string JSON
 *  mas IA passa como string JSON
 * - editar_multi_arquivos: 'requests' deve ser array mas IA passa como string
 * - Boolean fields: 'createIfMissing', 'all' passados como "true"/"false" string
 * Modifica args in-place.
 */
function autoParseArgs(name: string, args: Record<string, unknown>): void {
  // Array fields que IAs costumam passar como string JSON
  const arrayFields: Record<string, string[]> = {
    "editar_arquivo": ["edits"],
    "editar_multi_arquivos": ["requests"],
    "todo_write": ["items"],
    "atualizar_estado": ["done", "todo", "decisions", "bugs", "dependencies"],
  };

  const fields = arrayFields[name];
  if (fields) {
    for (const field of fields) {
      const val = args[field];
      if (typeof val === "string" && val.trim().startsWith("[")) {
        try {
          args[field] = JSON.parse(val);
          log.debug(`[AUTO-PARSE] Parsed ${name}.${field} from string to array`);
        } catch {
          // não é JSON válido — deixa como está
        }
      }
    }
  }

  // Boolean fields que IAs passam como string "true"/"false"
  const boolFields: Record<string, string[]> = {
    "editar_arquivo": ["createIfMissing", "all"],
    "editar_multi_arquivos": ["createIfMissing"],
  };

  const bFields = boolFields[name];
  if (bFields) {
    for (const field of bFields) {
      const val = args[field];
      if (val === "true") args[field] = true;
      else if (val === "false") args[field] = false;
    }
  }
}

function runSchemaGate(name: string, args: Record<string, unknown>): string | null {
  const schema = getToolSchemaMap().get(name);
  if (!schema) return null;
  const vr = validateToolCall(name, args, schema as unknown as Parameters<typeof validateToolCall>[2]);
  if (!vr.valid) {
    log.warn(`[SCHEMA] Blocked ${name}: ${vr.errors.length} error(s)`);
    return formatValidationErrors(name, vr.errors);
  }
  return null;
}

/** Track read accesses and touched files for read-before-write + strict quality gate. */
function trackFileAccess(name: string, args: Record<string, unknown>): void {
  const filePath = asString(args.caminho ?? args.path ?? args.filePath ?? "");
  if (!filePath) return;
  if (READ_ONLY_TOOLS.has(name)) {
    recordRead(name, filePath);
  }
  if (WRITE_FILE_TOOLS.has(name)) {
    const resolved = pokaYokeCheck(name, args).resolvedPath ?? filePath;
    turnTouchedFiles.add(resolved);
  }
}

async function executeHandler(name: string, args: Record<string, unknown>, toolCall: ToolCall, healRetry: number): Promise<ToolResult> {
  // Sprint C bug fix (BUG-Z): algumas IAs (deepseek, mistral) inventam nomes
  // de tools diferentes dos definidos no schema. Mapear aliases comuns.
  const TOOL_ALIASES: Record<string, string> = {
    "buscar_conteudo": "buscar_texto",
    "buscar_texto_no_projeto": "buscar_texto",
    "grep": "buscar_texto",
    "search": "buscar_texto",
    "find_files": "buscar_arquivos",
    "glob": "buscar_arquivos",
    "list_files": "buscar_arquivos",
    "read_file": "ler_arquivo",
    "read": "ler_arquivo",
    "write_file": "editar_arquivo",
    "write": "editar_arquivo",
    "edit": "editar_arquivo",
    "run_command": "executar_comando",
    "shell": "executar_comando",
    "think": "pensar",
  };
  const resolvedName = TOOL_ALIASES[name] ?? name;
  const handler = toolHandlers[resolvedName];
  if (handler) {
    try {
      return await handler(args, toolCall, healRetry);
    } catch (err) {
      const errMsg = `[ERRO] ${(err as Error).message ?? String(err)}`;
      log.error(`Handler "${name}" lançou exceção: ${(err as Error).message ?? String(err)}`);
      return { resultStr: errMsg, usedHeal: false };
    }
  }
  // Sprint 3: Check if this is a manifest-based tool (rojo_build, wally_install, etc.)
  if (isManifestTool(name, activeManifests)) {
    try {
      const modeName = getActiveModeFromModes()?.name ?? null;
      const result = await executeFromManifest(name, args, activeManifests, modeName);
      const output = [
        result.ok ? "OK Sucesso" : "X Falha",
        result.output,
        result.errors.length ? `Erros:\n${result.errors.join("\n")}` : "",
        result.duration ? `Duração: ${result.duration}ms` : "",
      ].filter(Boolean).join("\n");
      return { resultStr: output, usedHeal: false };
    } catch (err) {
      const errMsg = `[ERRO] Manifest tool "${name}" falhou: ${(err as Error).message ?? String(err)}`;
      log.error(errMsg);
      return { resultStr: errMsg, usedHeal: false };
    }
  }
  if (name.includes("__")) {
    try {
      return { resultStr: await callMCPTool(name, args), usedHeal: false };
    } catch (err) {
      const errMsg = `[ERRO] ${(err as Error).message ?? String(err)}`;
      log.error(`MCP tool "${name}" lançou exceção: ${(err as Error).message ?? String(err)}`);
      return { resultStr: errMsg, usedHeal: false };
    }
  }
  const unknown = `[ERRO] Ferramenta desconhecida: "${name}"`;
  log.error(unknown);
  return { resultStr: unknown, usedHeal: false };
}

// --- Tool Call Processing -----------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  "ler_arquivo", "buscar_arquivos", "buscar_texto",
  "git_status", "git_log", "git_diff", "parse_ast",
  // IDEIA 5: explorar_subagente is read-only (only reads code, never edits)
  // and benefits from parallel execution with other read-only tools.
  "explorar_subagente",
  // Multi-key pool status is read-only and side-effect-free.
  // Task state read is read-only.
  "ler_estado",
]);

const FILE_TOOLS = new Set([
  "editar_arquivo", "editar_multi_arquivos",
]);

/** File-mutating tools - used to populate turnTouchedFiles for the strict quality gate */
const WRITE_FILE_TOOLS = new Set([
  "editar_arquivo", "editar_multi_arquivos", "desfazer_edicao",
]);

async function executeReadOnlyCallsInParallel(toolCalls: ToolCall[]): Promise<void> {
  if (toolCalls.length <= 1) return;

  const parallelTools: ParallelToolCall[] = toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    args: parseArgs(tc.function.arguments),
    execute: async () => {
      // Push a tool activity for each parallel tool. They'll show as the
      // most recently pushed one (which is fine for visual purposes — the
      // user just wants to know something is happening).
      const label = formatToolActivityLabel(tc.function.name, parseArgs(tc.function.arguments));
      const done = pushActivity("tool", label);
      try {
        const result = await dispatchToolCall(tc);
        return result.resultStr;
      } finally { done(); }
    },
  }));
  const results = await executeParallelTools(parallelTools);
  for (const result of results) {
    const tc = toolCalls.find((t) => t.id === result.id);
    if (tc) {
      history.addToolResult(tc.id, result.result);
    }
  }
}

async function executeToolCallsSequentially(toolCalls: ToolCall[]): Promise<void> {
  for (const toolCall of toolCalls) {
    const args = parseArgs(toolCall.function.arguments);
    const label = formatToolActivityLabel(toolCall.function.name, args);
    const { resultStr } = await withActivity("tool", label, () => dispatchToolCall(toolCall));
    if (!alreadyInHistory(toolCall.id)) {
      history.addToolResult(toolCall.id, resultStr);
    }
  }
}

/**
 * Builds a human-readable activity label for a tool call.
 * Examples:
 *   ler_arquivo { path: "/foo.ts" }            ->  "ler_arquivo /foo.ts"
 *   editar_arquivo { path: "/foo.ts" }            ->  "editar_arquivo /foo.ts"
 *   executar_comando { comando: "npm test" }    ->  "executar_comando: npm test"
 *   pensar { pensamento: "..." }                ->  "pensar"
 */
function formatToolActivityLabel(toolName: string, args: Record<string, unknown>): string {
  const path = args.path ?? args.caminho;
  if (typeof path === "string" && path.length > 0) {
    return `${toolName} ${truncate(path, 60)}`;
  }
  const cmd = args.comando ?? args.command;
  if (typeof cmd === "string" && cmd.length > 0) {
    return `${toolName}: ${truncate(cmd, 60)}`;
  }
  const query = args.query ?? args.consulta ?? args.questao;
  if (typeof query === "string" && query.length > 0) {
    return `${toolName}: ${truncate(query, 60)}`;
  }
  return toolName;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// --- Auto-Heal: detect test/lint failures and inject retry context ------------

const TEST_TOOLS = new Set(["executar_testes", "executar_comando", "sugerir_fixes"]);
const MAX_AUTO_HEAL_RETRIES = 2;

function isTestFailure(resultStr: string): boolean {
  const lower = resultStr.toLowerCase();
  return (
    lower.includes("fail") ||
    lower.includes("error") ||
    lower.includes("failed") ||
    lower.includes("X") ||
    lower.includes("failing")
  ) && (
    lower.includes("test") ||
    lower.includes("lint") ||
    lower.includes("vitest") ||
    lower.includes("jest") ||
    lower.includes("pytest") ||
    lower.includes("cargo") ||
    lower.includes("eslint") ||
    lower.includes("tsc")
  );
}

async function processToolCalls(toolCalls: ToolCall[]): Promise<void> {
  const readOnlyCalls = toolCalls.filter((tc) => READ_ONLY_TOOLS.has(tc.function.name));
  const writeCalls = toolCalls.filter((tc) => !READ_ONLY_TOOLS.has(tc.function.name));

  await executeReadOnlyCallsInParallel(readOnlyCalls);

  if (writeCalls.length > 0) {
    await executeToolCallsSequentially(writeCalls);
    fireOnFileTrigger(writeCalls);
  } else if (readOnlyCalls.length <= 1) {
    await executeToolCallsSequentially(readOnlyCalls);
  }

  checkAutoHeal(toolCalls);
}

function fireOnFileTrigger(writeCalls: ToolCall[]): void {
  const fileTools = writeCalls.filter((tc) => FILE_TOOLS.has(tc.function.name));
  if (fileTools.length === 0) return;
  const triggerCtx: TriggerContext = { cwd: process.cwd() };
  for (const tc of fileTools) {
    const args = parseArgs(tc.function.arguments);
    triggerCtx.filePath = asString(args.path ?? args.caminho);
    triggerCtx.toolName = tc.function.name;
  }
  executeTrigger("on_file", triggerCtx).catch((err) => {
    log.warn(`On-file trigger failed: ${(err as Error).message}`);
  });
}

function checkAutoHeal(toolCalls: ToolCall[]): void {
  const testCalls = toolCalls.filter((tc) => TEST_TOOLS.has(tc.function.name));
  for (const tc of testCalls) {
    const historyArr = history.getHistory();
    for (let i = historyArr.length - 1; i >= 0; i--) {
      const m = historyArr[i];
      if (m.role === "tool" && (m as { tool_call_id?: string }).tool_call_id === tc.id) {
        const content = (m as { content?: string }).content;
        if (content && isTestFailure(content)) {
          history.addSystemMessage(
            `[AUTO-HEAL] A ferramenta "${tc.function.name}" retornou falhas. ` +
            `Analise o erro acima, corrija o código usando editar_arquivo, e rode os testes novamente. ` +
            `Máximo de ${MAX_AUTO_HEAL_RETRIES} tentativas automáticas.`
          );
          log.debug(`Auto-heal triggered for ${tc.function.name}`);
        }
        break;
      }
    }
  }
}

// --- Main Agent Loop ---------------------------------------------------------

async function sendAndProcess(
  depth: number = 0,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void
): Promise<string> {
  if (depth > 20) {
    throw new Error("Agent loop exceeded maximum depth (20). Possible runaway detected.");
  }

  await runPreTurnMaintenance();
  history.optimizeContext();

  // IDEIA 10: Tool reduction - filter tools by detected intent
  let toolsForCall = getMergedTools();
  try {
    const { detectIntent, filterToolsByIntent, getFilterSummary } = await import("./toolReduction.js");
    const userMsg = history.getHistory().find((m) => m.role === "user");
    const userText = typeof userMsg?.content === "string" ? userMsg.content : "";
    const intent = detectIntent(userText);
    toolsForCall = filterToolsByIntent(toolsForCall, intent);
    const summary = getFilterSummary(getMergedTools().length, toolsForCall.length, intent);
    log.debug(`[TOOL_REDUCTION] ${summary}`);
  } catch { /* toolReduction not available */ }

  // IDEIA 27+#28: Checkpoint writer - proactive state extraction
  try {
    const { shouldCheckpoint, writeCheckpoint, formatCheckpoint } = await import("./checkpointWriter.js");
    const histLen = history.getHistory().length;
    const checkpointNum = shouldCheckpoint(histLen);
    if (checkpointNum > 0) {
      log.info(`[CHECKPOINT] Triggering checkpoint ${checkpointNum} at ${histLen} messages`);
      const done = pushActivity("checkpoint", `checkpoint ${checkpointNum}`);
      try {
        const cp = await writeCheckpoint(checkpointNum);
        if (cp.state.intention) {
          history.addSystemMessage(formatCheckpoint(cp.state));
        }
      } finally { done(); }
    }
  } catch { /* checkpointWriter not available */ }

  // Activity: waiting for LLM response. Popped when chat() returns.
  const apiActivityDone = pushActivity("api_call", config.model);
  try {
    const response = await withRetry(
      () => chat(history.getHistory(), onStreamStart, onToken, onThinking, toolsForCall),
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        retryOn: isRetryableError,
        onRetry: (attempt, err, delay) => log.warn(`Retry ${attempt} after ${delay}ms: ${(err as Error).message}`),
      }
    );
    apiActivityDone();
    return await handleChatResponse(response, depth, onStreamStart, onToken, onThinking, onUsage);
  } catch (err) {
    apiActivityDone();
    throw err;
  }
}

/** Process chat response: handle tool calls, stop reason, or final answer. */
async function handleChatResponse(
  response: { choices: any[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } },
  depth: number,
  onStreamStart: (() => void) | undefined,
  onToken: ((token: string) => void) | undefined,
  onThinking: (() => void) | undefined,
  onUsage: ((usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void) | undefined,
): Promise<string> {
  if (response.usage && onUsage) onUsage(response.usage);
  const choice = response.choices[0];
  if (!choice) throw new Error("Empty response from NVIDIA NIM API");

  const { message, finish_reason } = choice;
  history.addRawAssistantMessage(message);

  fireTrigger("always");

  if (finish_reason === "tool_calls" && message.tool_calls?.length) {
    log.debug(`Model requested ${message.tool_calls.length} tool call(s)`);
    await processToolCalls(message.tool_calls);
    return sendAndProcess(depth + 1, onStreamStart, onToken, onThinking, onUsage);
  }

  // -- Stop-reason branch: quality gate + task state ----------------------
  const recurseReason = await handleStopReason(message);
  if (recurseReason) {
    return sendAndProcess(depth + 1, onStreamStart, onToken, onThinking, onUsage);
  }

  // Reset turn-level counters for the next user turn
  turnTouchedFiles = new Set();
  turnStopHits = 0;

  fireTrigger("on_task");

  // --- Sprint 8: on_task hooks (Worker-Thread sandbox) ---
  // Runs user-provided JS snippets in isolated Worker Threads after the
  // agent finishes a task (finish_reason=stop, no further recursion).
  // Best-effort — failures are logged but never break the agent loop.
  try {
    const { runHooks } = await import("./hookRunner.js");
    const mode = getActiveModeFromModes();
    await runHooks(
      "on_task",
      { mode: mode?.name },
      mode?.name ?? null,
    );
  } catch (err) {
    /* best-effort */
    log.debug(`agent: on_task hook error: ${(err as Error).message}`);
  }

  return message.content ?? "(resposta vazia)";
}

/** Pre-turn maintenance: context compaction + checkpoint write. */
async function runPreTurnMaintenance(): Promise<void> {
  const compaction = smartCompact(config.contextWindowTokens * 0.75);
  if (compaction.compacted) {
    log.debug(`Context compacted: saved ${compaction.savedTokens} tokens`);
  }
  await maybeWriteCheckpoint();
}

async function maybeWriteCheckpoint(): Promise<void> {
  const currentTokens = history.estimateTokens?.() ?? 0;
  if (!shouldWriteCheckpoint(currentTokens) || currentTokens <= lastCheckpointTokens + 1000) return;
  const checkpoint = createCheckpoint(
    sessionStartTime,
    history.getHistory().map((m) => ({ role: m.role, content: typeof m.content === "string" ? m.content : "" })),
    sessionFileChanges,
    sessionToolsUsed
  );
  const { writeCheckpoint } = await import("./memory.js");
  writeCheckpoint(memoryConfig, checkpoint);
  lastCheckpointTokens = currentTokens;
  log.debug(`Checkpoint saved at ${currentTokens} tokens`);
}

function fireTrigger(name: "always" | "on_task"): void {
  const triggerCtx: TriggerContext = { cwd: process.cwd() };
  executeTrigger(name, triggerCtx).catch((err) => {
    log.warn(`${name} trigger failed: ${(err as Error).message}`);
  });
}

/**
 * Handle a stop_reason. Returns true if the agent should recurse (continue working),
 * false if the turn is complete and may finish.
 */

async function checkPlanCompletion(): Promise<boolean> {
  try {
    const { hasIncompletePlan, formatPlan } = await import("./planExecutor.js");
    if (hasIncompletePlan()) {
      // Sprint C bug fix (BUG-AA): só bloquear finish se a IA realmente
      // tocou arquivos (fez trabalho). Se a IA só foi pedida pra CRIAR
      // o plano (sem executar), não faz sentido bloquear — a tarefa era
      // criar o plano, não completá-lo.
      if (turnTouchedFiles.size === 0) {
        log.debug(`[PLAN] Plan has incomplete steps but no files touched — allowing finish (plan creation task)`);
        return false;
      }
      log.warn(`[PLAN] Blocking finish - plan has incomplete steps`);
      history.addSystemMessage(`${formatPlan()}\n\nNÃO finalize até completar TODOS os passos do plano. Continue trabalhando.`);
      return true;
    }
  } catch { /* planExecutor not available */ }
  return false;
}

async function checkHonestyReview(message: { content?: string | null }): Promise<boolean> {
  try {
    const { isHonestyFeatureEnabled, runDevilsAdvocate, runAnonymousReview } = await import("./honestySystem.js");
    const editedFiles = [...turnTouchedFiles].map((f) => ({ path: f, content: "" }));
    if (editedFiles.length === 0) return false;

    const agentClaims = message.content ?? "";
    const devilsOn = await isHonestyFeatureEnabled("feature:devils_advocate");
    const reviewOn = await isHonestyFeatureEnabled("feature:anonymous_review");
    if (!devilsOn && !reviewOn) return false;

    const fs = await import("node:fs");
    for (const f of editedFiles) {
      try { f.content = fs.readFileSync(f.path, "utf8"); } catch { /* skip */ }
    }

    const promises: Promise<any>[] = [];
    if (devilsOn) promises.push(runDevilsAdvocate(editedFiles, agentClaims));
    if (reviewOn) promises.push(runAnonymousReview(editedFiles));
    const results = await Promise.all(promises);

    if (devilsOn) {
      const daResult = results[0];
      if (daResult?.severity === "high" && daResult.issues.length > 0) {
        const msg = `[DEVIL'S ADVOCATE] Problemas críticos encontrados:\n${daResult.issues.map((i: string) => "  - " + i).join("\n")}\n\nCorrija antes de finalizar.`;
        history.addSystemMessage(msg);
        return true;
      }
    }
  } catch { /* honestySystem not available */ }
  return false;
}

async function checkGoalCompletion(message: { content?: string | null }): Promise<boolean> {
  try {
    const { verifyGoalCompletion, formatGoalVerification } = await import("./goalVerifier.js");
    if (turnTouchedFiles.size === 0) return false;

    const userRequestRaw = history.getHistory().find((m) => m.role === "user")?.content;
    const userRequest = typeof userRequestRaw === "string" ? userRequestRaw : "";
    const result = await verifyGoalCompletion(userRequest, [...turnTouchedFiles], message.content ?? "");
    if (!result.done && result.verified) {
      log.warn(`[GOAL_VERIFIER] Task NOT done - blocking finish`);
      history.addSystemMessage(formatGoalVerification(result));
      return true;
    }
  } catch { /* goalVerifier not available */ }
  return false;
}

async function handleStopReason(message: { content?: string | null }): Promise<boolean> {
  turnStopHits++;

  // False-promise detector — run FIRST, before any other gate.
  // If the agent said "vou investigar" but didn't call any tool, that's a
  // false promise. Inject a rejection message forcing the agent to either
  // call a tool or explain why it can't. Bounded to MAX_FALSE_PROMISE_RETRIES
  // per turn to prevent infinite loops.
  //
  // We check this whenever the agent stopped WITHOUT touching any files in
  // this turn — that's the suspicious case. We don't restrict to turnStopHits===1
  // because the agent might promise-and-stop multiple times in a row.
  if (turnTouchedFiles.size === 0) {
    const fpResult = shouldBlockForFalsePromise(message.content ?? "", 0, 0);
    if (fpResult.block && fpResult.rejectionMessage) {
      log.warn(`[FALSE_PROMISE] ${fpResult.reason}`);
      history.addSystemMessage(fpResult.rejectionMessage);
      return true; // recurse — model must call a tool or explain
    }
  }

  // IDEIA 2: Self-validation - force the model to reflect before finishing.
  // Must run BEFORE the strict quality gate so the model can fix issues
  // it discovers during reflection before we measure with tsc/lint.
  if (shouldSelfValidate(turnTouchedFiles.size)) {
    injectSelfValidationPrompt([...turnTouchedFiles]);
    return true; // recurse so the model runs the validation
  }

  // Strict quality gate - may inject errors and force a recursion
  const gateBlocked = await runStrictGateIfActive();
  if (gateBlocked) return true;

  // IDEIA 11: Plan-then-execute - block finish if plan has incomplete steps
  // Sprint C (BUG-AA): só bloquear se IA tocou arquivos (fez trabalho real).
  try {
    const { hasIncompletePlan, formatPlan } = await import("./planExecutor.js");
    if (hasIncompletePlan() && turnTouchedFiles.size > 0) {
      log.warn(`[PLAN] Blocking finish - plan has incomplete steps`);
      history.addSystemMessage(`${formatPlan()}\n\nNÃO finalize até completar TODOS os passos do plano. Continue trabalhando.`);
      return true;
    }
  } catch { /* planExecutor not available */ }

  // IDEIA 12 + Honesty: Devil's Advocate + Anonymous Review (pre-finish, parallel)
  try {
    const { isHonestyFeatureEnabled, runDevilsAdvocate, runAnonymousReview } = await import("./honestySystem.js");
    const editedFiles = [...turnTouchedFiles].map((f) => ({ path: f, content: "" }));
    // Only run if files were touched AND features are enabled
    if (editedFiles.length > 0) {
      const agentClaims = message.content ?? "";
      const devilsOn = await isHonestyFeatureEnabled("feature:devils_advocate");
      const reviewOn = await isHonestyFeatureEnabled("feature:anonymous_review");

      if (devilsOn || reviewOn) {
        // Read file contents for review
        const fs = await import("node:fs");
        for (const f of editedFiles) {
          try { f.content = fs.readFileSync(f.path, "utf8"); } catch { /* skip */ }
        }

        // Run both in parallel if both enabled
        const promises: Promise<any>[] = [];
        if (devilsOn) promises.push(runDevilsAdvocate(editedFiles, agentClaims));
        if (reviewOn) promises.push(runAnonymousReview(editedFiles));
        const results = await Promise.all(promises);

        // Check if Devil's Advocate found high-severity issues
        if (devilsOn) {
          const daResult = results[0] as any;
          if (daResult?.severity === "high" && daResult.issues.length > 0) {
            const msg = `[DEVIL'S ADVOCATE] Problemas críticos encontrados:\n${daResult.issues.map((i: string) => `  - ${i}`).join("\n")}\n\nCorrija antes de finalizar.`;
            history.addSystemMessage(msg);
            return true;  // Block finish
          }
        }
      }
    }
  } catch { /* honestySystem not available */ }

  // IDEIA 26: Goal verifier - independent check if task is actually done
  try {
    const { verifyGoalCompletion, formatGoalVerification } = await import("./goalVerifier.js");
    if (turnTouchedFiles.size > 0) {
      const userRequestRaw = history.getHistory().find((m) => m.role === "user")?.content;
      const userRequest = typeof userRequestRaw === "string" ? userRequestRaw : "";
      const result = await verifyGoalCompletion(
        userRequest,
        [...turnTouchedFiles],
        message.content ?? ""
      );
      if (!result.done && result.verified) {
        log.warn(`[GOAL_VERIFIER] Task NOT done - blocking finish`);
        history.addSystemMessage(formatGoalVerification(result));
        return true;  // Block finish, force AI to continue
      }
    }
  } catch { /* goalVerifier not available */ }

  // IDEIA 14: Inject failure memory before finishing (for next turn's awareness)
  try {
    const { getRecentFailures, clearFailures } = await import("./failureMemory.js");
    const failures = getRecentFailures();
    if (failures) {
      log.debug(`[FAILURE_MEMORY] ${failures.length} recent failures noted`);
      // Don't inject - just log. Failures are injected before EDIT calls, not at finish.
    }
  } catch { /* failureMemory not available */ }

  // Update TASK_STATE.md
  updateTaskStateOnStop(message);

  return false;
}

async function runStrictGateIfActive(): Promise<boolean> {
  if (turnStopHits > MAX_STOPS_PER_TURN) return false;
  if (!isStrictModeEnabled() || turnTouchedFiles.size === 0) return false;
  const gateResult = await runQualityGate([...turnTouchedFiles]);
  if (gateResult.allowed || !gateResult.errorLog) return false;
  log.warn(`[STRICT_GATE] Blocking finish #${turnStopHits} - injecting errors into context.`);
  history.addSystemMessage(gateResult.errorLog);
  return true;
}

function updateTaskStateOnStop(message: { content?: string | null }): void {
  try {
    const summary = message.content?.slice(0, 200).replaceAll("\n", " ").trim();
    if (summary) appendTaskStateItem("done", `[turn] ${summary}`);
    if (readTaskState()) {
      updateTaskState({ notes: `Last update at turn end (${new Date().toISOString()}).` });
    }
  } catch (err) {
    log.debug(`[TASK_STATE] Update on stop failed: ${(err as Error).message}`);
  }
}

// --- Public Entry Point -------------------------------------------------------

export async function runAgentLoop(
  userInput: string,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void,
  /**
   * Called when the agent dispatches a tool call (before execution).
   * The TUI uses this to add a "tool" message to the chat history so the
   * user can see what the agent is doing in chronological order.
   */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void,
  /**
   * Called when a tool call completes (after execution).
   * The TUI uses this to add a "tool result" message with success/error status.
   */
  onToolResult?: (toolName: string, ok: boolean, resultStr: string) => void,
  /**
   * Sprint 1: AskUser — Called when the IA calls `perguntar_usuario`.
   * The TUI shows a QuestionPrompt UI and resolves the promise when
   * the user answers. The agent loop naturally pauses (async/await).
   * If undefined, perguntar_usuario returns an error (sub-agents).
   */
  onAskUser?: AskUserCallback,
  /**
   * Whether the current context allows user questions.
   * Main chat: true (default). Sub-agents: false.
   */
  allowUserQuestions: boolean = true,
): Promise<string> {
  startSession();
  sessionStartTime = new Date().toISOString();
  sessionFileChanges = [];
  sessionToolsUsed = [];
  lastCheckpointTokens = 0;
  turnTouchedFiles = new Set();
  turnStopHits = 0;
  resetGateState();
  resetContextInjection();
  resetSelfValidation();
  resetAutoTestSuggestions();
  resetFalsePromiseCounter();
  setEffortLevel(getEffortLevel()); // refresh system prompt with current effort

  // 3.7: Initialize TASK_STATE.md from the user's first message
  try {
    initTaskStateFromUserMessage(userInput);
    const summary = getTaskStateSummary();
    if (summary) {
      history.addSystemMessage(summary);
    }
  } catch (err) {
    log.debug(`[TASK_STATE] Init failed: ${(err as Error).message}`);
  }

  // Initialize external tools system
  await initializeTools();

  // Sprint 3: Load manifests for the active mode.
  // These are used to generate specific function calls (rojo_build, wally_install, etc.)
  // and to dispatch tool calls to the correct binary + args.
  activeManifests = loadActiveManifests();
  log.debug(`[AGENT] Loaded ${activeManifests.length} manifests for active mode`);
  
  // Detect tools from project context
  const detector = getDetector();
  const contextTools = detector.detectFromContext();
  if (contextTools.length > 0) {
    log.debug(`Detected ${contextTools.length} tools from project context`);
  }

  // Inject memory into context
  const memory = injectMemory(memoryConfig);
  if (memory.totalTokensEstimate > 100) {
    const memoryStr = formatInjectedMemory(memory);
    history.addSystemMessage(`## Persistent Memory\n\n${memoryStr}`);
    log.debug(`Injected memory: ~${memory.totalTokensEstimate} tokens`);
  }

  history.addUserMessage(userInput);
  recordMessage(userInput.length);
  log.debug(`History: ${history.historySummary()}`);

  // Set module-level callbacks so processToolCalls/dispatchToolCall can
  // notify the TUI of tool execution. These are cleared in the finally
  // block below to prevent leaking across turns.
  currentOnToolCall = onToolCall;
  currentOnToolResult = onToolResult;
  setAskUserCallback(onAskUser, allowUserQuestions);

  let result: string;
  try {
    result = await sendAndProcess(0, onStreamStart, onToken, onThinking, onUsage);
  } finally {
    // Always clear callbacks to prevent leaks across turns
    currentOnToolCall = undefined;
    currentOnToolResult = undefined;
    clearAskUserCallback();
  }

  // Save session trace
  const trace: SessionTrace = {
    id: sessionStartTime,
    startTime: sessionStartTime,
    endTime: new Date().toISOString(),
    summary: userInput.slice(0, 200),
    decisions: [],
    fileChanges: sessionFileChanges,
    toolsUsed: [...new Set(sessionToolsUsed)],
    tokensUsed: 0,
    messages: history.getHistory().map((m) => ({
      role: m.role as "user" | "assistant" | "tool",
      content: typeof m.content === "string" ? m.content : "",
      timestamp: new Date().toISOString(),
    })),
  };
  saveSessionTrace(memoryConfig, trace);

  recordMessage(result.length);
  endSession();

  // Clear any leftover activity entries so the TUI doesn't show a stale
  // "Executando tool: foo" after the loop has ended.
  clearActivity();

  return result;
}
