import { describe, it, expect, vi, beforeEach } from "vitest";

describe("Config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("loads config from env", async () => {
    process.env.NVIDIA_API_KEY = "test-key-12345";
    const { config } = await import("../config.js");

    expect(config.nvidiaApiKey).toBe("test-key-12345");
    expect(config.nvidiaBaseUrl).toContain("nvidia.com");
    expect(config.rateLimitRpm).toBeGreaterThan(0);
    expect(config.maxHealRetries).toBeGreaterThan(0);
    expect(config.contextWindowTokens).toBeGreaterThan(0);
  });

  it("has correct defaults", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    delete process.env.RATE_LIMIT_RPM;
    delete process.env.MAX_HEAL_RETRIES;
    delete process.env.DEBUG;

    const { config } = await import("../config.js");

    expect(config.debug).toBe(false);
    expect(config.diffPreview).toBe(true);
    expect(config.contextCompactThreshold).toBe(0.75);
    expect(config.contextWarnThreshold).toBe(0.6);
  });

  it("handles optionalInt with invalid value", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    process.env.RATE_LIMIT_RPM = "not_a_number";
    const { config } = await import("../config.js");
    expect(config.rateLimitRpm).toBe(40); // falls back to default
    delete process.env.RATE_LIMIT_RPM;
  });

  it("handles optionalFloat with invalid value", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    process.env.CONTEXT_COMPACT_THRESHOLD = "not_a_float";
    const { config } = await import("../config.js");
    expect(config.contextCompactThreshold).toBe(0.75); // falls back
    delete process.env.CONTEXT_COMPACT_THRESHOLD;
  });

  it("handles optionalBool with true", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    process.env.DEBUG = "1";
    const { config } = await import("../config.js");
    expect(config.debug).toBe(true);
  });

  it("handles optionalBool with false", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    process.env.DEBUG = "0";
    const { config } = await import("../config.js");
    expect(config.debug).toBe(false);
  });

  it("handles optionalInt with valid string number", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    process.env.MAX_HEAL_RETRIES = "5";
    const { config } = await import("../config.js");
    expect(config.maxHealRetries).toBe(5);
    delete process.env.MAX_HEAL_RETRIES;
  });

  it("handles optionalFloat with valid string number", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    process.env.CONTEXT_WARN_THRESHOLD = "0.8";
    const { config } = await import("../config.js");
    expect(config.contextWarnThreshold).toBe(0.8);
    delete process.env.CONTEXT_WARN_THRESHOLD;
  });

  it("model uses default when env not set", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    delete process.env.MODEL;
    const { config } = await import("../config.js");
    expect(config.model).toContain("kimi");
  });

  it("maxConcurrency is capped at 1", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    process.env.MAX_CONCURRENCY = "5";
    const { config } = await import("../config.js");
    expect(config.maxConcurrency).toBe(1);
    delete process.env.MAX_CONCURRENCY;
  });

  it("costPerKPrompt defaults to 0", async () => {
    process.env.NVIDIA_API_KEY = "test-key";
    const { config } = await import("../config.js");
    expect(config.costPerKPrompt).toBe(0);
    expect(config.costPerKCompletion).toBe(0);
  });
});
