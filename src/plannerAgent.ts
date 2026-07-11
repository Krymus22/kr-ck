/**
 * plannerAgent.ts — Heavy model agent for planning.
 *
 * Called by the orchestrator via chamar_planejador. Uses GLM 5.2 with a
 * planning-specific system prompt to produce high-quality structured plans.
 *
 * Tools: pensar, buscar_web, ler_url, usar_scout, pesquisar_api
 * (NO edit tools — planner only PLANS, doesn't code)
 *
 * The plan is returned to the orchestrator RAW (never compacted).
 *
 * FEATURE TOGGLE: implicit — only invoked when ORCHESTRATOR_MODE=1 (the
 * orchestrator gates its own entry; the planner is reachable only via
 * chamar_planejador).
 * MODEL: HEAVY_MODEL env var (default: z-ai/glm-5.2).
 *
 * ANTI-RECURSION: CLAUDE_KILLER_AGENT_ID = "planner". The planner is a
 * heavy model and is ALLOWED to call usar_scout (the scout's anti-recursion
 * guard only blocks "scout" / "sub-agent" / "small-task-agent"). The
 * planner sets its own ID, so the scout's check (in agent.ts) lets it
 * through.
 *
 * FIX-ORCH-S1 (CRITICAL 4): previously the planner CLEARED
 * CLAUDE_KILLER_AGENT_ID before calling runScout (defense-in-depth against
 * any future check that blocks on ANY non-empty ID). But that defeated the
 * whole point of the anti-recursion guard — a (hypothetical) recursive
 * call path could now slip through. We no longer clear it: the scout's
 * existing check in agent.ts already permits "planner", so the clear was
 * unnecessary AND harmful (it disabled the guard for the duration of the
 * scout call).
 */

import type OpenAI from "openai";
import { chatWithModel, clearModelOverride } from "./apiClient.js";
import type { Message } from "./apiClient.js";
import * as log from "./logger.js";
import { pushActivity } from "./activityTracker.js";
import { think, THINK_TOOL_DEFINITION } from "./thinkTool.js";
import { isScoutEnabled, runScout, formatScoutResult, type ScoutArgs, type ScoutTask } from "./scoutAgent.js";
// FIX-MED-PC (LOW 10): removed dead imports `resolveAndCheckPath` and
// `executarComando` — the planner is read-only (no executarComando) and
// pathSecurity's resolveAndCheckPath is not used anywhere in this module.

// --- Config -----------------------------------------------------------------

/** Heavy model ID (default: z-ai/glm-5.2). Mirrors orchestratorAgent. */
function getHeavyModel(): string {
  return process.env.HEAVY_MODEL ?? "z-ai/glm-5.2";
}

/** Max planner iterations (tool-call rounds). Prevents runaway loops. */
const PLANNER_MAX_ITERATIONS = parseInt(process.env.PLANNER_MAX_ITERATIONS ?? "20", 10);

/**
 * Total deadline (ms). Default 5 min — heavy model is slow.
 *
 * FIX-MED-PC (MED 4): previous comment said "per-iteration" but this is the
 * TOTAL deadline checked via `Date.now() > deadline` at the top of each
 * iteration — not a per-call timeout.
 */
const PLANNER_TIMEOUT_MS = parseInt(process.env.PLANNER_TIMEOUT_MS ?? "300000", 10);

// --- Anti-recursion ---------------------------------------------------------

const PLANNER_AGENT_ID = "planner";

// --- System prompt ----------------------------------------------------------

const PLANNER_SYSTEM_PROMPT = `Você é um ARQUITETO SÊNIOR especializado em planejamento de software.

Sua tarefa é criar um PLANO ESTRUTURADO para a tarefa do usuário.

REGRAS:
1. Use as tools (pensar, buscar_web, ler_url, usar_scout, pesquisar_api) para coletar contexto.
2. Crie um plano com passos numbered, claros e específicos.
3. Considere edge cases, dependências e riscos.
4. O plano deve ser executável por outro agente — seja específico sobre arquivos, funções, e mudanças.
5. NÃO escreva código — apenas planeje.
6. NÃO edite arquivos — apenas leia e analise.
7. Use pesquisar_api para verificar a assinatura atual de APIs (ex: TweenService:Create, React.useState) antes de planejar usá-las — útil para APIs que mudam frequentemente.

FORMATO DO PLANO:
[PLAN - N steps]
1. <passo específico com arquivo e mudança>
2. <passo específico>
...
N. <passo final>

Seja ESPECÍFICO: cite nomes de arquivos, funções, e mudanças exatas.`;

