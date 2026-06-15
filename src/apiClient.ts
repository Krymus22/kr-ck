/**
 * apiClient.ts — NVIDIA NIM OpenAI-compatible client with:
 *   1. Single-concurrency Mutex (only ONE in-flight request at a time)
 *   2. Sliding-window rate limiter (≤ N requests per minute)
 *
 * Consumers call `chat()` without worrying about throttling — the module
 * handles queuing transparently.
 */

import OpenAI from "openai";
import https from "node:https";
import { config } from "./config.js";
import * as log from "./logger.js";

// ─── OpenAI Client (pointed at NVIDIA NIM) ──────────────────────────────────

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

// ─── Rate Limiter (Sliding Window Token Bucket) ─────────────────────────────

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
        return; // slot available — proceed immediately
      }

      // Window is full: calculate how long to sleep until the oldest
      // timestamp leaves the window, then retry
      const oldestTs = this.timestamps[0];
      const sleepMs = this.windowMs - (now - oldestTs) + 1;
      log.throttle(
        `Rate limit reached (${this.maxRequests} rpm). ` +
          `Waiting ${Math.ceil(sleepMs / 1000)} s…`
      );
      await sleep(sleepMs);
    }
  }
}

// ─── Mutex (Binary Semaphore) ────────────────────────────────────────────────

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
    log.throttle("Another request is in-flight. Queuing…");
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

// ─── Singletons ──────────────────────────────────────────────────────────────

const mutex = new Mutex();
const rateLimiter = new SlidingWindowRateLimiter(config.rateLimitRpm);

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tool Definitions for the API ────────────────────────────────────────────

