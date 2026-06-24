/**
 * apiClient.ts - NVIDIA NIM OpenAI-compatible client with:
 *   1. Single-concurrency Mutex (only ONE in-flight request at a time)
 *   2. Sliding-window rate limiter (<= N requests per minute)
 *
 * Consumers call `chat()` without worrying about throttling - the module
 * handles queuing transparently.
 */

import OpenAI from "openai";
import https from "node:https";
import { config } from "./config.js";
import { getModelMaxOutputTokens } from "./modelRegistry.js";
import * as log from "./logger.js";
import { initApiKeyPool, acquireKeyForStreaming, tryAcquireKeyImmediate, getPoolSize, getAvailableKeyCount, getTotalKeyCount } from "./apiKeyPool.js";
import { providerSendsThinkingMode, getProviderReasoningField, providerNeedsHedging } from "./apiProvider.js";
import { getModelInfo } from "./modelRegistry.js";

// --- OpenAI Client (pointed at NVIDIA NIM) ----------------------------------

// TCP keepalive agent: sends probes every 3s during idle periods.
// This prevents intermediate load balancers/proxies from killing
// the connection while the model is still "thinking" but hasn't
// started emitting tokens yet (cold-start / warm-up phase).
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,   // probe every 1 second (extra aggressive to prevent proxy cuts)
  timeout: 0,               // no socket-level timeout
  maxSockets: 10,           // allow slightly more concurrent sockets if needed
  scheduling: "lifo",       // re-use the most recently used connections to keep them warm
});

const client = new OpenAI({
  apiKey: config.nvidiaApiKey,
  baseURL: config.nvidiaBaseUrl,
  timeout: 5 * 60 * 1000,   // 5 min max request timeout (generous for long thinking)
  httpAgent: keepAliveAgent,
});

// --- Rate Limiter (Sliding Window Token Bucket) -----------------------------

/**
 * A minimal sliding-window rate limiter.
 * Tracks the timestamps of all requests sent in the last 60 s window;
 * if the window is full, it delays the caller until the oldest timestamp
 * falls outside the 60 s boundary.
 */
class SlidingWindowRateLimiter {
  private readonly windowMs = 60_000; // 1 minute
  private readonly maxRequests: number;
  private timestamps: number[] = [];

  constructor(requestsPerMinute: number) {
    this.maxRequests = requestsPerMinute;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      // Drop timestamps older than the window
      this.timestamps = this.timestamps.filter(
        (t) => now - t < this.windowMs
      );

      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(now);
        return; // slot available - proceed immediately
      }

      // Window is full: calculate how long to sleep until the oldest
      // timestamp leaves the window, then retry
      const oldestTs = this.timestamps[0];
      const sleepMs = this.windowMs - (now - oldestTs) + 1;
      log.throttle(
        `Rate limit reached (${this.maxRequests} rpm). ` +
          `Waiting ${Math.ceil(sleepMs / 1000)} s...`
      );
      await sleep(sleepMs);
    }
  }
}

// --- Mutex (Binary Semaphore) ------------------------------------------------

/**
 * A promise-based mutex that guarantees at most ONE concurrent API call.
 * Callers awaiting `.lock()` are queued in FIFO order.
 */
class Mutex {
  private _locked = false;
  private readonly _queue: Array<() => void> = [];

  async lock(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    log.throttle("Another request is in-flight. Queuing...");
    return new Promise((resolve) => this._queue.push(resolve));
  }

  unlock(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }
}

// --- Singletons --------------------------------------------------------------

const mutex = new Mutex();
const rateLimiter = new SlidingWindowRateLimiter(config.rateLimitRpm);

