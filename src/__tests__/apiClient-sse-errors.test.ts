/**
 * apiClient-sse-errors.test.ts — Testa cenários de erro e recovery do
 * apiClient.ts com streaming SSE.
 *
 * Cobre:
 *   1. Rate limit (429) — Retry-After curto, longo, ausente
 *   2. Server errors (5xx) — 500 e 503
 *   3. Network errors — connection drop mid-stream, ETIMEDOUT, ECONNRESET
 *   4. Hedging (NVIDIA-specific) — primary lento >5s, primary rápido <5s
 *   5. Pool behavior — todas ocupadas, key em cooldown
 *
 * Estratégia: mock do pacote `openai` via vi.mock + vi.hoisted, simulação
 * de streams e erros. Fake timers (vi.useFakeTimers + advanceTimersByTimeAsync)
 * para testar retry backoff e hedging. Testa o comportamento REAL das funções
 * internas (handle429Error, handleTransientNetworkError, chatWithPool) através
 * da função pública chat().
 *
 * NOTA: o apiClient.ts NÃO retenta 500 (geralmente é bug real no servidor).
 * 502 e 503 SÃO retried (BUG 1 fix) — frequentemente são transientes.
 * Erros de rede (ECONNRESET, ETIMEDOUT, etc.) também são retried.
 * Os testes refletem o comportamento real do código.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── vi.hoisted: mocks compartilhados entre factory e testes ───────────────
const hoisted = vi.hoisted(() => {
  // Mock da classe APIError do pacote openai
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

    configMock: {
      nvidiaApiKey: "test-key",
      nvidiaApiKeys: "",
      nvidiaApiKeysFile: "",
      nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
      model: "moonshotai/kimi-k2.6",
      rateLimitRpm: 1000,          // alto: rate limiter não bloqueia nos retries
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

// ─── Helpers: streams mock ─────────────────────────────────────────────────

/** Cria um async iterable que produz chunks no formato OpenAI SSE. */
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

/** Cria um stream que produz alguns chunks e DEPOIS lança um erro
 * (simula connection drop no meio do stream). */
function makeDroppingStream(chunks: any[], errorAtEnd: Error): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      let threw = false;
      return {
        next: async () => {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          if (!threw) {
            threw = true;
            throw errorAtEnd;
          }
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/** Cria um stream que nunca produz nenhum chunk nem termina (pending forever). */
function makePendingForeverStream(): AsyncIterable<any> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<any>>(() => {}), // nunca resolve
      };
    },
  };
}

