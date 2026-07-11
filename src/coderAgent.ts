/**
 * coderAgent.ts — Heavy model agent for writing code.
 *
 * Called by the orchestrator via chamar_programador. Uses GLM 5.2 with a
 * coding-specific system prompt to write/edit code.
 *
 * Tools: editar_arquivo, aplicar_diff, editar_multi_arquivos, desfazer_edicao,
 *        usar_scout, pensar, executar_comando (for testing), pesquisar_api
 *
 * The coder receives the task + optional plan and executes it.
 * Anti-recursion: CLAUDE_KILLER_AGENT_ID = "coder".
 * The coder CAN use scout (it's the heavy model, not a sub-agent).
 *
 * FEATURE TOGGLE: implicit — only invoked when ORCHESTRATOR_MODE=1 (the
 * orchestrator gates its own entry; the coder is reachable only via
 * chamar_programador).
 * MODEL: HEAVY_MODEL env var (default: z-ai/glm-5.2).
 *
 * READ-BEFORE-WRITE: the coder uses usar_scout for reads. The scout doesn't
 * call recordRead (it's a separate agent). To keep the read-before-write
 * gate happy, the coder's usar_scout handler calls recordRead for each file
 * in the scout's filesInspected array. This way the gate knows the coder
 * has "seen" those files (via the scout's raw output).
 */

import type OpenAI from "openai";
import { chatWithModel, clearModelOverride } from "./apiClient.js";
import type { Message } from "./apiClient.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";
import { think, THINK_TOOL_DEFINITION } from "./thinkTool.js";
import { isScoutEnabled, runScout, formatScoutResult, type ScoutArgs, type ScoutTask } from "./scoutAgent.js";
import { recordRead, checkReadBeforeWrite } from "./readBeforeWrite.js";
import { resolveAndCheckPath } from "./pathSecurity.js";
import { editFile, type EditOperation } from "./fileEdit.js";
import { aplicarDiff, desfazerEdicao, executarComando } from "./tools.js";
import { multiFileEditWithLocks, type FileEditRequest } from "./multiFileEdit.js";

// --- Config -----------------------------------------------------------------

/** Heavy model ID (default: z-ai/glm-5.2). Mirrors orchestratorAgent. */
function getHeavyModel(): string {
  return process.env.HEAVY_MODEL ?? "z-ai/glm-5.2";
}

/** Max coder iterations (tool-call rounds). Default 40 — coding is iterative. */
const CODER_MAX_ITERATIONS = parseInt(process.env.CODER_MAX_ITERATIONS ?? "40", 10);

/** Per-iteration global timeout (ms). Default 10 min — coding takes time. */
const CODER_TIMEOUT_MS = parseInt(process.env.CODER_TIMEOUT_MS ?? "600000", 10);

// --- Anti-recursion ---------------------------------------------------------

const CODER_AGENT_ID = "coder";

// --- System prompt ----------------------------------------------------------

const CODER_SYSTEM_PROMPT = `Você é um PROGRAMADOR SÊNIOR especializado em escrever código limpo e eficiente.

Sua tarefa é implementar a tarefa (possivelmente com um plano) escrevendo/editando código.

REGRAS:
1. Use usar_scout para ler arquivos antes de editar (read-before-write).
2. Use editar_arquivo ou aplicar_diff para fazer mudanças.
3. Siga o plano se fornecido — não desvie sem motivo.
4. Use pensar para raciocinar antes de mudanças complexas.
5. Use executar_comando para testar (rode testes, build, etc).
6. Seja PRECISO — faça mudanças mínimas e focadas.
7. NÃO reescreva arquivos inteiros se um diff resolve.
8. Após editar, verifique se o código compila/testa.
9. Use pesquisar_api para verificar a assinatura atual de APIs (ex: TweenService:Create, React.useState) ANTES de escrever código que as usa — APIs como as do Roblox mudam toda semana.

Quando terminar, escreva um RESUMO do que fez (arquivos editados, funções criadas, etc).`;

// --- Tool definitions -------------------------------------------------------

