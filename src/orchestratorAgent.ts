/**
 * orchestratorAgent.ts — Lightweight orchestrator agent.
 *
 * Uses a fast, smaller model (default: google/gemma-4-31b-it) to converse
 * with the user and orchestrate work. When the user asks for something
 * complex, the orchestrator delegates to a heavy model (GLM 5.2) via
 * chamar_planejador or chamar_programador.
 *
 * The orchestrator NEVER reads files, edits code, or plans. It ORCHESTRATES.
 * It can run read-only commands, call scout, search the web, and ask the user.
 *
 * When the heavy model (planner/coder) finishes, its RAW output is fed back
 * to the orchestrator. The orchestrator then "compacts" it — producing a
 * concise summary that stays in its context so it knows what happened.
 * EXCEPTION: the PLAN is never compacted — it stays raw.
 *
 * FEATURE TOGGLE: ORCHESTRATOR_MODE=1 to enable.
 * MODELS: ORCHESTRATOR_MODEL (default: google/gemma-4-31b-it)
 *         HEAVY_MODEL (default: z-ai/glm-5.2)
 *
 * ANTI-RECURSION: CLAUDE_KILLER_AGENT_ID = "orchestrator". The orchestrator
 * is the main agent (talks to user directly), so it CAN call perguntar_usuario
 * — it bypasses handleAskUser (which blocks any agent_id) and calls the
 * onAskUser callback directly. The orchestrator is also allowed to call
 * usar_scout (the scout's anti-recursion only blocks "scout"/"sub-agent"/
 * "small-task-agent"). The orchestrator keeps the ID set during scout calls
 * (FIX-ORCH-S23) — clearing it was unnecessary defense-in-depth that risked
 * losing the ID on error paths.
 */

import type OpenAI from "openai";
import { chatWithModel, clearModelOverride } from "./apiClient.js";
import type { Message } from "./apiClient.js";
import * as history from "./history.js";
import * as log from "./logger.js";
import { pushActivity, clearActivity } from "./activityTracker.js";
import type { AskUserCallback, AskUserQuestion, AskUserResponse } from "./askUser.js";
import { isScoutEnabled, runScout, formatScoutResult, type ScoutArgs, type ScoutTask } from "./scoutAgent.js";
import { runPlanner } from "./plannerAgent.js";
import { runCoder } from "./coderAgent.js";
// FIX-ORCH-CRIT (HIGH 4): per-turn state cleanup. runPlanner/runCoder delegate
// to the heavy model's loop, which mutates module-level state in
// strictQualityGate, contextInjector, selfValidation, autoTestGenerator,
// promiseDetector, and activityTracker. runAgentLoop resets these at the start
// of each turn; runOrchestratorLoop must do the same to prevent stale state
// from leaking across orchestrator turns (e.g. a previous coder turn's gate
// blocks blocking the next turn, or stale activity entries persisting).
import { resetGateState } from "./strictQualityGate.js";
import { resetContextInjection } from "./contextInjector.js";
import { resetSelfValidation } from "./selfValidation.js";
import { resetAutoTestSuggestions } from "./autoTestGenerator.js";
import { resetFalsePromiseCounter } from "./promiseDetector.js";
import { config } from "./config.js";

// --- Concurrency guard ------------------------------------------------------

/**
 * Module-level flag that prevents two concurrent runOrchestratorLoop() calls
 * from corrupting shared state (history, planStore, env vars, activity
 * tracker). Mirrors `agentLoopRunning` in agent.ts:176. The orchestrator mutates
 * module-level state (CLAUDE_KILLER_AGENT_ID, planStore passed by reference,
 * history via add*Message) — two overlapping turns would interleave messages
 * and corrupt the conversation. The TUI serializes via isProcessing.current,
 * but programmatic callers (tests, future entry points) could bypass it.
 */
let orchestratorLoopRunning = false;

// --- Config (env vars) -----------------------------------------------------

/** Whether orchestrator mode is enabled (ORCHESTRATOR_MODE=1 or =true). */
export function isOrchestratorMode(): boolean {
  return process.env.ORCHESTRATOR_MODE === "1" || process.env.ORCHESTRATOR_MODE === "true";
}

/** Get the orchestrator model ID (default: google/gemma-4-31b-it). */
export function getOrchestratorModel(): string {
  // FIX-ORCH-CRIT (HIGH 5): use `||` (not `??`) so empty-string env vars fall
  // back to the default — ORCHESTRATOR_MODEL="" should not silently produce
  // an empty model ID. Mirrors config.ts's optionalString pattern.
  return process.env.ORCHESTRATOR_MODEL?.trim() || "google/gemma-4-31b-it";
}

/** Get the heavy model ID used by planner and coder (default: z-ai/glm-5.2). */
export function getHeavyModel(): string {
  // FIX-ORCH-CRIT (HIGH 5): use `||` (not `??`) so empty-string env vars fall
  // back to the default — HEAVY_MODEL="" should not silently produce an empty
  // model ID. Mirrors config.ts's optionalString pattern.
  return process.env.HEAVY_MODEL?.trim() || "z-ai/glm-5.2";
}

