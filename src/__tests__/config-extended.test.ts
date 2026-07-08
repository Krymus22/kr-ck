/**
 * config-extended.test.ts - Expansão de cobertura de src/config.ts.
 *
 * Foca em cenários não cobertos por config.test.ts:
 *   - requireEnv (presente/ausente) — testado indiretamente via carregamento
 *     do módulo com diferentes combinações de env vars
 *   - optionalInt/Bool/Float com valores extremos (negativo, zero, decimal,
 *     string, vazio)
 *   - env var loading (NVIDIA_API_KEYS multi-key pool, NVIDIA_API_KEYS_FILE)
 *   - provider detection (NVIDIA via key única, ZenMux via ZENMUX_API_KEY,
 *     override via API_PROVIDER)
 *   - error messages (mensagens específicas para cada combinação de env
 *     ausente)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("Config (extended)", () => {
  beforeEach(() => {
    vi.resetModules();
    // Limpa todas as env vars relevantes antes de cada teste
    delete process.env.NVIDIA_API_KEY;
    delete process.env.NVIDIA_API_KEYS;
    delete process.env.NVIDIA_API_KEYS_FILE;
    delete process.env.ZENMUX_API_KEY;
    delete process.env.API_PROVIDER;
    delete process.env.MODEL;
    delete process.env.MAX_TOKENS;
    delete process.env.RATE_LIMIT_RPM;
    delete process.env.MAX_CONCURRENCY;
    delete process.env.MAX_HEAL_RETRIES;
    delete process.env.TEMPERATURE;
    delete process.env.TOP_P;
    delete process.env.DEBUG;
    delete process.env.DIFF_PREVIEW;
    delete process.env.CONTEXT_WINDOW_TOKENS;
    delete process.env.CONTEXT_COMPACT_THRESHOLD;
    delete process.env.CONTEXT_WARN_THRESHOLD;
    delete process.env.COST_PER_K_PROMPT;
    delete process.env.COST_PER_K_COMPLETION;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- requireEnv: presente vs ausente (via carregamento do módulo) ---------

  it("carrega com sucesso quando NVIDIA_API_KEY está presente (requireEnv ok)", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-12345";
    const { config } = await import("../config.js");
    expect(config.nvidiaApiKey).toBe("nvapi-12345");
    expect(config.apiProvider).toBe("nvidia");
  });

  it("chama process.exit(1) com mensagem sobre NVIDIA_API_KEY quando todas ausentes", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit called");
    }) as any);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("../config.js");
    } catch (e: any) {
      expect(e.message).toBe("exit called");
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    // Mensagem menciona as três opções
    const msg = errorSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("NVIDIA_API_KEY");
    expect(msg).toContain("NVIDIA_API_KEYS");
    expect(msg).toContain("ZENMUX_API_KEY");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // --- optionalInt edge cases ------------------------------------------------

  it("optionalInt retorna fallback quando env é string vazia", async () => {
    process.env.NVIDIA_API_KEY = "k";
    process.env.MAX_TOKENS = "";
    const { config } = await import("../config.js");
    // Number.parseInt("") é NaN, então fallback
    expect(config.maxTokens).toBe(131072);
  });

  it("optionalInt aceita valor decimal (trunca para int)", async () => {
    process.env.NVIDIA_API_KEY = "k";
    process.env.MAX_TOKENS = "100.99";
    const { config } = await import("../config.js");
    expect(config.maxTokens).toBe(100);
  });

  it("optionalInt aceita valor negativo", async () => {
    process.env.NVIDIA_API_KEY = "k";
    process.env.RATE_LIMIT_RPM = "-5";
    const { config } = await import("../config.js");
    expect(config.rateLimitRpm).toBe(-5);
  });

  it("maxConcurrency é sempre capppado em 1 mesmo com valor negativo", async () => {
    process.env.NVIDIA_API_KEY = "k";
    process.env.MAX_CONCURRENCY = "-1";
    const { config } = await import("../config.js");
    // BUG FIX: Math.max(1, Math.min(-1, 1)) = 1 (clamped to [1, 1]).
    // Previously this returned -1 (Math.min(-1, 1) = -1), which broke the
    // concurrency limiter. Per BUSINESS_RULES §2: maxConcurrency is a hard
    // limit of 1, so negative values must be clamped up to 1.
    expect(config.maxConcurrency).toBe(1);
  });

  // --- optionalBool edge cases ----------------------------------------------

  it("optionalBool trata 'true' e 'false' case-insensitive", async () => {
    process.env.NVIDIA_API_KEY = "k";
    process.env.DEBUG = "TRUE";
    const { config: c1 } = await import("../config.js");
    expect(c1.debug).toBe(true);
  });

  it("optionalBool retorna fallback quando valor não é true/false/1/0", async () => {
    process.env.NVIDIA_API_KEY = "k";
    process.env.DIFF_PREVIEW = "yes";
    const { config } = await import("../config.js");
    expect(config.diffPreview).toBe(true); // fallback default
  });

  // --- optionalFloat edge cases ---------------------------------------------

  it("optionalFloat aceita notação científica", async () => {
    process.env.NVIDIA_API_KEY = "k";
    process.env.TEMPERATURE = "1e-1";
    const { config } = await import("../config.js");
    expect(config.temperature).toBeCloseTo(0.1, 5);
  });

  it("optionalFloat retorna fallback quando valor é Infinity-like", async () => {
    process.env.NVIDIA_API_KEY = "k";
    // parseFloat("Infinity") = Infinity, mas Number.isFinite(Infinity) = false
    process.env.TOP_P = "Infinity";
    const { config } = await import("../config.js");
    expect(config.topP).toBe(0.95); // fallback
  });

  // --- env var loading (multi-key pool, AI_SEARCH) --------------------------

  it("carrega NVIDIA_API_KEYS (multi-key pool) sem NVIDIA_API_KEY", async () => {
    process.env.NVIDIA_API_KEYS = "nvapi-1,nvapi-2,nvapi-3";
    const { config } = await import("../config.js");
    expect(config.nvidiaApiKeys).toBe("nvapi-1,nvapi-2,nvapi-3");
    expect(config.apiProvider).toBe("nvidia");
  });

  it("carrega NVIDIA_API_KEYS_FILE quando presente", async () => {
    process.env.NVIDIA_API_KEY = "nvapi-main";
    process.env.NVIDIA_API_KEYS_FILE = "/path/to/keys.txt";
    const { config } = await import("../config.js");
    expect(config.nvidiaApiKeysFile).toBe("/path/to/keys.txt");
  });

  // --- provider detection ----------------------------------------------------

  it("detecta nvidia por padrão quando apenas NVIDIA_API_KEY está setada", async () => {
    process.env.NVIDIA_API_KEY = "k";
    const { config } = await import("../config.js");
    expect(config.apiProvider).toBe("nvidia");
    expect(config.nvidiaBaseUrl).toContain("integrate.api.nvidia.com");
  });

  it("detecta zenmux quando ZENMUX_API_KEY está setada e NVIDIA_API_KEY não", async () => {
    process.env.ZENMUX_API_KEY = "sk-ai-v1-xxx";
    const { config } = await import("../config.js");
    expect(config.apiProvider).toBe("zenmux");
    expect(config.nvidiaBaseUrl).toContain("zenmux.ai");
  });

  it("respeita API_PROVIDER=nvidia explícito mesmo com ZENMUX_API_KEY setada", async () => {
    process.env.NVIDIA_API_KEY = "nvapi";
    process.env.ZENMUX_API_KEY = "sk-ai-v1";
    process.env.API_PROVIDER = "nvidia";
    const { config } = await import("../config.js");
    expect(config.apiProvider).toBe("nvidia");
  });

  it("respeita API_PROVIDER=zenmux explícito mesmo com NVIDIA_API_KEY setada", async () => {
    process.env.NVIDIA_API_KEY = "nvapi";
    process.env.ZENMUX_API_KEY = "sk-ai-v1";
    process.env.API_PROVIDER = "zenmux";
    const { config } = await import("../config.js");
    expect(config.apiProvider).toBe("zenmux");
  });

  it("respeita API_PROVIDER=ZENMUX (case-insensitive, uppercase)", async () => {
    process.env.ZENMUX_API_KEY = "sk-ai-v1-zenmux";
    process.env.API_PROVIDER = "ZENMUX";
    const { config } = await import("../config.js");
    expect(config.apiProvider).toBe("zenmux");
  });

  // --- error messages --------------------------------------------------------

  it("exibe mensagem sobre ausência de API key quando nenhuma env está setada", async () => {
    // Mensagem vem de apiProvider.ts getProviderConfig
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit called");
    }) as any);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("../config.js");
    } catch {
      // expected
    }
    const msg = errorSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain("No API key configured");
    expect(msg).toContain("NVIDIA_API_KEY");
    expect(msg).toContain("ZENMUX_API_KEY");
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
