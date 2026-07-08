/**
 * regression-bug-hunter-4-apiClient.test.ts — Regression tests for the
 * apiClient.ts buildQuotaExhaustedMessage fix (require() → dynamic import).
 *
 * This file is SEPARATE from regression-bug-hunter-4.test.ts because the
 * tests here require module-level vi.mock() of openai/config/apiKeyPool/
 * apiProvider/modelRegistry. Those mocks would interfere with the direct
 * apiKeyPool tests in the sibling file.
 *
 * Bug fixed:
 *   apiClient.ts buildQuotaExhaustedMessage — was using require("./i18n.js")
 *   which violates the ESM-only convention (project's package.json has
 *   "type": "module"). Converted to async function with
 *   `await import("./i18n.js")`. Caller handle429Error is already async,
 *   so the new `throw new Error(await buildQuotaExhaustedMessage(...))`
 *   works without further changes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── vi.hoisted: mocks compartilhados entre factory e testes ───────────────
const apiClientHoisted = vi.hoisted(() => {
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
    static APIError = apiClientHoisted.MockAPIError;
    chat = {
      completions: {
        create: apiClientHoisted.createMock,
      },
    };
  }
  return { default: MockOpenAI, APIError: apiClientHoisted.MockAPIError };
});

vi.mock("../config.js", () => ({ config: apiClientHoisted.configMock }));
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
  throttle: vi.fn(),
}));
vi.mock("../apiKeyPool.js", () => apiClientHoisted.poolMock);
vi.mock("../apiProvider.js", () => apiClientHoisted.providerMock);
vi.mock("../modelRegistry.js", () => apiClientHoisted.modelRegistryMock);

// Import chat AFTER mocks are registered.
import { chat } from "../apiClient.js";

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Bug Hunter #4 — apiClient buildQuotaExhaustedMessage uses dynamic import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClientHoisted.createMock.mockReset();
  });

  afterEach(async () => {
    vi.useRealTimers();
    // Restore default language (pt-BR) so subsequent test files that rely
    // on the i18n default aren't affected by setLanguage() calls in the
    // pt-BR / EN verification tests below.
    const i18n = await import("../i18n.js");
    i18n.setLanguage("pt-BR");
  });

  it("429 with long Retry-After still produces a quota-exhausted error (not 'require is not defined')", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // Retry-After=120s > MAX_RETRY_AFTER_S (90s) → quota exhausted → throw
    // (buildQuotaExhaustedMessage now uses `await import("./i18n.js")` instead
    // of `require("./i18n.js")` — this would have thrown "require is not
    // defined" in ESM before the fix.)
    const err429 = new apiClientHoisted.MockAPIError("rate limited", 429, { "retry-after": "120" });
    apiClientHoisted.createMock.mockRejectedValue(err429);

    const p = chat([{ role: "user", content: "hi" }]);
    const assertion = expect(p).rejects.toThrow(/429|quota/i);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    // Only 1 call — quota exhausted is NOT retried
    expect(apiClientHoisted.createMock).toHaveBeenCalledTimes(1);
  });

  it("429 with no Retry-After header still produces a quota-exhausted error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // No retry-after header → NaN → quota exhausted → throw
    const err429 = new apiClientHoisted.MockAPIError("rate limited", 429, {});
    apiClientHoisted.createMock.mockRejectedValue(err429);

    const p = chat([{ role: "user", content: "hi" }]);
    const assertion = expect(p).rejects.toThrow(/429|quota/i);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(apiClientHoisted.createMock).toHaveBeenCalledTimes(1);
  });

  it("429 with Retry-After > MAX_RETRY_AFTER_S (90s) is treated as quota exhausted (§3.1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // Retry-After=91s > 90s → quota exhausted → throw
    const err429 = new apiClientHoisted.MockAPIError("rate limited", 429, { "retry-after": "91" });
    apiClientHoisted.createMock.mockRejectedValue(err429);

    const p = chat([{ role: "user", content: "hi" }]);
    const assertion = expect(p).rejects.toThrow(/429|quota/i);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(apiClientHoisted.createMock).toHaveBeenCalledTimes(1);
  });

  it("error message includes 'quota' (clear user feedback about exhausted quota)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const err429 = new apiClientHoisted.MockAPIError("rate limited", 429, {});
    apiClientHoisted.createMock.mockRejectedValue(err429);

    // Register the rejection handler BEFORE advancing timers to avoid
    // unhandled rejection.
    let caught: unknown = null;
    const p = chat([{ role: "user", content: "hi" }]);
    p.catch((e: unknown) => { caught = e; });

    // Advance fake timers so the async chat() pipeline can settle.
    await vi.advanceTimersByTimeAsync(500);
    // Yield a microtask tick so the .catch handler runs.
    await Promise.resolve();
    await Promise.resolve();

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message.toLowerCase();
    expect(msg).toMatch(/429|quota/);
  });

  // ─── Round 4 deep audit: pt-BR translation is actually used ───────────────
  //
  // The default language (per i18n.ts detectLanguage()) is "pt-BR". The
  // dynamic-import fix in buildQuotaExhaustedMessage calls
  // `t("error.429_quota", ...)` which should return the pt-BR translation.
  // The tests above only assert `/429|quota/i` which matches BOTH the EN
  // and pt-BR translations (because both contain "429"). This test
  // specifically verifies the pt-BR translation is returned — if the
  // dynamic import silently fell back to the EN branch (e.g., due to a
  // future regression where the import failed), the message would NOT
  // contain the pt-BR-specific marker "Detalhes do erro" or "Possíveis
  // causas".

  it("pt-BR translation is used (default language) — message contains PT-BR markers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    // Force pt-BR (the project default) so the test is deterministic
    // regardless of any test-ordering effects on the i18n module cache.
    const i18n = await import("../i18n.js");
    i18n.setLanguage("pt-BR");

    const err429 = new apiClientHoisted.MockAPIError("rate limited", 429, {});
    apiClientHoisted.createMock.mockRejectedValue(err429);

    let caught: unknown = null;
    const p = chat([{ role: "user", content: "hi" }]);
    p.catch((e: unknown) => { caught = e; });

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // PT-BR markers (present in the pt-BR translation of error.429_quota):
    expect(msg).toContain("Erro 429");
    expect(msg).toContain("Possíveis causas");
    expect(msg).toContain("Detalhes do erro");
    // Should NOT contain EN-only markers:
    expect(msg).not.toContain("Possible causes");
    expect(msg).not.toContain("Error details");
  });

  it("en translation is used when language is forced to 'en' — message contains EN markers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date(0));

    const i18n = await import("../i18n.js");
    i18n.setLanguage("en");

    const err429 = new apiClientHoisted.MockAPIError("rate limited", 429, {});
    apiClientHoisted.createMock.mockRejectedValue(err429);

    let caught: unknown = null;
    const p = chat([{ role: "user", content: "hi" }]);
    p.catch((e: unknown) => { caught = e; });

    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    await Promise.resolve();

    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    // EN markers:
    expect(msg).toContain("NVIDIA NIM API 429 error");
    expect(msg).toContain("Possible causes");
    expect(msg).toContain("Error details");
    // Should NOT contain PT-BR markers:
    expect(msg).not.toContain("Possíveis causas");

    // (Language is restored to pt-BR by afterEach.)
  });
});
