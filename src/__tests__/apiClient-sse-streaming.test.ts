/**
 * apiClient-sse-streaming.test.ts — Testa processamento de chunks SSE
 * realistas no apiClient.ts.
 *
 * Cobre:
 *   1. Streaming básico de texto (5 chunks, chunk vazio, 100 chunks)
 *   2. Reasoning content (delta.reasoning_content — "thinking")
 *   3. Tool calls no stream (completo, parcial em múltiplos chunks, múltiplos)
 *   4. Usage no chunk final (com e sem usage)
 *   5. finish_reason ("stop" e "tool_calls")
 *   6. Edge cases (choices vazio, delta vazio, stream sem [DONE])
 *
 * Estratégia: mock do pacote `openai` via vi.mock + vi.hoisted, simulação
 * de streams via async iterables (makeChunkStream), teste do processamento
 * REAL dos chunks em consumeStream/buildChatResponse através da função
 * pública chat(). Não usa fake timers — todos os testes são síncronos
 * em relação ao relógio.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── vi.hoisted: mocks compartilhados entre factory e testes ───────────────
const hoisted = vi.hoisted(() => {
  // Mock da classe APIError do pacote openai (mesma forma do apiClient-extended)
  class MockAPIError extends Error {
    status?: number;
    headers?: Record<string, string>;
    constructor(message: string, status?: number, headers?: Record<string, string>) {
      super(message);
      this.name = "APIError";
      this.status = status;
      this.headers = headers;
    }
  }

  return {
    createMock: vi.fn(),
    MockAPIError,

    // Config mutável por teste (apiClient lê config.rateLimitRpm no módulo load)
    configMock: {
      nvidiaApiKey: "test-key",
      nvidiaApiKeys: "",
      nvidiaApiKeysFile: "",
      nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
      model: "moonshotai/kimi-k2.6",
      rateLimitRpm: 1000,          // alto: rate limiter não bloqueia
      maxConcurrency: 1,
      maxHealRetries: 3,
      debug: false,
      contextWindowTokens: 128000,
      contextCompactThreshold: 0.75,
      contextWarnThreshold: 0.6,
      costPerKPrompt: 0,
      costPerKCompletion: 0,
      diffPreview: false,
      maxTokens: 4096,
      temperature: 0.6,
      topP: 0.9,
    },

    poolMock: {
      initApiKeyPool: vi.fn(() => false),
      getPoolSize: vi.fn(() => 0),
      acquireKeyForStreaming: vi.fn(),
      tryAcquireKeyImmediate: vi.fn(() => null),
      getAvailableKeyCount: vi.fn(() => 0),
      getTotalKeyCount: vi.fn(() => 0),
      getPoolStats: vi.fn(() => []),
      formatPoolStats: vi.fn(() => "[POOL] mock"),
    },

    providerMock: {
      providerSendsThinkingMode: vi.fn(() => false),
      getProviderReasoningField: vi.fn(() => "reasoning_content" as const),
      providerNeedsHedging: vi.fn(() => false),
      detectProvider: vi.fn(() => "nvidia" as const),
      getProviderConfig: vi.fn(() => ({
        name: "nvidia",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "test-key",
        sendThinkingMode: false,
        reasoningField: "reasoning_content" as const,
        needsHeartbeat: true,
        needsHedging: false,
        needsMultiKeyPool: true,
        maxConcurrentSubAgents: 2,
        heartbeatMaxTokens: 1,
      })),
      providerNeedsHeartbeat: vi.fn(() => true),
      getProviderMaxSubAgents: vi.fn(() => 2),
      providerUsesMultiKeyPool: vi.fn(() => true),
    },

    modelRegistryMock: {
      getModelInfo: vi.fn(() => ({
        id: "moonshotai/kimi-k2.6",
        name: "Kimi K2.6",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        costPer1MPrompt: 0,
        costPer1MCompletion: 0,
        supportsTools: true,
        supportsParallelTools: true,
        hasThinking: false,
        provider: "nvidia",
      })),
      getModelMaxOutputTokens: vi.fn(() => 8192),
      getModelContextWindow: vi.fn(() => 128000),
    },
  };
});

// ─── Mocks (devem vir antes de importar apiClient) ─────────────────────────

vi.mock("openai", () => {
  // A classe default precisa ter APIError como propriedade estática,
  // pois apiClient.ts usa `err instanceof OpenAI.APIError`.
  class MockOpenAI {
    static APIError = hoisted.MockAPIError;
    chat = {
      completions: {
        create: hoisted.createMock,
      },
    };
  }
  return {
    default: MockOpenAI,
    APIError: hoisted.MockAPIError,
  };
});

vi.mock("../config.js", () => ({ config: hoisted.configMock }));
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  throttle: vi.fn(),
}));
vi.mock("../apiKeyPool.js", () => hoisted.poolMock);
vi.mock("../apiProvider.js", () => hoisted.providerMock);
vi.mock("../modelRegistry.js", () => hoisted.modelRegistryMock);

// ─── Imports ───────────────────────────────────────────────────────────────

import { chat, type Message } from "../apiClient.js";

// ─── Helpers: streams mock (formato OpenAI SSE) ────────────────────────────

/**
 * Cria um async iterable que produz chunks no formato OpenAI SSE.
 * Simula o stream retornado por client.chat.completions.create({stream:true}).
 */