export const TOOL_DEFINITIONS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "ler_arquivo",
      description:
        "Reads the complete content of a local file or lists directory contents from the filesystem. " +
        "If the path is a directory, it returns the list of files and subdirectories. " +
        "Use this to inspect any source file or explore folder structure before making changes.",
      parameters: {
        type: "object",
        properties: {
          caminho: {
            type: "string",
            description: "Relative or absolute path to the file or directory.",
          },
        },
        required: ["caminho"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ler_arquivo_avancado",
      description:
        "Reads file content with offset, limit, line numbers, and optional grep filtering. " +
        "Supports reading specific line ranges and searching within file content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." },
          offset: { type: "number", description: "1-indexed start line." },
          limit: { type: "number", description: "Max lines to return." },
          grep: { type: "string", description: "Regex pattern to filter lines." },
          contextLines: { type: "number", description: "Lines of context around grep matches." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "aplicar_diff",
      description:
        "Applies a Search & Replace diff block to a local file. " +
        "The file content is parsed, and sections matching SEARCH are replaced with REPLACE. " +
        "A syntax guardrail will validate the entire file after the patch is applied. " +
        "Use this tool to make edits instead of writing full files.",
      parameters: {
        type: "object",
        properties: {
          caminho: { type: "string", description: "Relative or absolute path to the file to modify." },
          bloco_diff: {
            type: "string",
            description:
              "The diff contents following the strict format:\n" +
              "<<<<<<< SEARCH\n[exact old code to replace]\n=======\n[new code replacement]\n>>>>>>> REPLACE",
          },
        },
        required: ["caminho", "bloco_diff"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "editar_arquivo",
      description:
        "Edit a file using string match/replace. Supports multiple edits and create-if-missing. " +
        "More precise than aplicar_diff for simple changes.",
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
      name: "buscar_arquivos",
      description:
        "Search for files by glob pattern (e.g. **/*.ts, src/**/*.test.ts). " +
        "Returns matching file paths relative to cwd.",
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
        "Search file contents using regex (like grep). Returns matching lines with file paths and line numbers.",
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
      name: "git_status",
      description: "Shows the working tree status (branch, staged, modified, untracked files).",
      parameters: { type: "object", properties: { cwd: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Shows file changes. Use staged=true for staged changes.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          file: { type: "string", description: "Specific file to diff." },
          staged: { type: "boolean", description: "Show staged changes." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Shows recent commit history.",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string" },
          count: { type: "number", description: "Number of commits (default 10)." },
          file: { type: "string", description: "Show history for specific file." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Create a git commit. Optionally stage files first.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message." },
          files: { type: "array", items: { type: "string" }, description: "Files to stage." },
          cwd: { type: "string" },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_blame",
      description: "Show who changed each line of a file.",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "File to blame." },
          cwd: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_show",
      description: "Show details of a specific commit.",
      parameters: {
        type: "object",
        properties: {
          commitHash: { type: "string", description: "Commit hash to show." },
          cwd: { type: "string" },
        },
        required: ["commitHash"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_branch",
      description: "List all branches (local and remote).",
      parameters: { type: "object", properties: { cwd: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "git_checkout",
      description: "Switch to a branch.",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Branch name." },
          cwd: { type: "string" },
        },
        required: ["branch"],
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
      name: "salvar_sessao",
      description: "Save the current conversation session to disk for later restoration.",
      parameters: { type: "object", properties: { id: { type: "string", description: "Optional session ID." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "carregar_sessao",
      description: "Load a previously saved session from disk.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Session ID to load." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_sessoes",
      description: "List all saved sessions.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "parse_ast",
      description:
        "Parse a source file and extract symbols (functions, classes, interfaces, etc.), imports, and exports. " +
        "Language-agnostic: supports TypeScript, JavaScript, Python, Rust, Go, Java.",
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
      name: "executar_paralelo",
      description: "Execute multiple tool calls in parallel for performance.",
      parameters: {
        type: "object",
        properties: {
          tools: { type: "array", items: { type: "string" }, description: "Tool names to call." },
          args: { type: "array", items: { type: "object" }, description: "Arguments for each tool." },
        },
        required: ["tools", "args"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "Update the visible todo list for the current task. Use this to plan and track multi-step work. " +
        "Call repeatedly as work progresses to mark items as `in_progress` or `completed`. " +
        "Only one item should be `in_progress` at a time. Pass an empty array to clear the list.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Full replacement list of todos.",
            items: {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "Current status of this todo item.",
                },
                content: {
                  type: "string",
                  description: "Imperative form describing what was done.",
                  maxLength: 200,
                },
                active_form: {
                  type: "string",
                  description: "Present continuous form shown when status is in_progress.",
                  maxLength: 200,
                },
              },
              required: ["status", "content"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "executar_comando",
      description:
        "Executes a shell command in the terminal and returns its combined stdout/stderr output. " +
        "Use this tool to run tests, linters, or compilation commands locally.",
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
        "Runs the project's test suite and returns structured results. " +
        "Auto-detects test framework (vitest, jest, pytest, cargo, go). " +
        "Can optionally run tests for a specific file. Returns pass/fail counts and failure details.",
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
        "Analyzes test failures and suggests fixes. " +
        "Use after running tests to get actionable fix suggestions for each failure.",
      parameters: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Project directory (defaults to cwd)." },
        },
      },
    },
  },
];

// ─── Main Chat Function ───────────────────────────────────────────────────────

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatResponse = OpenAI.Chat.Completions.ChatCompletion;

/**
 * Maximum retry-after seconds we are willing to wait for a 429.
 * If the API says "wait longer than this", it's treated as quota-exhausted
 * and we throw immediately with a clear diagnostic message.
 */
const MAX_RETRY_AFTER_S     = 90;
const MAX_429_RETRIES       = 4;
const MAX_NETWORK_RETRIES   = 8;   // ECONNRESET etc. — more generous, fast retry

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND",
  "EPIPE", "ECONNREFUSED", "EAI_AGAIN",
]);

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
  tools?: OpenAI.Chat.Completions.ChatCompletionTool[]
) {
  return client.chat.completions.create({
    model: config.model,
    messages,
    tools: tools ?? TOOL_DEFINITIONS,
    tool_choice: "auto",
    stream: true,
    max_tokens: 16384,
    chat_template_kwargs: { thinking_mode: "enabled" },
  } as any);
}

function processReasoningChunk(
  state: StreamState,
  onThinking?: () => void,
): boolean {
  const wasFirst = state.isFirstChunk;
  if (wasFirst) {
    state.isFirstChunk = false;
  }
  onThinking?.();
  return !wasFirst;
}

function processContentChunk(
  state: StreamState,
  content: string,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
): void {
  if (state.isFirstChunk) {
    state.isFirstChunk = false;
    onStreamStart?.();
  } else if (state.totalContent === "") {
    onStreamStart?.();
  }
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
  const choice = chunk.choices?.[0];
  if (!choice) return;

  if (!state.responseId) state.responseId = chunk.id ?? "";
  if (!state.responseModel) state.responseModel = chunk.model ?? "";
  if (!state.responseCreated) state.responseCreated = chunk.created ?? 0;

  const delta = choice.delta ?? {};

  const reasoning = delta.reasoning_content || ("reasoning" in delta ? delta.reasoning : undefined);
  if (reasoning) {
    processReasoningChunk(state, onThinking);
    return;
  }

  if (delta.content) {
    processContentChunk(state, delta.content, onStreamStart, onToken);
  }

  if (delta.tool_calls) {
    processToolCallDelta(state.toolCallsAccumulator, delta.tool_calls);
  }

  if (choice.finish_reason) state.finishReason = choice.finish_reason;

  if (chunk.usage) {
    state.promptTokens = chunk.usage.prompt_tokens ?? 0;
    state.completionTokens = chunk.usage.completion_tokens ?? 0;
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
        finish_reason: (state.finishReason as any) ?? "stop",
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
    `  code        : ${anyErr?.code ?? anyErr?.cause?.code ?? "—"}`,
    `  http status : ${apiErr?.status ?? anyErr?.status ?? "—"}`,
    `  request_id  : ${apiErr?.headers?.["x-request-id"] ?? "—"}`,
    `  nvcf-reqid  : ${apiErr?.headers?.["nvcf-reqid"] ?? "—"}`,
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
    ? `Retry-After ausente ou muito longo (${retryAfterLabel}) — provável quota diária/mensal esgotada.`
    : `Limite de ${MAX_429_RETRIES} retentativas atingido.`;

  return (
    `\n✖  Erro 429 da NVIDIA NIM API — ${hint}\n\n` +
    `   Possíveis causas:\n` +
    `     • Quota diária/mensal da sua API key esgotada\n` +
    `     • Plano gratuito sem acesso ao modelo minimaxai/minimax-m3\n` +
    `     • Verifique em: https://build.nvidia.com/ → Usage & Billing\n\n` +
    `   Detalhes do erro: ${errBody}`
  );
}

function is429Error(err: unknown): boolean {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  return apiErr?.status === 429 ||
    (apiErr == null && (err as { status?: number })?.status === 429);
}

function handleStreamError(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> | null {
  if (is429Error(err)) {
    return handle429Error(err, attempt);
  }
  if (isTransientNetworkError(err)) {
    return handleTransientNetworkError(err, attempt);
  }
  return null;
}

function isTransientNetworkError(err: unknown): boolean {
  const anyErr = err as any;
  const errCode = anyErr?.code || anyErr?.cause?.code;
  return typeof errCode === "string" && TRANSIENT_NETWORK_CODES.has(errCode);
}

function getErrCode(err: unknown): string {
  const anyErr = err as any;
  return anyErr?.code || anyErr?.cause?.code || "unknown";
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
    `Aguardando ${retryAfterS}s (tentativa ${newAttempt}/${MAX_429_RETRIES})…`
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
    `Retry em ${waitMs / 1000}s (tentativa ${newAttempt}/${MAX_NETWORK_RETRIES})…`
  );
  await sleep(waitMs);
  return { retried: true, newAttempt };
}

/**
 * Send a complete message history to the Kimi K2.6 model.
 *
 * Enforces:
 *  - Single-flight concurrency (Mutex)
 *  - Sliding-window rate limiting (≤ rateLimitRpm rpm)
 *  - Smart 429 retry: only retries short-lived rate limits (Retry-After ≤ 90 s).
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