const CODER_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  THINK_TOOL_DEFINITION,
  {
    type: "function",
    function: {
      name: "editar_arquivo",
      description:
        "Edita um arquivo aplicando operações de search/replace. " +
        "USE ESTA TOOL para mudanças precisas. Cada edit = { search, replace, all? }. " +
        "Para criar arquivo novo, use createIfMissing=true com search vazio.",
      parameters: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "Caminho do arquivo (relativo ou absoluto)." },
          edits: {
            type: "array",
            description: "Lista de operações search/replace.",
            items: {
              type: "object",
              properties: {
                search: { type: "string", description: "Texto exato para buscar (copia do arquivo)." },
                replace: { type: "string", description: "Texto novo que substitui search." },
                all: { type: "boolean", description: "Se true, substitui TODAS ocorrências. Default: false (só a primeira)." },
              },
              required: ["search", "replace"],
            },
          },
          createIfMissing: { type: "boolean", description: "Se true, cria o arquivo se não existir." },
        },
        required: ["caminho", "edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aplicar_diff",
      description:
        "Aplica um bloco diff SEARCH/REPLACE a um arquivo. " +
        "Formato do bloco_diff:\n" +
        "<<<<<<< SEARCH\n[texto antigo]\n=======\n[texto novo]\n>>>>>>> REPLACE",
      parameters: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "Caminho do arquivo." },
          bloco_diff: { type: "string", description: "Bloco diff no formato SEARCH/REPLACE." },
        },
        required: ["caminho", "bloco_diff"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_multi_arquivos",
      description:
        "Edita múltiplos arquivos atomicamente. Se qualquer edit falhar, TODOS são revertidos. " +
        "Use para mudanças coordinated que tocam vários arquivos.",
      parameters: {
        type: "object",
        properties: {
          arquivos: {
            type: "array",
            description: "Lista de arquivos para editar.",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string", description: "Caminho do arquivo." },
                edits: {
                  type: "array",
                  description: "Operações search/replace para este arquivo.",
                  items: {
                    type: "object",
                    properties: {
                      search: { type: "string" },
                      replace: { type: "string" },
                      all: { type: "boolean" },
                    },
                    required: ["search", "replace"],
                  },
                },
                createIfMissing: { type: "boolean" },
              },
              required: ["filePath", "edits"],
            },
          },
        },
        required: ["arquivos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "desfazer_edicao",
      description: "Desfaz a edição mais recente de um arquivo (restaura backup).",
      parameters: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "Caminho do arquivo para restaurar." },
        },
        required: ["caminho"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "usar_scout",
      description:
        "Delega leituras e buscas de código para um modelo ultra-rápido. " +
        "USE SEMPRE antes de editar — ler o arquivo atual é OBRIGATÓRIO. " +
        "O scout retorna o conteúdo RAW dos arquivos.",
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
    type: "function" as const,
    function: {
      name: "pesquisar_api",
      description: "Pesquisa a documentação de uma API específica (ex: TweenService:Create, React.useState, DataStoreService). Retorna assinatura, exemplos, e melhores práticas. Útil para planejar como usar uma API que você não conhece bem.",
      parameters: {
        type: "object",
        properties: {
          apiName: { type: "string", description: "Nome da API (ex: 'TweenService:Create', 'FindFirstChild', 'React.useState')" },
          language: { type: "string", description: "Linguagem/plataforma (ex: 'roblox', 'typescript', 'python')" },
          context: { type: "string", description: "Contexto: o que você está tentando fazer (opcional)" },
        },
        required: ["apiName", "language"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_comando",
      description:
        "Executa um comando shell e retorna stdout+stderr. Use para testar código (npm test, npx tsc, build, etc). " +
        "Timeout: 60s. Output truncado em 512KB.",
      parameters: {
        type: "object",
        properties: {
          comando: { type: "string", description: "O comando shell para executar." },
          cwd: { type: "string", description: "Diretório base (opcional)." },
        },
        required: ["comando"],
      },
    },
  },
];

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
 * Execute a coder tool call. Returns the result string + success flag.
 *
 * The coder's tools include edit tools (editar_arquivo, aplicar_diff,
 * editar_multi_arquivos, desfazer_edicao) + read tools (usar_scout) +
 * pensar + executar_comando.
 *
 * Anti-recursion for usar_scout: the coder keeps CLAUDE_KILLER_AGENT_ID = "coder"
 * set while calling runScout — the scout's anti-recursion guard only blocks
 * "scout"/"sub-agent"/"small-task-agent", so "coder" is allowed (FIX-ORCH-S23).
 *
 * Read-before-write: when usar_scout returns, call recordRead for each file
 * the scout inspected. This satisfies the read-before-write gate so the
 * coder can subsequently edit those files.
 */