function makeChunkStream(chunks: any[]): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () => {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/** Chunk com delta.content (texto normal). */
function contentChunk(
  text: string,
  opts: { id?: string; model?: string; created?: number } = {},
): any {
  return {
    id: opts.id ?? "chatcmpl-test",
    model: opts.model ?? "moonshotai/kimi-k2.6",
    created: opts.created ?? 1700000000,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

/** Chunk com delta.reasoning_content (thinking — modelos com reasoning). */
function reasoningChunk(
  text: string,
  field: "reasoning_content" | "reasoning" = "reasoning_content",
): any {
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [{ index: 0, delta: { [field]: text }, finish_reason: null }],
  };
}

/** Chunk com delta.tool_calls (tool call delta — pode ser parcial). */
function toolCallChunk(
  index: number,
  id: string | undefined,
  functionName: string | undefined,
  argsFragment: string | undefined,
): any {
  const tc: any = { index, type: "function" };
  if (id !== undefined) tc.id = id;
  tc.function = {};
  if (functionName !== undefined) tc.function.name = functionName;
  if (argsFragment !== undefined) tc.function.arguments = argsFragment;
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [{ index: 0, delta: { tool_calls: [tc] }, finish_reason: null }],
  };
}

/** Chunk com apenas usage (sem choices — comum no final do stream NVIDIA NIM). */
function usageOnlyChunk(usage: any): any {
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    usage,
  };
}

/** Chunk com choices vazio (alguns providers enviam). */
function emptyChoicesChunk(usage?: any): any {
  const chunk: any = {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

/** Chunk com delta totalmente vazio (nenhum campo). */
function emptyDeltaChunk(finishReason: string | null = null): any {
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}

/** Chunk de finish (delta vazio + finish_reason + usage opcional). */
function finishChunk(finishReason: string, usage?: any): any {
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: usage,
  };
}

/** Chunk com apenas delta.role (primeiro chunk de alguns providers). */
function roleOnlyChunk(): any {
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  };
}

const sampleMessages: Message[] = [{ role: "user", content: "test" }];

