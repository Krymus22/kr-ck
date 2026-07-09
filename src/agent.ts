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
import * as nodePath from "node:path";
import { chat, TOOL_DEFINITIONS } from "./apiClient.js";
import * as history from "./history.js";
import { executePreToolCallHooks, executePostToolCallHooks } from "./hooks.js";
import { getMCPToolDefinitions, callMCPTool, getActiveSkills } from "./extensions.js";
// Static imports for skill tracker + file rehydration (Gap 1 + Gap 9).
// BUG FIX: previously these were loaded via require() inside trackFileAccess,
// but require() is undefined in ESM modules — the require() calls threw
// ReferenceError, the surrounding try/catch swallowed it, and the
// recordSkillInvocation / recordSessionFileEdit calls were NEVER executed.
// That silently broke post-compaction skill re-injection (Gap 9) and
// file re-hydration (Gap 1). Use static imports so the calls actually run.
import { recordSkillInvocation } from "./skillTracker.js";
import { recordSessionFileEdit } from "./fileRehydration.js";
import * as log from "./logger.js";
import { config } from "./config.js";
import { readFileAdvanced } from "./fileRead.js";
import { editFile, type EditOperation } from "./fileEdit.js";
import { globSearch } from "./fileSearch.js";
import { grepSearch, formatGrepResults } from "./contentSearch.js";
import { gitStatus, gitDiff, gitLog, gitCommit, gitBlame, gitShow, gitBranch, gitCheckout } from "./gitTool.js";
import { multiFileEditWithLocks, type FileEditRequest } from "./multiFileEdit.js";
import { listSessions } from "./session.js";
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
// testRunner is dynamically imported in the Bug Hunter handler to avoid circular deps
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
import { runScout, formatScoutResult, isScoutEnabled, type ScoutArgs, type ScoutTask, type ScoutResult } from "./scoutAgent.js";
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
import { setAgentLoopRunningChecker } from "./readBeforeWrite.js";

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
/** Counter of goal verifier blocks this turn (avoids infinite goal-verifier loops) */
let goalVerifierBlocksThisTurn = 0;
/** Counter of bug hunter rounds this turn (max 5 rounds per turn) */
let bugHunterBlocksThisTurn = 0;
let bugHunterMediumLowRounds = 0;
/** Max stops per turn (safety) */
const MAX_STOPS_PER_TURN = 12;

/**
 * Re-entrancy guard for runAgentLoop.
 *
 * RACE CONDITION (Concurrency Audit Part 2):
 * The agent loop reads/writes a lot of module-level mutable state
 * (sessionFileChanges, turnTouchedFiles, currentOnToolCall, etc.). If a
 * second runAgentLoop() call starts while the first is still running
 * (e.g. a test calling it in parallel, a future caller bypassing the
 * TUI's isProcessing ref, or /compact firing while the previous turn's
 * tail is still unwinding), the two turns corrupt each other's state.
 *
 * The TUI guards against this via `isProcessing.current` (App.tsx), but
 * the agent itself had no defensive guard. This flag closes that hole:
 * a second call rejects immediately with a clear error, and other
 * modules (readBeforeWrite, stateCleanup) can read isAgentLoopRunning()
 * to decide whether to defer destructive state clears.
 */
let agentLoopRunning = false;

/** Returns true while a runAgentLoop() call is in progress. */
export function isAgentLoopRunning(): boolean {
  return agentLoopRunning;
}

// Register the agent-loop-running checker so readBeforeWrite.ts can refuse
// to clear state mid-turn (Concurrency Audit Part 2 — Race #2/#3). Done at
// module load via the setter (rather than a static import) to avoid a
// circular dependency: readBeforeWrite.ts is imported by agent.ts.
// Must run AFTER `agentLoopRunning` is declared above so the closure
// captures an initialized binding.
setAgentLoopRunningChecker(() => agentLoopRunning);

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
import { t } from "./i18n.js";
import { normalizeArgs } from "./argsNormalizer.js";
const MAX_CONCURRENT_SUB_AGENTS = parseInt(
  process.env.MAX_CONCURRENT_SUB_AGENTS ?? String(getProviderMaxSubAgents()),
  10
);
let activeSubAgents = 0;
const subAgentWaitQueue: Array<() => void> = [];

