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
//
// CRITICAL FIX: timeout must NOT be 0 (infinite). If NVIDIA's API accepts
// the TCP connection but never responds (load balancer issue, server hang),
// the socket would hang forever, freezing the entire agent loop.
// 5 min matches the OpenAI client timeout — if no response by then, abort.
const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 1_000,   // probe every 1 second (extra aggressive to prevent proxy cuts)
  timeout: 5 * 60 * 1000,  // 5 min socket timeout — matches OpenAI client timeout
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
        "Read file content or list directory. Pass 'path' (or 'caminho' alias) with the file path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File or directory path to read." },
          caminho: { type: "string", description: "Alias for path (PT)." },
          offset: { type: "number", description: "1-indexed start line (optional)." },
          limit: { type: "number", description: "Max lines to return (optional)." },
          grep: { type: "string", description: "Regex pattern to filter lines (optional)." },
          contextLines: { type: "number", description: "Lines of context around grep matches (optional)." },
        },
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
          caminho: { type: "string", description: "Alias for path (PT)." },
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
        "Run a shell command. Pass 'comando' (PT) or 'command' (EN) with the shell command.",
      parameters: {
        type: "object",
        properties: {
          comando: { type: "string", description: "The shell command to execute." },
          command: { type: "string", description: "Alias for comando (EN)." },
          cwd: { type: "string", description: "Working directory (optional)." },
        },
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
      name: "listar_memoria",
      description:
        "List project memory files (CLAUDE.md, AGENTS.md) loaded into the system prompt at startup, with their paths and sizes. " +
        "Use this when the user asks 'which config files did you read?' or 'what files are in your context?' or 'which AGENTS.md/CLAUDE.md did you load?' " +
        "Returns the list of files with their relative paths and sizes. To see the CURRENT file contents (in case the file was edited since startup), call ler_arquivo(<path>) with the path returned here.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "explorar_subagente",
      description:
        "Delegate EXPLORATION/RESEARCH tasks to a read-only sub-agent. " +
        "USE THIS when you need to: explore a codebase, understand how something works, " +
        "find all files matching a pattern, investigate a bug's root cause, " +
        "or gather information BEFORE making changes. " +
        "The sub-agent runs in parallel and has its own context window, " +
        "so it can do deep exploration WITHOUT polluting your main context. " +
        "Example: 'Find all places where UserService is called and explain the data flow'. " +
        "Returns a summary of findings. Does NOT edit files.",
      parameters: {
        type: "object",
        properties: {
          questao: { type: "string", description: "Specific question the sub-agent should answer. Be detailed: 'Find all callers of function X and explain how data flows through them'." },
          cwd: { type: "string", description: "Base directory for exploration (default: current cwd)." },
          max_tool_calls: { type: "number", description: "Max tool calls for sub-agent (default: 8, max: 20)." },
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
const MAX_NETWORK_RETRIES   = 15;  // ECONNRESET/ETIMEDOUT etc. - generous for unstable APIs

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
  /** Repetition detection: tracks recent chunks to detect loops */
  recentChunks: string[];
  repetitionDetected: boolean;
  /**
   * <think> tag filtering (real-time).
   * Some models (Kimi K2.6) embed reasoning as <think>...</think> tags
   * INSIDE delta.content instead of using delta.reasoning_content.
   * We filter these during streaming so the user never sees them.
   */
  inThinkBlock: boolean;
  pendingTagBuffer: string;
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
    recentChunks: [],
    repetitionDetected: false,
    inThinkBlock: false,
    pendingTagBuffer: "",
  };
}

/**
 * Detect if the model is stuck in a repetition loop.
 *
 * BALANCED THRESHOLDS (fixed after false-positive on markdown tables):
 * The old detector (6 repetitions of 10-char phrases) triggered on legitimate
 * markdown formatting like table cells ("| Siste...") or bullet lists
 * ("- **Gacha..."). The new thresholds are:
 *   - Minimum phrase length: 25 chars (too short = markdown fragments)
 *   - Repetition threshold: 8x (was 6x — markdown naturally repeats 6x)
 *   - Minimum alphanumeric chars: 15 (skip pure symbol/markdown phrases)
 *   - Window: last 3000 chars (was 2000 — need more context for longer phrases)
 *
 * The detector also SKIPS phrases that look like markdown formatting:
 *   - Phrases starting with |, -, #, *, >, or ``` (table cells, headers, etc.)
 *   - Phrases that are mostly symbols/punctuation (< 60% alphanumeric)
 */
function detectRepetition(state: StreamState): boolean {
  const content = state.totalContent;
  if (content.length < 300) return false;

  // Check the last 3000 chars for repetition
  const recent = content.slice(-3000);

  // Try to find a phrase (25-100 chars) that repeats 8+ times.
  // Start at 25 chars — shorter phrases are too often markdown fragments.
  for (let len = 25; len <= 100; len += 5) {
    // Sample phrases from different positions in the recent text
    for (let start = 0; start < recent.length - len * 8; start += Math.max(1, len)) {
      const phrase = recent.slice(start, start + len);
      const trimmed = phrase.trim();

      // Skip whitespace-only or trivial phrases
      if (trimmed.length < 20) continue;

      // Skip phrases that look like markdown formatting (false-positive source):
      //   - Starts with markdown markers: |, -, #, *, >, ```, 1., 2.
      //   - Mostly symbols/punctuation (< 60% alphanumeric)
      if (/^[|\-#*>`]/.test(trimmed)) continue;
      if (/^\d+\.\s/.test(trimmed)) continue;

      const alphaNumCount = (trimmed.match(/[a-zA-Z0-9à-úÀ-Ú]/g) ?? []).length;
      if (alphaNumCount / trimmed.length < 0.6) continue;

      // Count occurrences in recent text
      let count = 0;
      let searchFrom = 0;
      while (count < 8) {
        const idx = recent.indexOf(phrase, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + len;
      }

      if (count >= 8) {
        console.log(`[REPETITION_DETECTED] Phrase "${phrase.slice(0, 50)}..." repeated ${count}x — aborting generation`);
        return true;
      }
    }
  }

  return false;
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

  // CRITICAL FIX: Hard request timeout.
  // If NVIDIA accepts TCP but never streams any data (server hang, LB issue),
  // the keepAliveAgent timeout (5 min) and OpenAI client timeout (5 min)
  // cover this. We don't add AbortSignal here because:
  //   1. The OpenAI client timeout (5 min) already handles this case
  //   2. AbortSignal.timeout() doesn't work well with vi.useFakeTimers in tests
  //   3. The socket timeout (5 min) on keepAliveAgent is the primary defense
  // If 5 min is too long, we can revisit — but for now, the layered timeouts
  // (socket + client) are sufficient.
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

/**
 * Length of the <think> opening tag.
 */
const THINK_OPEN_LEN = 7;  // "<think>".length
const THINK_CLOSE_LEN = 8; // "</think>".length

/**
 * Check if `s` ends with a prefix of `tag` (partial tag at end of buffer).
 * Returns the length of the partial match (1..tag.length-1), or 0 if no match.
 * Example: partialTagSuffix("hello <thi", "<think>") returns 4 ("<thi" is a prefix).
 */
function partialTagSuffix(s: string, tag: string): number {
  const maxCheck = Math.min(s.length, tag.length - 1);
  for (let i = maxCheck; i >= 1; i--) {
    const suffix = s.slice(s.length - i);
    if (tag.startsWith(suffix)) return i;
  }
  return 0;
}

function processContentChunk(
  state: StreamState,
  content: string,
  onStreamStart?: () => void,
  onToken?: (token: string) => void,
  onThinking?: () => void,
): void {
  if (state.isFirstChunk) {
    state.isFirstChunk = false;
    onStreamStart?.();
  }

  // If repetition was already detected, ignore further tokens
  if (state.repetitionDetected) return;

  // ── Real-time <think> tag filtering ──────────────────────────────
  // Some models (Kimi K2.6) embed reasoning as <think>...</think> inside
  // delta.content. We must filter these DURING streaming, not after,
  // because onToken sends tokens to the TUI in real-time. If we wait
  // until buildChatResponse to strip tags, the user has already seen
  // the reasoning text being "typed" on screen.
  //
  // State machine:
  //   - inThinkBlock=false: scan for "<think>". Emit text before it as
  //     normal content. Hold potential partial tag at end of buffer.
  //   - inThinkBlock=true: scan for "</think>". Call onThinking for
  //     reasoning content (don't emit to user). Hold partial at end.
  state.pendingTagBuffer += content;

  let emittedContent = "";
  let hadThinking = false;

  let safety = 1000; // prevent infinite loops on malformed input
  while (state.pendingTagBuffer.length > 0 && safety-- > 0) {
    if (!state.inThinkBlock) {
      const openIdx = state.pendingTagBuffer.indexOf("<think>");
      if (openIdx === -1) {
        // No complete opening tag. Check if buffer ends with a partial
        // "<think>" prefix (e.g. "<thi") and hold it back.
        const partialLen = partialTagSuffix(state.pendingTagBuffer, "<think>");
        const safeEnd = state.pendingTagBuffer.length - partialLen;
        if (safeEnd > 0) {
          emittedContent += state.pendingTagBuffer.slice(0, safeEnd);
          state.pendingTagBuffer = state.pendingTagBuffer.slice(safeEnd);
        }
        break; // waiting for more content to resolve the partial tag
      }
      // Emit everything before the <think> tag as normal content
      if (openIdx > 0) {
        emittedContent += state.pendingTagBuffer.slice(0, openIdx);
      }
      state.pendingTagBuffer = state.pendingTagBuffer.slice(openIdx + THINK_OPEN_LEN);
      state.inThinkBlock = true;
    } else {
      // Inside <think> block — look for closing </think> tag
      const closeIdx = state.pendingTagBuffer.indexOf("</think>");
      if (closeIdx === -1) {
        // No closing tag yet. The reasoning content in the buffer should
        // trigger onThinking but NOT be emitted to the user. Hold back
        // a potential partial "</think>" prefix at the end.
        const partialLen = partialTagSuffix(state.pendingTagBuffer, "</think>");
        const safeEnd = state.pendingTagBuffer.length - partialLen;
        if (safeEnd > 0) {
          hadThinking = true;
          state.pendingTagBuffer = state.pendingTagBuffer.slice(safeEnd);
        }
        break; // waiting for more content to find closing tag
      }
      // Found closing tag — everything up to it is reasoning content
      if (closeIdx > 0) {
        hadThinking = true;
      }
      state.pendingTagBuffer = state.pendingTagBuffer.slice(closeIdx + THINK_CLOSE_LEN);
      state.inThinkBlock = false;
    }
  }

  // Emit accumulated non-think content to the TUI
  if (emittedContent) {
    onToken?.(emittedContent);
    state.totalContent += emittedContent;
  } else if (content === "" && !state.inThinkBlock && state.pendingTagBuffer.length === 0) {
    // Heartbeat passthrough: some providers send empty content chunks as
    // keep-alive signals. The TUI uses onToken callbacks to update timing
    // metrics and keep the UI responsive. We must still call onToken("")
    // for these heartbeats — but ONLY when we're not inside a <think> block
    // and have no pending partial tag in the buffer.
    onToken?.("");
  }

  // Signal thinking indicator for reasoning content
  if (hadThinking) {
    onThinking?.();
  }

  // REPETITION DETECTION: check every ~500 chars if the model is looping
  if (state.totalContent.length > 200 && state.totalContent.length % 500 < content.length) {
    if (detectRepetition(state)) {
      state.repetitionDetected = true;
      state.finishReason = "repetition_detected";
      // Truncate repeated garbage
      state.totalContent = state.totalContent.slice(0, -500) +
        "\n\n[GERAÇÃO INTERROMPIDA: repetição detectada. Tente reformular sua pergunta.]";
      console.log("[REPETITION] Generation aborted — returning partial content");
    }
  }
}

/**
 * Flush any pending non-think content remaining in the tag buffer.
 * Called at the end of consumeStream to ensure no visible content is lost
 * when the stream ends with a partial tag prefix in the buffer.
 *
 * If we're inside a <think> block when the stream ends, the reasoning
 * content is discarded (the model never closed its <think> tag).
 */
function flushPendingTagBuffer(
  state: StreamState,
  onToken?: (token: string) => void,
): void {
  if (state.pendingTagBuffer.length === 0) return;

  if (!state.inThinkBlock) {
    // The pending buffer is a partial <think> prefix that never completed.
    // Emit it as normal content — it's not actually a think tag.
    const partial = state.pendingTagBuffer;
    state.pendingTagBuffer = "";
    onToken?.(partial);
    state.totalContent += partial;
  } else {
    // Inside a <think> block that never closed — discard reasoning content.
    state.pendingTagBuffer = "";
    state.inThinkBlock = false;
  }
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
    // BUG FIX (BUG 1 from /home/z/my-project session): NÃO fazer `return` aqui.
    // Modelos de reasoning (GLM-4.5, Kimi K2, DeepSeek R1, Qwen3) frequentemente
    // enviam chunks de transição com BOTH `reasoning_content` AND `content` no
    // mesmo delta — algo como `{ delta: { reasoning_content: "fim do pensamento",
    // content: "A resposta é" } }`. O `return` prematuro descartava silenciosamente
    // o `content`, fazendo a IA "perder" os primeiros caracteres da resposta.
    // Agora processamos reasoning E continuamos para checar tool_calls/content.
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
    processContentChunk(state, delta.content, onStreamStart, onToken, onThinking);
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
    // ABORT: if repetition was detected, stop consuming the stream
    if (state.repetitionDetected) {
      try { rawStream.controller?.abort?.(); } catch { /* ignore */ }
      break;
    }
    processStreamChunk(chunk, state, onStreamStart, onToken, onThinking);
  }
  // Flush any pending content left in the tag buffer (partial tags that
  // never completed, or leftover from a think block that never closed).
  flushPendingTagBuffer(state, onToken);
}

function buildChatResponse(state: StreamState): ChatResponse {
  const toolCallsList = Object.values(state.toolCallsAccumulator);

  // SAFETY NET: Strip any <think>...</think> tags that may have leaked through.
  // The primary filtering now happens in processContentChunk (real-time during
  // streaming), so totalContent should never contain <think> tags. This regex
  // cleanup is kept as a defense-in-depth for edge cases (e.g., uppercase
  // <THINK> variants that the streaming filter doesn't catch).
  let content = state.totalContent || null;
  if (content) {
    // Remove complete <think>...</think> blocks
    content = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
    // Remove unclosed <think> blocks (model still generating reasoning when stream ended)
    content = content.replace(/<think>[\s\S]*$/gi, "");
    // Remove stray </think> tags
    content = content.replace(/<\/think>/gi, "");
    content = content.trim();
    if (!content) content = null;
  }

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
          content: content,
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
  const modelHint = config.model ?? "this model";

  // Defer i18n import to avoid circular dependency at module load time
  // (apiClient is imported very early, before i18n is initialized)
  try {
    const { t } = require("./i18n.js") as { t: (key: string, ...args: unknown[]) => string };
    return t("error.429_quota", modelHint, errBody) + `\n\n   ${hint}`;
  } catch {
    // Fallback to EN if i18n not available
    return (
      `\nx  NVIDIA NIM API 429 error - ${hint}\n\n` +
      `   Possible causes:\n` +
      `     * Daily/monthly API key quota exhausted\n` +
      `     * Free-tier plan without access to ${modelHint}\n` +
      `     * Check: https://build.nvidia.com/ -> Usage & Billing\n\n` +
      `   Error details: ${errBody}`
    );
  }
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
  if (is403Error(err)) {
    return handle403Error(err, attempt);
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
  // Exponential backoff: 1s, 2s, 4s, 8s, 15s, 30s, 30s, 30s...
  const waitMs = Math.min(Math.pow(2, newAttempt - 1) * 1000, 30000);
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const status = apiErr?.status ?? (err as { status?: number })?.status ?? "?";
  log.warn(
    `Erro ${status} do servidor (transiente). ` +
    `Retry em ${waitMs / 1000}s (tentativa ${newAttempt}/${MAX_NETWORK_RETRIES})...`
  );
  await sleep(waitMs);
  return { retried: true, newAttempt };
}

// ── 403 retry handler ───────────────────────────────────────────────────────
// NVIDIA NIM ocasionalmente retorna 403 (Forbidden) sem motivo aparente —
// não é key expirada, não é rate limit, não é modelo removido. É um glitch
// temporário do servidor. Tentar novamente em 1s costuma resolver.
//
// Limite: 3 retries (4 tentativas total). Wait: 1s, 2s, 4s (backoff exponencial).
// Se falhar na 4ª, o erro propaga para o usuário com mensagem útil.
//
// Causas comuns de 403:
//   1. Glitch temporário do servidor NVIDIA (mais comum)
//   2. Key expirada ou revogada (verificar NVIDIA_API_KEY)
//   3. Contexto muito grande (histórico estourou limite do modelo)
//   4. Modelo temporariamente indisponível
const MAX_403_RETRIES = 3;

// INVARIANT: 403 retry should be >= 3 to handle transient NVIDIA glitches
import { invariant as _inv403 } from "./invariants.js";
_inv403(MAX_403_RETRIES >= 1, "403_RETRY_TOO_LOW", "MAX_403_RETRIES < 1 não retenta 403", { MAX_403_RETRIES });

function is403Error(err: unknown): boolean {
  const apiErr = err instanceof OpenAI.APIError ? err : null;
  const status = apiErr?.status ?? (err as { status?: number })?.status;
  return status === 403;
}

async function handle403Error(
  err: unknown,
  attempt: number,
): Promise<{ retried: boolean; newAttempt: number }> {
  if (attempt >= MAX_403_RETRIES) {
    // Última tentativa falhou — loga mensagem útil com possíveis causas
    log.error(
      `Erro 403 (Forbidden) persistente após ${MAX_403_RETRIES} tentativas. ` +
      `Possíveis causas:\n` +
      `  1. Glitch temporário do servidor NVIDIA (tente novamente em alguns minutos)\n` +
      `  2. Key expirada ou revogada (verifique NVIDIA_API_KEY no .env)\n` +
      `  3. Contexto muito grande (use /compact para reduzir o histórico)\n` +
      `  4. Modelo temporariamente indisponível (tente /model para trocar)\n` +
      `Erro original: ${(err as Error)?.message ?? String(err)}`
    );
    return { retried: false, newAttempt: attempt };
  }

  const newAttempt = attempt + 1;
  // Backoff exponencial: 1s, 2s, 4s
  const waitMs = Math.pow(2, attempt) * 1000;
  log.warn(
    `Erro 403 (Forbidden) — glitch temporário do servidor. ` +
    `Retry em ${waitMs / 1000}s (tentativa ${newAttempt}/${MAX_403_RETRIES})...`
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
  const errCode = getErrCode(err);

  // ETIMEDOUT / ECONNRESET: try a DIFFERENT API key immediately (no backoff)
  // instead of waiting. The NVIDIA API is often unstable per-key, so switching
  // to another key in the pool gives a better chance of success.
  if (TRANSIENT_NETWORK_CODES.has(errCode) && getPoolSize() > 1) {
    const availKeys = getAvailableKeyCount();
    if (availKeys > 0) {
      log.warn(
        `Erro de rede (${errCode}). ` +
        `Tentando outra key do pool imediatamente (tentativa ${newAttempt}/${MAX_NETWORK_RETRIES}, ${availKeys} keys disponíveis)...`
      );
      // No sleep — try immediately with a different key
      return { retried: true, newAttempt };
    }
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, 15s, 30s, 30s, 30s...
  const waitMs = Math.min(Math.pow(2, newAttempt - 1) * 1000, 30000);
  log.warn(
    `Erro de rede (${errCode}). ` +
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

