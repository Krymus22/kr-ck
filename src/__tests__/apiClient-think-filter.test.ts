/**
 * apiClient-think-filter.test.ts — Testes do filtro de <think> tags em streaming
 *
 * Verifica que o reasoning embutido como <think>...</think> dentro de
 * delta.content é filtrado EM TEMPO REAL (durante o streaming), não após.
 *
 * Cobre os cenários:
 *   1. <think> no início do stream (antes do conteúdo real)
 *   2. <think> no meio do stream (depois de algum conteúdo)
 *   3. <think> tag dividida entre chunks (partial tag at boundary)
 *   4. <think> sem fechamento (stream terminou dentro do block)
 *   5. Texto que PARECE <think> mas não é (ex: "<thinking about>")
 *   6. Múltiplos <think> blocks no mesmo stream
 *   7. onThinking é chamado para reasoning, onToken NUNCA recebe reasoning
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── vi.hoisted: mocks compartilhados ───────────────────────────────────────
const hoisted = vi.hoisted(() => {
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
      rateLimitRpm: 1000,
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

import { chat, type Message } from "../apiClient.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockStream(chunks: any[]): AsyncIterable<any> {
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
    usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const sampleMessages: Message[] = [{ role: "user", content: "test" }];

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.createMock.mockReset();
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("apiClient — <think> tag filtering during streaming", () => {
  it("filtra <think> no início do stream — usuário não vê reasoning", async () => {
    const stream = mockStream([
      contentChunk("<think>I need to search for AI news</think>"),
      contentChunk("Here are the latest AI news."),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    // onToken deve receber APENAS o conteúdo real
    const fullTokenText = tokens.join("");
    expect(fullTokenText).not.toContain("<think>");
    expect(fullTokenText).not.toContain("I need to search for AI news");
    expect(fullTokenText).toContain("Here are the latest AI news.");

    // onThinking deve ter sido chamado
    expect(thinkingCalls).toBeGreaterThan(0);

    // Response final não deve conter <think>
    expect(response.choices[0].message.content).toBe("Here are the latest AI news.");
  });

  it("filtra <think> no meio do stream — conteúdo antes é preservado", async () => {
    const stream = mockStream([
      contentChunk("Let me search. "),
      contentChunk("<think>I should use the web search tool</think>"),
      contentChunk("Done!"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    expect(fullTokenText).toContain("Let me search.");
    expect(fullTokenText).not.toContain("I should use the web search tool");
    expect(fullTokenText).toContain("Done!");

    expect(thinkingCalls).toBeGreaterThan(0);
    expect(response.choices[0].message.content).toContain("Let me search.");
    expect(response.choices[0].message.content).toContain("Done!");
    expect(response.choices[0].message.content).not.toContain("<think>");
  });

  it("lida com <think> tag dividida entre chunks (boundary)", async () => {
    // Simula o tag sendo dividido: "<thi" + "nk>" + "reasoning" + "</th" + "ink>"
    const stream = mockStream([
      contentChunk("<thi"),
      contentChunk("nk>internal reasoning here"),
      contentChunk("</think>"),
      contentChunk("Visible response."),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    expect(fullTokenText).not.toContain("internal reasoning here");
    expect(fullTokenText).not.toContain("<think>");
    expect(fullTokenText).not.toContain("</think>");
    expect(fullTokenText).toContain("Visible response.");

    expect(thinkingCalls).toBeGreaterThan(0);
    expect(response.choices[0].message.content).toBe("Visible response.");
  });

  it("descarta <think> sem fechamento (stream terminou dentro do block)", async () => {
    const stream = mockStream([
      contentChunk("<think>reasoning that never closes"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    expect(fullTokenText).not.toContain("reasoning that never closes");
    expect(fullTokenText).not.toContain("<think>");
    expect(thinkingCalls).toBeGreaterThan(0);

    // Como todo o conteúdo era reasoning, o content final deve ser null
    expect(response.choices[0].message.content).toBeNull();
  });

  it("NÃO confunde '<thinking about>' com tag <think>", async () => {
    const stream = mockStream([
      contentChunk("I am <thinking about> the problem"),
      contentChunk(" and here is my answer."),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    // O texto "<thinking about>" deve ser preservado (não é uma tag <think>)
    expect(fullTokenText).toContain("I am <thinking about> the problem");
    expect(fullTokenText).toContain("and here is my answer.");
    // onThinking não deve ser chamado pois não há <think> real
    expect(thinkingCalls).toBe(0);

    expect(response.choices[0].message.content).toContain("<thinking about>");
  });

  it("lida com múltiplos <think> blocks no mesmo stream", async () => {
    const stream = mockStream([
      contentChunk("<think>first reasoning</think>"),
      contentChunk("First answer. "),
      contentChunk("<think>second reasoning</think>"),
      contentChunk("Second answer."),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    expect(fullTokenText).not.toContain("first reasoning");
    expect(fullTokenText).not.toContain("second reasoning");
    expect(fullTokenText).not.toContain("<think>");
    expect(fullTokenText).toContain("First answer.");
    expect(fullTokenText).toContain("Second answer.");

    expect(thinkingCalls).toBeGreaterThanOrEqual(2);
    expect(response.choices[0].message.content).toContain("First answer.");
    expect(response.choices[0].message.content).toContain("Second answer.");
  });

  it("preserva conteúdo normal quando não há <think> tags", async () => {
    const stream = mockStream([
      contentChunk("Just a normal "),
      contentChunk("response without any thinking."),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    expect(fullTokenText).toBe("Just a normal response without any thinking.");
    expect(thinkingCalls).toBe(0);
    expect(response.choices[0].message.content).toBe("Just a normal response without any thinking.");
  });

  it("filtra <think> com quebras de linha dentro do reasoning", async () => {
    const stream = mockStream([
      contentChunk("<think>Line 1\nLine 2\nLine 3</think>"),
      contentChunk("Actual response."),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    expect(fullTokenText).not.toContain("Line 1");
    expect(fullTokenText).not.toContain("Line 2");
    expect(fullTokenText).not.toContain("Line 3");
    expect(fullTokenText).toContain("Actual response.");

    expect(thinkingCalls).toBeGreaterThan(0);
    expect(response.choices[0].message.content).toBe("Actual response.");
  });

  it("lida com <think> no final do stream sem conteúdo depois", async () => {
    const stream = mockStream([
      contentChunk("Real content here. "),
      contentChunk("<think>trailing reasoning</think>"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    expect(fullTokenText).toContain("Real content here.");
    expect(fullTokenText).not.toContain("trailing reasoning");

    expect(thinkingCalls).toBeGreaterThan(0);
    expect(response.choices[0].message.content).toContain("Real content here.");
  });

  it("partial <think> no final do stream é emitido como texto normal", async () => {
    // O stream termina com "<thi" que nunca completa o tag
    // Deve ser emitido como texto normal (não é um <think> real)
    const stream = mockStream([
      contentChunk("Hello "),
      contentChunk("<thi"),
      finishChunk("stop"),
    ]);
    hoisted.createMock.mockResolvedValue(stream);

    const tokens: string[] = [];
    let thinkingCalls = 0;
    const response = await chat(
      sampleMessages,
      undefined,
      (t) => tokens.push(t),
      () => thinkingCalls++,
    );

    const fullTokenText = tokens.join("");
    expect(fullTokenText).toContain("Hello");
    expect(fullTokenText).toContain("<thi"); // partial tag é texto normal
    expect(thinkingCalls).toBe(0);
    expect(response.choices[0].message.content).toContain("<thi");
  });
});