// --- Tool definitions -------------------------------------------------------

/**
 * Planner tools: pensar (structured thinking), buscar_web, ler_url, usar_scout.
 *
 * NO edit tools — the planner only PLANS. It can read/search (via scout) and
 * think, but never writes code. This enforces the orchestrator architecture's
 * separation of concerns: planner plans, coder codes.
 */
const PLANNER_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  THINK_TOOL_DEFINITION,
  {
    type: "function",
    function: {
      name: "buscar_web",
      description: "Busca na web por informações. Retorna títulos, URLs e snippets. Útil para pesquisar documentação, exemplos de código, ou informações atuais.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Termo de busca" },
          maxResults: { type: "number", description: "Máximo de resultados (default: 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_url",
      description: "Lê o conteúdo de uma URL. Extrai texto de páginas web (remove HTML). Útil para ler documentação ou artigos.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL para ler" },
          maxLength: { type: "number", description: "Tamanho máximo do conteúdo (default: 10000 chars)" },
        },
        required: ["url"],
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
        "O scout retorna o conteúdo RAW dos arquivos (não resumido).",
      parameters: {
        type: "object",
        properties: {
          objetivo: {
            type: "string",
            description: "O que você precisa ler/buscar e por quê.",
          },
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
                descricao: {
                  type: "string",
                  description: "Descrição específica da tarefa (ex: 'ler src/foo.ts', 'buscar todas as chamadas a bar()').",
                },
              },
              required: ["descricao"],
            },
          },
          max_tool_calls: {
            type: "number",
            description: "Max tool calls (default 50, max 100).",
          },
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
 * Execute a planner tool call. Returns the result string + success flag.
 *
 * The planner's tools are read-only + pensar + scout. It CANNOT edit files.
 *
 * FIX-ORCH-S1 (CRITICAL 4): we no longer clear CLAUDE_KILLER_AGENT_ID before
 * calling runScout. The scout's anti-recursion check in agent.ts already
 * permits "planner" (it only blocks "scout"/"sub-agent"/"small-task-agent"),
 * so the clear was unnecessary. Worse, clearing defeated the anti-recursion
 * guard for the duration of the scout call — if any future code path
 * re-entered the planner while the env var was deleted, it would slip past
 * the guard. Keeping "planner" set preserves the guard end-to-end.
 */
