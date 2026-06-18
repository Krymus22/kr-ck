/**
 * apiProvider.test.ts — tests for the API provider abstraction.
 *
 * Tests cover:
 *   - detectProvider() auto-detection (NVIDIA vs ZenMux)
 *   - getProviderConfig() returns correct config per provider
 *   - providerNeedsHeartbeat() (NVIDIA: yes, ZenMux: no)
 *   - providerNeedsHedging() (NVIDIA: yes, ZenMux: no)
 *   - providerSendsThinkingMode() (NVIDIA: yes, ZenMux: no)
 *   - getProviderMaxSubAgents() (NVIDIA: 2, ZenMux: 10)
 *   - getProviderReasoningField() (NVIDIA: reasoning_content, ZenMux: reasoning)
 *   - providerUsesMultiKeyPool() (NVIDIA: yes, ZenMux: no)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

const origEnv = { ...process.env };

beforeEach(() => {
  // Clean env
  delete process.env.API_PROVIDER;
  delete process.env.ZENMUX_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEYS;
  delete process.env.NVIDIA_API_KEYS_FILE;
  delete process.env.MODEL;
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...origEnv };
  vi.resetModules();
});

describe("apiProvider", () => {
  describe("detectProvider", () => {
    it("returns 'nvidia' by default when NVIDIA_API_KEY is set", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("nvidia");
    });

    it("returns 'zenmux' when API_PROVIDER=zenmux", async () => {
      process.env.API_PROVIDER = "zenmux";
      process.env.NVIDIA_API_KEY = "nvapi-test"; // also set, but explicit wins
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("zenmux");
    });

    it("returns 'nvidia' when API_PROVIDER=nvidia", async () => {
      process.env.API_PROVIDER = "nvidia";
      process.env.ZENMUX_API_KEY = "sk-test"; // also set, but explicit wins
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("nvidia");
    });

    it("returns 'zenmux' when only ZENMUX_API_KEY is set (auto-detect)", async () => {
      process.env.ZENMUX_API_KEY = "sk-ai-v1-test";
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("zenmux");
    });

    it("returns 'nvidia' when both keys are set (NVIDIA takes priority in auto-detect)", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      process.env.ZENMUX_API_KEY = "sk-test";
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("nvidia");
    });

    it("returns 'nvidia' when NVIDIA_API_KEYS is set (multi-key)", async () => {
      process.env.NVIDIA_API_KEYS = "nvapi-k1,nvapi-k2";
      const { detectProvider } = await import("../apiProvider.js");
      expect(detectProvider()).toBe("nvidia");
    });
  });

  describe("getProviderConfig — NVIDIA", () => {
    it("returns NVIDIA config with correct baseUrl", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      const cfg = getProviderConfig();
      expect(cfg.name).toBe("nvidia");
      expect(cfg.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
      expect(cfg.apiKey).toBe("nvapi-test");
    });

    it("NVIDIA sends thinking mode", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().sendThinkingMode).toBe(true);
    });

    it("NVIDIA needs heartbeat", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsHeartbeat).toBe(true);
    });

    it("NVIDIA needs hedging", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsHedging).toBe(true);
    });

    it("NVIDIA uses multi-key pool", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsMultiKeyPool).toBe(true);
    });

    it("NVIDIA max sub-agents is 2", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().maxConcurrentSubAgents).toBe(2);
    });

    it("NVIDIA reasoning field is 'reasoning_content'", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().reasoningField).toBe("reasoning_content");
    });
  });

  describe("getProviderConfig — ZenMux", () => {
    it("returns ZenMux config with correct baseUrl", async () => {
      process.env.ZENMUX_API_KEY = "sk-ai-v1-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      const cfg = getProviderConfig();
      expect(cfg.name).toBe("zenmux");
      expect(cfg.baseUrl).toBe("https://zenmux.ai/api/v1");
      expect(cfg.apiKey).toBe("sk-ai-v1-test");
    });

    it("ZenMux does NOT send thinking mode", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().sendThinkingMode).toBe(false);
    });

    it("ZenMux does NOT need heartbeat", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsHeartbeat).toBe(false);
    });

    it("ZenMux does NOT need hedging", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsHedging).toBe(false);
    });

    it("ZenMux does NOT use multi-key pool", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().needsMultiKeyPool).toBe(false);
    });

    it("ZenMux max sub-agents is 10", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().maxConcurrentSubAgents).toBe(10);
    });

    it("ZenMux reasoning field is 'reasoning'", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(getProviderConfig().reasoningField).toBe("reasoning");
    });
  });

  describe("helper functions", () => {
    it("providerNeedsHeartbeat() returns true for NVIDIA", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { providerNeedsHeartbeat } = await import("../apiProvider.js");
      expect(providerNeedsHeartbeat()).toBe(true);
    });

    it("providerNeedsHeartbeat() returns false for ZenMux", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { providerNeedsHeartbeat } = await import("../apiProvider.js");
      expect(providerNeedsHeartbeat()).toBe(false);
    });

    it("providerNeedsHedging() returns true for NVIDIA", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { providerNeedsHedging } = await import("../apiProvider.js");
      expect(providerNeedsHedging()).toBe(true);
    });

    it("providerNeedsHedging() returns false for ZenMux", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { providerNeedsHedging } = await import("../apiProvider.js");
      expect(providerNeedsHedging()).toBe(false);
    });

    it("providerSendsThinkingMode() returns true for NVIDIA", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { providerSendsThinkingMode } = await import("../apiProvider.js");
      expect(providerSendsThinkingMode()).toBe(true);
    });

    it("providerSendsThinkingMode() returns false for ZenMux", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { providerSendsThinkingMode } = await import("../apiProvider.js");
      expect(providerSendsThinkingMode()).toBe(false);
    });

    it("getProviderMaxSubAgents() returns 2 for NVIDIA", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderMaxSubAgents } = await import("../apiProvider.js");
      expect(getProviderMaxSubAgents()).toBe(2);
    });

    it("getProviderMaxSubAgents() returns 10 for ZenMux", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { getProviderMaxSubAgents } = await import("../apiProvider.js");
      expect(getProviderMaxSubAgents()).toBe(10);
    });

    it("getProviderReasoningField() returns 'reasoning_content' for NVIDIA", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { getProviderReasoningField } = await import("../apiProvider.js");
      expect(getProviderReasoningField()).toBe("reasoning_content");
    });

    it("getProviderReasoningField() returns 'reasoning' for ZenMux", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { getProviderReasoningField } = await import("../apiProvider.js");
      expect(getProviderReasoningField()).toBe("reasoning");
    });

    it("providerUsesMultiKeyPool() returns true for NVIDIA", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-test";
      const { providerUsesMultiKeyPool } = await import("../apiProvider.js");
      expect(providerUsesMultiKeyPool()).toBe(true);
    });

    it("providerUsesMultiKeyPool() returns false for ZenMux", async () => {
      process.env.ZENMUX_API_KEY = "sk-test";
      const { providerUsesMultiKeyPool } = await import("../apiProvider.js");
      expect(providerUsesMultiKeyPool()).toBe(false);
    });
  });

  describe("error handling", () => {
    it("exits with error when ZENMUX_API_KEY not set but provider is zenmux", async () => {
      process.env.API_PROVIDER = "zenmux";
      // Don't set ZENMUX_API_KEY
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as any);
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(() => getProviderConfig()).toThrow("exit");
      exitSpy.mockRestore();
    });

    it("exits with error when no API key is set at all", async () => {
      // Don't set any key
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as any);
      const { getProviderConfig } = await import("../apiProvider.js");
      expect(() => getProviderConfig()).toThrow("exit");
      exitSpy.mockRestore();
    });
  });
});