async function executeCoderTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  callbacks?: CoderCallbacks,
): Promise<{ result: string; ok: boolean }> {
  try {
    switch (toolName) {
      case "pensar": {
        const pensamento = typeof args.pensamento === "string" ? args.pensamento : "";
        if (!pensamento) return { result: "[ERROR] pensamento vazio", ok: false };
        const result = await think({
          pensamento,
          categoria: typeof args.categoria === "string" ? args.categoria : undefined,
        });
        return { result: result.message, ok: true };
      }

      case "editar_arquivo": {
        const caminho = asString(args.caminho);
        if (!caminho) return { result: "[ERROR] caminho vazio", ok: false };
        // FIX-ORCH-S1 (CRITICAL 1): path traversal protection.
        try {
          resolveAndCheckPath(caminho, process.cwd());
        } catch (secErr) {
          const msg = secErr instanceof Error ? secErr.message : String(secErr);
          return { result: `[ERROR] ${msg}`, ok: false };
        }
        // FIX-ORCH-S1 (CRITICAL 2): read-before-write gate.
        const rbwCheck = checkReadBeforeWrite("editar_arquivo", args);
        if (!rbwCheck.allowed) {
          return {
            result: `[ERROR] Read-before-write: você precisa ler o arquivo antes de editá-lo. Use usar_scout para ler o arquivo primeiro.`,
            ok: false,
          };
        }
        const rawEdits = args.edits;
        if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
          return { result: "[ERROR] edits deve ser um array não-vazio", ok: false };
        }
        const edits: EditOperation[] = rawEdits.map((e: any) => ({
          search: typeof e.search === "string" ? e.search : "",
          replace: typeof e.replace === "string" ? e.replace : "",
          all: e.all === true,
        }));
        const createIfMissing = args.createIfMissing === true;
        const result = await editFile(caminho, edits, { createIfMissing });
        return { result, ok: !result.startsWith("[ERROR]") };
      }

      case "aplicar_diff": {
        const caminho = asString(args.caminho);
        if (!caminho) return { result: "[ERROR] caminho vazio", ok: false };
        // FIX-ORCH-S1 (CRITICAL 1): path traversal protection.
        try {
          resolveAndCheckPath(caminho, process.cwd());
        } catch (secErr) {
          const msg = secErr instanceof Error ? secErr.message : String(secErr);
          return { result: `[ERROR] ${msg}`, ok: false };
        }
        // FIX-ORCH-S1 (CRITICAL 2): read-before-write gate.
        const rbwCheck = checkReadBeforeWrite("aplicar_diff", args);
        if (!rbwCheck.allowed) {
          return {
            result: `[ERROR] Read-before-write: você precisa ler o arquivo antes de editá-lo. Use usar_scout para ler o arquivo primeiro.`,
            ok: false,
          };
        }
        const bloco_diff = asString(args.bloco_diff);
        if (!bloco_diff) return { result: "[ERROR] bloco_diff vazio", ok: false };
        const result = await aplicarDiff({ caminho, bloco_diff });
        return { result: result.toolMessage, ok: result.written };
      }

      case "editar_multi_arquivos": {
        const rawArquivos = args.arquivos ?? args.requests;
        if (!Array.isArray(rawArquivos) || rawArquivos.length === 0) {
          return { result: "[ERROR] arquivos deve ser um array não-vazio", ok: false };
        }
        // FIX-ORCH-S1 (CRITICAL 1): path traversal protection for every file.
        // We resolve each requested filePath against the project cwd BEFORE
        // delegating to multiFileEditWithLocks. If any path escapes, reject.
        try {
          for (const a of rawArquivos) {
            const fp = String((a as any)?.filePath ?? (a as any)?.caminho ?? "");
            if (fp) resolveAndCheckPath(fp, process.cwd());
          }
        } catch (secErr) {
          const msg = secErr instanceof Error ? secErr.message : String(secErr);
          return { result: `[ERROR] ${msg}`, ok: false };
        }
        // FIX-ORCH-S1 (CRITICAL 2): read-before-write gate. checkReadBeforeWrite
        // expects the `requests` field shape; normalize `arquivos` → `requests`.
        const rbwArgs = { ...args, requests: rawArquivos };
        const rbwCheck = checkReadBeforeWrite("editar_multi_arquivos", rbwArgs);
        if (!rbwCheck.allowed) {
          return {
            result: `[ERROR] Read-before-write: você precisa ler o arquivo antes de editá-lo. Use usar_scout para ler o arquivo primeiro.`,
            ok: false,
          };
        }
        const requests: FileEditRequest[] = rawArquivos.map((a: any) => ({
          filePath: String(a.filePath ?? a.caminho ?? ""),
          edits: Array.isArray(a.edits)
            ? a.edits.map((e: any) => ({
                search: typeof e.search === "string" ? e.search : "",
                replace: typeof e.replace === "string" ? e.replace : "",
                all: e.all === true,
              }))
            : [],
          createIfMissing: a.createIfMissing === true,
        })).filter((r: FileEditRequest) => r.filePath);
        if (requests.length === 0) {
          return { result: "[ERROR] Nenhum arquivo válido", ok: false };
        }
        const result = await multiFileEditWithLocks(requests);
        if (result.success) {
          return {
            result: `[SUCCESS] ${result.filesEdited.length} arquivos editados: ${result.filesEdited.join(", ")}`,
            ok: true,
          };
        }
        const errors = result.errors.map((e: { file: string; error: string }) => `  ${e.file}: ${e.error}`).join("\n");
        return {
          result: `[ERROR] Falha${result.rolledBack ? " (rollback executado)" : ""}:\n${errors}`,
          ok: false,
        };
      }

      case "desfazer_edicao": {
        const caminho = asString(args.caminho);
        if (!caminho) return { result: "[ERROR] caminho vazio", ok: false };
        // FIX-ORCH-S1 (CRITICAL 1): path traversal protection.
        try {
          resolveAndCheckPath(caminho, process.cwd());
        } catch (secErr) {
          const msg = secErr instanceof Error ? secErr.message : String(secErr);
          return { result: `[ERROR] ${msg}`, ok: false };
        }
        // FIX-ORCH-S1 (CRITICAL 2): read-before-write gate. desfazer_edicao
        // restores a backup (writes to disk), so it's subject to the same
        // read-before-write discipline as the other edit tools. NOTE:
        // checkReadBeforeWrite currently treats desfazer_edicao as a no-op
        // (not in WRITE_TOOLS), but we call it for consistency + future-proofing
        // — if WRITE_TOOLS is extended to include undo, the gate activates.
        const rbwCheck = checkReadBeforeWrite("desfazer_edicao", args);
        if (!rbwCheck.allowed) {
          return {
            result: `[ERROR] Read-before-write: você precisa ler o arquivo antes de editá-lo. Use usar_scout para ler o arquivo primeiro.`,
            ok: false,
          };
        }
        const result = desfazerEdicao({ caminho });
        return { result, ok: !result.includes("[ERROR]") && !result.toLowerCase().includes("não") };
      }

      case "usar_scout": {
        if (!isScoutEnabled()) {
          return {
            result: "[ERROR] Scout desabilitado. Set SCOUT_ENABLED=1.",
            ok: false,
          };
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
        const scoutArgs: ScoutArgs = {
          objective,
          tasks,
          cwd,
          maxToolCalls: maxCalls,
          onToolCall: callbacks?.onToolCall,
          onToolResult: callbacks?.onToolResult,
        };
        // FIX-ORCH-S23 (HIGH 3): Removed the save/clear/restore of
        // CLAUDE_KILLER_AGENT_ID around runScout. The scout's anti-recursion
        // guard (agent.ts) only blocks "scout"/"sub-agent"/"small-task-agent"
        // — "coder" is explicitly ALLOWED. Clearing the ID was
        // defense-in-depth but caused a subtle bug: if an error threw between
        // the `delete` and the `finally`, the env var stayed deleted and the
        // coder's own anti-recursion state was lost. Keeping the ID set is
        // both correct (the guard allows it) and safer (no env var churn).
        const scoutResult = await runScout(scoutArgs);
        if (scoutResult === null) {
          return { result: "[SCOUT] Desabilitado ou falhou ao iniciar.", ok: false };
        }
        // Record reads for the read-before-write gate: every file the scout
        // inspected counts as "read" by the coder. Without this, the coder's
        // subsequent editar_arquivo / aplicar_diff would be blocked.
        for (const f of scoutResult.filesInspected) {
          try { recordRead("ler_arquivo", f); } catch { /* ignore */ }
        }
        if (!scoutResult.completed) {
          return {
            result: `[SCOUT FAILED] ${scoutResult.error ?? "unknown"}`,
            ok: false,
          };
        }
        return { result: formatScoutResult(scoutResult), ok: true };
      }

      case "executar_comando": {
        const comando = asString(args.comando);
        if (!comando) return { result: "[ERROR] comando vazio", ok: false };
        const effectiveCwd = typeof args.cwd === "string" && args.cwd.trim() !== ""
          ? args.cwd
          : cwd;
        const result = await executarComando({
          comando,
          cwd: effectiveCwd,
          timeoutMs: 60000,
          background: false,
        });
        return {
          result: typeof result === "string" ? result : String(result),
          ok: !result.startsWith("[ERROR]"),
        };
      }

      case "pesquisar_api": {
        const apiName = String(args.apiName ?? "");
        const language = String(args.language ?? "");
        if (!apiName || !language) {
          return { result: "[ERROR] apiName and language are required", ok: false };
        }
        const { researchApi } = await import("./apiResearcher.js");
        const result = await researchApi({
          apiName,
          language,
          context: typeof args.context === "string" ? args.context : undefined,
        });
        if ("error" in result) {
          return {
            result: `[ERROR] API research failed: ${result.error}`,
            ok: false,
          };
        }
        const examples = result.examples ?? [];
        return {
          result:
            `API: ${result.apiName} (${result.language})\n` +
            `Signature: ${result.signature}\n` +
            `Summary: ${result.summary}\n\n` +
            `Examples:\n${examples.join("\n")}`,
          ok: true,
        };
      }

      default:
        return { result: `[ERROR] Tool desconhecida: ${toolName}`, ok: false };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { result: `[ERROR] ${msg}`, ok: false };
  }
}

// --- Public API ------------------------------------------------------------

export interface CoderCallbacks {
  /** Called before each tool call (for TUI display). */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /** Called after each tool call completes. */
  onToolResult?: (toolName: string, ok: boolean, resultStr: string) => void;
}

export interface CoderResult {
  /** The coder's final summary (what it did, files edited, etc). */
  result: string;
  /** Whether the coder completed successfully. */
  success: boolean;
  /** Error message if success=false. */
  error?: string;
  /** Time taken in ms. */
  elapsedMs: number;
  /** Number of tool calls made. */
  toolCallsMade: number;
}

/**
 * Run the coder agent to implement a task (optionally following a plan).
 *
 * The coder uses the HEAVY_MODEL (GLM 5.2) with edit tools + scout + pensar +
 * executar_comando. It receives the task and an optional plan (from the
 * planner), executes the plan, and returns a summary of what it did.
 *
 * The summary is returned to the orchestrator, which may compact it (if
 * >500 chars) before adding to its context.
 *
 * @param task       The task description (what to implement).
 * @param plan       Optional structured plan from the planner. Passed verbatim.
 * @param callbacks  Optional TUI callbacks.
 * @returns          The result summary + status.
 */
export async function runCoder(
  task: string,
  plan: string | null,
  callbacks?: CoderCallbacks,
): Promise<CoderResult> {
  const start = Date.now();
  const heavyModel = getHeavyModel();

  if (typeof task !== "string" || task.length === 0) {
    return {
      result: "",
      success: false,
      error: "Invalid task (must be non-empty string)",
      elapsedMs: 0,
      toolCallsMade: 0,
    };
  }

  // Anti-recursion guard: coder can't be called from inside another coder.
  if (process.env.CLAUDE_KILLER_AGENT_ID === CODER_AGENT_ID) {
    return {
      result: "",
      success: false,
      error: "Coder não pode ser chamado de dentro de outro coder (recursão)",
      elapsedMs: 0,
      toolCallsMade: 0,
    };
  }

  const cwd = process.cwd();
  const shortTask = task.length > 60 ? task.slice(0, 59) + "…" : task;
  const activityDone = pushActivity("subagent", `coder: ${shortTask}`);

  // Set anti-recursion env var (preserve previous to restore in finally).
  const prevAgentId = process.env.CLAUDE_KILLER_AGENT_ID;
  process.env.CLAUDE_KILLER_AGENT_ID = CODER_AGENT_ID;

  let toolCallsMade = 0;

  try {
    const planSection = plan && plan.length > 0
      ? `\n\n--- PLANO (siga este plano) ---\n${plan}\n--- FIM DO PLANO ---\n`
      : "";

    const messages: Message[] = [
      { role: "system", content: CODER_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Working directory: ${cwd}\n\n` +
          `Tarefa: ${task}${planSection}\n\n` +
          `Use usar_scout para ler arquivos antes de editar. ` +
          `Use editar_arquivo ou aplicar_diff para fazer mudanças. ` +
          `Use executar_comando para testar. ` +
          `Quando terminar, escreva um RESUMO do que fez.`,
      },
    ];

    const deadline = start + CODER_TIMEOUT_MS;

    for (let iter = 0; iter < CODER_MAX_ITERATIONS; iter++) {
      if (Date.now() > deadline) {
        throw new Error(`Coder timeout após ${CODER_TIMEOUT_MS}ms`);
      }

      log.debug(`[CODER] Iteração ${iter + 1}/${CODER_MAX_ITERATIONS}, model=${heavyModel}`);

      const response = await chatWithModel(
        messages,
        CODER_TOOLS,
        heavyModel,
        false, // thinking ENABLED — coder needs reasoning
      );

      const choice = response.choices?.[0];
      if (!choice) {
        throw new Error("Resposta vazia do modelo");
      }

      const msg = choice.message;

      // Add assistant message to local history.
      messages.push({
        role: "assistant",
        content: msg.content || "(executando tools)",
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      });

      // If tool calls, execute them and continue the loop.
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          toolCallsMade++;
          const toolName = tc.function?.name ?? "unknown";
          const tcId = tc.id ?? `coder-tc-${iter}-${toolCallsMade}-${Date.now()}`;

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
            log.warn(`[CODER] Malformed JSON args for ${toolName}: ${parseMsg}`);
            const errResult = `[ERROR] Malformed JSON arguments: ${parseMsg}`;
            messages.push({ role: "tool", tool_call_id: tcId, content: errResult });
            callbacks?.onToolResult?.(toolName, false, errResult);
            continue;
          }

          log.info(`[CODER] Tool: ${toolName}(${JSON.stringify(parsedArgs).slice(0, 80)})`);
          callbacks?.onToolCall?.(toolName, parsedArgs);

          const { result, ok } = await executeCoderTool(toolName, parsedArgs, cwd, callbacks);

          // Truncate very large results to prevent context overflow.
          const forModel = result.length > 32_000
            ? result.slice(0, 16_000) + "\n[TRUNCATED]\n" + result.slice(-16_000)
            : result;
          const forTui = result.length > 4000
            ? result.slice(0, 2000) + "\n[TRUNCATED]\n" + result.slice(-2000)
            : result;

          callbacks?.onToolResult?.(toolName, ok, forTui);

          messages.push({
            role: "tool",
            tool_call_id: tcId,
            content: forModel,
          });
        }
        continue; // recurse — model will process tool results
      }

      // No tool calls — this is the final summary.
      const summary = (msg.content ?? "").trim();
      if (!summary) {
        throw new Error("Coder não retornou um resumo");
      }

      const result: CoderResult = {
        result: summary,
        success: true,
        elapsedMs: Date.now() - start,
        toolCallsMade,
      };
      log.info(`[CODER] Concluído: ${toolCallsMade} tool calls, ${summary.length} chars`);
      return result;
    }

    // Max iterations reached
    throw new Error(`Coder excedeu ${CODER_MAX_ITERATIONS} iterações`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[CODER] Falhou: ${msg}`);
    return {
      result: "",
      success: false,
      error: msg,
      elapsedMs: Date.now() - start,
      toolCallsMade,
    };
  } finally {
    // Restore previous agent ID. If it was undefined, DELETE the env var.
    if (prevAgentId === undefined) {
      delete process.env.CLAUDE_KILLER_AGENT_ID;
    } else {
      process.env.CLAUDE_KILLER_AGENT_ID = prevAgentId;
    }

    // Safety net: clear model override (mirrors smallTaskAgent pattern).
    clearModelOverride();

    activityDone();
  }
}

/**
 * Reset coder state (for tests).
 * Currently no module-level mutable state — placeholder for future use.
 */
export function _resetCoderForTests(): void {
  // No-op — no module-level state to reset.
}
