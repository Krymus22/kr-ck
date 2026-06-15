import { describe, it, expect } from "vitest";

describe("Config", () => {
  it("loads config from env", async () => {
    // Set required env var before importing
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
});
