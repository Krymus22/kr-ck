/**
 * regression-bug-hunter-8a-config-effort.test.ts
 *
 * Regression tests for Bug Hunter #8a — Config + effort levels.
 *
 * Bugs covered:
 *   1. optionalBool did not trim whitespace — `DEBUG="  true  "` returned fallback.
 *   2. maxConcurrency accepted negative values — `MAX_CONCURRENCY=-1` returned -1
 *      instead of being clamped to 1 (BUSINESS_RULES §2 hard limit).
 *   3. nvidiaApiKey was not trimmed of leading/trailing whitespace, causing 401s.
 *   4. loadInitialLevel was case-sensitive for stored value, inconsistent with
 *      the env-var path which lowercases. `CLAUDE_KILLER_EFFORT_STORED=LOW`
 *      returned "medium" instead of "low".
 *   5. setEffortLevel must NOT modify config.maxTokens or config.temperature
 *      (BUSINESS_RULES §9 invariant).
 *   6. Effort prompt snippets must include correct depth instructions per level
 *      (low=1 frase, medium=2-3, high=4-6, max=6+).
 *   7. setEffortLevel refreshes history[0] system prompt on level change
 *      (BUSINESS_RULES §9 invariant).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock logger to keep test output clean
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

describe("Bug Hunter #8a — Config + effort regressions", () => {
  describe("Bug 1: optionalBool trims whitespace", () => {
    beforeEach(() => {
      vi.resetModules();
      delete process.env.NVIDIA_API_KEY;
      delete process.env.NVIDIA_API_KEYS;
      delete process.env.NVIDIA_API_KEYS_FILE;
      delete process.env.ZENMUX_API_KEY;
      delete process.env.API_PROVIDER;
      delete process.env.DEBUG;
      delete process.env.DIFF_PREVIEW;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("DEBUG='  true  ' (with surrounding whitespace) → true", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.DEBUG = "  true  ";
      const { config } = await import("../config.js");
      // Previously this returned false (fallback) because "  true  " !== "true".
      // After fix: trims first, so "true" === "true" → true.
      expect(config.debug).toBe(true);
    });

    it("DEBUG='\\ttrue\\n' (with tab/newline whitespace) → true", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.DEBUG = "\ttrue\n";
      const { config } = await import("../config.js");
      expect(config.debug).toBe(true);
    });

    it("DIFF_PREVIEW='  false  ' (with surrounding whitespace) → false", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.DIFF_PREVIEW = "  false  ";
      const { config } = await import("../config.js");
      // Default is true, so if trim works, we get false. Without trim, fallback (true).
      expect(config.diffPreview).toBe(false);
    });

    it("DEBUG='  TRUE  ' (uppercase + whitespace) → true", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.DEBUG = "  TRUE  ";
      const { config } = await import("../config.js");
      // Both trim AND lowercase are applied.
      expect(config.debug).toBe(true);
    });

    it("DEBUG='  1  ' (whitespace + '1') → true", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.DEBUG = "  1  ";
      const { config } = await import("../config.js");
      expect(config.debug).toBe(true);
    });

    it("DEBUG='  0  ' (whitespace + '0') → false", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.DEBUG = "  0  ";
      const { config } = await import("../config.js");
      expect(config.debug).toBe(false);
    });
  });

  describe("Bug 2: maxConcurrency clamps negative to 1 (BUSINESS_RULES §2)", () => {
    beforeEach(() => {
      vi.resetModules();
      delete process.env.NVIDIA_API_KEY;
      delete process.env.NVIDIA_API_KEYS;
      delete process.env.NVIDIA_API_KEYS_FILE;
      delete process.env.ZENMUX_API_KEY;
      delete process.env.API_PROVIDER;
      delete process.env.MAX_CONCURRENCY;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("MAX_CONCURRENCY=-1 → 1 (clamped, not -1)", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.MAX_CONCURRENCY = "-1";
      const { config } = await import("../config.js");
      // Previously: Math.min(-1, 1) = -1 (BUG — negative breaks limiter)
      // After fix: Math.max(1, Math.min(-1, 1)) = Math.max(1, -1) = 1
      expect(config.maxConcurrency).toBe(1);
    });

    it("MAX_CONCURRENCY=-100 → 1 (clamped)", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.MAX_CONCURRENCY = "-100";
      const { config } = await import("../config.js");
      expect(config.maxConcurrency).toBe(1);
    });

    it("MAX_CONCURRENCY=0 → 1 (clamped up to minimum)", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.MAX_CONCURRENCY = "0";
      const { config } = await import("../config.js");
      // 0 would also break the limiter (no requests allowed). Clamped to 1.
      expect(config.maxConcurrency).toBe(1);
    });

    it("MAX_CONCURRENCY=5 → 1 (still capped at hard limit)", async () => {
      process.env.NVIDIA_API_KEY = "k";
      process.env.MAX_CONCURRENCY = "5";
      const { config } = await import("../config.js");
      // Hard limit is 1 per BUSINESS_RULES §2.
      expect(config.maxConcurrency).toBe(1);
    });

    it("MAX_CONCURRENCY unset → 1 (default)", async () => {
      process.env.NVIDIA_API_KEY = "k";
      const { config } = await import("../config.js");
      expect(config.maxConcurrency).toBe(1);
    });
  });

  describe("Bug 3: nvidiaApiKey trims whitespace", () => {
    beforeEach(() => {
      vi.resetModules();
      delete process.env.NVIDIA_API_KEY;
      delete process.env.NVIDIA_API_KEYS;
      delete process.env.NVIDIA_API_KEYS_FILE;
      delete process.env.ZENMUX_API_KEY;
      delete process.env.API_PROVIDER;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("NVIDIA_API_KEY='  nvapi-xxx  ' (with whitespace) → trimmed", async () => {
      process.env.NVIDIA_API_KEY = "  nvapi-xxx  ";
      const { config } = await import("../config.js");
      // Previously: passed "  nvapi-xxx  " verbatim, causing 401s.
      // After fix: trimmed to "nvapi-xxx".
      expect(config.nvidiaApiKey).toBe("nvapi-xxx");
    });

    it("NVIDIA_API_KEY='nvapi-xxx' (no whitespace) → unchanged", async () => {
      process.env.NVIDIA_API_KEY = "nvapi-xxx";
      const { config } = await import("../config.js");
      expect(config.nvidiaApiKey).toBe("nvapi-xxx");
    });

    it("ZENMUX_API_KEY='  sk-ai-v1-xxx  ' (with whitespace) → trimmed", async () => {
      process.env.ZENMUX_API_KEY = "  sk-ai-v1-xxx  ";
      const { config } = await import("../config.js");
      // Provider auto-detects zenmux when only ZENMUX_API_KEY is set.
      expect(config.apiProvider).toBe("zenmux");
      expect(config.nvidiaApiKey).toBe("sk-ai-v1-xxx");
    });
  });

  describe("Bug 4: loadInitialLevel accepts uppercase stored value", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      // effortLevels.ts imports history.ts which imports config.ts which
      // requires an API key. Set one so module load doesn't exit.
      process.env.NVIDIA_API_KEY = "test-key-for-effort";
      delete process.env.CLAUDE_KILLER_EFFORT;
      delete process.env.CLAUDE_KILLER_EFFORT_STORED;
      vi.resetModules();
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("CLAUDE_KILLER_EFFORT_STORED=LOW → loads as 'low'", async () => {
      process.env.CLAUDE_KILLER_EFFORT_STORED = "LOW";
      // Dynamic import reloads the module, which calls loadInitialLevel() at
      // module-load time. Previously this returned "medium" because the stored
      // value "LOW" didn't match the lowercase Set. After fix: lowercased.
      const mod = await import("../effortLevels.js");
      expect(mod.getEffortLevel()).toBe("low");
    });

    it("CLAUDE_KILLER_EFFORT_STORED=HIGH → loads as 'high'", async () => {
      process.env.CLAUDE_KILLER_EFFORT_STORED = "HIGH";
      const mod = await import("../effortLevels.js");
      expect(mod.getEffortLevel()).toBe("high");
    });

    it("CLAUDE_KILLER_EFFORT_STORED=Max → loads as 'max' (mixed case)", async () => {
      process.env.CLAUDE_KILLER_EFFORT_STORED = "Max";
      const mod = await import("../effortLevels.js");
      expect(mod.getEffortLevel()).toBe("max");
    });

    it("CLAUDE_KILLER_EFFORT_STORED=low → loads as 'low' (lowercase still works)", async () => {
      process.env.CLAUDE_KILLER_EFFORT_STORED = "low";
      const mod = await import("../effortLevels.js");
      expect(mod.getEffortLevel()).toBe("low");
    });

    it("CLAUDE_KILLER_EFFORT_STORED=invalid → falls back to 'medium'", async () => {
      process.env.CLAUDE_KILLER_EFFORT_STORED = "invalid";
      const mod = await import("../effortLevels.js");
      expect(mod.getEffortLevel()).toBe("medium");
    });

    it("env var still wins over stored (priority preserved)", async () => {
      process.env.CLAUDE_KILLER_EFFORT = "high";
      process.env.CLAUDE_KILLER_EFFORT_STORED = "low";
      const mod = await import("../effortLevels.js");
      expect(mod.getEffortLevel()).toBe("high");
    });
  });

  describe("Bug 5: setEffortLevel does NOT override maxTokens or temperature", () => {
    // Per BUSINESS_RULES §9: "Effort NÃO override maxOutputTokens ou temperature"
    beforeEach(() => {
      vi.resetModules();
    });

    it("switching effort levels does not change config.maxTokens", async () => {
      process.env.NVIDIA_API_KEY = "k";
      delete process.env.MAX_TOKENS;
      const { config } = await import("../config.js");
      const originalMaxTokens = config.maxTokens;

      const { setEffortLevel, getEffortLevel } = await import("../effortLevels.js");
      for (const level of ["low", "medium", "high", "max"] as const) {
        setEffortLevel(level);
        expect(getEffortLevel()).toBe(level);
        // maxTokens must NOT change with effort level.
        expect(config.maxTokens).toBe(originalMaxTokens);
      }
    });

    it("switching effort levels does not change config.temperature", async () => {
      process.env.NVIDIA_API_KEY = "k";
      delete process.env.TEMPERATURE;
      const { config } = await import("../config.js");
      const originalTemp = config.temperature;

      const { setEffortLevel } = await import("../effortLevels.js");
      for (const level of ["low", "medium", "high", "max"] as const) {
        setEffortLevel(level);
        // temperature must NOT change with effort level.
        expect(config.temperature).toBe(originalTemp);
      }
    });

    it("switching effort levels does not change config.topP", async () => {
      process.env.NVIDIA_API_KEY = "k";
      delete process.env.TOP_P;
      const { config } = await import("../config.js");
      const originalTopP = config.topP;

      const { setEffortLevel } = await import("../effortLevels.js");
      for (const level of ["low", "medium", "high", "max"] as const) {
        setEffortLevel(level);
        expect(config.topP).toBe(originalTopP);
      }
    });
  });

  describe("Bug 6: effort prompt snippets include correct depth instructions", () => {
    // Per BUSINESS_RULES §9 table:
    //   low: 1 frase | medium: 2-3 frases | high: 4-6 frases | max: 6+ frases
    // Use dynamic import to get a fresh module reference.
    let mod: typeof import("../effortLevels.js");
    beforeEach(async () => {
      mod = await import("../effortLevels.js");
    });

    it("low snippet mentions 1-sentence thought", () => {
      mod.setEffortLevel("low");
      const snippet = mod.getEffortPromptSnippet();
      expect(snippet).toContain("1-sentence");
    });

    it("medium snippet mentions '2-3 frases'", () => {
      mod.setEffortLevel("medium");
      const snippet = mod.getEffortPromptSnippet();
      expect(snippet).toContain("2-3 frases");
    });

    it("high snippet mentions '4-6 frases'", () => {
      mod.setEffortLevel("high");
      const snippet = mod.getEffortPromptSnippet();
      expect(snippet).toContain("4-6 frases");
    });

    it("max snippet mentions '6+ frases'", () => {
      mod.setEffortLevel("max");
      const snippet = mod.getEffortPromptSnippet();
      expect(snippet).toContain("6+ frases");
    });

    it("all snippets contain 'EFFORT LEVEL' header", () => {
      for (const level of ["low", "medium", "high", "max"] as const) {
        mod.setEffortLevel(level);
        expect(mod.getEffortPromptSnippet()).toContain("EFFORT LEVEL");
      }
    });

    it("snippets are distinct per level", () => {
      const snippets = new Set<string>();
      for (const level of ["low", "medium", "high", "max"] as const) {
        mod.setEffortLevel(level);
        snippets.add(mod.getEffortPromptSnippet());
      }
      expect(snippets.size).toBe(4);
    });
  });

  describe("Bug 7: setEffortLevel refreshes history[0] system prompt", () => {
    // Per BUSINESS_RULES §9: "/effort atualiza system prompt imediatamente
    //   (history[0].content = getSystemPrompt())"

    it("setEffortLevel updates history[0].content with new snippet", async () => {
      const history = await import("../history.js");
      const { setEffortLevel } = await import("../effortLevels.js");

      // Ensure history is initialized (creates system prompt with current level).
      setEffortLevel("low");
      const initialContent = history.getHistory()[0].content as string;
      expect(initialContent).toContain("EFFORT LEVEL: LOW");

      // Switch to max — system prompt should refresh immediately.
      setEffortLevel("max");
      const refreshedContent = history.getHistory()[0].content as string;
      expect(refreshedContent).toContain("EFFORT LEVEL: MAX");
      expect(refreshedContent).not.toContain("EFFORT LEVEL: LOW");

      // Reset for other tests.
      setEffortLevel("medium");
    });

    it("setEffortLevel does not crash when history is empty (defensive)", async () => {
      const history = await import("../history.js");
      const { setEffortLevel } = await import("../effortLevels.js");

      // Replace history with empty array — setEffortLevel should not throw.
      // The check `length > 0 && role === "system"` prevents the assignment.
      history.replaceHistory([]);
      expect(() => setEffortLevel("high")).not.toThrow();

      // Cleanup: re-init.
      history.resetHistory();
    });
  });

  describe("Bug 8: feature gating matches BUSINESS_RULES §9 table", () => {
    let mod: typeof import("../effortLevels.js");
    beforeEach(async () => {
      mod = await import("../effortLevels.js");
    });

    // | Level   | Auto-test | Sub-agents | LLM Compaction |
    // |---------|-----------|------------|----------------|
    // | low     | ❌        | ❌         | ❌              |
    // | medium  | ✅        | ❌         | ✅              |
    // | high    | ✅        | ✅         | ✅              |
    // | max     | ✅        | ✅         | ✅              |

    it("low: all 3 features disabled", () => {
      mod.setEffortLevel("low");
      expect(mod.shouldAutoGenerateTests()).toBe(false);
      expect(mod.shouldUseSubAgents()).toBe(false);
      expect(mod.shouldUseIntelligentCompaction()).toBe(false);
    });

    it("medium: auto-test + compaction ON, sub-agents OFF", () => {
      mod.setEffortLevel("medium");
      expect(mod.shouldAutoGenerateTests()).toBe(true);
      expect(mod.shouldUseSubAgents()).toBe(false);
      expect(mod.shouldUseIntelligentCompaction()).toBe(true);
    });

    it("high: all 3 features ON", () => {
      mod.setEffortLevel("high");
      expect(mod.shouldAutoGenerateTests()).toBe(true);
      expect(mod.shouldUseSubAgents()).toBe(true);
      expect(mod.shouldUseIntelligentCompaction()).toBe(true);
    });

    it("max: all 3 features ON", () => {
      mod.setEffortLevel("max");
      expect(mod.shouldAutoGenerateTests()).toBe(true);
      expect(mod.shouldUseSubAgents()).toBe(true);
      expect(mod.shouldUseIntelligentCompaction()).toBe(true);
    });
  });

  describe("Bug 9: setEffortLevel rejects invalid level without side effects", () => {
    let mod: typeof import("../effortLevels.js");
    beforeEach(async () => {
      mod = await import("../effortLevels.js");
    });

    it("returns false for invalid level string", () => {
      mod.setEffortLevel("medium"); // known starting state
      const result = mod.setEffortLevel("turbo" as never);
      expect(result).toBe(false);
    });

    it("does not change current level on invalid input", () => {
      mod.setEffortLevel("high");
      mod.setEffortLevel("invalid" as never);
      expect(mod.getEffortLevel()).toBe("high");
    });

    it("rejects empty string", () => {
      mod.setEffortLevel("medium");
      mod.setEffortLevel("" as never);
      expect(mod.getEffortLevel()).toBe("medium");
    });
  });

  describe("Bug 10: effort label matches BUSINESS_RULES §9 table", () => {
    let mod: typeof import("../effortLevels.js");
    beforeEach(async () => {
      mod = await import("../effortLevels.js");
    });

    it("low → 'LOW !'", () => {
      mod.setEffortLevel("low");
      expect(mod.getEffortLabel()).toBe("LOW !");
    });

    it("medium → 'MEDIUM G'", () => {
      mod.setEffortLevel("medium");
      expect(mod.getEffortLabel()).toBe("MEDIUM G");
    });

    it("high → 'HIGH Q'", () => {
      mod.setEffortLevel("high");
      expect(mod.getEffortLabel()).toBe("HIGH Q");
    });

    it("max → 'MAX B'", () => {
      mod.setEffortLevel("max");
      expect(mod.getEffortLabel()).toBe("MAX B");
    });
  });

  describe("Bug 11: contextCompactThreshold stays at 0.70 (§17 invariant)", () => {
    // Per §17.2 rule 5: contextCompactThreshold = 0.70 — LLM compaction é
    // prioridade, roda primeiro quando threshold é atingido.
    // This is a non-modification invariant — we verify it's still 0.70.

    beforeEach(() => {
      vi.resetModules();
      delete process.env.CONTEXT_COMPACT_THRESHOLD;
      delete process.env.NVIDIA_API_KEY;
      delete process.env.NVIDIA_API_KEYS;
      delete process.env.NVIDIA_API_KEYS_FILE;
      delete process.env.ZENMUX_API_KEY;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("default contextCompactThreshold is exactly 0.70", async () => {
      process.env.NVIDIA_API_KEY = "k";
      const { config } = await import("../config.js");
      expect(config.contextCompactThreshold).toBe(0.70);
    });
  });

  describe("Bug 12: model default is moonshotai/kimi-k2.6 (§2 invariant)", () => {
    // Per BUSINESS_RULES §2: model default = moonshotai/kimi-k2.6.
    beforeEach(() => {
      vi.resetModules();
      delete process.env.MODEL;
      delete process.env.NVIDIA_API_KEY;
      delete process.env.NVIDIA_API_KEYS;
      delete process.env.NVIDIA_API_KEYS_FILE;
      delete process.env.ZENMUX_API_KEY;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("default model is 'moonshotai/kimi-k2.6'", async () => {
      process.env.NVIDIA_API_KEY = "k";
      const { config } = await import("../config.js");
      expect(config.model).toBe("moonshotai/kimi-k2.6");
    });
  });
});