function contentChunk(text: string): any {
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function finishChunk(finishReason: string, usage?: any): any {
  return {
    id: "chatcmpl-test",
    model: "moonshotai/kimi-k2.6",
    created: 1700000000,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: usage,
  };
}

/** Stream simples com texto + finish stop. */
function simpleStream(text = "ok"): AsyncIterable<any> {
  return makeChunkStream([contentChunk(text), finishChunk("stop")]);
}

/** Cria um erro 429 (APIError) com headers opcionais. */
function make429Error(retryAfter?: string): InstanceType<typeof hoisted.MockAPIError> {
  const headers: Record<string, string> = {};
  if (retryAfter !== undefined) headers["retry-after"] = retryAfter;
  return new hoisted.MockAPIError("rate limited", 429, headers);
}

/** Cria um erro 5xx (APIError). */
function make5xxError(status: number, message: string): InstanceType<typeof hoisted.MockAPIError> {
  return new hoisted.MockAPIError(message, status);
}

/** Cria um erro de rede transiente (ECONNRESET, ETIMEDOUT, etc.). */
function makeNetworkError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const sampleMessages: Message[] = [{ role: "user", content: "test" }];

// ─── Setup global ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.createMock.mockReset();
  hoisted.createMock.mockImplementation(() => Promise.resolve(simpleStream()));

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

// ─── 1. Rate limit (429) ───────────────────────────────────────────────────

describe("Rate limit (429)", () => {
  it("429 com Retry-After curto (5s) → retry com backoff → sucesso", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // Primeira chamada rejeita com 429 + Retry-After: 5
    // Segunda chamada resolve com stream de sucesso
    hoisted.createMock
      .mockReturnValueOnce(Promise.reject(make429Error("5")))
      .mockResolvedValueOnce(simpleStream("depois do retry"));

    const p = chat(sampleMessages);
    // Retry-After=5s → sleep = 5*1000 + 500 = 5500ms
    await vi.advanceTimersByTimeAsync(6_000);
    const response = await p;

    // 2 chamadas ao create (1 inicial + 1 retry)
    expect(hoisted.createMock).toHaveBeenCalledTimes(2);
    expect(response.choices[0].message.content).toBe("depois do retry");
  });

  it("429 com Retry-After longo (120s) → NÃO retry (quota exhausted) → erro propagado", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // Retry-After=120s > MAX_RETRY_AFTER_S (90s) → quota exhausted → throw
    hoisted.createMock.mockRejectedValue(make429Error("120"));

    const p = chat(sampleMessages);
    // Registra handler ANTES de avançar o tempo (evita unhandled rejection)
    const assertion = expect(p).rejects.toThrow(/429|quota/i);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    // Apenas 1 chamada — não retry
    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });

  it("429 sem Retry-After → NÃO retry → erro propagado", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // 429 sem header retry-after → NaN → quota exhausted → throw
    hoisted.createMock.mockRejectedValue(make429Error(undefined));

    const p = chat(sampleMessages);
    const assertion = expect(p).rejects.toThrow(/429|quota/i);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    // Apenas 1 chamada — não retry
    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. Server errors (5xx) ────────────────────────────────────────────────

describe("Server errors (5xx)", () => {
  // NOTA: apiClient.ts NÃO retenta 500 (geralmente é bug real no servidor).
  // 502 e 503 SÃO retried (BUG 1 fix) — frequentemente são transientes
  // (gateway restart, deploy, overload momentâneo).

  it("500 internal server error → NÃO retry → erro propagado", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    hoisted.createMock.mockRejectedValue(make5xxError(500, "internal server error"));

    const p = chat(sampleMessages);
    const assertion = expect(p).rejects.toThrow("internal server error");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    // Apenas 1 chamada — 500 NÃO é retried (bug real no servidor)
    expect(hoisted.createMock).toHaveBeenCalledTimes(1);
  });

  it("503 service unavailable → RETRY com backoff → erro propagado após esgotar retries (BUG 1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // BUG 1 fix: 503 agora é retried (transiente). Retry 8x com backoff
    // crescente (exponential backoff 1s+2s+4s+8s+15s+30s+30s...), depois
    // propaga o erro.
    hoisted.createMock.mockRejectedValue(make5xxError(503, "service unavailable"));

    const p = chat(sampleMessages);
    // Registra handler ANTES de avançar o tempo (evita unhandled rejection)
    const assertion = expect(p).rejects.toThrow("service unavailable");
    // 15 retries com backoff crescente → 16500ms no total
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // 1 chamada inicial + 15 retries = 16 chamadas
    expect(hoisted.createMock).toHaveBeenCalledTimes(9);
  });

  it("502 bad gateway → RETRY com backoff → erro propagado após esgotar retries (BUG 1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // BUG 1 fix: 502 também é retried (mesmo motivo que 503).
    hoisted.createMock.mockRejectedValue(make5xxError(502, "bad gateway"));

    const p = chat(sampleMessages);
    const assertion = expect(p).rejects.toThrow("bad gateway");
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // 1 inicial + 15 retries = 16
    expect(hoisted.createMock).toHaveBeenCalledTimes(9);
  });
});

// ─── 3. Network errors ─────────────────────────────────────────────────────

