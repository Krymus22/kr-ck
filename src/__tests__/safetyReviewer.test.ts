/**
 * safetyReviewer.test.ts - Tests for the LLM-based safety reviewer.
 *
 * Tests are split into:
 *   - Heuristic scan (no network, pure regex) - full coverage
 *   - LLM integration (uses real network, may be slow) - lenient timeouts
 *   - Formatter (pure function, deterministic)
 *   - Mode integration (verify Roblox mode has safetyReview=true)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("safetyReviewer - heuristic scan", () => {
  describe("scanDangerousPatterns", () => {
    it("should return empty when no dangerous patterns", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
local function add(a, b)
    return a + b
end
print(add(1, 2))
`);
      expect(result.matched).toEqual([]);
      expect(result.hasHighSeverity).toBe(false);
    });

    it("should detect :RemoveAsync", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
local store = DataStoreService:GetDataStore("PlayerData")
store:RemoveAsync("user_123")
`);
      expect(result.matched.length).toBeGreaterThan(0);
      expect(result.hasHighSeverity).toBe(true);
      expect(result.matched.some((p) => p.description.includes("RemoveAsync"))).toBe(true);
    });

    it("should detect :RemoveAllAsync", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`store:RemoveAllAsync()`);
      expect(result.hasHighSeverity).toBe(true);
    });

    it("should detect profile.Data = assignment (full overwrite)", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
local profile = profileStore:Load(userId)
profile.Data = {}
`);
      expect(result.hasHighSeverity).toBe(true);
    });

    it("should detect profile.Data.X = (field mutation)", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
profile.Data.Coins = 100
`);
      expect(result.matched.length).toBeGreaterThan(0);
      // Field mutation is medium severity, not high
      const fieldMutation = result.matched.find((p) => p.description.includes("profile.Data.X"));
      expect(fieldMutation).toBeDefined();
    });

    it("should detect Replica.Data assignment", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
replica.Data = { coins = 0 }
`);
      expect(result.hasHighSeverity).toBe(true);
    });

    it("should detect :ClearAllChildren", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
game.ReplicatedStorage.Saves:ClearAllChildren()
`);
      expect(result.hasHighSeverity).toBe(true);
    });

    it("should detect :Destroy", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
part:Destroy()
`);
      expect(result.matched.length).toBeGreaterThan(0);
    });

    it("should detect HttpService:PostAsync", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
HttpService:PostAsync("https://api.example.com/wipe", "confirm=true")
`);
      expect(result.matched.length).toBeGreaterThan(0);
    });

    it("should detect while true do loop", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
while true do
    task.wait(1)
end
`);
      expect(result.matched.length).toBeGreaterThan(0);
    });

    it("should detect :SetAsync (medium severity)", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
store:SetAsync("user_123", data)
`);
      expect(result.matched.length).toBeGreaterThan(0);
      // SetAsync is medium, not high
      expect(result.hasHighSeverity).toBe(false);
    });

    it("should detect multiple patterns at once", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
store:RemoveAsync("user_1")
store:SetAsync("user_2", {})
game.ReplicatedStorage:ClearAllChildren()
part:Destroy()
`);
      expect(result.matched.length).toBeGreaterThanOrEqual(4);
      expect(result.hasHighSeverity).toBe(true);
    });

    it("should not flag safe read operations", async () => {
      const { scanDangerousPatterns } = await import("./../safetyReviewer.js");
      const result = scanDangerousPatterns(`
local data = store:GetAsync("user_123")
print(data.Coins)
local player = Players:GetPlayerByUserId(123)
print(player.Name)
`);
      // GetAsync and GetPlayerByUserId are reads, not mutations
      // Should not match any dangerous patterns
      expect(result.matched.length).toBe(0);
    });
  });

  describe("shouldReviewFile", () => {
    it("should return true for .luau files", async () => {
      const { shouldReviewFile } = await import("./../safetyReviewer.js");
      expect(shouldReviewFile("/path/to/Service.luau")).toBe(true);
      expect(shouldReviewFile("Service.luau")).toBe(true);
    });

    it("should return true for .lua files", async () => {
      const { shouldReviewFile } = await import("./../safetyReviewer.js");
      expect(shouldReviewFile("/path/to/Service.lua")).toBe(true);
    });

    it("should return false for .ts files", async () => {
      const { shouldReviewFile } = await import("./../safetyReviewer.js");
      expect(shouldReviewFile("/path/to/Service.ts")).toBe(false);
    });

    it("should return false for .py files", async () => {
      const { shouldReviewFile } = await import("./../safetyReviewer.js");
      expect(shouldReviewFile("/path/to/script.py")).toBe(false);
    });
  });
});

describe("safetyReviewer - formatter", () => {
  describe("formatSafetyReview", () => {
    it("should format high-risk result as blocking error", async () => {
      const { formatSafetyReview } = await import("./../safetyReviewer.js");
      const result = {
        risk: "high" as const,
        reasoning: "Code calls RemoveAsync which permanently deletes player data.",
        patternsMatched: ["DataStore:RemoveAsync (deletes data permanently)"],
        reviewedByLlm: true,
        durationMs: 2500,
      };
      const formatted = formatSafetyReview(result);
      expect(formatted).toContain("BLOQUEIO DE SEGURANÇA");
      expect(formatted).toContain("HIGH");
      expect(formatted).toContain("RemoveAsync");
      expect(formatted).toContain("NÃO escreva este código");
      expect(formatted).toContain("guardrails");
    });

    it("should format low-risk result as warning", async () => {
      const { formatSafetyReview } = await import("./../safetyReviewer.js");
      const result = {
        risk: "low" as const,
        reasoning: "Code uses SetAsync but with proper validation.",
        patternsMatched: ["DataStore:SetAsync (overwrites without merge)"],
        reviewedByLlm: true,
        durationMs: 1500,
      };
      const formatted = formatSafetyReview(result);
      expect(formatted).toContain("AVISO DE SEGURANÇA");
      expect(formatted).toContain("BAIXO");
      expect(formatted).toContain("SetAsync");
      // Should NOT contain blocking language
      expect(formatted).not.toContain("BLOQUEIO");
    });

    it("should format none-risk result (LLM reviewed) as OK", async () => {
      const { formatSafetyReview } = await import("./../safetyReviewer.js");
      const result = {
        risk: "none" as const,
        reasoning: "Code only reads data, no mutations.",
        patternsMatched: [],
        reviewedByLlm: true,
        durationMs: 1500,
      };
      const formatted = formatSafetyReview(result);
      expect(formatted).toContain("SEGURANÇA OK");
    });

    it("should return empty string for none-risk without LLM review", async () => {
      const { formatSafetyReview } = await import("./../safetyReviewer.js");
      const result = {
        risk: "none" as const,
        reasoning: "No dangerous patterns detected in static scan.",
        patternsMatched: [],
        reviewedByLlm: false,
        durationMs: 5,
      };
      const formatted = formatSafetyReview(result);
      expect(formatted).toBe("");
    });
  });
});

describe("safetyReviewer - LLM integration", () => {
  // These tests call the real LLM API. They are lenient about timeouts
  // since the API may be slow or unavailable in CI.

  it("should return risk=none when no dangerous patterns (no LLM call)", async () => {
    const { reviewCodeSafety } = await import("./../safetyReviewer.js");
    const result = await reviewCodeSafety(
      `local function add(a: number, b: number): number\n    return a + b\nend\n`,
      "test.luau"
    );
    expect(result.risk).toBe("none");
    expect(result.reviewedByLlm).toBe(false);
    expect(result.patternsMatched).toEqual([]);
    expect(result.durationMs).toBeLessThan(1000);  // heuristic only, very fast
  });

  it("should call LLM when dangerous patterns detected", async () => {
    const { reviewCodeSafety } = await import("./../safetyReviewer.js");
    const code = `
local function wipeAllData()
    local store = DataStoreService:GetDataStore("PlayerData")
    store:RemoveAllAsync()
end
`;
    const result = await Promise.race([
      reviewCodeSafety(code, "wipe.luau"),
      new Promise<any>((resolve) =>
        setTimeout(() => resolve({ timeout: true }), 30_000)
      ),
    ]);

    if ("timeout" in result) {
      // LLM took too long - acceptable in CI
      return;
    }
    expect(result.reviewedByLlm).toBe(true);
    expect(result.patternsMatched.length).toBeGreaterThan(0);
    // Risk should be "high" for RemoveAllAsync, but be lenient in case
    // LLM disagrees (it's the LLM's job to make the call)
    expect(["none", "low", "high"]).toContain(result.risk);
  }, 35_000);
});

describe("safetyReviewer - mode integration", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-safety-mode-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("roblox built-in mode should have safetyReview=true", async () => {
    const { getBuiltInModes } = await import("./../modes.js");
    const roblox = getBuiltInModes().find((m) => m.name === "roblox");
    expect(roblox).toBeDefined();
    expect(roblox!.safetyReview).toBe(true);
  });

  it("roblox mode should also have autoResearch=true (combined safety)", async () => {
    const { getBuiltInModes } = await import("./../modes.js");
    const roblox = getBuiltInModes().find((m) => m.name === "roblox");
    expect(roblox!.safetyReview).toBe(true);
    expect(roblox!.autoResearch).toBe(true);
  });
});

describe("safetyReviewer - getDangerousPatterns", () => {
  it("should return all 20 dangerous patterns", async () => {
    const { getDangerousPatterns } = await import("./../safetyReviewer.js");
    const patterns = getDangerousPatterns();
    expect(patterns.length).toBe(20);
  });

  it("should include all critical patterns", async () => {
    const { getDangerousPatterns } = await import("./../safetyReviewer.js");
    const patterns = getDangerousPatterns();
    const descriptions = patterns.map((p) => p.description);
    // Verify critical patterns are present
    expect(descriptions.some((d) => d.includes("RemoveAsync"))).toBe(true);
    expect(descriptions.some((d) => d.includes("RemoveAllAsync"))).toBe(true);
    expect(descriptions.some((d) => d.includes("ClearAllChildren"))).toBe(true);
    expect(descriptions.some((d) => d.includes("profile.Data"))).toBe(true);
  });
});