// --- Utility -----------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Tool Definitions for the API --------------------------------------------

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "ler_arquivo",
      description:
        "Read file content or list directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path to read." },
          caminho: { type: "string", description: "Alias for path (backwards compat)." },
          offset: { type: "number", description: "1-indexed start line (optional)." },
          limit: { type: "number", description: "Max lines to return (optional)." },
          grep: { type: "string", description: "Regex pattern to filter lines (optional)." },
          contextLines: { type: "number", description: "Lines of context around grep matches (optional)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_arquivo",
      description:
        "Edit a file. You MUST provide either 'search'+'replace' or 'edits' array. " +
        "Example: editar_arquivo({path: '/x.ts', search: 'old', replace: 'new'}). " +
        "For new files: editar_arquivo({path: '/x.ts', replace: 'content', createIfMissing: true}).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit." },
          search: { type: "string", description: "Exact string to find and replace." },
          replace: { type: "string", description: "Replacement string." },
          all: { type: "boolean", description: "Replace all occurrences (default: first only)." },
          createIfMissing: { type: "boolean", description: "Create file if it doesn't exist." },
          edits: {
            type: "array",
            description: "Array of {search, replace, all?} operations for multiple edits.",
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
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_web",
      description:
        "Search the web.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (be specific for better results)." },
          maxResults: { type: "number", description: "Max results to return (default: 5)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_url",
      description:
        "Read content from a web URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch and read." },
          maxLength: { type: "number", description: "Max characters to return (default: 10000)." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_arquivos",
      description:
        "Find files by glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern to match files." },
          cwd: { type: "string", description: "Directory to search in (default: cwd)." },
          maxDepth: { type: "number", description: "Max directory depth." },
          ignore: { type: "array", items: { type: "string" }, description: "Patterns to ignore." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_texto",
      description:
        "Search file contents with regex.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for." },
          path: { type: "string", description: "File or directory to search in." },
          include: { type: "string", description: "File pattern filter (e.g. *.ts)." },
          caseInsensitive: { type: "boolean", description: "Case-insensitive search." },
          wholeWord: { type: "boolean", description: "Match whole words only." },
          contextLines: { type: "number", description: "Context lines around matches." },
          maxResults: { type: "number", description: "Max results to return." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_multi_arquivos",
      description: "Edit multiple files atomically. All edits succeed or all are rolled back.",
      parameters: {
        type: "object",
        properties: {
          requests: {
            type: "array",
            description: "Array of {filePath, edits, createIfMissing?}.",
            items: {
              type: "object",
              properties: {
                filePath: { type: "string" },
                edits: {
                  type: "array",
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
        required: ["requests"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "parse_ast",
      description:
        "Extract symbols from source file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Source file to parse." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_comando",
      description:
        "Run a shell command.",
      parameters: {
        type: "object",
        properties: {
          comando: { type: "string", description: "The shell command to execute." },
        },
        required: ["comando"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_testes",
      description:
        "Run test suite (auto-detects framework).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional file path to run tests for." },
          dir: { type: "string", description: "Project directory (defaults to cwd)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sugerir_fixes",
      description:
        "Run the project's test suite and suggest fixes for failing tests. Only useful if the project has a test framework (vitest/jest/pytest/cargo/go). Returns 'No fix suggestions' if no tests fail or no framework is detected.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Project directory (defaults to cwd)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "desfazer_edicao",
      description:
        "Undo the last file edit.",
      parameters: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "Caminho absoluto do arquivo a restaurar." },
        },
        required: ["caminho"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "atualizar_estado",
      description:
        "Update TASK_STATE.md (done/todo/decisions/bugs).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title of current task." },
          done: { type: "array", items: { type: "string" }, description: "List of completed items (replaces current)." },
          todo: { type: "array", items: { type: "string" }, description: "List of pending items (replaces current)." },
          decisions: { type: "array", items: { type: "string" }, description: "Decisions made (with brief justification)." },
          bugs: { type: "array", items: { type: "string" }, description: "Bugs found (with file:line if possible)." },
          dependencies: { type: "array", items: { type: "string" }, description: "Dependencies or blockers." },
          notes: { type: "string", description: "Notas livres." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "marcar_feito",
      description:
        "Mark a todo item as done.",
      parameters: {
        type: "object",
        properties: {
          item: { type: "string", description: "Substring do item em 'todo' a ser marcado como feito." },
        },
        required: ["item"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_estado",
      description:
        "Read TASK_STATE.md." +
        "Use after context compaction to recover task state.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "explorar_subagente",
      description:
        "Delegate task to a read-only sub-agent.",
      parameters: {
        type: "object",
        properties: {
          questao: { type: "string", description: "Specific question the sub-agent should answer." },
          cwd: { type: "string", description: "Base directory for exploration (default: current cwd)." },
          max_tool_calls: { type: "number", description: "Max tool calls for sub-agent (default: 8)." },
        },
        required: ["questao"],
      },
    },
  },
];

// --- Main Chat Function -------------------------------------------------------

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatResponse = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Maximum retry-after seconds we are willing to wait for a 429.
 * If the API says "wait longer than this", it's treated as quota-exhausted
 * and we throw immediately with a clear diagnostic message.
 */
const MAX_RETRY_AFTER_S     = 90;
const MAX_429_RETRIES       = 4;
const MAX_NETWORK_RETRIES   = 8;   // ECONNRESET etc. - more generous, fast retry

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
  "EPIPE", "ECONNREFUSED", "EAI_AGAIN",
]);

// Exported for use by sub-agents (so they can use the same retry heuristics)
export const SUB_AGENT_MAX_CHAT_RETRIES = 2;  // outer-level chat() retries per call
export const SUB_AGENT_MAX_NETWORK_RETRIES = MAX_NETWORK_RETRIES;
export const SUB_AGENT_TRANSIENT_NETWORK_CODES = TRANSIENT_NETWORK_CODES;

/** Returns true if the error is a transient network error that warrants a retry. */
export function isTransientNetworkErrorPublic(err: unknown): boolean {
  const anyErr = err as any;
  const errCode = anyErr?.code ?? anyErr?.cause?.code;
  return typeof errCode === "string" && TRANSIENT_NETWORK_CODES.has(errCode);
}

/** Returns true if the error is a 429 (rate limit). */
export function is429ErrorPublic(err: unknown): boolean {
  const status = (err as any)?.status ?? (err as any)?.response?.status;
  return status === 429;
}

type ToolCallAccumulator = Record<number, {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}>;

interface StreamState {
  isFirstChunk: boolean;
  finishReason: string | null;
  responseId: string;
  responseModel: string;
  responseCreated: number;
  totalContent: string;
  toolCallsAccumulator: ToolCallAccumulator;
  promptTokens: number;
  completionTokens: number;
}

function createStreamState(): StreamState {
  return {
    isFirstChunk: true,
    finishReason: null,
    responseId: "",
    responseModel: "",
    responseCreated: 0,
    totalContent: "",
    toolCallsAccumulator: {},
    promptTokens: 0,
    completionTokens: 0,
  };
}

function createStreamRequest(
  messages: Message[],
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[],
  clientOverride?: OpenAI
) {
  const c = clientOverride ?? client;

  // Dynamic thinking mode: only send chat_template_kwargs when:
  //   1. Provider supports it (NVIDIA: yes, ZenMux: no — thinking is built-in)
  //   2. Model has thinking (checked from modelRegistry)
  // This prevents errors on ZenMux (which doesn't accept chat_template_kwargs)
  // and on models that don't support thinking at all (kimi-k2.7-code-free).
  const modelInfo = getModelInfo(config.model);
  const shouldSendThinking = providerSendsThinkingMode() && modelInfo.hasThinking;

  const requestBody: any = {
    model: config.model,
    messages,
    tools: tools ?? TOOL_DEFINITIONS,
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    max_tokens: Math.min(config.maxTokens, getModelMaxOutputTokens(config.model)),
    temperature: config.temperature,
    top_p: config.topP,
  };

  // Only add chat_template_kwargs for NVIDIA provider with thinking-capable models.
  // ZenMux models have thinking built-in (GLM) or don't have it (Kimi Code Free).
  // Sending chat_template_kwargs to ZenMux may cause 400 errors.
  if (shouldSendThinking) {
    requestBody.chat_template_kwargs = { thinking_mode: "enabled" };
  }

  return c.chat.completions.create(requestBody);
}

// BUG FIX (BUG 5): processReasoningChunk antes retornava `!wasFirst` (boolean
// indicando se NÃO foi o primeiro chunk), mas `processStreamChunk` ignorava o
// retorno — código morto. Mudado for `void` e o retorno foi removido.
//
// BUG FIX (BUG 3 complemento): antes, esta função também consumia o flag
// `isFirstChunk` (setava for false). Mas `isFirstChunk` é usado por
// `processContentChunk` for disparar `onStreamStart` no PRIMEIRO chunk de
// CONTEÚDO. Como `processReasoningChunk` NÃO chama `onStreamStart`, consumir o
// flag aqui fazia com que `onStreamStart` nunca fosse chamado quando o stream
// começava com reasoning. Removida a manipulação de `isFirstChunk` — o flag
// só é consumido quando o primeiro CONTENT chunk chega.
function processReasoningChunk(
  state: StreamState,
  onThinking?: () => void,
): void {
  // state é recebido apenas for manter a assinatura consistente com as outras
  // funções processXxxChunk. Não há estado a mutar aqui.
  void state;
  onThinking?.();
}

function processContentChunk(
  state: StreamState,
  content: string,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
): void {
  // BUG FIX (BUG 3): antes havia um `else if (state.totalContent === "")`
  // morto — totalContent só cresce, nunca volta a ser "". onStreamStart deve
  // ser chamado APENAS na primeira vez que isFirstChunk é true.
  if (state.isFirstChunk) {
    state.isFirstChunk = false;
    onStreamStart?.();
  }
  // BUG FIX (BUG 2): antes, o caller usava `if (delta.content)` (falsy para
  // string vazia), então chunks com content="" nunca chegavam aqui. Agora o
  // caller testa `typeof delta.content === "string"`, então strings vazias
  // chegam. Chamamos onToken mesmo com string vazia (alguns provedores enviam
  // chunks vazios como heartbeats). totalContent += "" é no-op, então a
  // contagem de tokens no conteúdo final não é afetada.
  onToken?.(content);
  state.totalContent += content;
}

function processToolCallDelta(
  accumulator: ToolCallAccumulator,
  toolCalls: any[],
): void {
  for (const tc of toolCalls) {
    const idx: number = tc.index ?? 0;
    if (accumulator[idx]) {
      const acc = accumulator[idx];
      if (tc.id && !acc.id) acc.id = tc.id;
    } else {
      accumulator[idx] = {
        id: tc.id ?? "",
        type: "function",
        function: { name: tc.function?.name ?? "", arguments: "" },
      };
    }
    if (tc.function?.arguments) {
      accumulator[idx].function.arguments += tc.function.arguments;
    }
  }
}

function processStreamChunk(
  chunk: any,
  state: StreamState,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
): void {
  // BUG FIX: previously, this function did `if (!choice) return;` at the top,
  // which meant that chunks containing ONLY `usage` (no `choices` array, or
  // empty `choices`) were discarded before we could read the token counts.
  //
  // The NVIDIA NIM API (and OpenAI-compatible APIs in general) sends the
  // final `usage` object in a separate chunk that has NO choices. This
  // chunk is the only one that contains accurate prompt_tokens and
  // completion_tokens. By returning early, we never captured them, so
  // state.promptTokens and state.completionTokens stayed at 0 forever,
  // and the StatusBar always showed "0/256k 0%".
  //
  // Fix: process `usage` BEFORE the `if (!choice) return` guard.

  // Process usage FIRST — it may arrive in a chunk without choices.
  if (chunk.usage) {
    state.promptTokens = chunk.usage.prompt_tokens ?? 0;
    state.completionTokens = chunk.usage.completion_tokens ?? 0;
  }

  const choice = chunk.choices?.[0];
  if (!choice) return;

  if (!state.responseId) state.responseId = chunk.id ?? "";
  if (!state.responseModel) state.responseModel = chunk.model ?? "";
  if (!state.responseCreated) state.responseCreated = chunk.created ?? 0;

  const delta = choice.delta ?? {};

  const reasoning = delta.reasoning_content ?? ("reasoning" in delta ? delta.reasoning : undefined);
  if (reasoning) {
    processReasoningChunk(state, onThinking);
    return;
  }

  if (delta.tool_calls) {
    processToolCallDelta(state.toolCallsAccumulator, delta.tool_calls);
  }

  // BUG FIX (BUG 2): antes era `if (delta.content)` (falsy for string vazia),
  // então chunks com content="" nunca chamavam onToken. Agora testamos
  // `typeof delta.content === "string"` for que chunks vazios (heartbeats)
  // também sejam processados. O acúmulo em totalContent não é afetado porque
  // somar "" é no-op.
  if (typeof delta.content === "string") {
    processContentChunk(state, delta.content, onStreamStart, onToken);
  }

  if (choice.finish_reason) state.finishReason = choice.finish_reason;

  // Note: usage was already processed above (before the choice guard).
  // Some APIs also send usage in the final choice chunk, so check again
  // in case it wasn't in the separate usage-only chunk.
  if (chunk.usage) {
    state.promptTokens = chunk.usage.prompt_tokens ?? state.promptTokens;
    state.completionTokens = chunk.usage.completion_tokens ?? state.completionTokens;
  }
}

async function consumeStream(
  rawStream: any,
  state: StreamState,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
): Promise<void> {
  for await (const chunk of rawStream) {
    processStreamChunk(chunk, state, onStreamStart, onToken, onThinking);
  }
}

function buildChatResponse(state: StreamState): ChatResponse {
  const toolCallsList = Object.values(state.toolCallsAccumulator);
  return {
    id: state.responseId,
    object: "chat.completion",
    created: state.responseCreated,
    model: state.responseModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: state.totalContent || null,
          tool_calls: toolCallsList.length > 0 ? toolCallsList : undefined,
          refusal: null,
        },
        // BUG FIX (BUG 4): antes, quando o stream terminava sem finish_reason
        // explícito, o default era "stop" — isso mascarava streams que
        // terminaram abruptamente. Agora o default é null, e o caller é
        // responsável por interpretar a ausência de finish_reason. O tipo
        // ChatCompletion do OpenAI SDK aceita null for finish_reason.
        finish_reason: (state.finishReason as any) ?? null,
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: state.promptTokens,
      completion_tokens: state.completionTokens,
      total_tokens: state.promptTokens + state.completionTokens,
    },
  };
}

function logApiDiagnostics(err: unknown, attempt: number): void {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const anyErr = err as any;

  const diagLines: string[] = [
    `[API Error] attempt=${attempt}`,
    `  type        : ${apiErr ? "OpenAI.APIError" : (anyErr?.constructor?.name ?? typeof err)}`,
    `  message     : ${apiErr?.message ?? anyErr?.message ?? String(err)}`,
    `  code        : ${anyErr?.code ?? anyErr?.cause?.code ?? "-"}`,
    `  http status : ${apiErr?.status ?? anyErr?.status ?? "-"}`,
    `  request_id  : ${apiErr?.headers?.["x-request-id"] ?? "-"}`,
    `  nvcf-reqid  : ${apiErr?.headers?.["nvcf-reqid"] ?? "-"}`,
  ];

  if (apiErr?.headers) {
    const h = Object.entries(apiErr.headers).map(([k, v]) => `    ${k}: ${v}`).join("\n");
    diagLines.push(`  headers:\n${h}`);
  }

  if (anyErr?.stack) {
    diagLines.push(`  stack:\n${anyErr.stack}`);
  }

  log.debug(diagLines.join("\n"));
}

function extractRetryAfter(err: unknown): number {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const rawRetryAfter =
    apiErr?.headers?.["retry-after"] ??
    (err as { headers?: Record<string, string> })?.headers?.["retry-after"];
  return rawRetryAfter ? Number(rawRetryAfter) : Number.NaN;
}

function buildQuotaExhaustedMessage(retryAfterS: number, errBody: string): string {
  const isQuotaExhausted = Number.isNaN(retryAfterS) || retryAfterS > MAX_RETRY_AFTER_S;
  const retryAfterLabel = Number.isNaN(retryAfterS) ? "N/A" : retryAfterS + "s";
  const hint = isQuotaExhausted
    ? `Retry-After missing or too long (${retryAfterLabel}) - likely daily/monthly quota exhausted.`
    : `Max retries (${MAX_429_RETRIES}) reached.`;
  const modelHint = config.model ? `the model ${config.model}` : "this model";

  return (
    `\nx  NVIDIA NIM API 429 error - ${hint}\n\n` +
    `   Possible causes:\n` +
    `     * Daily/monthly API key quota exhausted\n` +
    `     * Free-tier plan without access to ${modelHint}\n` +
    `     * Check: https://build.nvidia.com/ -> Usage & Billing\n\n` +
    `   Error details: ${errBody}`
  );
}

function is429Error(err: unknown): boolean {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  return apiErr?.status === 429 ||
    (apiErr == null && (err as { status?: number })?.status === 429);
}

// BUG FIX (BUG 1): antes, só 429 e erros de rede (ECONNRESET, ETIMEDOUT) eram
// retried. 502/503 frequentemente são transientes (gateway restart, deploy,
// overload momentâneo) e deveriam ser retried. 500 NÃO é retriable (geralmente
// é bug real no servidor). 504 também não (gateway timeout — retry provável de
// falhar da mesma forma; o cliente de HTTP já tem seu próprio timeout).
const RETRIABLE_5XX_STATUSES = new Set([502, 503]);

function is5xxRetryableError(err: unknown): boolean {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const status = apiErr?.status ?? (err as { status?: number })?.status;
  return typeof status === "number" && RETRIABLE_5XX_STATUSES.has(status);
}

function handleStreamError(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> | null {
  if (is429Error(err)) {
    return handle429Error(err, attempt);
  }
  if (is5xxRetryableError(err)) {
    return handle5xxRetryableError(err, attempt);
  }
  if (isTransientNetworkError(err)) {
    return handleTransientNetworkError(err, attempt);
  }
  return null;
}

function isTransientNetworkError(err: unknown): boolean {
  return isTransientNetworkErrorPublic(err);
}

function getErrCode(err: unknown): string {
  const anyErr = err as any;
  return anyErr?.code ?? anyErr?.cause?.code ?? "unknown";
}

async function handle429Error(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> {
  const retryAfterS = extractRetryAfter(err);
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const errBody = apiErr?.message ?? String(err);

  const isQuotaExhausted =
    Number.isNaN(retryAfterS) || retryAfterS > MAX_RETRY_AFTER_S;

  if (isQuotaExhausted || attempt >= MAX_429_RETRIES) {
    throw new Error(buildQuotaExhaustedMessage(retryAfterS, errBody));
  }

  return retryWithDelay(retryAfterS, attempt);
}

async function retryWithDelay(retryAfterS: number, attempt: number): Promise<{ retried: boolean; newAttempt: number }> {
  const newAttempt = attempt + 1;
  const waitMs = retryAfterS * 1000 + 500;
  log.throttle(
    `API retornou 429. Retry-After: ${retryAfterS}s. ` +
    `Aguardando ${retryAfterS}s (tentativa ${newAttempt}/${MAX_429_RETRIES})...`
  );
  await sleep(waitMs);
  return { retried: true, newAttempt };
}

// BUG FIX (BUG 1): handler de retry for 502/503 (transientes). Usa o mesmo
// limite e backoff de erros de rede (MAX_NETWORK_RETRIES = 8, 500ms..3000ms),
// porque 5xx transiente tem perfil de recuperação similar a um erro de rede.
async function handle5xxRetryableError(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> {
  if (attempt >= MAX_NETWORK_RETRIES) {
    return { retried: false, newAttempt: attempt };
  }

  const newAttempt = attempt + 1;
  const waitMs = Math.min(newAttempt * 500, 3000);
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const status = apiErr?.status ?? (err as { status?: number })?.status ?? "?";
  log.warn(
    `Erro ${status} do servidor (transiente). ` +
    `Retry em ${waitMs / 1000}s (tentativa ${newAttempt}/${MAX_NETWORK_RETRIES})...`
  );
  await sleep(waitMs);
  return { retried: true, newAttempt };
}

async function handleTransientNetworkError(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> {
  if (attempt >= MAX_NETWORK_RETRIES) {
    return { retried: false, newAttempt: attempt };
  }

  const newAttempt = attempt + 1;
  const waitMs = Math.min(newAttempt * 500, 3000);
  log.warn(
    `Erro de rede (${getErrCode(err)}). ` +
    `Retry em ${waitMs / 1000}s (tentativa ${newAttempt}/${MAX_NETWORK_RETRIES})...`
  );
  await sleep(waitMs);
  return { retried: true, newAttempt };
}

/**
 * Send a complete message history to the Kimi K2.6 model.
 *
 * Enforces:
 *  - Single-flight concurrency (Mutex)
 *  - Sliding-window rate limiting (<= rateLimitRpm rpm)
 *  - Smart 429 retry: only retries short-lived rate limits (Retry-After <= 90 s).
 *    Quota-exhausted 429s (no Retry-After, or Retry-After > 90 s) are thrown
 *    immediately with a clear diagnostic.
 *
 * @param messages  Full conversation history to send.
 * @returns         The raw OpenAI ChatCompletion response.
 */
export async function chat(
  messages: Message[],
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[]
): Promise<ChatResponse> {
  // IDEIA: Multi-key pool - if NVIDIA_API_KEYS is configured, use the pool
  // instead of the single-key mutex+rateLimiter. Each call picks a free key,
  // allowing sub-agents to run truly in parallel without contending.
  const poolActive = getPoolSize() > 0 || initApiKeyPool();

  if (poolActive) {
    try {
      return await chatWithPool(messages, tools, onStreamStart, onToken, onThinking);
    } catch (err) {
      // Pool acquisition failed entirely - fall back to single-key mode
      log.warn(`[POOL] Falling back to single-key mode: ${(err as Error).message}`);
    }
  }
  return chatSingleKey(messages, tools, onStreamStart, onToken, onThinking);
}

// BUG FIX (BUG 6): helper for cancelar/abortar um stream perdedor do hedging.
// Tenta várias APIs comuns: OpenAI SDK Stream expõe `.controller` (AbortController);
// Node streams têm `.destroy()`; alguns objetos têm `.abort()`. Se nada for
// disponível (ex: mock async iterable em testes), a função é no-op.
function abortStreamSafe(s: any): void {
  if (s == null) return;
  try { s?.controller?.abort?.(); } catch { /* noop */ }
  try { s?.abort?.(); } catch { /* noop */ }
  try { s?.destroy?.(); } catch { /* noop */ }
  try { s?.return?.(); } catch { /* noop */ } // encerra async iterators
}

/** Pool-mode chat: pick a free key from the pool, run the request, release. */
async function chatWithPool(
  messages: Message[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  onStreamStart: (() => void) | undefined,
  onToken: ((token: string) => void) | undefined,
  onThinking: (() => void) | undefined
): Promise<ChatResponse> {
  let attempt = 0;
  for (;;) {
    const poolHandle = await acquireKeyForStreaming();
    const start = Date.now();
    let httpStatus: number | null = null;
    let releaseSuccess!: boolean;
    try {
      log.debug(`Sending ${messages.length} messages to ${config.model} (pool mode)` +
        (attempt > 0 ? ` (retry ${attempt}/${MAX_429_RETRIES})` : ""));

      // ─── Delayed Hedging ────────────────────────────────────────────
      // If there are 2+ free keys in the pool, send a backup request on
      // a 2nd key after HEDGE_TIMEOUT_MS (5s). The first stream to
      // produce output wins; the other is cancelled.
      //
      // This is "delayed" hedging — we don't fire 2 requests at once.
      // We fire 1, wait 5s, and only fire the 2nd if the 1st hasn't
      // produced output yet. This way:
      //   - Fast requests (<5s): 1 key used, 0 waste
      //   - Slow requests (>5s): 2 keys used, 1 waste, but faster response
      //
      // The pool's mutex guarantees we never steal a key that's already
      // in use by the main agent or a sub-agent. If only 1 key is free,
      // hedging is skipped (no backup).
      const HEDGE_TIMEOUT_MS = 5000;
      // Hedging only makes sense for NVIDIA (GPU queue contention).
      // ZenMux has no queue (10+ concurrent, no cold start) — hedging would
      // just waste requests for no benefit.
      // Also requires at least 1 free key in the pool for backup.
      const canHedge = providerNeedsHedging() && getAvailableKeyCount() >= 1 && getTotalKeyCount() >= 2;

      let hedgeHandle: { client: OpenAI; entry: any; release: (success: boolean, httpStatus: number | null, latencyMs: number) => void } | null = null;
      let hedgeWinner: "primary" | "hedge" | null = null;
      let primaryStreamStarted = false;

      // Start primary stream
      const primaryStreamPromise = createStreamRequest(messages, tools, poolHandle.client);

      // If hedging is possible, set a timer to fire the backup
      let hedgeTimer: ReturnType<typeof setTimeout> | null = null;
      if (canHedge) {
        hedgeTimer = setTimeout(() => {
          // Only fire hedge if primary hasn't started streaming yet
          if (primaryStreamStarted) return;
          hedgeHandle = tryAcquireKeyImmediate() as any;
          if (hedgeHandle) {
            log.debug(`[HEDGE] Primary slow after ${HEDGE_TIMEOUT_MS}ms — firing backup on key #${(hedgeHandle.entry as any).index}`);
          }
        }, HEDGE_TIMEOUT_MS);
      }

      try {
        // Wait for primary stream to be created (the initial HTTP request)
        const rawStream = await primaryStreamPromise;
        primaryStreamStarted = true;

        // Check if hedge was already fired (meaning primary took >5s to even
        // get the initial response). If so, race both streams.
        if (hedgeHandle) {
          // Primary was slow to start — race both streams
          log.debug(`[HEDGE] Primary eventually started, but hedge was already fired — racing`);

          const primaryState = createStreamState();
          const hedgeState = createStreamState();

          // Race: first stream to produce content wins
          // BUG FIX (BUG 6): antes, o `.catch(() => {})` do perdedor era
          // registrado APÓS o `Promise.race` resolver. Se o stream perdedor
          // rejeitasse antes do catch ser anexado, vira unhandled rejection.
          // Agora anexamos o catch ANTES da race em AMBAS as promises —
          // qualquer rejeição é silenciada imediatamente.
          const primaryPromise = consumeStream(rawStream, primaryState, undefined, undefined, undefined).then(() => "primary" as const);
          primaryPromise.catch(() => {}); // suppress unhandled rejection no perdedor

          let hedgeRawStream: any = null;
          const hedgeStreamPromise = createStreamRequest(messages, tools, (hedgeHandle as any)!.client)
            .then(hs => {
              hedgeRawStream = hs;
              return consumeStream(hs, hedgeState, undefined, undefined, undefined).then(() => "hedge" as const);
            });
          hedgeStreamPromise.catch(() => {}); // suppress unhandled rejection no perdedor

          const winner = await Promise.race([primaryPromise, hedgeStreamPromise]);
          hedgeWinner = winner as "primary" | "hedge";

          // BUG FIX (BUG 6): cancelar/abortar o stream perdedor for evitar
          // leak. Tenta chamar `.abort()` / `.destroy()` / `.controller.abort()`
          // se disponível (OpenAI SDK Stream expõe `.controller`). Se o stream
          // for um mock/async iterable sem esses métodos, nada acontece.
          if (hedgeWinner === "primary") {
            // Hedge lost — aborta o stream subjacente do hedge
            abortStreamSafe(hedgeRawStream);
            const response = buildChatResponse(primaryState);
            // But we need to call onStreamStart/onToken with the winner's content
            if (onStreamStart) onStreamStart();
            if (onToken && response.choices[0]?.message?.content) {
              onToken(response.choices[0].message.content);
            }
            releaseSuccess = true;
            return response;
          } else {
            // Primary lost — aborta o stream subjacente do primary
            abortStreamSafe(rawStream);
            const response = buildChatResponse(hedgeState);
            if (onStreamStart) onStreamStart();
            if (onToken && response.choices[0]?.message?.content) {
              onToken(response.choices[0].message.content);
            }
            releaseSuccess = true;
            return response;
          }
        }

        // Normal path: no hedge fired, consume primary stream
        const state = createStreamState();
        await consumeStream(rawStream, state, onStreamStart, onToken, onThinking);
        const response = buildChatResponse(state);
        releaseSuccess = true;
        log.debug(
          `Response: stop_reason=${response.choices[0]?.finish_reason}, ` +
            `tokens=${response.usage?.total_tokens ?? "?"}`
        );
        return response;
      } finally {
        if (hedgeTimer) clearTimeout(hedgeTimer);
        if (hedgeHandle) {
          (hedgeHandle as any).release(hedgeWinner === "hedge", null, Date.now() - start);
        }
      }
    } catch (err: unknown) {
      releaseSuccess = false;
      httpStatus = (err as any)?.status ?? null;
      logApiDiagnostics(err, attempt);
      const retryResult = await handleStreamError(err, attempt);
      if (retryResult?.retried && attempt < MAX_429_RETRIES + MAX_NETWORK_RETRIES) {
        attempt = retryResult.newAttempt;
        continue;
      }
      throw err;
    } finally {
      poolHandle.release(releaseSuccess, httpStatus, Date.now() - start);
    }
  }
}

/** Single-key chat path - uses global mutex + rateLimiter (backwards compat). */
async function chatSingleKey(
  messages: Message[],
  tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
  onStreamStart: (() => void) | undefined,
  onToken: ((token: string) => void) | undefined,
  onThinking: (() => void) | undefined
): Promise<ChatResponse> {
  let attempt = 0;
  for (;;) {
    await mutex.lock();
    try {
      await rateLimiter.acquire();
      log.debug(`Sending ${messages.length} messages to ${config.model}` +
        (attempt > 0 ? ` (retry ${attempt}/${MAX_429_RETRIES})` : ""));
      const rawStream = await createStreamRequest(messages, tools);
      const state = createStreamState();
      await consumeStream(rawStream, state, onStreamStart, onToken, onThinking);
      const response = buildChatResponse(state);
      log.debug(
        `Response: stop_reason=${response.choices[0]?.finish_reason}, ` +
          `tokens=${response.usage?.total_tokens ?? "?"}`
      );
      return response;
    } catch (err: unknown) {
      logApiDiagnostics(err, attempt);
      const retryResult = await handleStreamError(err, attempt);
      if (retryResult?.retried) {
        attempt = retryResult.newAttempt;
        continue;
      }
      throw err;
    } finally {
      mutex.unlock();
    }
  }
}