describe("Network errors", () => {
  it("Connection drop no meio do stream → stream interrompido gracefully", async () => {
    // Stream produz 2 chunks e depois lança erro (connection drop)
    const droppingStream = makeDroppingStream(
      [contentChunk("partial"), contentChunk(" content")],
      new Error("stream interrupted"),
    );
    hoisted.createMock.mockResolvedValue(droppingStream);

    // chat() deve rejeitar com o erro do stream
    await expect(chat(sampleMessages)).rejects.toThrow("stream interrupted");

    // Mutex é liberado no finally — chamada subsequente funciona normalmente
    hoisted.createMock.mockResolvedValue(simpleStream("recuperado"));
    const response = await chat(sampleMessages);
    expect(response.choices[0].message.content).toBe("recuperado");
  });

  it("ETIMEDOUT → erro propagado com mensagem clara", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // ETIMEDOUT é erro de rede transiente → retry até MAX_NETWORK_RETRIES (15)
    const err = makeNetworkError("ETIMEDOUT", "Connection timed out");
    hoisted.createMock.mockRejectedValue(err);

    const p = chat(sampleMessages);
    // Registra handler antes de avançar tempo
    const assertion = expect(p).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: expect.stringMatching(/timed out/i),
    });
    // 15 retries com backoff crescente (exponential backoff 1s+2s+4s+8s+15s+30s+30s...)
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // 1 chamada inicial + 15 retries = 16 chamadas
    expect(hoisted.createMock).toHaveBeenCalledTimes(9);
  });

  it("ECONNRESET → erro propagado", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // ECONNRESET também é transiente → retry 8x depois propaga
    const err = makeNetworkError("ECONNRESET", "socket hang up");
    hoisted.createMock.mockRejectedValue(err);

    const p = chat(sampleMessages);
    const assertion = expect(p).rejects.toMatchObject({
      code: "ECONNRESET",
      message: expect.stringMatching(/socket hang up/i),
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;

    // 1 inicial + 15 retries = 16
    expect(hoisted.createMock).toHaveBeenCalledTimes(9);
  });
});

// ─── 4. Hedging (NVIDIA-specific) ──────────────────────────────────────────

describe("Hedging (NVIDIA-specific)", () => {
  it("Primary demora >5s, hedge dispara no key 2 → hedge vence", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // Configura pool com 2 keys, hedging habilitado
    hoisted.providerMock.providerNeedsHedging.mockReturnValue(true);
    hoisted.poolMock.getAvailableKeyCount.mockReturnValue(1);
    hoisted.poolMock.getTotalKeyCount.mockReturnValue(2);
    hoisted.poolMock.getPoolSize.mockReturnValue(2);

    // Primary: createMock retorna promise controlada (resolve manualmente)
    let resolvePrimary: (v: any) => void = () => {};
    const primaryPromise = new Promise((resolve) => { resolvePrimary = resolve; });
    const primaryCreate = vi.fn().mockReturnValue(primaryPromise);
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: vi.fn(),
    });

    // Hedge: stream rápido com conteúdo "hedge response"
    const hedgeStream = makeChunkStream([
      contentChunk("hedge response"),
      finishChunk("stop"),
    ]);
    const hedgeCreate = vi.fn().mockResolvedValue(hedgeStream);
    hoisted.poolMock.tryAcquireKeyImmediate.mockReturnValue({
      client: { chat: { completions: { create: hedgeCreate } } },
      entry: { index: 1 },
      release: vi.fn(),
    });

    const p = chat(sampleMessages);

    // Antes de 5s — hedge NÃO disparou
    await vi.advanceTimersByTimeAsync(100);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).not.toHaveBeenCalled();

    // Após 5s — hedge timer dispara (primary ainda pendente)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).toHaveBeenCalledTimes(1);

    // Resolve primary com stream que nunca completa (pending forever)
    // → hedge vence a corrida
    resolvePrimary(makePendingForeverStream());

    // Deixa microtasks settarem — hedge stream consome 2 chunks e completa
    await vi.advanceTimersByTimeAsync(200);
    const response = await p;

    // Resposta vem do hedge (não do primary)
    expect(response.choices[0].message.content).toBe("hedge response");
    // Hedge create foi chamado
    expect(hedgeCreate).toHaveBeenCalledTimes(1);
  });

  it("Primary começa a streamar antes de 5s → hedge NÃO dispara", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    hoisted.providerMock.providerNeedsHedging.mockReturnValue(true);
    hoisted.poolMock.getAvailableKeyCount.mockReturnValue(1);
    hoisted.poolMock.getTotalKeyCount.mockReturnValue(2);
    hoisted.poolMock.getPoolSize.mockReturnValue(2);

    // Primary: resolve rapidamente com stream completo
    const primaryCreate = vi.fn().mockResolvedValue(simpleStream("primary response"));
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: primaryCreate } } },
      entry: { index: 0 },
      release: vi.fn(),
    });

    const p = chat(sampleMessages);
    // Primary resolve em <100ms — primaryStreamStarted = true
    await vi.advanceTimersByTimeAsync(100);
    const response = await p;

    // Avança bem além de 5s — hedge NÃO deveria ter disparado
    await vi.advanceTimersByTimeAsync(6_000);
    expect(hoisted.poolMock.tryAcquireKeyImmediate).not.toHaveBeenCalled();

    // Resposta vem do primary
    expect(response.choices[0].message.content).toBe("primary response");
  });
});