// ─── Setup global ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.createMock.mockReset();
  // Default: stream simples "ok" + finish stop
  hoisted.createMock.mockImplementation(() =>
    Promise.resolve(makeChunkStream([contentChunk("ok"), finishChunk("stop")])),
  );

  // Pool desativado por default → cai em chatSingleKey
  hoisted.poolMock.getPoolSize.mockReturnValue(0);
  hoisted.poolMock.initApiKeyPool.mockReturnValue(false);
  hoisted.poolMock.acquireKeyForStreaming.mockReset();
  hoisted.poolMock.tryAcquireKeyImmediate.mockReset();
  hoisted.poolMock.tryAcquireKeyImmediate.mockReturnValue(null);
  hoisted.poolMock.getAvailableKeyCount.mockReturnValue(0);
  hoisted.poolMock.getTotalKeyCount.mockReturnValue(0);

  hoisted.providerMock.providerNeedsHedging.mockReturnValue(false);
  hoisted.providerMock.providerSendsThinkingMode.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 1. Streaming básico de texto ──────────────────────────────────────────

describe("Streaming básico de texto", () => {
  it("5 chunks com delta.content → texto acumulado corretamente", async () => {
    const stream = makeChunkStream([
      contentChunk("Hello"),
      contentChunk(" "),
      contentChunk("world"),
      contentChunk("!"),
      contentChunk(""), // 5º chunk vazio — BUG 2: agora também chama onToken
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    const response = await chat(sampleMessages, undefined, (t) => tokens.push(t));

    // Conteúdo acumulado = concatenação dos 4 chunks não-vazios (string vazia
    // não adiciona nada ao conteúdo total)
    expect(response.choices[0].message.content).toBe("Hello world!");
    // BUG 2 fix: onToken é chamado para TODOS os chunks de content, inclusive
    // o vazio (alguns provedores enviam chunks vazios como heartbeat).
    expect(tokens).toEqual(["Hello", " ", "world", "!", ""]);
  });

  it("1 chunk vazio (só role) → não crasha", async () => {
    // Alguns providers enviam um chunk inicial com delta.role apenas.
    const stream = makeChunkStream([
      roleOnlyChunk(),
      contentChunk("ok"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    // Chunk de role não gera conteúdo nem crasha
    expect(response.choices[0].message.content).toBe("ok");
    expect(response.choices[0].finish_reason).toBe("stop");
  });

  it("100 chunks pequenos → não degrada performance", async () => {
    // 100 chunks de 1 char cada — testa se o processamento escala linearmente.
    const chunks: any[] = [];
    for (let i = 0; i < 100; i++) chunks.push(contentChunk("a"));
    chunks.push(finishChunk("stop"));
    hoisted.createMock.mockResolvedValue(makeChunkStream(chunks));

    const start = Date.now();
    const response = await chat(sampleMessages);
    const elapsed = Date.now() - start;

    // Conteúdo = 100 "a"s concatenados
    expect(response.choices[0].message.content).toBe("a".repeat(100));
    // Deve processar 101 chunks em menos de 2s (normalmente < 50ms)
    expect(elapsed).toBeLessThan(2000);
    // Apenas 1 chamada ao create (sem retry)
    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. Reasoning content (thinking) ───────────────────────────────────────

describe("Reasoning content (thinking)", () => {
  it("Chunks com delta.reasoning_content → onThinking chamado", async () => {
    // 2 chunks de reasoning + 1 de content + finish
    const stream = makeChunkStream([
      reasoningChunk("pensamento 1"),
      reasoningChunk("pensamento 2"),
      contentChunk("resposta final"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    let thinkingCount = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      undefined,
      () => { thinkingCount++; },
    );

    // onThinking chamado 1x para cada chunk de reasoning (2 total)
    expect(thinkingCount).toBe(2);
    // Conteúdo final não inclui o reasoning (apenas o content)
    expect(response.choices[0].message.content).toBe("resposta final");
  });

  it("Mix de reasoning + content → ambos acumulados separadamente", async () => {
    // Stream com reasoning intercalado com content
    const stream = makeChunkStream([
      reasoningChunk("pensando..."),
      contentChunk("A resposta é "),
      contentChunk("42"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    let thinkingCount = 0;
    const tokens: string[] = [];
    let streamStartCount = 0;
    const response = await chat(
      sampleMessages,
      () => { streamStartCount++; },        // onStreamStart
      (t) => tokens.push(t),                 // onToken
      () => { thinkingCount++; },            // onThinking
    );

    // onThinking chamado 1x (chunk de reasoning)
    expect(thinkingCount).toBe(1);
    // onToken chamado 2x (chunks de content) — reasoning não gera tokens
    expect(tokens).toEqual(["A resposta é ", "42"]);
    // Conteúdo final contém APENAS o content (não o reasoning)
    expect(response.choices[0].message.content).toBe("A resposta é 42");
    // BUG 3 fix: onStreamStart é chamado quando o primeiro CONTENT chunk chega
    // (não quando o reasoning chega). Como removemos a manipulação de
    // isFirstChunk em processReasoningChunk, o flag ainda está true quando o
    // primeiro content chega → onStreamStart dispara exatamente 1x.
    expect(streamStartCount).toBe(1);
  });
});

// ─── 3. Tool calls no stream ───────────────────────────────────────────────

describe("Tool calls no stream", () => {
  it("1 tool_call completo (id, function.name, function.arguments)", async () => {
    // Um único chunk com o tool_call inteiro
    const stream = makeChunkStream([
      toolCallChunk(0, "call_abc", "ler_arquivo", '{"caminho":"/test.txt"}'),
      finishChunk("tool_calls"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.choices[0].message.tool_calls).toHaveLength(1);
    const tc = response.choices[0].message.tool_calls![0];
    expect(tc.id).toBe("call_abc");
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("ler_arquivo");
    expect(tc.function.arguments).toBe('{"caminho":"/test.txt"}');
    // finish_reason indica tool_calls
    expect(response.choices[0].finish_reason).toBe("tool_calls");
    // Sem conteúdo textual (só tool_call)
    expect(response.choices[0].message.content).toBeNull();
  });

  it("Tool_call com arguments em múltiplos chunks (JSON parcial)", async () => {
    // JSON quebrado em 2 chunks — simula streaming de arguments
    const stream = makeChunkStream([
      toolCallChunk(0, "call_1", "ler_arquivo", '{"caminho'),
      // Segundo chunk: só arguments (sem id nem name — já foram enviados)
      toolCallChunk(0, undefined, undefined, '":"/test.txt"}'),
      finishChunk("tool_calls"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    const tc = response.choices[0].message.tool_calls![0];
    expect(tc.id).toBe("call_1");
    expect(tc.function.name).toBe("ler_arquivo");
    // Arguments concatenados corretamente
    expect(tc.function.arguments).toBe('{"caminho":"/test.txt"}');
    // JSON resultante é válido
    expect(JSON.parse(tc.function.arguments)).toEqual({ caminho: "/test.txt" });
  });

  it("Múltiplos tool_calls no mesmo stream", async () => {
    // 2 tool_calls com índices diferentes (0 e 1)
    const stream = makeChunkStream([
      toolCallChunk(0, "call_a", "ler_arquivo", '{"caminho":"/a"}'),
      toolCallChunk(1, "call_b", "escrever_spec", '{"nome":"X"}'),
      finishChunk("tool_calls"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.choices[0].message.tool_calls).toHaveLength(2);
    const [tc0, tc1] = response.choices[0].message.tool_calls!;
    expect(tc0.id).toBe("call_a");
    expect(tc0.function.name).toBe("ler_arquivo");
    expect(tc0.function.arguments).toBe('{"caminho":"/a"}');
    expect(tc1.id).toBe("call_b");
    expect(tc1.function.name).toBe("escrever_spec");
    expect(tc1.function.arguments).toBe('{"nome":"X"}');
  });
});

// ─── 4. Usage no chunk final ───────────────────────────────────────────────

describe("Usage no chunk final", () => {
  it("Chunk final com usage (prompt_tokens, completion_tokens, total_tokens)", async () => {
    const stream = makeChunkStream([
      contentChunk("resposta"),
      finishChunk("stop", { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    });
  });

  it("Chunk final SEM usage → não crasha (alguns providers não enviam)", async () => {
    // finish chunk sem usage (undefined) — providers como ZenMux às vezes omitam
    const stream = makeChunkStream([
      contentChunk("resposta"),
      finishChunk("stop", undefined),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    // Conteúdo processado normalmente
    expect(response.choices[0].message.content).toBe("resposta");
    // Tokens ficam em 0 (sem usage no stream)
    expect(response.usage.prompt_tokens).toBe(0);
    expect(response.usage.completion_tokens).toBe(0);
    // total_tokens é calculado como prompt + completion
    expect(response.usage.total_tokens).toBe(0);
  });
});

// ─── 5. finish_reason ──────────────────────────────────────────────────────

describe("finish_reason", () => {
  it("finish_reason=\"stop\" → stream termina normalmente", async () => {
    const stream = makeChunkStream([
      contentChunk("texto"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.choices[0].finish_reason).toBe("stop");
    expect(response.choices[0].message.content).toBe("texto");
    // Sem tool_calls quando finish_reason é stop
    expect(response.choices[0].message.tool_calls).toBeUndefined();
  });

  it("finish_reason=\"tool_calls\" → stream termina indicando tool calls", async () => {
    const stream = makeChunkStream([
      toolCallChunk(0, "call_x", "ler_arquivo", "{}"),
      finishChunk("tool_calls"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    expect(response.choices[0].finish_reason).toBe("tool_calls");
    expect(response.choices[0].message.tool_calls).toBeDefined();
    expect(response.choices[0].message.tool_calls).toHaveLength(1);
  });
});

// ─── 6. Edge cases de stream ───────────────────────────────────────────────

describe("Edge cases de stream", () => {
  it("Chunk com choices vazio (só usage) → não crasha", async () => {
    // NVIDIA NIM envia o usage final num chunk separado sem choices.
    // Bug histórico: antes, esse chunk era descartado antes de ler o usage.
    const stream = makeChunkStream([
      contentChunk("texto"),
      emptyChoicesChunk({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    // Conteúdo processado normalmente
    expect(response.choices[0].message.content).toBe("texto");
    // Usage do chunk sem choices deve ser capturado (regression test)
    expect(response.usage.prompt_tokens).toBe(5);
    expect(response.usage.completion_tokens).toBe(3);
    expect(response.usage.total_tokens).toBe(8);
  });

  it("Chunk com delta vazio → não crasha", async () => {
    // Chunks com delta totalmente vazio (sem content, reasoning, tool_calls)
    const stream = makeChunkStream([
      emptyDeltaChunk(null),
      contentChunk("texto"),
      emptyDeltaChunk(null),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    // Chunks vazios são ignorados silenciosamente
    expect(response.choices[0].message.content).toBe("texto");
    expect(response.choices[0].finish_reason).toBe("stop");
  });

  it("Stream que termina abruptamente (sem [DONE]) → gracefully handle", async () => {
    // Stream SEM chunk de finish — só chunks de content.
    // O iterador termina normalmente após o último chunk (sem [DONE] marker).
    // BUG 4 fix: buildChatResponse agora defaulta finish_reason para null
    // (antes era "stop"), para que o caller possa distinguir streams que
    // terminaram abruptamente de streams que terminaram normalmente.
    const stream = makeChunkStream([
      contentChunk("texto"),
      contentChunk(" mais"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const response = await chat(sampleMessages);

    // Conteúdo acumulado corretamente
    expect(response.choices[0].message.content).toBe("texto mais");
    // finish_reason default null quando nenhum finishReason veio no stream
    expect(response.choices[0].finish_reason).toBeNull();
  });
});