// --- Anti-recursion ---------------------------------------------------------

const ORCHESTRATOR_AGENT_ID = "orchestrator";

// --- Read-only command allowlist (mirrors scout) ----------------------------

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
    withoutSudo.startsWith(prefix + " ") || withoutSudo === prefix,
  );
}

// --- System prompt ----------------------------------------------------------

const ORCHESTRATOR_SYSTEM_PROMPT = `Você é um ORQUESTRADOR — o assistente principal do usuário. Você é rápido e conversa diretamente.

Você NÃO lê arquivos, NÃO edita código, NÃO planeja arquitetura. Você ORQUESTRA.

TOOLS:
1. chamar_planejador(tarefa) — chama modelo inteligente para planejar. Use para tarefas complexas.
2. chamar_programador(tarefa, plano?) — chama modelo inteligente para escrever/editar código.
3. executar_comando_readonly(comando) — comandos read-only (ls, git status, pwd, cat, grep).
4. usar_scout(objetivo) — delega leituras/buscas para modelo ultra-rápido.
5. buscar_web(query) — busca na web.
6. ler_url(url) — lê conteúdo de URL.
7. perguntar_usuario(pergunta, alternativas) — pergunta ao usuário.

REGRAS:
- Conversa simples → responda DIRETAMENTE, sem tools.
- Tarefa de código → chame chamar_planejador, depois chamar_programador com o plano.
- Verificação rápida → executar_comando_readonly.
- Ler arquivos/procurar código → usar_scout.
- Seja CONCISO. Não explique — faça.
- Quando o modelo pesado terminar, você recebe o resultado. Resuma para o usuário.
- O PLANO nunca deve ser modificado ou resumido — passe-o intacto para o programador.`;

/** Marker used to detect if the orchestrator prompt is already in history. */
const ORCHESTRATOR_PROMPT_MARKER = "VOCÊ É UM ORQUESTRADOR";

// --- Tool definitions -------------------------------------------------------