async function executePlannerTool(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  callbacks?: PlannerCallbacks,
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
      case "buscar_web": {
        const query = asString(args.query);
        if (!query) return { result: "[ERROR] query vazia", ok: false };
        // FIX-LOW-ALL (S2-2 LOW 9): range-validate maxResults to [1, 20] —
        // defends against absurd model-supplied values (0, -5, 1000) that
        // would either return nothing or hammer the search API.
        const rawMax = typeof args.maxResults === "number" ? args.maxResults : 5;
        const maxResults = Math.max(1, Math.min(20, rawMax));
        const { webSearch } = await import("./apiResearcher.js");
        const results = await webSearch(query, maxResults);
        if (results.length === 0) return { result: "Nenhum resultado encontrado.", ok: true };
        const formatted = results.map((r: { url: string; title: string; snippet: string }, i: number) =>
          `${i + 1}. ${r.title ?? "Sem título"}\n   URL: ${r.url}\n   ${r.snippet ?? ""}`,
        ).join("\n\n");
        return { result: formatted, ok: true };
      }
      case "ler_url": {
        const url = asString(args.url);
        if (!url) return { result: "[ERROR] url vazia", ok: false };
        // FIX-MED-PC (MED 5): respect user's maxLength first; apply 32K only
        // as an ABSOLUTE CAP. Previously the loop's 32K middle-cut truncation
        // (runPlanner) silently overrode a user-chosen maxLength > 32K,
        // discarding the user's "first N chars" intent. Now ler_url handles
        // its own truncation here (min(userMaxLength, 32K)) and the loop
        // skips 32K truncation for ler_url results.
        // FIX-LOW-ALL (S2-2 LOW 9): range-validate maxLength to [100, 50000]
        // BEFORE applying the 32K cap — defends against absurd model-supplied
        // values (0, -5, 10_000_000) that would either return nothing or
        // overflow the model's context window. Default 10000 stays in range.
        const rawUserMax = typeof args.maxLength === "number" ? args.maxLength : 10000;
        const userMaxLength = Math.max(100, Math.min(50000, rawUserMax));
        const effectiveMax = Math.min(userMaxLength, 32_000);
        const { webRead } = await import("./apiResearcher.js");
        const content = await webRead(url);
        const truncated = content.length > effectiveMax
          ? content.slice(0, effectiveMax) + "\n[TRUNCATED]"
          : content;
        return { result: truncated || "[ERROR] Conteúdo vazio", ok: !!content };
      }
      case "usar_scout": {
        // Feature gate
        if (!isScoutEnabled()) {
          return {
            result: "[ERROR] Scout desabilitado. Set SCOUT_ENABLED=1. Use ler arquivos via outra estratégia.",
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
        // FIX-LOW-ALL (S2-2 LOW 8): clamp max_tool_calls to [1, 100] —
        // values >100 would let the scout run unbounded (its own loop cap is
        // 100), and values <=0 would be nonsensical. The tool schema says
        // "max 100" but the schema is advisory — enforce programmatically.
        const rawCalls = typeof args.max_tool_calls === "number" ? args.max_tool_calls : 50;
        const maxCalls = Math.max(1, Math.min(100, rawCalls));
        const scoutArgs: ScoutArgs = {
          objective,
          tasks,
          cwd,
          maxToolCalls: maxCalls,
          onToolCall: callbacks?.onToolCall,
          onToolResult: callbacks?.onToolResult,
        };
        // FIX-ORCH-S1 (CRITICAL 4): Do NOT clear CLAUDE_KILLER_AGENT_ID here.
        // The scout's anti-recursion check in agent.ts already allows
        // "planner" (it only blocks "scout"/"sub-agent"/"small-task-agent").
        // Clearing the env var defeated the anti-recursion guard for the
        // duration of the scout call. See module-level doc for full rationale.
        const scoutResult = await runScout(scoutArgs);
        if (scoutResult === null) {
          return { result: "[SCOUT] Desabilitado ou falhou ao iniciar.", ok: false };
        }
        if (!scoutResult.completed) {
          return {
            result: `[SCOUT FAILED] ${scoutResult.error ?? "unknown"}`,
            ok: false,
          };
        }
        return { result: formatScoutResult(scoutResult), ok: true };
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

export interface PlannerCallbacks {
  /** Called when the model starts streaming a response. */
  onStreamStart?: () => void;
  /** Called for each token streamed (for TUI rendering). */
  onToken?: (token: string) => void;
  /** Called when the model is "thinking" (reasoning tokens). */
  onThinking?: () => void;
  /**
   * Called with token usage stats after each model call.
   * FIX-MED-ORCH (S2-8 HIGH / S1-8 HIGH): planner usage was never reported,
   * making token-cost attribution impossible. The orchestrator forwards this
   * callback through so the TUI / telemetry sees heavy-model token usage.
   */
  onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  /** Called before each tool call (for TUI display). */
  onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
  /** Called after each tool call completes. */
  onToolResult?: (toolName: string, ok: boolean, resultStr: string) => void;
}

export interface PlannerResult {
  /** The structured plan (raw text). Never compacted — passed to coder as-is. */
  plan: string;
  /** Whether the planner completed successfully. */
  success: boolean;
  /** Error message if success=false. */
  error?: string;
  /** Time taken in ms. */
  elapsedMs: number;
  /** Number of tool calls made. */
  toolCallsMade: number;
}

/**
 * Run the planner agent to produce a structured plan for a task.
 *
 * The planner uses the HEAVY_MODEL (GLM 5.2) with read-only tools + pensar +
 * scout. It returns the plan as raw text — the orchestrator stores it
 * separately and never compacts it (it's passed verbatim to the coder via
 * chamar_programador).
 *
 * @param task       The task description (what the user wants done).
 * @param callbacks  Optional TUI callbacks.
 * @returns          The plan + status.
 */
export async function runPlanner(
  task: string,
  callbacks?: PlannerCallbacks,
): Promise<PlannerResult> {
  const start = Date.now();
  const heavyModel = getHeavyModel();

  if (typeof task !== "string" || task.length === 0) {
    // FIX-LOW-ALL (S2-2 LOW 11): report actual elapsed time, not 0 — the
    // `start` was captured at function entry, so even an immediate early
    // return took some nanoseconds. Reporting 0 misled callers/tests.
    return {
      plan: "",
      success: false,
      error: "Invalid task (must be non-empty string)",
      elapsedMs: Date.now() - start,
      toolCallsMade: 0,
    };
  }

  // Anti-recursion guard: planner can't be called from inside another planner
  // (would deadlock via shared modelOverride state).
  if (process.env.CLAUDE_KILLER_AGENT_ID === PLANNER_AGENT_ID) {
    // FIX-LOW-ALL (S2-2 LOW 11): report actual elapsed time (see above).
    return {
      plan: "",
      success: false,
      error: "Planner não pode ser chamado de dentro de outro planner (recursão)",
      elapsedMs: Date.now() - start,
      toolCallsMade: 0,
    };
  }

  const cwd = process.cwd();
  const shortTask = task.length > 60 ? task.slice(0, 59) + "…" : task;
  const activityDone = pushActivity("subagent", `planner: ${shortTask}`);

  // Set anti-recursion env var (preserve previous to restore in finally).
  const prevAgentId = process.env.CLAUDE_KILLER_AGENT_ID;
  process.env.CLAUDE_KILLER_AGENT_ID = PLANNER_AGENT_ID;

  let toolCallsMade = 0;

  try {
    // FIX-MED-SEC (S3-6 HIGH 7): The planner's internal conversation is
    // EPHEMERAL BY DESIGN. The `messages` array below is a LOCAL variable —
    // it is NOT appended to the shared `history` module (which the main
    // agent / orchestrator uses) and is NOT persisted to the session file.
    // When runPlanner returns, `messages` goes out of scope and is GC'd.
    // This is intentional:
    //   1. The planner's system prompt + scratch reasoning (tool calls,
    //      intermediate thoughts) are an internal implementation detail of
    //      planning — they should NOT pollute the orchestrator's context
    //      (the orchestrator only needs the final PLAN, which is returned
    //      as a string).
    //   2. Persisting them would balloon the session file (a planner turn
    //      can do 10+ tool calls reading files via scout) and confuse the
    //      user when they resume the session (they'd see planner-internal
    //      tool calls mixed with the orchestrator's tool calls).
    //   3. The orchestrator stores the FINAL plan in `planStore` and passes
    //      it verbatim to chamar_programador — that's the only artifact the
    //      orchestrator needs to remember.
    // If a future feature needs to expose planner internals (e.g. for
    // debugging), it should write them to a separate log file, NOT to the
    // shared history.
    const messages: Message[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Working directory: ${cwd}\n\n` +
          `Tarefa: ${task}\n\n` +
          `Use as tools para coletar contexto (usar_scout para ler arquivos, buscar_web para pesquisar). ` +
          `Quando tiver contexto suficiente, produza o PLANO no formato especificado.`,
      },
    ];

    const deadline = start + PLANNER_TIMEOUT_MS;

    for (let iter = 0; iter < PLANNER_MAX_ITERATIONS; iter++) {
      if (Date.now() > deadline) {
        throw new Error(`Planner timeout após ${PLANNER_TIMEOUT_MS}ms`);
      }

      log.debug(`[PLANNER] Iteração ${iter + 1}/${PLANNER_MAX_ITERATIONS}, model=${heavyModel}`);

      const response = await chatWithModel(
        messages,
        PLANNER_TOOLS,
        heavyModel,
        false, // thinking ENABLED — planner needs reasoning
        // FIX-MED-ORCH (S1-1 MED 9 / S2-6): forward streaming callbacks so
        // the TUI isn't silent during heavy-model work. Without these, the
        // user sees no token streaming while the planner is thinking.
        callbacks?.onStreamStart,
        callbacks?.onToken,
        callbacks?.onThinking,
      );

      // FIX-MED-ORCH (S2-8 HIGH / S1-8 HIGH): report planner token usage.
      if (response.usage && callbacks?.onUsage) {
        callbacks.onUsage(response.usage);
      }

      const choice = response.choices?.[0];
      if (!choice) {
        throw new Error("Resposta vazia do modelo");
      }

      // FIX-MED-PC (LOW 12): null-check choice.message before accessing
      // content/tool_calls. Some API responses return a choice without a
      // `message` field (malformed/empty); without this guard the next
      // line would throw TypeError on `msg.content`.
      if (!choice?.message) break;

      const msg = choice.message;

      // Add assistant message to local history (preserve tool_calls + content).
      // Some APIs reject empty assistant content — use a placeholder if empty.
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
          // FIX-MED-PC (LOW 7): use || instead of ?? so an EMPTY-STRING tc.id
          // (some APIs return "") also falls back to the generated id. An
          // empty tool_call_id can confuse the API on the next turn.
          const tcId = tc.id || `planner-tc-${iter}-${toolCallsMade}-${Date.now()}`;

          // Parse args (handle malformed JSON gracefully — mirrors scout pattern).
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
            log.warn(`[PLANNER] Malformed JSON args for ${toolName}: ${parseMsg}`);
            const errResult = `[ERROR] Malformed JSON arguments: ${parseMsg}`;
            messages.push({ role: "tool", tool_call_id: tcId, content: errResult });
            callbacks?.onToolResult?.(toolName, false, errResult);
            continue;
          }

          log.info(`[PLANNER] Tool: ${toolName}(${JSON.stringify(parsedArgs).slice(0, 80)})`);
          callbacks?.onToolCall?.(toolName, parsedArgs);

          const { result, ok } = await executePlannerTool(toolName, parsedArgs, cwd, callbacks);

          // Truncate very large results to prevent context overflow.
          // (Planner is a heavy model with a large context window, but
          // unbounded file reads can still OOM it.)
          // FIX-MED-PC (MED 5): EXEMPT ler_url — it already truncates to
          // min(userMaxLength, 32K) in its own case handler. Re-applying
          // the middle-cut here would override the user's maxLength.
          const forModel = (toolName !== "ler_url" && result.length > 32_000)
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

      // No tool calls — this is the final plan.
      const plan = (msg.content ?? "").trim();
      if (!plan) {
        throw new Error("Planner não retornou um plano");
      }

      // FIX-MED-PC (HIGH 3 / S2-2): warn (but do NOT block) if the plan
      // doesn't look like a structured plan. We check for the `[PLAN` marker
      // OR numbered steps (regex /\d+\./). A malformed plan is still returned
      // — the coder may still extract value, and blocking would force a retry
      // that costs another heavy-model round-trip. Just log a warning.
      const hasPlanMarker = plan.includes("[PLAN");
      const hasNumberedSteps = /\d+\./.test(plan);
      if (!hasPlanMarker && !hasNumberedSteps) {
        log.warn(
          `[PLANNER] Plan output failed format validation (no "[PLAN" marker ` +
          `and no numbered steps /\\d+\\./). Returning anyway — coder may ` +
          `still extract value. First 80 chars: ${plan.slice(0, 80)}`,
        );
      }

      const result: PlannerResult = {
        plan,
        success: true,
        elapsedMs: Date.now() - start,
        toolCallsMade,
      };
      log.info(`[PLANNER] Concluído: ${toolCallsMade} tool calls, ${plan.length} chars`);
      return result;
    }

    // Max iterations reached
    throw new Error(`Planner excedeu ${PLANNER_MAX_ITERATIONS} iterações`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[PLANNER] Falhou: ${msg}`);
    return {
      plan: "",
      success: false,
      error: msg,
      elapsedMs: Date.now() - start,
      toolCallsMade,
    };
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
}

/**
 * Reset planner state (for tests).
 * Currently no module-level mutable state — placeholder for future use.
 */
export function _resetPlannerForTests(): void {
  // No-op — no module-level state to reset.
}