// --- Scout tool definition (IDEIA: acelerar leituras com modelo menor) ------
// The scout tool lets the main agent delegate read-only exploration to a
// smaller, faster model. The scout reads files, searches code, and returns
// a summary — so the main (larger, slower) model can skip the read phase
// and go straight to editing.
const SCOUT_TOOL_DEFINITION = {
  type: "function" as const,
  function: {
    name: "usar_scout",
    description:
      "PREFER THIS over ler_arquivo/buscar_texto/explorar_subagente for reading files and searching code. " +
      "Delegates ALL your read/search tasks to a FAST smaller model that executes them in seconds (1-3s per call) " +
      "instead of you doing each call yourself (10-30s each with the large model). " +
      "The scout reads files, searches code, and returns the FULL RAW CONTENT of every file and search result directly to you — " +
      "NOT a summary. You get the actual file contents, line numbers, and search matches in your context, " +
      "so you can go straight to editing without re-reading anything. " +
      "The scout can do up to 50 tool calls and explore deeply (nested UIs, multiple directories). " +
      "USE THIS whenever you need to: read 2+ files, search for patterns, explore project structure, " +
      "find UI elements, understand how a system works, or gather any context before editing. " +
      "The scout CANNOT edit files — it only reads and searches. " +
      "Only use ler_arquivo directly for a SINGLE quick read. " +
      "Only use explorar_subagente for conceptual questions that need reasoning. " +
      "This tool is always available when you see it in your tool list.",
    parameters: {
      type: "object",
      properties: {
        objetivo: {
          type: "string",
          description:
            "What context do you need and why? Be specific. " +
            "Examples: 'Read InventoryService.luau, find all DataStore calls, and map the UI structure for the inventory panel' " +
            "or 'Find where PlayerData is loaded and what functions modify it' " +
            "or 'Search for all RemoteEvent connections and read the client-side handlers'.",
        },
        tarefas: {
          type: "array",
          description: "List of read/search tasks. Be thorough — the scout is fast and can do up to 50 calls.",
          items: {
            type: "object",
            properties: {
              tipo: {
                type: "string",
                description: "Type of task.",
                enum: ["read_file", "search_files", "search_text", "explore"],
              },
              descricao: {
                type: "string",
                description:
                  "Specific instruction. Examples: " +
                  "'read src/InventoryService.luau' " +
                  "'search for all SetAsync calls in src/' " +
                  "'find all .spec.luau files' " +
                  "'explore the UI structure under StarterGui/InventoryPanel'.",
              },
            },
            required: ["tipo", "descricao"],
          },
        },
        max_tool_calls: {
          type: "number",
          description: "Max tool calls (default 50, max 50). Increase if you need deep exploration.",
        },
      },
      required: ["objetivo", "tarefas"],
    },
  },
};

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
  // Scout tool (only added when feature is enabled, so the model doesn't
  // see it when disabled — avoids confusion about a tool that returns error)
  if (isScoutEnabled()) {
    allTools.push(SCOUT_TOOL_DEFINITION);
  }

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
        description: "List available external tools.",
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
    // Accept both 'comando' (PT, original) and 'command' (EN, alias)
    const result = await executarComando({
      comando: asString(args.comando ?? args.command),
      cwd: args.cwd as string | undefined,
      background: args.background === true,
    });
    return { resultStr: result, usedHeal: false };
  },

  "verificar_comando": async (args) => {
    const { getProcessOutput, listBackgroundProcesses } = await import("./backgroundProcesses.js");
    const id = args.id as number | undefined;
    if (id === undefined || id === null) {
      return { resultStr: listBackgroundProcesses(), usedHeal: false };
    }
    const output = getProcessOutput(Number(id));
    if (output === null) {
      return { resultStr: `[ERROR] No background process with ID ${id}. Use verificar_comando without an ID to list all processes.`, usedHeal: false };
    }
    return { resultStr: output, usedHeal: false };
  },

  "parar_comando": async (args) => {
    const { killProcess } = await import("./backgroundProcesses.js");
    const id = Number(args.id);
    const killed = killProcess(id);
    if (killed) {
      return { resultStr: `[OK] Background process #${id} stopped (SIGTERM sent).`, usedHeal: false };
    }
    return { resultStr: `[ERROR] Could not stop process #${id} — not found or already exited.`, usedHeal: false };
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

  "buscar_web": async (args) => {
    const query = asString(args.query);
    if (!query) {
      return { resultStr: "[ERROR] 'query' is required.", usedHeal: false };
    }
    const maxResults = (args.maxResults as number) ?? 5;
    try {
      const { webSearch, getLastSearchSource } = await import("./apiResearcher.js");
      const startTime = Date.now();
      const results = await webSearch(query, maxResults);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const source = getLastSearchSource();
      if (results.length === 0) {
        return { resultStr: `[INFO] Nenhum resultado encontrado para: "${query}" (busca concluída em ${elapsed}s via ${source}). Tente reformular a busca com termos mais específicos ou em inglês.`, usedHeal: false };
      }
      const formatted = results.map((r: any, i: number) =>
        `${i + 1}. ${r.title ?? t("ui.untitled")}\n   URL: ${r.url}\n   ${r.snippet ?? r.description ?? ""}`
      ).join("\n\n");
      return { resultStr: `${t("tool.web_results", results.length, query)}:\n[Source: ${source} | ${elapsed}s]\n\n${formatted}\n\n💡 Dica: Se os resultados não são relevantes, tente adicionar termos específicos (ex: "roblox", "lua") ou usar site:dominio.com para filtrar.`, usedHeal: false };
    } catch (err) {
      return { resultStr: t("tool.web_search_failed", (err as Error).message), usedHeal: false };
    }
  },

  "ler_url": async (args) => {
    const url = asString(args.url);
    if (!url) {
      return { resultStr: "[ERROR] 'url' is required.", usedHeal: false };
    }
    const maxLength = (args.maxLength as number) ?? 10000;
    try {
      const { webRead } = await import("./apiResearcher.js");
      const content = await webRead(url);
      const truncated = content.length > maxLength
        ? content.slice(0, maxLength) + t("tool.content_truncated", content.length, maxLength)
        : content;
      return { resultStr: truncated || t("tool.url_extract_failed", url), usedHeal: false };
    } catch (err) {
      return { resultStr: t("tool.url_read_failed", (err as Error).message), usedHeal: false };
    }
  },

  "buscar_arquivos": async (args) => {
    const results = globSearch({
      pattern: asString(args.pattern ?? args.glob, "**/*"),
      cwd: args.cwd as string | undefined,
      maxDepth: args.maxDepth as number | undefined,
      ignore: args.ignore as string[] | undefined,
    });
    const output = results.length > 0 ? results.join("\n") : t("tool.no_files_found");
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

  "editar_multi_arquivos": async (args) => {
    const requests = args.requests as FileEditRequest[] | undefined;
    if (!requests || !Array.isArray(requests)) {
      return { resultStr: "[ERROR] 'requests' array is required", usedHeal: false };
    }
    // BUG FIX (concurrency race): acquire per-file locks BEFORE editing to
    // prevent two concurrent agents (main + sub-agent, or two parallel tool
    // calls) from racing on the same file. The single-file `editar_arquivo`
    // already locks via fileLock.ts; this extends the same protection to
    // multi-file edits. See multiFileEditWithLocks docstring for rationale.
    const result = await multiFileEditWithLocks(requests);
    const errorList = result.errors.map((e) => `${e.file}: ${e.error}`).join("; ");
    const output = result.success
      ? t("tool.edited_files", result.filesEdited.join(", "))
      : t("tool.edit_failures", errorList);
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
    // Use the testRunner to run tests
    const { runBugTest, detectLanguage } = await import("./testRunner.js");
    if (filePath) {
      const result = runBugTest(filePath, dir);
      return {
        resultStr: `Test ${result.passed ? "PASSED" : "FAILED"} (${result.language})\nCommand: ${result.command}\n${result.output}`,
        usedHeal: false,
      };
    }
    return { resultStr: "No test file specified. Use executar_testes with path argument.", usedHeal: false };
  },

  "sugerir_fixes": async (args) => {
    const dir = asString(args.dir, process.cwd());
    return {
      resultStr: "Fix suggestions: analyze test failures and check the source code for the bug. Use ler_arquivo to read the failing file, then editar_arquivo to fix.",
      usedHeal: false,
    };
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
      `OK Installeds: ${installed.length}`,
      `X Not installed: ${notInstalled.length}`,
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
      return { resultStr: t("ui.no_tool_suggested"), usedHeal: false };
    }
    
    const output = [
      "? Suggested tools:",
      ...suggestions.slice(0, 5).map((s, i) => 
        `${i + 1}. ${s.tool.name} (${s.tool.category}) - Confidence: ${(s.confidence * 100).toFixed(0)}%\n   Reason: ${s.reason}`
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
      "? Tool detection:",
      "",
      "By intent:",
      detection.intent ? `  * ${detection.intent.tool}` : "  * None",
      "",
      "By project context:",
      detection.context.length > 0 
        ? detection.context.map(t => `  * ${t.name} (${t.category})`).join("\n")
        : "  * None"
    ].join("\n");
    
    return { resultStr: output, usedHeal: false };
  },

  // --- Think Tool (3.1) ----------------------------------------------------
  "pensar": async (args) => {
    // Accept both `categoria` (PT, original) and `category` (EN, alias)
    const cat = asString(args.categoria ?? args.category, "general");
    const result = await think({
      pensamento: asString(args.pensamento),
      category: cat,
    });
    // Update task state based on thinking category
    if (cat === "planning" && asString(args.pensamento).length > 20) {
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
      resultStr: t("tool.task_state_updated", updated.updatedAt, updated.done.length, updated.todo.length, updated.decisions.length, updated.bugs.length),
      usedHeal: false,
    };
  },

  "marcar_feito": async (args) => {
    const item = asString(args.item);
    if (!item) {
      return { resultStr: "[ERROR] 'item' is required (substring of an item in todo).", usedHeal: false };
    }
    const { markTaskItemDone } = await import("./taskState.js");
    const updated = markTaskItemDone(item);
    return {
      resultStr: t("tool.item_moved_to_done", item, updated.todo.length),
      usedHeal: false,
    };
  },

  "ler_estado": async () => {
    const summary = getTaskStateSummary();
    return {
      resultStr: summary ?? t("tool.task_state_not_found"),
      usedHeal: false,
    };
  },

  "listar_memoria": async () => {
    // Returns the list of project memory files (CLAUDE.md, AGENTS.md) loaded
    // into the system prompt at startup. The model uses this to answer
    // "which config file did you read?" without parsing the system prompt.
    const files = history.getLoadedMemoryFiles();
    if (files.length === 0) {
      return {
        resultStr: "No project memory files (CLAUDE.md / AGENTS.md) were found at startup. " +
          "To add one, create CLAUDE.md or AGENTS.md in the project root (or any parent dir up to 10 levels).",
        usedHeal: false,
      };
    }
    const lines = [
      `Project memory files loaded at startup (${files.length}):`,
      "",
    ];
    for (const f of files) {
      const sizeStr = f.sizeBytes < 1024
        ? `${f.sizeBytes} B`
        : f.sizeBytes < 1024 * 1024
        ? `${(f.sizeBytes / 1024).toFixed(1)} KB`
        : `${(f.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
      lines.push(`- ${f.relativePath} (${sizeStr})`);
    }
    lines.push(
      "",
      "To see the CURRENT contents of any file above, call ler_arquivo(<path>).",
      "The cached version in the system prompt may be stale if the file was edited since startup.",
    );
    return {
      resultStr: lines.join("\n"),
      usedHeal: false,
    };
  },

  // --- IDEIA 5: Sub-agent for isolated exploration ------------------------
  "explorar_subagente": async (args) => {
    const question = asString(args.questao ?? args.question);
    if (!question) {
      return { resultStr: "[ERROR] 'questao' (or 'question') is required (the question for the sub-agent to explore).", usedHeal: false };
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
        resultStr: t("tool.subagent_disabled"),
        usedHeal: false,
      };
    }
    return { resultStr: result, usedHeal: false };
    } finally {
      releaseSubAgentSlot();
    }
  },

  // --- Scout: delegate read-only exploration to a faster, smaller model ---
  // This tool lets the main agent delegate read/search tasks to a scout
  // sub-agent that uses a smaller, faster model. The scout gathers context
  // and returns a summary, so the main model can skip the read phase.
  "usar_scout": async (args) => {
    // Feature gate — if disabled, return error so the model knows
    if (!isScoutEnabled()) {
      return {
        resultStr: "[ERROR] Scout feature is disabled. Set SCOUT_ENABLED=1 to enable. You can continue reading files directly with ler_arquivo/buscar_texto.",
        usedHeal: false,
      };
    }

    // BUG FIX (anti-recursion): prevent scout from being called inside a
    // sub-agent (which would cause deadlock via acquireSubAgentSlot).
    // Sub-agents set CLAUDE_KILLER_AGENT_ID env var — if it's set, we're
    // inside a sub-agent context and must refuse.
    if (process.env.CLAUDE_KILLER_AGENT_ID) {
      return {
        resultStr: "[ERROR] usar_scout cannot be called from inside a sub-agent (would deadlock). Use ler_arquivo/buscar_texto directly.",
        usedHeal: false,
      };
    }

    const objective = asString(args.objetivo ?? args.objective);
    if (!objective) {
      return { resultStr: "[ERROR] 'objetivo' is required (what context you need from the scout).", usedHeal: false };
    }

    // Parse tasks array
    const rawTasks = args.tarefas ?? args.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return { resultStr: "[ERROR] 'tarefas' must be a non-empty array of {tipo, descricao}.", usedHeal: false };
    }

    const tasks: ScoutTask[] = rawTasks.map((t: any) => ({
      type: (t.tipo ?? t.type ?? "explore") as ScoutTask["type"],
      description: asString(t.descricao ?? t.description ?? ""),
    })).filter((t: ScoutTask) => t.description);

    if (tasks.length === 0) {
      return { resultStr: "[ERROR] No valid tasks provided. Each task needs a 'descricao'.", usedHeal: false };
    }

    const cwd = args.cwd ? asString(args.cwd) : undefined;
    const maxCalls = args.max_tool_calls as number | undefined;

    // Scout uses the sub-agent slot semaphore (same concurrency limit)
    await acquireSubAgentSlot();
    try {
      // BUG FIX (visual-feedback): pass the current onToolCall/onToolResult
      // callbacks so the scout's tool calls appear in the TUI in real-time.
      // The user sees ALL calls (including failures) as they happen, with
      // "scout:" prefix so they know it's the smaller model doing the work.
      const scoutArgs: ScoutArgs = {
        objective,
        tasks,
        cwd,
        maxToolCalls: maxCalls,
        onToolCall: currentOnToolCall,
        onToolResult: currentOnToolResult,
      };
      const result = await runScout(scoutArgs);

      if (result === null) {
        return {
          resultStr: "[SCOUT] Feature disabled or failed to start. Continue with ler_arquivo/buscar_texto directly.",
          usedHeal: false,
        };
      }

      if (!result.completed) {
        return {
          resultStr: `[SCOUT FAILED] Model: ${result.modelUsed}, Error: ${result.error ?? "unknown"}. Continue with ler_arquivo/buscar_texto directly.`,
          usedHeal: false,
        };
      }

      // Return the formatted summary for the main agent to use as context
      const formatted = formatScoutResult(result);
      return { resultStr: formatted, usedHeal: false };
    } finally {
      releaseSubAgentSlot();
    }
  },

  // --- Multi-key pool status (IDEIA Fase 1) ------------------------------
  // Sprint C bug fix (BUG-S): todo_write estava definido em TOOL_DEFINITIONS
  // mas NÃO tinha handler. IA via a tool, chamava, e recebia "Ferramenta
  // desconhecida". Agora delega for todo.todoWrite().
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

// BUG-PP+ : track duplicate blocked tool calls per agent loop iteration.
// Reset at the start of each runAgentLoop. If the same tool+args is blocked 3+ times,
// dispatchToolCall returns a STOP message forcing the IA to give up and respond.
const blockedCallCounter = new Map<string, number>();

async function dispatchToolCall(
  toolCall: ToolCall,
  healRetry: number = 0
): Promise<ToolResult> {
  const name = toolCall.function.name;
  const startTime = Date.now();

  const rawArgs = parseArgs(toolCall.function.arguments);
  // BUG FIX: previously, when the pre-hook skipped the call, dispatchToolCall
  // called executePreToolCallHooks AGAIN to recover `resultOverride`. This
  // ran every pre-hook twice on skip. Now resolvePreCallHooks returns the
  // override in one call.
  const preCallResolution = await resolvePreCallHooks(name, rawArgs);
  if (preCallResolution.args === null) {
    return { resultStr: preCallResolution.resultOverride ?? `[HOOK] Tool "${name}" skipped by pre-hook.`, usedHeal: false };
  }
  const finalArgs = preCallResolution.args;

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

    // DEDUP: detect duplicate blocked tool calls (same tool + same args).
    // After 2 identical failures: WARN the IA to try a different approach.
    // After 3 identical failures: STOP and force the IA to respond to the user.
    const argSignature = `${name}:${toolCall.function.arguments}`;
    blockedCallCounter.set(argSignature, (blockedCallCounter.get(argSignature) ?? 0) + 1);
    const attemptNum = blockedCallCounter.get(argSignature)!;
    if (attemptNum >= 3) {
      const stopMsg = t("abort.stop_duplicate", name, attemptNum);
      log.warn(`[DEDUP] Tool ${name} blocked ${attemptNum}x with same args — forcing stop`);
      return { resultStr: stopMsg, usedHeal: false };
    }
    if (attemptNum >= 2) {
      // 2nd failure — warn the IA to change strategy before we force stop
      const warnMsg =
        `[WARNING] You already tried "${name}" with these EXACT same arguments and it failed. ` +
        `Do NOT retry with the same arguments. Try a DIFFERENT approach: ` +
        `re-read the file (ler_arquivo) to see the ACTUAL current content, ` +
        `then adjust your search string or use createIfMissing. ` +
        `If you can't fix it, explain the issue to the user.`;
      log.warn(`[DEDUP] Tool ${name} blocked ${attemptNum}x — warning IA to change approach`);
      return { resultStr: warnMsg, usedHeal: false };
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

  // IDEIA E: Snapshot file before edit (for Bug Hunter diff)
  if (WRITE_FILE_TOOLS.has(name)) {
    try {
      const { snapshotFileBeforeEdit } = await import("./bugHunter.js");
      const filePath = asString(finalArgs.caminho ?? finalArgs.path ?? finalArgs.filePath ?? "");
      if (filePath) snapshotFileBeforeEdit(filePath);
    } catch { /* ignore */ }
  }

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

  // DEDUP-EXEC: detect repeated EXECUTION errors (not just gate blocks).
  // After 2 identical failures: WARN the IA to try a different approach.
  // After 3 identical failures: STOP and force the IA to respond to the user.
  {
    const resultStrSafe = result.resultStr ?? "";
    const isExecError = resultStrSafe.startsWith("[ERROR]") || resultStrSafe.startsWith("[ERRO");
    if (isExecError) {
      const errSignature = `${name}:EXEC:${resultStrSafe.slice(0, 200)}`;
      blockedCallCounter.set(errSignature, (blockedCallCounter.get(errSignature) ?? 0) + 1);
      const execAttemptNum = blockedCallCounter.get(errSignature)!;
      if (execAttemptNum >= 3) {
        const stopMsg = t("abort.stop_duplicate", name, execAttemptNum);
        log.warn(`[DEDUP-EXEC] Tool ${name} failed ${execAttemptNum}x with same error — forcing stop`);
        result.resultStr = stopMsg;
      } else if (execAttemptNum >= 2) {
        // 2nd failure — warn the IA to change strategy
        result.resultStr +=
          `\n\n[WARNING] This is the ${execAttemptNum}nd time "${name}" failed with this EXACT same error. ` +
          `Do NOT retry with the same arguments. Try a DIFFERENT approach: ` +
          `re-read the file (ler_arquivo) to see the ACTUAL current content, ` +
          `then adjust your search string. If you can't fix it, explain the issue to the user.`;
        log.warn(`[DEDUP-EXEC] Tool ${name} failed ${execAttemptNum}x — warning IA to change approach`);
      }
    }
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
  // IDEIA E: Also show diff of what changed after edit.
  if (WRITE_FILE_TOOLS.has(name) && !resultStrSafe.startsWith("[ERRO") && !resultStrSafe.startsWith("[BLOQUEADO")) {
    const editedPath = asString(finalArgs.caminho ?? finalArgs.path ?? finalArgs.filePath ?? "");

    // IDEIA E: Generate diff after edit and append to result
    if (editedPath) {
      try {
        const { generateDiffAfterEdit } = await import("./bugHunter.js");
        const diff = generateDiffAfterEdit(editedPath);
        if (diff) {
          result.resultStr += `\n\n${diff}`;
        }
      } catch { /* ignore */ }
    }
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

/**
 * Returns the (possibly modified) args, or null if the pre-hook skipped the call.
 *
 * BUG FIX: previously this returned only `null` on skip, forcing the caller
 * (dispatchToolCall) to call executePreToolCallHooks AGAIN to recover the
 * `resultOverride`. That meant every pre-hook ran twice on skip — wasteful
 * and potentially causing side effects (double logging, double counter
 * increments, etc.). Now we return the full resolution so the caller can
 * read `resultOverride` without re-running the hook chain.
 */
async function resolvePreCallHooks(
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<{ args: Record<string, unknown> | null; resultOverride?: string }> {
  const preResult = await executePreToolCallHooks(name, rawArgs);
  if (preResult.skip) return { args: null, resultOverride: preResult.resultOverride };
  return { args: preResult.modifiedArgs ?? rawArgs };
}

/** Run schema validation, poka-yoke, and read-before-write gates. Returns an error string if blocked, else null. */
function runDispatchGates(name: string, args: Record<string, unknown>): string | null {
  // BUG-ARGS: Universal argument normalization BEFORE schema gate.
  // Auto-corrects: aliases (caminho→path, command→comando), type coercion
  // (string→number, "true"→true), JSON string parsing, default values.
  // This makes the system robust to model-specific quirks — even weaker
  // models won't fail on args.
  try {
    const schema = getToolSchemaMap().get(name);
    normalizeArgs(name, args, schema as any);

    // BUG-REPLACE2: Fallback for when schema lookup fails or doesn't cover
    // a field. Some models pass 'replace' as an object instead of string.
    // Force-convert known string fields that arrived as objects.
    const stringFields = ["replace", "search", "path", "caminho", "comando", "pensamento", "questao", "query", "url", "pattern"];
    for (const field of stringFields) {
      if (field in args && typeof args[field] === "object" && args[field] !== null && !Array.isArray(args[field])) {
        const obj = args[field] as Record<string, unknown>;
        if (typeof obj.content === "string") args[field] = obj.content;
        else if (typeof obj.value === "string") args[field] = obj.value;
        else if (typeof obj.text === "string") args[field] = obj.text;
        else args[field] = JSON.stringify(args[field]);
        log.debug(`[NORMALIZE-FALLBACK] Force-converted ${name}.${field} from object to string`);
      }
    }
  } catch {
    // best-effort — don't block the call if normalization fails
  }

  const schemaBlock = runSchemaGate(name, args);
  if (schemaBlock) return schemaBlock;

  const pyResult = pokaYokeCheck(name, args);
  if (!pyResult.ok) return pyResult.error ?? "[POKA-YOKE] Blocked.";

  const rbwResult = checkReadBeforeWrite(name, args);
  if (!rbwResult.allowed) return rbwResult.message ?? "[BLOCKED] Read-before-write check failed.";

  return null;
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
    // Gap 9: Track skill invocations for post-compaction re-injection.
    // If the IA reads a file that's a skill, record it so we can re-inject
    // the skill content after compaction.
    //
    // BUG FIX: previously this block used require() to load extensions.js,
    // skillTracker.js, and the path module. In ESM, require() is undefined
    // and the require() calls threw ReferenceError — silently caught by the
    // try/catch below — so recordSkillInvocation was NEVER called and skill
    // re-injection after compaction was broken. Use the statically-imported
    // helpers (and the already-imported nodePath alias) instead.
    try {
      const skills = getActiveSkills() as Array<{ path: string }>;
      const resolved = nodePath.resolve(filePath);
      if (skills.some((s) => nodePath.resolve(s.path) === resolved)) {
        recordSkillInvocation(resolved);
      }
    } catch { /* skillTracker not available — skip */ }
  }
  if (WRITE_FILE_TOOLS.has(name)) {
    const resolved = pokaYokeCheck(name, args).resolvedPath ?? filePath;
    turnTouchedFiles.add(resolved);
    // Gap 1: Track session-edited files for post-compaction re-hydration.
    // This lets the IA "remember" file contents even after context is compacted.
    //
    // BUG FIX: same require() issue as above — recordSessionFileEdit was
    // never actually called. Use the statically-imported helper.
    try {
      recordSessionFileEdit(resolved);
    } catch { /* fileRehydration not available — skip */ }
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
      const errMsg = `[ERROR] ${(err as Error).message ?? String(err)}`;
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
      const errMsg = `[ERROR] Manifest tool "${name}" failed: ${(err as Error).message ?? String(err)}`;
      log.error(errMsg);
      return { resultStr: errMsg, usedHeal: false };
    }
  }
  if (name.includes("__")) {
    // ── Roblox Studio MCP Guard ────────────────────────────────────────────
    // Intercept MCP tool calls to prevent the IA from bypassing safety
    // validations (Bug Hunter, DataGuard, read-before-write, rollback).
    //
    // WRITE tools (multi_edit, generate_*, insert_from_creator_store) are
    // BLOCKED — the IA must use our `aplicar_diff` instead, which goes
    // through the full safety pipeline before syncing to Studio via Rojo.
    //
    // READ, EXECUTE, PLAYTEST, and SESSION tools are allowed (with logging
    // for execute tools).
    try {
      const { evaluateMcpToolCall } = await import("./robloxMcpGuard.js");
      const guardResult = evaluateMcpToolCall(name, args);
      if (!guardResult.allowed) {
        log.warn(`[MCP_GUARD] Blocked "${name}" — category: ${guardResult.category}`);
        return {
          resultStr: guardResult.blockReason ?? `[MCP_GUARD] Tool "${name}" blocked.`,
          usedHeal: false,
        };
      }
      if (guardResult.shouldLog) {
        log.info(`[MCP_GUARD] Allowing "${name}" — category: ${guardResult.category}`);
      }
    } catch (guardErr) {
      // If the guard itself fails, fail-SAFE: block the call
      log.error(`[MCP_GUARD] Guard error, blocking call: ${(guardErr as Error).message}`);
      return {
        resultStr: `[MCP_GUARD] Safety check failed — call blocked for protection. Error: ${(guardErr as Error).message}`,
        usedHeal: false,
      };
    }

    try {
      return { resultStr: await callMCPTool(name, args), usedHeal: false };
    } catch (err) {
      const errMsg = `[ERROR] ${(err as Error).message ?? String(err)}`;
      log.error(`MCP tool "${name}" lançou exceção: ${(err as Error).message ?? String(err)}`);
      return { resultStr: errMsg, usedHeal: false };
    }
  }
  const unknown = `[ERROR] Unknown tool: "${name}"`;
  log.error(unknown);
  return { resultStr: unknown, usedHeal: false };
}

// --- Tool Call Processing -----------------------------------------------------

const READ_ONLY_TOOLS = new Set([
  "ler_arquivo", "buscar_arquivos", "buscar_texto",
  "buscar_web", "ler_url", "parse_ast",
  // IDEIA 5: explorar_subagente is read-only (only reads code, never edits)
  // and benefits from parallel execution with other read-only tools.
  "explorar_subagente",
  // Scout is read-only (delegates to a smaller model that only reads files
  // and searches code — never edits). Benefits from parallel execution.
  "usar_scout",
  // Task state read is read-only.
  "ler_estado",
  // Listing project memory files is read-only (just returns the cached list).
  "listar_memoria",
  // Background process management is read-only (checking status, listing)
  "verificar_comando",
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

  // Execute read-only calls: in parallel when 2+ of them, sequentially when
  // exactly 1 (no benefit from parallelism for a single call).
  //
  // BUG FIX: previously this was written as
  //     await executeReadOnlyCallsInParallel(readOnlyCalls); // no-op when length<=1
  //     if (writeCalls.length > 0) { ... } else if (readOnlyCalls.length <= 1) {
  //         await executeToolCallsSequentially(readOnlyCalls);
  //     }
  // When the model returned exactly 1 read-only call + 1+ write calls, the
  // parallel path was a no-op (length <= 1) AND the `else if` branch was
  // skipped (because writeCalls.length > 0), so the single read-only call
  // was SILENTLY DROPPED — never executed, never added to history. The model
  // would then see an orphan tool_call_id and the API would 400 on the next
  // request. We now explicitly route the single-call case through the
  // sequential executor regardless of whether write calls are present.
  if (readOnlyCalls.length > 1) {
    await executeReadOnlyCallsInParallel(readOnlyCalls);
  } else if (readOnlyCalls.length === 1) {
    await executeToolCallsSequentially(readOnlyCalls);
  }

  if (writeCalls.length > 0) {
    await executeToolCallsSequentially(writeCalls);
    fireOnFileTrigger(writeCalls);
  }

  checkAutoHeal(toolCalls);
}

function fireOnFileTrigger(writeCalls: ToolCall[]): void {
  const fileTools = writeCalls.filter((tc) => FILE_TOOLS.has(tc.function.name));
  if (fileTools.length === 0) return;
  // BUG FIX: previously, the loop overwrote `triggerCtx.filePath` and
  // `triggerCtx.toolName` on each iteration, then fired ONE trigger after
  // the loop — so only the LAST file in the batch actually triggered on_file
  // hooks. If the IA edited files A, B, and C in one turn, only C's hook
  // ran. Now we fire one trigger per file so every edited file announces
  // itself to extensions/hooks listening on "on_file".
  for (const tc of fileTools) {
    const args = parseArgs(tc.function.arguments);
    const triggerCtx: TriggerContext = {
      cwd: process.cwd(),
      filePath: asString(args.path ?? args.caminho),
      toolName: tc.function.name,
    };
    executeTrigger("on_file", triggerCtx).catch((err) => {
      log.warn(`On-file trigger failed for ${tc.function.name}: ${(err as Error).message}`);
    });
  }
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
  // No depth limit — the dedup detector (blockedCallCounter) already prevents
  // infinite loops by aborting after 3 identical blocked tool calls.
  // This allows complex multi-step tasks without artificial limits.

  // CRITICAL FIX: runPreTurnMaintenance must NEVER crash the agent.
  // It contains writeCheckpoint (file I/O) and chat() calls (API).
  // Any error here would propagate up to runAgentLoop's try/finally (no catch),
  // killing the process via unhandled rejection.
  try {
    await runPreTurnMaintenance();
  } catch (err) {
    log.warn(`[PRE_TURN_MAINTENANCE] Failed (non-fatal): ${(err as Error).message}`);
  }
  try {
    history.optimizeContext();
  } catch (err) {
    log.warn(`[OPTIMIZE_CONTEXT] Failed (non-fatal): ${(err as Error).message}`);
  }

  // Always send ALL tools — no tool reduction.
  // Tool reduction was removed because it filtered tools the IA might need.
  // The IA should always have access to all 18 tools.
  let toolsForCall = getMergedTools();

  // IDEIA 27+#28: Checkpoint writer - proactive state extraction
  try {
    const { shouldCheckpoint, writeCheckpoint, formatCheckpoint } = await import("./checkpointWriter.js");
    // BUG FIX: shouldCheckpoint expects TOKENS (it divides by MAX_CONTEXT_TOKENS
    // = 128000 and compares to thresholds 0.20 / 0.45 / 0.70). The previous
    // code passed `history.getHistory().length` (MESSAGE COUNT), which made
    // contextPercent = messageCount / 128000 — always near 0 (e.g. 50 msgs
    // = 0.04%), so checkpoints were NEVER triggered. Pass the token estimate
    // so the 20% / 45% / 70% thresholds actually fire.
    //
    // BUG FIX (Bug Hunter: checkpoint firing too early): the checkpointWriter
    // now reads `config.contextWindowTokens` (the ACTUAL model context window
    // from modelRegistry.ts via config.ts — defaults to 256_000 for Kimi K2.6)
    // instead of the old hardcoded 128_000. Using 128_000 made the 20% threshold
    // fire at 25_600 tokens (= 10% of the actual 256_000 window), which is why
    // the user saw "Salvando checkpoint…" at ~13% context after 2 messages.
    // No explicit override is passed here — checkpointWriter uses
    // config.contextWindowTokens by default (per §1.1, the registry is the
    // source of truth for context window).
    const currentTokens = history.estimateTokens();
    const checkpointNum = shouldCheckpoint(currentTokens);
    if (checkpointNum > 0) {
      log.info(`[CHECKPOINT] Triggering checkpoint ${checkpointNum} at ~${currentTokens} tokens`);
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

  // BUG-PP fix: sanitize malformed tool_call arguments BEFORE adding to history.
  // Some models (llama-3.3-70b) occasionally emit truncated/malformed JSON in
  // tool_call.function.arguments. If we store that raw and re-send it on the
  // next iteration, the OpenAI client rejects the whole request with 400.
  // Sanitize: if JSON.parse fails on arguments, replace with a valid JSON
  // object containing the raw text so the model can see what went wrong.
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (tc?.function?.arguments && typeof tc.function.arguments === "string") {
        try {
          JSON.parse(tc.function.arguments);
        } catch {
          // BUG-PP++: Try to recover a valid JSON prefix from the malformed string.
          // Some models (diffusiongemma, llama) emit JSON like:
          //   {"path": "/tmp"}{}        (extra "{}" appended)
          //   {"path": "/tmp"}<|channel> (trailing tokens)
          //   {"path": "/tmp"}\n\n       (trailing whitespace/newlines that break parser)
          // Strategy: find the longest valid JSON prefix by scanning for the last
          // `}` that produces a valid JSON.parse, then use that as the args.
          const rawArgs = tc.function.arguments;
          let recovered: string | null = null;

          // Strategy 1: find the first complete JSON object (balanced braces)
          let depth = 0;
          let inString = false;
          let escape = false;
          let endIdx = -1;
          for (let i = 0; i < rawArgs.length; i++) {
            const ch = rawArgs[i];
            if (escape) { escape = false; continue; }
            if (ch === "\\") { escape = true; continue; }
            if (ch === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (ch === "{") depth++;
            else if (ch === "}") {
              depth--;
              if (depth === 0) {
                // Found a complete top-level object — try to parse it
                try {
                  JSON.parse(rawArgs.slice(0, i + 1));
                  recovered = rawArgs.slice(0, i + 1);
                  endIdx = i;
                  break;
                } catch {
                  // not valid JSON, keep scanning
                }
              }
            }
          }

          if (recovered) {
            log.debug(`[SANITIZE] Tool ${tc.function.name} recovered valid JSON prefix from malformed args`);
            tc.function.arguments = recovered;
          } else {
            // Could not recover — replace with error placeholder
            log.warn(`[SANITIZE] Tool ${tc.function.name} had malformed JSON args — replacing with error placeholder`);
            tc.function.arguments = JSON.stringify({
              _malformed_json: rawArgs.slice(0, 500),
              _error: "Previous arguments were malformed JSON. Please retry with valid JSON."
            });
          }
        }
      }
    }
  }

  history.addRawAssistantMessage(message);

  fireTrigger("always");

  if (finish_reason === "tool_calls" && message.tool_calls?.length) {
    log.debug(`Model requested ${message.tool_calls.length} tool call(s)`);
    await processToolCalls(message.tool_calls);

    // BUG-PP+ : abort the agent loop if any tool has been blocked 3+ times with the same args.
    // The IA is stuck in a loop and won't recover — better to return what we have so far
    // than to spin for another 10+ iterations.
    let maxBlocked = 0;
    let blockedTool = "";
    for (const [sig, count] of blockedCallCounter.entries()) {
      if (count > maxBlocked) { maxBlocked = count; blockedTool = sig.split(":")[0]; }
    }
    if (maxBlocked >= 3) {
      log.warn(`[DEDUP-ABORT] Aborting agent loop: tool "${blockedTool}" blocked ${maxBlocked}x with same args`);
      // Return immediately with a final error message. Don't recurse — the IA will
      // just call the same tool again. Force-terminate.
      const abortMsg = t("abort.loop_detected", blockedTool, maxBlocked);
      return abortMsg;
    }

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
  goalVerifierBlocksThisTurn = 0;
  bugHunterBlocksThisTurn = 0;
  bugHunterMediumLowRounds = 0;

  // Reset Bug Hunter previous findings for new turn
  try {
    const { resetBugHunterState } = await import("./bugHunter.js");
    resetBugHunterState();
    const { resetDataGuardState } = await import("./dataGuard.js");
    resetDataGuardState();
  } catch { /* ignore */ }

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
  // Compaction threshold from config (default 65% — more aggressive than before).
  // Override via CONTEXT_COMPACT_THRESHOLD env var (0.0-1.0).
  // CRITICAL: smartCompact is now ASYNC and BLOCKING. The agent PAUSES here
  // until compaction completes. This prevents OOM kills from running compaction
  // in parallel with the main chat() call.
  const compactionThreshold = config.contextWindowTokens * config.contextCompactThreshold;
  const compaction = await smartCompact(compactionThreshold);
  if (compaction.compacted) {
    log.info(`[COMPACTION] Context compacted: saved ${compaction.savedTokens} tokens (threshold was ${Math.round(compactionThreshold)})`);
  }
  await maybeWriteCheckpoint();
}

async function maybeWriteCheckpoint(): Promise<void> {
  try {
    const currentTokens = history.estimateTokens?.() ?? 0;
    // BUG FIX (Bug Hunter: checkpoint firing too early): the default
    // CheckpointWriterConfig in memory.ts uses contextBudget = 128_000 (a
    // historical hardcoded value). The actual model context window is
    // `config.contextWindowTokens` (256_000 for Kimi K2.6 — see
    // modelRegistry.ts). Passing the explicit config here makes the second
    // checkpoint system fire at the SAME thresholds as checkpointWriter.ts
    // (20% / 45% / 70% of the REAL context window), so they don't disagree
    // and the user doesn't see duplicate "Salvando checkpoint…" messages at
    // conflicting percentages.
    const checkpointWriterConfig = {
      contextBudget: config.contextWindowTokens,
      checkpointPercentages: [0.2, 0.45, 0.7],
    };
    if (!shouldWriteCheckpoint(currentTokens, checkpointWriterConfig) || currentTokens <= lastCheckpointTokens + 1000) return;
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
  } catch (err) {
    log.warn(`[CHECKPOINT_WRITE] Failed (non-fatal): ${(err as Error).message}`);
  }
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

/**
 * GOAL-VERIFIER-V2: Heuristic to detect if the user message is a TASK
 * (something that needs verification) or a QUESTION (just needs an answer).
 *
 * Tasks: "create", "fix", "implement", "refactor", "add", "remove", "edit"
 * Questions: "what", "how", "why", "explain", "show", "list", "?"
 *
 * This prevents the goal verifier from blocking finish when the user just
 * asked a question (no task to verify).
 */
function looksLikeTask(userMessage: string): boolean {
  const lower = userMessage.toLowerCase();
  // Question indicators
  const questionWords = ["what ", "how ", "why ", "when ", "where ", "which ", "explain", "show me", "list ", "tell me", "?"];
  for (const q of questionWords) {
    if (lower.includes(q)) return false;
  }
  // Task indicators
  const taskWords = ["create", "fix", "implement", "refactor", "add ", "remove", "edit", "update", "change", "modify", "build", "write", "delete", "configure", "install", "run ", "test"];
  for (const t of taskWords) {
    if (lower.includes(t)) return true;
  }
  // Default: treat as task if it's long enough to be a request
  return userMessage.length > 30;
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
  // GOAL-VERIFIER-V2: Less aggressive — only block if:
  //   1. This is the FIRST stop attempt (turnStopHits === 1)
  //   2. Files were modified this turn (real work happened)
  //   3. We haven't already blocked N times this turn (avoid loops)
  //   4. The user request looks like a TASK (not a question)
  // After 2 blocks, allow finish — the IA may genuinely be done.
  try {
    const { verifyGoalCompletion, formatGoalVerification } = await import("./goalVerifier.js");
    const MAX_GOAL_BLOCKS_PER_TURN = 2;
    if (turnTouchedFiles.size > 0 &&
        turnStopHits === 1 &&
        goalVerifierBlocksThisTurn < MAX_GOAL_BLOCKS_PER_TURN) {
      const userRequestRaw = history.getHistory().find((m) => m.role === "user")?.content;
      const userRequest = typeof userRequestRaw === "string" ? userRequestRaw : "";

      // Skip verification for simple questions (not tasks)
      if (!looksLikeTask(userRequest)) {
        log.debug(`[GOAL_VERIFIER] Skipping — user message is a question, not a task`);
      } else {
        const result = await verifyGoalCompletion(
          userRequest as string,
          [...turnTouchedFiles],
          message.content ?? ""
        );
        if (!result.done && result.verified) {
          goalVerifierBlocksThisTurn++;
          log.warn(`[GOAL_VERIFIER] Task NOT done (block ${goalVerifierBlocksThisTurn}/${MAX_GOAL_BLOCKS_PER_TURN})`);
          history.addSystemMessage(formatGoalVerification(result));
          return true;  // Block finish, force AI to continue
        }
      }
    }
  } catch { /* goalVerifier not available */ }

  // BUG_HUNTER: Run independent critical code review before finishing.
  // This is a sub-agent with CLEAN context that hunts for bugs actively.
  //
  // LOOP BEHAVIOR: When the Bug Hunter finds CRITICAL or HIGH bugs:
  //   1. It reports ALL findings to the main IA
  //   2. The IA is forced to fix them (finish is blocked)
  //   3. After fixing, the IA tries to finish again
  // ─── BUG HUNTER + DATAGUARD (parallel) ──────────────────────────────────
  // BUG FIX (sequential-shortcircuit): previously Bug Hunter and DataGuard
  // ran SEQUENTIALLY — if Bug Hunter blocked (critical/high), DataGuard
  // NEVER ran (return true before reaching it). This meant data-loss risks
  // went undetected during Bug Hunter correction loops.
  //
  // Fix: run BOTH in parallel via Promise.all. Both reviews complete, both
  // results are injected into the IA's context, and we block if EITHER has
  // critical/high findings. This matches §10.5 (steps 7 and 8 are
  // independent reviews) and the docstring in dataGuard.ts ("Roda em
  // paralelo com o Bug Hunter").
  try {
    const MAX_BUG_HUNTER_ROUNDS = 10;
    const MAX_MEDIUM_LOW_ROUNDS = 3;
    if (turnTouchedFiles.size > 0 && bugHunterBlocksThisTurn < MAX_BUG_HUNTER_ROUNDS) {
      const userRequestRaw = history.getHistory().find((m) => m.role === "user")?.content;
      const userRequest = typeof userRequestRaw === "string" ? userRequestRaw : "";
      const filesArr = [...turnTouchedFiles];
      const agentResponse = message.content ?? "";

      // BUG FIX (parallel-reviews): launch both reviews in parallel.
      // Both sub-agents have independent clean contexts — no shared state.
      // Promise.all waits for both, then we process combined results.
      console.log(`[BUG_HUNTER+DATAGUARD] Starting parallel review of ${filesArr.length} file(s)`);
      const [{ runBugHunter }, { runDataGuard }] = await Promise.all([
        import("./bugHunter.js"),
        import("./dataGuard.js"),
      ]);
      const [bhResult, dgResult] = await Promise.all([
        runBugHunter(filesArr, userRequest, agentResponse),
        runDataGuard(filesArr, userRequest, agentResponse),
      ]);

      console.log(`[BUG_HUNTER] Result: shouldBlock=${bhResult.shouldBlock}, completed=${bhResult.completed}, findings=${bhResult.findings.length}`);
      console.log(`[DATAGUARD] Result: shouldBlock=${dgResult.shouldBlock}, completed=${dgResult.completed}, findings=${dgResult.findings.length}`);

      // ─── BUG HUNTER test verification ─────────────────────────────────
      try {
        const { runTestsForFindings, allCriticalHighTestsPass } = await import("./bugHunter.js");
        const projectRoot = process.cwd();
        runTestsForFindings(bhResult.findings, projectRoot);
        const allPass = allCriticalHighTestsPass(bhResult.findings);
        const testedCount = bhResult.findings.filter(f => f.testStatus === "passed" || f.testStatus === "failed").length;
        const passedCount = bhResult.findings.filter(f => f.testStatus === "passed").length;
        const failedCount = bhResult.findings.filter(f => f.testStatus === "failed").length;
        if (testedCount > 0) {
          console.log(`[BUG_HUNTER] Test verification: ${passedCount}/${testedCount} tests passed, ${failedCount} failed`);
          if (failedCount > 0) {
            const failedFindings = bhResult.findings.filter(f => f.testStatus === "failed");
            bhResult.message += `\n\n## TEST RESULTS\n${passedCount}/${testedCount} tests PASSED, ${failedCount} FAILED.\n`;
            bhResult.message += `The following findings have FAILING tests (bug NOT fixed):\n`;
            for (const f of failedFindings) {
              bhResult.message += `- [${f.severity.toUpperCase()}] ${f.file} — ${f.description.slice(0, 80)}\n`;
              bhResult.message += `  Test: ${f.testFile}\n`;
            }
            bhResult.message += `\nThese bugs PERSIST. Try a DIFFERENT fix approach.\n`;
          } else if (passedCount > 0) {
            bhResult.message += `\n\n## TEST RESULTS\n✓ All ${passedCount} tests PASSED. The bugs covered by tests are FIXED.\n`;
          }
        }
        void allPass;
      } catch (err) {
        console.log(`[BUG_HUNTER] Test verification skipped: ${(err as Error).message}`);
      }

      // ─── Process Bug Hunter results ───────────────────────────────────
      let bhBlocked = false;
      if (bhResult.shouldBlock && bhResult.completed) {
        const hasCriticalHigh = bhResult.findings.some(f => f.severity === "critical" || f.severity === "high");
        const hasMediumLow = bhResult.findings.some(f => f.severity === "medium" || f.severity === "low");
        if (hasCriticalHigh) {
          bugHunterBlocksThisTurn++;
          console.log(`[BUG_HUNTER] ACTION: blocking finish for critical/high (round ${bugHunterBlocksThisTurn}/${MAX_BUG_HUNTER_ROUNDS})`);
          history.addSystemMessage(bhResult.message);
          bhBlocked = true;
        } else if (hasMediumLow && bugHunterMediumLowRounds < MAX_MEDIUM_LOW_ROUNDS) {
          bugHunterBlocksThisTurn++;
          bugHunterMediumLowRounds++;
          console.log(`[BUG_HUNTER] ACTION: blocking finish for medium/low (round ${bugHunterMediumLowRounds}/${MAX_MEDIUM_LOW_ROUNDS})`);
          history.addSystemMessage(bhResult.message);
          bhBlocked = true;
        } else {
          console.log(`[BUG_HUNTER] ACTION: medium/low cap reached — allowing finish`);
          history.addSystemMessage(`[BUG_HUNTER] Medium/low review cap reached. ${bhResult.findings.length} findings remain unaddressed — please review manually.\n\n${bhResult.message}`);
        }
      } else if (bhResult.completed && bhResult.findings.length === 0) {
        console.log(`[BUG_HUNTER] ACTION: clean pass — no bugs found`);
        if (bugHunterBlocksThisTurn > 0) {
          history.addSystemMessage(`[BUG_HUNTER] ✓ All previously identified bugs have been fixed. Code passed critical review on round ${bugHunterBlocksThisTurn + 1}.`);
        }
      }

      // ─── Process DataGuard results ────────────────────────────────────
      // BUG FIX: DataGuard now ALWAYS runs (not skipped when Bug Hunter blocks).
      // Both results are injected so the IA can fix both logic bugs AND data
      // risks in the same turn.
      let dgBlocked = false;
      if (dgResult.shouldBlock && dgResult.completed) {
        const hasCriticalHigh = dgResult.findings.some(f => f.severity === "critical" || f.severity === "high");
        if (hasCriticalHigh) {
          console.log(`[DATAGUARD] Found ${dgResult.findings.length} data protection issue(s) — BLOCKING finish`);
          history.addSystemMessage(dgResult.message);
          dgBlocked = true;
        } else {
          console.log(`[DATAGUARD] Only medium/low data risks — advisory only`);
          history.addSystemMessage(dgResult.message);
        }
      } else if (dgResult.completed && dgResult.findings.length === 0) {
        console.log(`[DATAGUARD] ✓ NO DATA RISKS — data protection review passed`);
      }

      // Block if EITHER review found critical/high issues
      if (bhBlocked || dgBlocked) {
        return true;
      }
    } else if (bugHunterBlocksThisTurn >= MAX_BUG_HUNTER_ROUNDS) {
      console.log(`[BUG_HUNTER] Max rounds (${MAX_BUG_HUNTER_ROUNDS}) reached — allowing finish despite potential bugs`);
      history.addSystemMessage(`[BUG_HUNTER] Max review rounds (${MAX_BUG_HUNTER_ROUNDS}) reached. The code may still have issues — please review manually.`);
    }
  } catch (err) {
    console.log(`[BUG_HUNTER+DATAGUARD] Skipped (error in handler): ${(err as Error).message}`);
  }

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
  // --- Re-entrancy guard (Concurrency Audit Part 2) --------------------------
  // The agent loop mutates module-level state (sessionFileChanges,
  // turnTouchedFiles, currentOnToolCall, agentLoopRunning itself, etc.).
  // Two concurrent runAgentLoop() calls would corrupt that state. The TUI
  // guards via `isProcessing.current`, but programmatic callers (tests,
  // future entry points) could bypass it. Reject hard here.
  if (agentLoopRunning) {
    throw new Error(
      "[AGENT_LOOP] Another runAgentLoop() is already in progress. " +
      "Concurrent agent turns are not supported because they share module-level " +
      "state (session traces, turn counters, tool callbacks). " +
      "The TUI serializes turns via isProcessing.current; programmatic callers " +
      "must do the same (await the previous turn before starting a new one)."
    );
  }
  agentLoopRunning = true;

  startSession();
  sessionStartTime = new Date().toISOString();
  sessionFileChanges = [];
  sessionToolsUsed = [];
  lastCheckpointTokens = 0;
  turnTouchedFiles = new Set();
  turnStopHits = 0;
  // BUG FIX: these per-turn counters were previously only reset at the END of
  // a successful turn (inside handleChatResponse). If the previous turn ended
  // via an error (API failure, exception in a hook, etc.), the counters
  // leaked into the next turn — causing Bug Hunter / Goal Verifier caps to
  // be reached prematurely or blocking finish on stale state. Reset them at
  // the START of each turn too, so a fresh user message always starts clean.
  goalVerifierBlocksThisTurn = 0;
  bugHunterBlocksThisTurn = 0;
  bugHunterMediumLowRounds = 0;
  resetGateState();
  resetContextInjection();
  resetSelfValidation();
  resetAutoTestSuggestions();
  resetFalsePromiseCounter();
  blockedCallCounter.clear(); // BUG-PP+: reset duplicate-call counter for new session
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

  // ── Auto Memory Injection ────────────────────────────────────────────────
  // Load notes the IA wrote in previous sessions (corrections, patterns).
  // Inspired by Claude Code's auto memory: first 200 lines of MEMORY.md
  // are loaded at session start.
  try {
    const { readAutoMemory } = await import("./autoMemory.js");
    const autoMem = readAutoMemory();
    if (autoMem && autoMem.length > 50) {
      history.addSystemMessage(`## Auto Memory (notas de sessões anteriores)\n\n${autoMem}`);
      log.debug(`[AUTO_MEMORY] Injected ${autoMem.length} chars`);
    }
  } catch (autoMemErr) {
    log.debug(`[AUTO_MEMORY] Failed to load: ${(autoMemErr as Error).message}`);
  }

  history.addUserMessage(userInput);
  recordMessage(userInput.length);
  log.debug(`History: ${history.historySummary()}`);

  // ── Research Hint Injection ──────────────────────────────────────────────
  // Detect if the user's question is about something that CHANGES OVER TIME
  // (games, APIs, products, versions, news). If so, inject a hint telling
  // the IA to consider using buscar_web() to verify before answering.
  //
  // This prevents the IA from answering factual questions from (potentially
  // outdated) training data when it has web search available. The hint is
  // SUBTLE — it suggests, doesn't force. The IA can still answer from
  // training if confident the info is timeless.
  //
  // Anti-triggers: programming basics (print, loops), concepts (OOP, HTTP),
  // and commands (write, create) do NOT trigger hints — those are either
  // timeless or action requests, not factual questions.
  try {
    const { detectResearchTrigger, generateResearchHint } = await import("./researchHint.js");
    const trigger = detectResearchTrigger(userInput);
    if (trigger) {
      const hint = generateResearchHint(trigger, userInput);
      if (hint) {
        history.addSystemMessage(hint);
        log.debug(`[RESEARCH_HINT] Injected hint for trigger: ${trigger}`);
      }
    }
  } catch (hintErr) {
    // Research hints are optional — don't crash if it fails
    log.debug(`[RESEARCH_HINT] Failed to inject: ${(hintErr as Error).message}`);
  }

  // Set module-level callbacks so processToolCalls/dispatchToolCall can
  // notify the TUI of tool execution. These are cleared in the finally
  // block below to prevent leaking across turns.
  currentOnToolCall = onToolCall;
  currentOnToolResult = onToolResult;
  setAskUserCallback(onAskUser, allowUserQuestions);

  let result: string;
  try {
    result = await sendAndProcess(0, onStreamStart, onToken, onThinking, onUsage);
  } catch (err) {
    // Log the error for debugging, but RE-THROW it so callers (tests, TUI)
    // that expect the promise to reject still work correctly.
    // The try/catch around runPreTurnMaintenance and maybeWriteCheckpoint
    // (added in this same fix) prevents the most common crash causes from
    // reaching here. If something still throws, it's a real error that
    // should propagate.
    log.error(`[AGENT_LOOP] Error: ${(err as Error).message}`);
    throw err;
  } finally {
    // Always clear callbacks to prevent leaks across turns
    currentOnToolCall = undefined;
    currentOnToolResult = undefined;
    clearAskUserCallback();
    // Release the re-entrancy guard so the next turn can start.
    // This MUST be in the finally so a thrown error doesn't permanently
    // lock out future turns (which would force the user to restart the CLI).
    agentLoopRunning = false;
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

  // ── Auto Memory Suggestion ───────────────────────────────────────────────
  // After the IA responds, check if the user was correcting the IA.
  // If so, inject a hint suggesting the IA write a note for future sessions.
  // This is non-blocking and doesn't affect the current response.
  try {
    const { maybeSuggestMemoryWrite } = await import("./autoMemory.js");
    const suggestion = maybeSuggestMemoryWrite(userInput, result);
    if (suggestion) {
      history.addSystemMessage(suggestion);
      log.debug("[AUTO_MEMORY] Suggested memory write for next turn");
    }
  } catch { /* auto memory is optional */ }

  return result;
}