const ORCHESTRATOR_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "chamar_planejador",
      description:
        "Chama o modelo pesado (GLM 5.2) para criar um plano estruturado de uma tarefa complexa. " +
        "Use para tarefas de código que precisam de planejamento. " +
        "O plano é retornado RAW — você deve passá-lo intacto para chamar_programador.",
      parameters: {
        type: "object",
        properties: {
          tarefa: {
            type: "string",
            description: "A tarefa a ser planejada (descrição completa do que o usuário quer).",
          },
        },
        required: ["tarefa"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "chamar_programador",
      description:
        "Chama o modelo pesado (GLM 5.2) para escrever/editar código. " +
        "Passe o plano se houver (do chamar_planejador) — o programador vai segui-lo. " +
        "Retorna um resumo do que foi feito.",
      parameters: {
        type: "object",
        properties: {
          tarefa: { type: "string", description: "A tarefa de código a ser implementada." },
          plano: {
            type: "string",
            description: "Plano estruturado (opcional). Se fornecido, será seguido. Passe o plano INTEIRO — não resuma.",
          },
        },
        required: ["tarefa"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_comando_readonly",
      description:
        "Executa um comando shell READ-ONLY (ls, cat, git status, git log, grep, find, wc, pwd, etc). " +
        "NÃO pode executar comandos que modificam arquivos. Use para verificações rápidas.",
      parameters: {
        type: "object",
        properties: {
          comando: { type: "string", description: "O comando read-only para executar." },
        },
        required: ["comando"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "usar_scout",
      description:
        "Delega leituras e buscas de código para um modelo ultra-rápido. " +
        "Use para ler arquivos, buscar padrões, ou explorar a estrutura do projeto. " +
        "Retorna o conteúdo RAW dos arquivos.",
      parameters: {
        type: "object",
        properties: {
          objetivo: { type: "string", description: "O que você precisa ler/buscar e por quê." },
          tarefas: {
            type: "array",
            description: "Lista de tarefas de leitura/busca.",
            items: {
              type: "object",
              properties: {
                tipo: {
                  type: "string",
                  description: "Tipo de tarefa.",
                  enum: ["read_file", "search_files", "search_text", "explore"],
                },
                descricao: { type: "string", description: "Descrição específica da tarefa." },
              },
              required: ["descricao"],
            },
          },
          max_tool_calls: { type: "number", description: "Max tool calls (default 50, max 100)." },
        },
        required: ["objetivo", "tarefas"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_web",
      description: "Busca na web por informações. Retorna títulos, URLs e snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Termo de busca." },
          maxResults: { type: "number", description: "Máximo de resultados (default: 5)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_url",
      description: "Lê o conteúdo de uma URL. Extrai texto de páginas web (remove HTML).",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL para ler." },
          maxLength: { type: "number", description: "Tamanho máximo (default: 10000 chars)." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "perguntar_usuario",
      description:
        "Pergunta ao usuário uma questão com alternativas. Use quando precisar de clarificação. " +
        "O usuário pode escolher uma alternativa ou digitar resposta livre.",
      parameters: {
        type: "object",
        properties: {
          pergunta: { type: "string", description: "A pergunta em linguagem natural." },
          alternativas: {
            type: "array",
            items: { type: "string" },
            description: "2-6 alternativas. O usuário também pode digitar livremente.",
            minItems: 2,
            maxItems: 6,
          },
          contexto: { type: "string", description: "Contexto opcional explicando POR QUÊ pergunta." },
        },
        required: ["pergunta", "alternativas"],
      },
    },
  },
];

// --- Callbacks --------------------------------------------------------------

export interface OrchestratorCallbacks {
  /** Called when the model starts streaming a response. */
  onStreamStart?: () => void;
  /** Called for each token streamed (for TUI rendering). */
  onToken?: (token: string) => void;
  /** Called when the model is "thinking" (reasoning tokens). */
  onThinking?: () => void;
  /** Called with token usage stats after each model call. */
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  /** Called before each tool call (for TUI display). */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /** Called after each tool call completes. */
  onToolResult?: (toolName: string, ok: boolean, resultStr: string) => void;
  /**
   * Called when the orchestrator calls perguntar_usuario. The TUI shows a
   * QuestionPrompt UI and resolves the promise when the user answers.
   * If undefined, perguntar_usuario returns an error.
   */
  onAskUser?: AskUserCallback;
}

// --- Compaction -------------------------------------------------------------

/** Results longer than this (in chars) get compacted before going into context. */
const COMPACTION_THRESHOLD_CHARS = 500;

/**
 * Compact a heavy-model result by asking the orchestrator model to summarize it.
 *
 * The orchestrator's context window is smaller than the heavy model's, so we
 * can't keep raw multi-KB coder output verbatim. Instead, we ask the
 * orchestrator model itself to produce a concise summary that captures the
 * key facts (what was done, files changed, errors encountered).
 *
 * Exception: the PLAN is never compacted (the orchestrator needs it raw to
 * pass to the coder). Compaction is only applied to coder output and other
 * large tool results.
 *
 * If the compaction call fails, we fall back to a hard truncation (first
 * 500 chars + "[TRUNCATED]") so the orchestrator loop doesn't break.
 */
async function compactResult(rawResult: string, label: string): Promise<string> {
  if (rawResult.length <= COMPACTION_THRESHOLD_CHARS) return rawResult;

  const orchestratorModel = getOrchestratorModel();
  log.debug(`[ORCH] Compacting ${label} (${rawResult.length} chars → summary)`);

  const compactionMessages: Message[] = [
    {
      role: "system",
      content:
        "Você é um compactador. Resuma o texto a seguir de forma CONCISA (máx ~300 chars), " +
        "preservando FATOS CHAVE: o que foi feito, arquivos alterados, erros, decisões. " +
        "NÃO adicione comentários — apenas o resumo.",
    },
    {
      role: "user",
      content: `Resuma o seguinte resultado do ${label}:\n\n${rawResult}`,
    },
  ];

  try {
    const response = await chatWithModel(
      compactionMessages,
      undefined, // no tools — compaction is a single-shot summarization
      orchestratorModel,
      true, // disableThinking — compaction should be fast
    );
    const summary = response.choices?.[0]?.message?.content?.trim();
    if (summary && summary.length > 0) {
      log.debug(`[ORCH] Compacted ${label}: ${summary.length} chars (was ${rawResult.length})`);
      return `[COMPACTED ${label}]\n${summary}\n[END COMPACTED]`;
    }
    // Empty summary — fall back to truncation.
  } catch (err) {
    log.warn(`[ORCH] Compaction failed for ${label}: ${err instanceof Error ? err.message : String(err)}. Falling back to truncation.`);
  }

  // Fallback: hard truncate.
  const truncated = rawResult.slice(0, COMPACTION_THRESHOLD_CHARS);
  return `${truncated}\n\n[... truncated ${rawResult.length - COMPACTION_THRESHOLD_CHARS} chars ...]`;
}

// --- Helpers ----------------------------------------------------------------

/**
 * Safely convert an unknown value to string. Returns fallback for non-string
 * primitives and objects (avoids `[object Object]`). Mirrors agent.ts
 * `asString` (which isn't exported).
 */
function asString(val: unknown, fallback = ""): string {
  if (typeof val === "string") return val;
  if (val == null) return fallback;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "symbol") return String(val);
  return fallback;
}

// --- Tool execution --------------------------------------------------------

/**
 * Execute an orchestrator tool call. Returns the result string + success flag.
 *
 * The orchestrator's tools are:
 * - chamar_planejador → runPlanner (heavy model)
 * - chamar_programador → runCoder (heavy model) — result may be compacted
 * - executar_comando_readonly → allowlisted shell commands
 * - usar_scout → runScout (fast model)
 * - buscar_web → webSearch
 * - ler_url → webRead
 * - perguntar_usuario → onAskUser callback (direct, bypasses handleAskUser)
 *
 * The plan from chamar_planejador is stored in `planStore` (passed by
 * reference) so the orchestrator loop can pass it to chamar_programador.
 * The plan is NEVER compacted.
 */
async function executeOrchestratorTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  callbacks: OrchestratorCallbacks | undefined,
  planStore: { plan: string | null },
): Promise<{ result: string; ok: boolean }> {
  try {
    switch (toolName) {
      case "chamar_planejador": {
        const tarefa = asString(args.tarefa);
        if (!tarefa) return { result: "[ERROR] tarefa vazia", ok: false };
        log.info(`[ORCH] chamar_planejador: ${tarefa.slice(0, 80)}`);
        callbacks?.onToolCall?.("chamar_planejador", args);

        const plannerResult = await runPlanner(tarefa, {
          onToolCall: callbacks?.onToolCall,
          onToolResult: callbacks?.onToolResult,
        });

        if (!plannerResult.success) {
          // FIX-ORCH-S23 (HIGH 5): Clear any stale plan from a PREVIOUS
          // chamar_planejador call when the current planner run fails.
          // Without this, a previous successful plan would remain in
          // planStore.plan and be reused by the next chamar_programador —
          // generating code for the WRONG task (the failed plan's task, not
          // the current one). The plan must come from the CURRENT planner
          // call; if that call failed, there is no valid plan.
          planStore.plan = null;
          const errResult = `[PLANNER FAILED] ${plannerResult.error ?? "unknown error"}`;
          callbacks?.onToolResult?.("chamar_planejador", false, errResult);
          return { result: errResult, ok: false };
        }

        // Store the plan — it's NEVER compacted. The orchestrator passes it
        // verbatim to chamar_programador.
        planStore.plan = plannerResult.plan;

        const okResult = `[PLAN — não modifique, passe intacto para chamar_programador]\n${plannerResult.plan}`;
        callbacks?.onToolResult?.("chamar_planejador", true, okResult);
        return { result: okResult, ok: true };
      }

      case "chamar_programador": {
        const tarefa = asString(args.tarefa);
        if (!tarefa) return { result: "[ERROR] tarefa vazia", ok: false };
        // The model may pass the plan via the `plano` arg, OR we use the
        // stored plan from a previous chamar_planejador call.
        const planoArg = typeof args.plano === "string" && args.plano.length > 0 ? args.plano : null;
        // FIX-ORCH-CRIT (HIGH 3): Stored plan takes priority over the model-
        // supplied plan. The raw plan from chamar_planejador is the canonical
        // source — the model may paraphrase, truncate, or "improve" it, which
        // violates rule 76 ("O PLANO nunca deve ser modificado"). Only fall
        // back to planoArg when no stored plan exists (e.g. the model called
        // chamar_programador without a prior chamar_planejador).
        const plan = planStore.plan ?? planoArg;
        log.info(`[ORCH] chamar_programador: ${tarefa.slice(0, 80)} (plan: ${plan ? "yes" : "no"})`);
        callbacks?.onToolCall?.("chamar_programador", args);

        const coderResult = await runCoder(tarefa, plan, {
          onToolCall: callbacks?.onToolCall,
          onToolResult: callbacks?.onToolResult,
        });

        // FIX-ORCH-S1 (CRITICAL 5): clear the stored plan now that the coder
        // has consumed it. Without this, a subsequent chamar_programador call
        // (in the same orchestrator turn or a later one within the same loop
        // invocation) would reuse the STALE plan from the previous task —
        // generating code for the wrong task. The plan is single-use by
        // contract: chamar_planejador → chamar_programador is a 1:1 pairing.
        planStore.plan = null;

        if (!coderResult.success) {
          const errResult = `[CODER FAILED] ${coderResult.error ?? "unknown error"}`;
          callbacks?.onToolResult?.("chamar_programador", false, errResult);
          return { result: errResult, ok: false };
        }

        // Compact the coder result if it's large (the orchestrator's context
        // is smaller than the heavy model's). The PLAN is never compacted,
        // but coder OUTPUT can be.
        const compacted = await compactResult(coderResult.result, "CODER");
        callbacks?.onToolResult?.("chamar_programador", true, compacted);
        return { result: compacted, ok: true };
      }

      case "executar_comando_readonly": {
        const comando = asString(args.comando);
        if (!comando) return { result: "[ERROR] comando vazio", ok: false };
        if (!isReadOnlyCommand(comando)) {
          const errResult = `[ERROR] Comando não está na allowlist read-only: "${comando.slice(0, 50)}". Apenas ls, cat, git status, grep, find, wc, pwd, etc.`;
          callbacks?.onToolResult?.("executar_comando_readonly", false, errResult);
          return { result: errResult, ok: false };
        }
        callbacks?.onToolCall?.("executar_comando_readonly", args);
        const { executarComando } = await import("./tools.js");
        const result = await executarComando({
          comando,
          cwd,
          timeoutMs: 15000,
          background: false,
        });
        const resultStr = typeof result === "string" ? result : String(result);
        const ok = !resultStr.startsWith("[ERROR]");
        // Truncate for TUI display.
        const forTui = resultStr.length > 4000
          ? resultStr.slice(0, 2000) + "\n[TRUNCATED]\n" + resultStr.slice(-2000)
          : resultStr;
        callbacks?.onToolResult?.("executar_comando_readonly", ok, forTui);
        return { result: resultStr, ok };
      }

      case "usar_scout": {
        if (!isScoutEnabled()) {
          const errResult = "[ERROR] Scout desabilitado. Set SCOUT_ENABLED=1.";
          callbacks?.onToolResult?.("usar_scout", false, errResult);
          return { result: errResult, ok: false };
        }
        const objective = asString(args.objetivo ?? args.objective);
        if (!objective) {
          return { result: "[ERROR] 'objetivo' é obrigatório.", ok: false };
        }
        const rawTasks = args.tarefas ?? args.tasks;
        if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
          return { result: "[ERROR] 'tarefas' deve ser um array não-vazio.", ok: false };
        }
        const tasks: ScoutTask[] = rawTasks.map((t: any) => ({
          type: (t.tipo ?? t.type ?? "explore") as ScoutTask["type"],
          description: String(t.descricao ?? t.description ?? ""),
        })).filter((t: ScoutTask) => t.description);
        if (tasks.length === 0) {
          return { result: "[ERROR] Nenhuma tarefa válida.", ok: false };
        }
        const maxCalls = typeof args.max_tool_calls === "number" ? args.max_tool_calls : undefined;
        callbacks?.onToolCall?.("usar_scout", args);

        // FIX-ORCH-S23 (HIGH 3): Removed the save/clear/restore of
        // CLAUDE_KILLER_AGENT_ID around runScout. The scout's anti-recursion
        // guard (agent.ts) only blocks "scout"/"sub-agent"/"small-task-agent" —
        // "orchestrator" is explicitly ALLOWED. Clearing the ID was
        // defense-in-depth but caused a subtle bug: if an error threw between
        // the `delete` and the `finally`, the env var stayed deleted and the
        // orchestrator's own anti-recursion state was lost. Keeping the ID set
        // is both correct (the guard allows it) and safer (no env var churn).
        const scoutArgs: ScoutArgs = {
          objective,
          tasks,
          cwd,
          maxToolCalls: maxCalls,
          onToolCall: callbacks?.onToolCall,
          onToolResult: callbacks?.onToolResult,
        };
        const scoutResult = await runScout(scoutArgs);
        if (scoutResult === null) {
          const errResult = "[SCOUT] Desabilitado ou falhou ao iniciar.";
          callbacks?.onToolResult?.("usar_scout", false, errResult);
          return { result: errResult, ok: false };
        }
        if (!scoutResult.completed) {
          const errResult = `[SCOUT FAILED] ${scoutResult.error ?? "unknown"}`;
          callbacks?.onToolResult?.("usar_scout", false, errResult);
          return { result: errResult, ok: false };
        }
        const formatted = formatScoutResult(scoutResult);
        // Scout results can be large (raw file contents). Compact if needed.
        const compacted = await compactResult(formatted, "SCOUT");
        callbacks?.onToolResult?.("usar_scout", true, compacted);
        return { result: compacted, ok: true };
      }

      case "buscar_web": {
        const query = asString(args.query);
        if (!query) return { result: "[ERROR] query vazia", ok: false };
        const maxResults = typeof args.maxResults === "number" ? args.maxResults : 5;
        callbacks?.onToolCall?.("buscar_web", args);
        const { webSearch } = await import("./apiResearcher.js");
        const results = await webSearch(query, maxResults);
        if (results.length === 0) {
          callbacks?.onToolResult?.("buscar_web", true, "Nenhum resultado.");
          return { result: "Nenhum resultado encontrado.", ok: true };
        }
        const formatted = results.map((r: { url: string; title: string; snippet: string }, i: number) =>
          `${i + 1}. ${r.title ?? "Sem título"}\n   URL: ${r.url}\n   ${r.snippet ?? ""}`,
        ).join("\n\n");
        callbacks?.onToolResult?.("buscar_web", true, formatted);
        return { result: formatted, ok: true };
      }

      case "ler_url": {
        const url = asString(args.url);
        if (!url) return { result: "[ERROR] url vazia", ok: false };
        const maxLength = typeof args.maxLength === "number" ? args.maxLength : 10000;
        callbacks?.onToolCall?.("ler_url", args);
        const { webRead } = await import("./apiResearcher.js");
        const content = await webRead(url);
        const truncated = content.length > maxLength
          ? content.slice(0, maxLength) + "\n[TRUNCATED]"
          : content;
        const resultStr = truncated || "[ERROR] Conteúdo vazio";
        callbacks?.onToolResult?.("ler_url", !!content, resultStr);
        return { result: resultStr, ok: !!content };
      }

      case "perguntar_usuario": {
        const pergunta = asString(args.pergunta);
        const alternativas = Array.isArray(args.alternativas) ? (args.alternativas as string[]) : [];
        const contexto = typeof args.contexto === "string" ? args.contexto : undefined;

        if (!pergunta) {
          return { result: "[ERROR] pergunta é obrigatória.", ok: false };
        }
        if (alternativas.length < 2) {
          return { result: "[ERROR] alternativas deve ter pelo menos 2 itens.", ok: false };
        }
        if (alternativas.length > 6) {
          return { result: "[ERROR] alternativas deve ter no máximo 6 itens.", ok: false };
        }

        if (!callbacks?.onAskUser) {
          return {
            result: "[ERROR] perguntar_usuario não disponível neste contexto. Use seu melhor julgamento.",
            ok: false,
          };
        }

        callbacks?.onToolCall?.("perguntar_usuario", args);

        // Call the onAskUser callback directly (bypasses handleAskUser,
        // which blocks when CLAUDE_KILLER_AGENT_ID is set — but the
        // orchestrator IS the main agent and SHOULD be able to ask).
        const question: AskUserQuestion = { pergunta, alternativas, contexto };
        let response: AskUserResponse;
        try {
          response = await callbacks.onAskUser(question);
        } catch (err) {
          const errResult = `[ERROR] Falha ao obter resposta: ${err instanceof Error ? err.message : String(err)}`;
          callbacks?.onToolResult?.("perguntar_usuario", false, errResult);
          return { result: errResult, ok: false };
        }

        let resultStr: string;
        if (response.cancelled) {
          resultStr = "[USER CANCELLED] Usuário não respondeu. Use seu melhor julgamento.";
        } else {
          const prefix = response.fromAlternatives ? "[USER RESPONSE]" : "[USER RESPONSE (free text)]";
          resultStr = `${prefix} ${response.value}`;
        }
        callbacks?.onToolResult?.("perguntar_usuario", true, resultStr);
        return { result: resultStr, ok: true };
      }

      default:
        return { result: `[ERROR] Tool desconhecida: ${toolName}`, ok: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `[ERROR] ${msg}`, ok: false };
  }
}

// --- Main entry point ------------------------------------------------------

/** Max orchestrator iterations (tool-call rounds). Default 20. */
const ORCHESTRATOR_MAX_ITERATIONS = parseInt(process.env.ORCHESTRATOR_MAX_ITERATIONS ?? "20", 10);

/**
 * Run the orchestrator loop. Entry point for orchestrator mode.
 *
 * The orchestrator uses the ORCHESTRATOR_MODEL (lightweight, fast) to
 * converse with the user and delegate complex work to the heavy model
 * (GLM 5.2) via chamar_planejador / chamar_programador.
 *
 * The loop is simpler than runAgentLoop — no bug hunter, no data guard,
 * no quality gate, no goal verifier. Those run inside the coder's loop
 * (via the heavy model's own reasoning + executar_comando for testing).
 *
 * Session persistence: messages are appended to the session file via the
 * shared history module (addUserMessage / addRawAssistantMessage /
 * addToolResult / addSystemMessage). The orchestrator system prompt is
 * injected once (detected via ORCHESTRATOR_PROMPT_MARKER).
 *
 * @param userInput  The user's message.
 * @param callbacks  Optional TUI callbacks (streaming, tool calls, ask user).
 * @returns          The orchestrator's final response to the user.
 */
export async function runOrchestratorLoop(
  userInput: string,
  callbacks?: OrchestratorCallbacks,
): Promise<string> {
  // FIX-ORCH-S23 (HIGH 1): Concurrency guard — mirrors `agentLoopRunning` in
  // agent.ts:2484. The orchestrator mutates module-level state (history,
  // planStore, CLAUDE_KILLER_AGENT_ID, activity tracker); two overlapping
  // runOrchestratorLoop() calls would interleave messages and corrupt the
  // conversation. Reject hard here so the second caller gets a clear error
  // instead of silently corrupting state.
  if (orchestratorLoopRunning) {
    throw new Error("Orchestrator loop already running");
  }
  orchestratorLoopRunning = true;

  try {
  if (!isOrchestratorMode()) {
    throw new Error(
      "Orchestrator mode is disabled. Set ORCHESTRATOR_MODE=1 to enable.",
    );
  }

  if (typeof userInput !== "string" || userInput.length === 0) {
    throw new Error("userInput must be a non-empty string");
  }

  // FIX-ORCH-CRIT (HIGH 4): Per-turn state cleanup — mirrors the reset block
  // at the top of runAgentLoop in agent.ts (~line 2512). runPlanner/runCoder
  // delegate to the heavy model's loop, which mutates module-level state in
  // strictQualityGate, contextInjector, selfValidation, autoTestGenerator,
  // promiseDetector, and activityTracker. Without this reset, stale state
  // from a previous orchestrator turn (or a previous coder/planner run)
  // leaks into the new turn — e.g. quality-gate blocks from turn N block
  // finishing in turn N+1, or stale "Executando tool" activity entries
  // persist in the TUI. Each user message must start from a clean slate.
  try {
    resetGateState();
    resetContextInjection();
    resetSelfValidation();
    resetAutoTestSuggestions();
    resetFalsePromiseCounter();
    clearActivity();
  } catch (cleanupErr) {
    // Defensive: a failure in any reset must NOT abort the orchestrator turn.
    log.warn(`[ORCH] state cleanup failed (continuing): ${
      cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
    }`);
  }

  // FIX-ORCH-S23 (HIGH 2): Call smartCompact BEFORE the loop starts — mirrors
  // runAgentLoop in agent.ts, which compacts at the start of each turn. Without
  // this, the orchestrator's context grows unbounded across turns (planner
  // plans, coder results, scout file dumps all accumulate). The orchestrator
  // uses a SMALL model with a smaller context window, so it overflows sooner
  // than the heavy model. Wrap in try/catch so compaction failures never abort
  // the turn — the loop can still proceed (worst case: context overflow later).
  try {
    const { smartCompact } = await import("./contextCompaction.js");
    const compactionThreshold = config.contextWindowTokens * config.contextCompactThreshold;
    await smartCompact(compactionThreshold);
  } catch (err) {
    log.debug(`[ORCH] Compaction failed: ${(err as Error).message}`);
  }

  const orchestratorModel = getOrchestratorModel();
  const cwd = process.cwd();

  // Anti-recursion: set CLAUDE_KILLER_AGENT_ID = "orchestrator".
  // The orchestrator IS the main agent (talks to user), so this ID is mostly
  // informational — but it prevents the main runAgentLoop from running
  // concurrently (its guard checks isAgentLoopRunning, not the env var, so
  // we're safe; but setting the ID is good hygiene and matches the spec).
  const prevAgentId = process.env.CLAUDE_KILLER_AGENT_ID;
  process.env.CLAUDE_KILLER_AGENT_ID = ORCHESTRATOR_AGENT_ID;

  // Plan store: passed by reference to executeOrchestratorTool so
  // chamar_planejador can store the plan and chamar_programador can read it
  // (if the model doesn't pass the plan explicitly via the `plano` arg).
  // The plan is NEVER compacted.
  const planStore: { plan: string | null } = { plan: null };

  const activityDone = pushActivity("tool", `orchestrator: ${userInput.slice(0, 50)}`);

  try {
    // Inject the orchestrator system prompt ONCE per session (idempotent).
    // We check by searching for the marker in existing system messages.
    const existingHistory = history.getHistory();
    const hasOrchestratorPrompt = existingHistory.some(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.includes(ORCHESTRATOR_PROMPT_MARKER),
    );
    if (!hasOrchestratorPrompt) {
      history.addSystemMessage(ORCHESTRATOR_SYSTEM_PROMPT);
    }

    // Add the user message (persists to session file).
    history.addUserMessage(userInput);

    let iterations = 0;

    while (iterations < ORCHESTRATOR_MAX_ITERATIONS) {
      iterations++;
      log.debug(`[ORCH] Iteração ${iterations}/${ORCHESTRATOR_MAX_ITERATIONS}, model=${orchestratorModel}`);

      const response = await chatWithModel(
        history.getHistory(),
        ORCHESTRATOR_TOOLS,
        orchestratorModel,
        false, // thinking ENABLED — orchestrator can reason about delegation
        callbacks?.onStreamStart,
        callbacks?.onToken,
        callbacks?.onThinking,
      );

      // Report usage if callback provided.
      if (response.usage && callbacks?.onUsage) {
        callbacks.onUsage(response.usage);
      }

      const choice = response.choices?.[0];
      if (!choice) {
        throw new Error("Resposta vazia do modelo (no choices)");
      }

      const msg = choice.message;

      // Sanitize malformed tool_call arguments BEFORE adding to history
      // (mirrors agent.ts handleChatResponse). Some models emit truncated
      // JSON — if we store it raw, the next API call rejects with 400.
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc?.function?.arguments && typeof tc.function.arguments === "string") {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              // Try to recover a valid JSON prefix (balanced braces).
              const rawArgs = tc.function.arguments;
              let recovered: string | null = null;
              let depth = 0;
              let inString = false;
              let escape = false;
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
                    try {
                      JSON.parse(rawArgs.slice(0, i + 1));
                      recovered = rawArgs.slice(0, i + 1);
                      break;
                    } catch { /* keep scanning */ }
                  }
                }
              }
              if (recovered) {
                log.debug(`[ORCH] Recovered valid JSON prefix from malformed args for ${tc.function.name}`);
                tc.function.arguments = recovered;
              } else {
                log.warn(`[ORCH] Malformed JSON args for ${tc.function.name} — replacing with placeholder`);
                tc.function.arguments = JSON.stringify({
                  _malformed_json: rawArgs.slice(0, 500),
                  _error: "Previous arguments were malformed JSON. Please retry with valid JSON.",
                });
              }
            }
          }
        }
      }

      // Add assistant message to history (persists to session file).
      history.addRawAssistantMessage(msg);

      // If tool calls, execute them and continue the loop.
      if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
        log.debug(`[ORCH] Model requested ${msg.tool_calls.length} tool call(s)`);

        for (const [tcIdx, tc] of msg.tool_calls.entries()) {
          // FIX-ORCH-S23 (HIGH 4): Basic tool call validation — mirrors the
          // schema check in agent.ts dispatchToolCall. Some models emit tool
          // calls with a missing or empty function.name (e.g. when they try
          // to "call" a plain text response as a tool). Without this check,
          // executeOrchestratorTool would fall through to the `default` case
          // and return "[ERROR] Tool desconhecida: undefined" — which is
          // confusing to the model. We push a clear error message to history
          // and skip, so the model can recover on the next iteration.
          if (!tc.function?.name) {
            const fallbackId = tc.id ?? `fallback_${Date.now()}`;
            const errResult = "[ERROR] Tool call missing function name";
            history.addToolResult(fallbackId, errResult);
            continue;
          }
          const toolName = tc.function?.name ?? "unknown";
          const tcId = tc.id ?? `orch-tc-${iterations}-${tcIdx}-${Date.now()}`;

          // Parse args (handle malformed JSON gracefully).
          let parsedArgs: Record<string, unknown> = {};
          try {
            const argStr = tc.function?.arguments?.trim() || "{}";
            try {
              parsedArgs = JSON.parse(argStr);
            } catch {
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
            log.warn(`[ORCH] Malformed JSON args for ${toolName}: ${parseMsg}`);
            const errResult = `[ERROR] Malformed JSON arguments: ${parseMsg}`;
            history.addToolResult(tcId, errResult);
            callbacks?.onToolResult?.(toolName, false, errResult);
            continue;
          }

          log.info(`[ORCH] Tool: ${toolName}(${JSON.stringify(parsedArgs).slice(0, 80)})`);

          // FIX-ORCH-CRIT (HIGH 6): `ok` is intentionally unused here — the
          // onToolResult callback (which used to receive it) is now fired
          // exclusively inside executeOrchestratorTool, which has the
          // authoritative ok/error status. We only need `result` to persist
          // the tool output in history.
          const { result } = await executeOrchestratorTool(
            toolName,
            parsedArgs,
            cwd,
            callbacks,
            planStore,
          );

          // Add tool result to history (persists to session file).
          // Truncate very large results to prevent context overflow.
          const forHistory = result.length > 32_000
            ? result.slice(0, 16_000) + "\n[TRUNCATED]\n" + result.slice(-16_000)
            : result;
          history.addToolResult(tcId, forHistory);

          // FIX-ORCH-CRIT (HIGH 6): Removed the duplicate onToolResult call
          // here. executeOrchestratorTool already fires onToolResult for every
          // tool (chamar_planejador, chamar_programador, executar_comando_readonly,
          // usar_scout, buscar_web, ler_url, perguntar_usuario). Firing it again
          // here caused the TUI to display each tool result TWICE. The only
          // case that doesn't fire onToolResult inside executeOrchestratorTool
          // is the "unknown tool" / "missing args" early-return paths, but
          // those are handled by the malformed-args branch above (which does
          // fire onToolResult) or return without a result to display.
        }
        continue; // recurse — model will process tool results
      }

      // No tool calls — this is the final answer.
      const finalAnswer = (msg.content ?? "").trim() || "(resposta vazia)";
      log.info(`[ORCH] Concluído em ${iterations} iterações: ${finalAnswer.length} chars`);
      return finalAnswer;
    }

    // Max iterations reached — return what we have with a notice.
    const abortMsg = `[ORCH] Limite de ${ORCHESTRATOR_MAX_ITERATIONS} iterações atingido. Respondendo com o que tenho até agora.`;
    log.warn(abortMsg);
    return abortMsg;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[ORCH] Loop falhou: ${msg}`);
    throw err;
  } finally {
    // Restore previous agent ID. If it was undefined, DELETE the env var
    // (setting process.env.X = undefined sets the STRING "undefined", which
    // is truthy and would trip the anti-recursion guard on the next call).
    if (prevAgentId === undefined) {
      delete process.env.CLAUDE_KILLER_AGENT_ID;
    } else {
      process.env.CLAUDE_KILLER_AGENT_ID = prevAgentId;
    }

    // Safety net: clear model override in case chatWithModel's own finally
    // didn't run (e.g., timeout raced the call — mirrors smallTaskAgent).
    clearModelOverride();

    activityDone();
  }
  } finally {
    // FIX-ORCH-S23 (HIGH 1): Release the re-entrancy guard so the next
    // orchestrator turn can start. MUST be in the outermost finally so a
    // thrown error doesn't permanently lock out future turns (mirrors
    // agentLoopRunning=false in agent.ts:2651).
    orchestratorLoopRunning = false;
  }
}

/**
 * Reset orchestrator state (for tests).
 * Currently no module-level mutable state — placeholder for future use.
 */
export function _resetOrchestratorForTests(): void {
  // No-op — no module-level state to reset.
}