// ─── 5. Pool behavior ──────────────────────────────────────────────────────

describe("Pool behavior", () => {
  it("4 keys no pool, todas ocupadas → espera liberar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // Pool com 4 keys
    hoisted.poolMock.getPoolSize.mockReturnValue(4);

    // acquireKeyForStreaming bloqueia (simula: todas as 4 keys ocupadas)
    let resolveAcquire: (v: any) => void = () => {};
    const acquirePromise = new Promise((resolve) => { resolveAcquire = resolve; });
    hoisted.poolMock.acquireKeyForStreaming.mockReturnValue(acquirePromise);

    const poolRelease = vi.fn();
    const poolCreate = vi.fn().mockResolvedValue(simpleStream("depois de esperar"));

    const p = chat(sampleMessages);

    // Avança tempo — chat() ainda bloqueado em acquireKeyForStreaming
    await vi.advanceTimersByTimeAsync(500);
    expect(poolCreate).not.toHaveBeenCalled();

    // Libera uma key — acquire resolve
    resolveAcquire({
      client: { chat: { completions: { create: poolCreate } } },
      entry: { index: 0 },
      release: poolRelease,
    });

    // Agora chat() prossegue
    await vi.advanceTimersByTimeAsync(100);
    const response = await p;

    expect(response.choices[0].message.content).toBe("depois de esperar");
    expect(poolCreate).toHaveBeenCalledTimes(1);
    expect(poolRelease).toHaveBeenCalledTimes(1);
    // Liberada com sucesso
    expect(poolRelease.mock.calls[0][0]).toBe(true);
  });

  it("Key com cooldown pós-429 → pula pra próxima key", async () => {
    // Simula: key #0 em cooldown (pós-429), pool retorna key #1
    hoisted.poolMock.getPoolSize.mockReturnValue(4);

    const poolRelease = vi.fn();
    const poolCreate = vi.fn().mockResolvedValue(simpleStream("from key 1"));

    // acquireKeyForStreaming retorna handle da key #1 (skip da #0 em cooldown)
    hoisted.poolMock.acquireKeyForStreaming.mockResolvedValue({
      client: { chat: { completions: { create: poolCreate } } },
      entry: { index: 1 }, // skip da key #0 (cooldown)
      release: poolRelease,
    });

    const response = await chat(sampleMessages);

    // Resposta veio da key #1
    expect(response.choices[0].message.content).toBe("from key 1");
    expect(hoisted.poolMock.acquireKeyForStreaming).toHaveBeenCalledTimes(1);
    // Release chamado para a key #1 (entry.index=1)
    expect(poolRelease).toHaveBeenCalledTimes(1);
  });
});
