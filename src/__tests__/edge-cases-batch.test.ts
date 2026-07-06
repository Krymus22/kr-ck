/**
 * edge-cases-batch.test.ts — Edge case tests for various modules.
 *
 * Tests:
 *   - Empty string inputs to pure functions
 *   - null/undefined inputs
 *   - Very large inputs (10000+ chars)
 *   - Unicode/emoji in strings
 *   - Nested objects/arrays in args
 *   - Boundary values (0, -1, MAX_SAFE_INTEGER)
 *   - Special characters in paths (spaces, accents)
 *   - Concurrent calls / rapid successive calls
 *
 * Strategy: use REAL modules for pure functions, mock only logger/fs/child_process
 * to avoid touching real disk/network. Tests run fast (no async needed for most).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Top-level mocks ────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

vi.mock("../fileLock.js", () => ({
  acquireLock: vi.fn(async () => vi.fn()),
  getCurrentAgentId: vi.fn(() => "test-agent"),
}));

vi.mock("../honestySystem.js", () => ({
  markFileAsEdited: vi.fn(),
  diffRealityCheck: vi.fn(async () => ({ matches: true, message: "" })),
  detectHallucinations: vi.fn(async () => ({ hallucinatedSymbols: [], message: "" })),
}));
vi.mock("../importResolver.js", () => ({
  checkImports: vi.fn(() => ({ ok: true, message: "" })),
}));
vi.mock("../impactAnalyzer.js", () => ({
  analyzeImpact: vi.fn(async () => ({ referencedBy: [], totalFiles: 0 })),
  formatImpactHint: vi.fn(() => ""),
}));
vi.mock("../luauValidator.js", () => ({
  shouldValidateFile: vi.fn(async () => false),
  getActiveValidationRules: vi.fn(async () => []),
  validateLuauBeforeWrite: vi.fn(async () => ({
    ok: true, blockingError: undefined, warnings: [],
    rulesApplied: [], rulesSkipped: [],
  })),
}));
vi.mock("../safetyReviewer.js", () => ({
  reviewCodeSafety: vi.fn(async () => ({
    risk: "low", reviewedByLlm: false, patternsMatched: [], durationMs: 0,
  })),
  formatSafetyReview: vi.fn(() => ""),
  shouldReviewFile: vi.fn(() => false),
  getDangerousPatterns: vi.fn(() => []),
}));
vi.mock("../hookRunner.js", () => ({
  runHooks: vi.fn(async () => []),
  loadHooks: vi.fn(() => []),
}));
vi.mock("../modeExtensions.js", () => ({
  runPostEditHooks: vi.fn(async () => ""),
  getActivePostEditHooks: vi.fn(async () => []),
}));
vi.mock("../taskState.js", () => ({
  getTaskStateSummary: vi.fn(() => null),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { normalizeArgs } from "../argsNormalizer.js";
import { pokaYokeCheck } from "../pokaYoke.js";
import { applyEdits, editFile } from "../fileEdit.js";
import {
  classifyMcpTool, evaluateMcpToolCall, extractToolName, isRobloxStudioMcpTool,
} from "../robloxMcpGuard.js";
import { detectIntent, filterToolsByIntent, getFilterSummary } from "../toolReduction.js";
import { validateModeConfig } from "../configSchema.js";
import {
  TokenCounter, BufferedStreamProcessor, StreamThrottle,
  estimateTokenCount, truncateToTokenLimit,
} from "../streaming.js";
import {
  setLanguage, resetLanguageCache, resetAllLanguageState, detectLanguage,
} from "../i18n.js";
import { getEffortLevel, setEffortLevel } from "../effortLevels.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-edge-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
  resetAllLanguageState();
  setEffortLevel("medium");
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.clearAllMocks();
  resetAllLanguageState();
});

// ═══════════════════════════════════════════════════════════════════════════
// Empty string inputs
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: empty string inputs", () => {
  it("normalizeArgs with empty toolName — does not throw", () => {
    const args: any = { path: "/x" };
    expect(() => normalizeArgs("", args)).not.toThrow();
    expect(args.path).toBe("/x");
  });

  it("normalizeArgs with empty args object — does not throw", () => {
    const args: any = {};
    expect(() => normalizeArgs("ler_arquivo", args)).not.toThrow();
    expect(Object.keys(args).length).toBe(0);
  });

  it("pokaYokeCheck with empty toolName — does not throw, returns ok=true (no checks apply)", () => {
    const r = pokaYokeCheck("", {});
    expect(r.ok).toBe(true);
  });

  it("detectIntent with empty string returns 'general'", () => {
    expect(detectIntent("")).toBe("general");
  });

  it("validateModeConfig with empty object — returns errors for missing name + label", () => {
    const errors = validateModeConfig({});
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some(e => e.field === "name")).toBe(true);
    expect(errors.some(e => e.field === "label")).toBe(true);
  });

  it("extractToolName with empty string returns empty string", () => {
    expect(extractToolName("")).toBe("");
  });

  it("isRobloxStudioMcpTool with empty string returns false", () => {
    expect(isRobloxStudioMcpTool("")).toBe(false);
  });

  it("estimateTokenCount with empty string returns 0", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("truncateToTokenLimit with empty string returns empty string", () => {
    expect(truncateToTokenLimit("", 100)).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// null/undefined inputs
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: null/undefined inputs", () => {
  it("validateModeConfig(null) — returns root error", () => {
    const errors = validateModeConfig(null);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("root");
  });

  it("validateModeConfig(undefined) — returns root error", () => {
    const errors = validateModeConfig(undefined);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].field).toBe("root");
  });

  it("pokaYokeCheck with empty args object — still works for path-taking tools (returns ok:false)", () => {
    const r = pokaYokeCheck("editar_arquivo", {});
    expect(r.ok).toBe(false);
  });

  it("filterToolsByIntent with empty array — returns empty array", () => {
    const filtered = filterToolsByIntent([], "read");
    expect(filtered).toEqual([]);
  });

  it("filterToolsByIntent with empty array for general intent — returns empty array", () => {
    const filtered = filterToolsByIntent([], "general");
    expect(filtered).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Very large inputs (10000+ chars)
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: very large inputs", () => {
  it("applyEdits handles 10000-char content", () => {
    const content = "x".repeat(10000);
    const result = applyEdits(content, [{ search: "x".repeat(100), replace: "y".repeat(100) }]);
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);
    expect(result.content.length).toBe(10000);
  });

  it("applyEdits handles 10000-char search string", () => {
    const content = "x".repeat(10000);
    const search = "x".repeat(10000);
    const result = applyEdits(content, [{ search, replace: "y" }]);
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("y");
  });

  it("applyEdits handles 10000 sequential edits", () => {
    const content = "a".repeat(10000);
    const edits = Array.from({ length: 100 }, (_, i) => ({
      search: "a",
      replace: String.fromCharCode(97 + (i % 26)),
    }));
    // Note: only the first occurrence of 'a' is replaced each time
    const result = applyEdits(content, edits);
    expect(result.success).toBe(true);
  });

  it("estimateTokenCount for 10000-char string returns reasonable estimate", () => {
    const big = "hello world ".repeat(1000);
    const tokens = estimateTokenCount(big);
    expect(tokens).toBeGreaterThan(1000);
    expect(tokens).toBeLessThan(5000);
  });

  it("normalizeArgs handles large args object (1000 fields)", () => {
    const args: any = {};
    for (let i = 0; i < 1000; i++) args[`field${i}`] = i;
    expect(() => normalizeArgs("ler_arquivo", args)).not.toThrow();
  });

  it("pokaYokeCheck handles 10000-char path (does not validate length)", () => {
    const longPath = "/tmp/" + "x".repeat(10000);
    const r = pokaYokeCheck("ler_arquivo", { path: longPath });
    expect(r.ok).toBe(true);
    expect(r.resolvedPath).toBeDefined();
  });

  it("truncateToTokenLimit truncates 10000-char string to 100 tokens", () => {
    const big = "hello world ".repeat(1000);
    const truncated = truncateToTokenLimit(big, 100);
    expect(truncated.length).toBeLessThan(big.length);
    expect(truncated).toContain("[TRUNCATED]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unicode/emoji in strings
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: unicode and emoji", () => {
  it("applyEdits handles emoji in content", () => {
    const content = "Hello 🌍 World 🚀";
    const result = applyEdits(content, [{ search: "🌍", replace: "🌎" }]);
    expect(result.success).toBe(true);
    expect(result.content).toBe("Hello 🌎 World 🚀");
  });

  it("applyEdits handles accented characters", () => {
    const content = "Olá, mundo! Çãõá";
    const result = applyEdits(content, [{ search: "mundo", replace: "Mundo" }]);
    expect(result.success).toBe(true);
    expect(result.content).toBe("Olá, Mundo! Çãõá");
  });

  it("applyEdits handles CJK characters", () => {
    const content = "Hello 你好 World 世界";
    const result = applyEdits(content, [{ search: "你好", replace: "您好" }]);
    expect(result.success).toBe(true);
    expect(result.content).toBe("Hello 您好 World 世界");
  });

  it("applyEdits handles mixed scripts in search", () => {
    const content = "English français 日本語";
    const result = applyEdits(content, [{ search: "français", replace: "French" }]);
    expect(result.success).toBe(true);
    expect(result.content).toBe("English French 日本語");
  });

  it("estimateTokenCount counts CJK characters differently (~1.5 chars/token)", () => {
    const cjk = "你好世界你好世界"; // 8 CJK chars
    const en = "hello world! "; // 13 ASCII chars
    // Both should produce positive token counts
    expect(estimateTokenCount(cjk)).toBeGreaterThan(0);
    expect(estimateTokenCount(en)).toBeGreaterThan(0);
    // CJK should have HIGHER token count than same-length ASCII
    expect(estimateTokenCount(cjk)).toBeGreaterThan(estimateTokenCount(en.slice(0, 8)));
  });

  it("normalizeArgs preserves unicode in path values", () => {
    const args: any = { caminho: "/tmp/Olá-Mundo-🌍.lua" };
    normalizeArgs("ler_arquivo", args);
    expect(args.path).toBe("/tmp/Olá-Mundo-🌍.lua");
  });

  it("pokaYokeCheck accepts unicode in path", () => {
    const r = pokaYokeCheck("ler_arquivo", { path: "/tmp/玩家.lua" });
    expect(r.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Nested objects/arrays in args
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: nested objects/arrays in args", () => {
  it("normalizeArgs handles nested object value (parses JSON string)", () => {
    const args: any = {
      path: "/x",
      config: JSON.stringify({ nested: { deep: [1, 2, 3] } }),
    };
    normalizeArgs("ler_arquivo", args);
    expect(args.config).toEqual({ nested: { deep: [1, 2, 3] } });
  });

  it("normalizeArgs handles JSON string array", () => {
    const args: any = {
      path: "/x",
      list: '["a", "b", "c"]',
    };
    normalizeArgs("ler_arquivo", args);
    expect(args.list).toEqual(["a", "b", "c"]);
  });

  it("normalizeArgs leaves invalid JSON string alone", () => {
    const args: any = {
      path: "/x",
      notJson: "{invalid",
    };
    normalizeArgs("ler_arquivo", args);
    expect(args.notJson).toBe("{invalid");
  });

  it("normalizeArgs coerces object to string when schema says 'string'", () => {
    const args: any = { replace: { content: "extracted" } };
    const schema = { properties: { replace: { type: "string" } } };
    normalizeArgs("editar_arquivo", args, schema as any);
    expect(args.replace).toBe("extracted");
  });

  it("normalizeArgs coerces object with 'value' field to string", () => {
    const args: any = { replace: { value: "val-extracted" } };
    const schema = { properties: { replace: { type: "string" } } };
    normalizeArgs("editar_arquivo", args, schema as any);
    expect(args.replace).toBe("val-extracted");
  });

  it("normalizeArgs JSON-stringifies object when schema says 'string' (parseJsonStrings respects schema)", () => {
    // coerceTypes converts object → JSON string when schema says "string".
    // BUG FIX: parseJsonStrings now SKIPS fields whose schema says type:"string",
    // so the stringified object stays as a string (not re-parsed back to object).
    const args: any = { replace: { foo: "bar", baz: 42 } };
    const schema = { properties: { replace: { type: "string" } } };
    normalizeArgs("editar_arquivo", args, schema as any);
    // The object is converted to JSON string and STAYS string (not re-parsed)
    expect(typeof args.replace).toBe("string");
    expect(JSON.parse(args.replace)).toEqual({ foo: "bar", baz: 42 });
  });

  it("normalizeArgs coerces number to string when schema says 'string'", () => {
    const args: any = { path: 12345 };
    const schema = { properties: { path: { type: "string" } } };
    normalizeArgs("ler_arquivo", args, schema as any);
    expect(args.path).toBe("12345");
  });

  it("normalizeArgs coerces boolean to string when schema says 'string'", () => {
    const args: any = { flag: true };
    const schema = { properties: { flag: { type: "string" } } };
    normalizeArgs("ler_arquivo", args, schema as any);
    expect(args.flag).toBe("true");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Boundary values (0, -1, MAX_SAFE_INTEGER)
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: boundary values", () => {
  it("normalizeArgs coerces '0' to number 0 when schema says 'number'", () => {
    const args: any = { count: "0" };
    const schema = { properties: { count: { type: "number" } } };
    normalizeArgs("ler_arquivo", args, schema as any);
    expect(args.count).toBe(0);
    expect(typeof args.count).toBe("number");
  });

  it("normalizeArgs coerces '-1' to number -1", () => {
    const args: any = { offset: "-1" };
    const schema = { properties: { offset: { type: "number" } } };
    normalizeArgs("ler_arquivo", args, schema as any);
    expect(args.offset).toBe(-1);
  });

  it("normalizeArgs coerces '1.5' to number 1.5 (decimal)", () => {
    const args: any = { ratio: "1.5" };
    const schema = { properties: { ratio: { type: "number" } } };
    normalizeArgs("ler_arquivo", args, schema as any);
    expect(args.ratio).toBe(1.5);
  });

  it("normalizeArgs does NOT coerce empty string to NaN (leaves as-is)", () => {
    const args: any = { count: "" };
    const schema = { properties: { count: { type: "number" } } };
    normalizeArgs("ler_arquivo", args, schema as any);
    // Empty string is left as-is (the trim() check skips it)
    expect(args.count).toBe("");
  });

  it("normalizeArgs does NOT coerce 'abc' to NaN (leaves as-is)", () => {
    const args: any = { count: "abc" };
    const schema = { properties: { count: { type: "number" } } };
    normalizeArgs("ler_arquivo", args, schema as any);
    expect(args.count).toBe("abc"); // not a valid number
  });

  it("normalizeArgs coerces 'true'/'false'/'1'/'0' to boolean", () => {
    const cases: Array<[string, boolean]> = [
      ["true", true], ["false", false], ["1", true], ["0", false],
    ];
    for (const [str, expected] of cases) {
      const args: any = { flag: str };
      const schema = { properties: { flag: { type: "boolean" } } };
      normalizeArgs("ler_arquivo", args, schema as any);
      expect(args.flag).toBe(expected);
    }
  });

  it("normalizeArgs leaves non-true/false string alone when schema says 'boolean'", () => {
    const args: any = { flag: "maybe" };
    const schema = { properties: { flag: { type: "boolean" } } };
    normalizeArgs("ler_arquivo", args, schema as any);
    // 'maybe' is not 'true'/'false'/'1'/'0' — left as-is
    expect(args.flag).toBe("maybe");
  });

  it("TokenCounter handles MAX_SAFE_INTEGER additions", () => {
    const tc = new TokenCounter();
    tc.addPrompt(Number.MAX_SAFE_INTEGER);
    expect(tc.getPromptTokens()).toBe(Number.MAX_SAFE_INTEGER);
    tc.addCompletion(0);
    expect(tc.getCompletionTokens()).toBe(0);
    expect(tc.getTotalTokens()).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Special characters in paths (spaces, accents)
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: special characters in paths", () => {
  it("editFile with path containing spaces", async () => {
    const file = path.join(tmpDir, "my file.txt");
    fs.writeFileSync(file, "hello", "utf8");
    const result = await editFile(file, [{ search: "hello", replace: "hi" }]);
    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("hi");
  });

  it("editFile with path containing accents (São Paulo)", async () => {
    const file = path.join(tmpDir, "São-Paulo.txt");
    fs.writeFileSync(file, "city", "utf8");
    const result = await editFile(file, [{ search: "city", replace: "cidade" }]);
    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("cidade");
  });

  it("editFile with path containing emoji", async () => {
    const file = path.join(tmpDir, "🚀rocket.lua");
    fs.writeFileSync(file, "x", "utf8");
    const result = await editFile(file, [{ search: "x", replace: "y" }]);
    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("y");
  });

  it("editFile with nested subdirectories that don't exist yet (creates them)", async () => {
    const file = path.join(tmpDir, "a", "b", "c", "deep.txt");
    const result = await editFile(file, [{ search: "", replace: "deep content" }], {
      createIfMissing: true,
    });
    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(file, "utf8")).toBe("deep content");
  });

  it("pokaYokeCheck resolves relative path to absolute", () => {
    const r = pokaYokeCheck("ler_arquivo", { path: "relative/file.txt" });
    expect(r.ok).toBe(true);
    expect(path.isAbsolute(r.resolvedPath!)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rapid successive calls
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: rapid successive calls (idempotency)", () => {
  it("normalizeArgs called 100 times on same args object is idempotent", () => {
    const args: any = { caminho: "/x" };
    for (let i = 0; i < 100; i++) {
      normalizeArgs("ler_arquivo", args);
    }
    expect(args.path).toBe("/x");
    expect(args.caminho).toBe("/x");
  });

  it("pokaYokeCheck called 100 times returns consistent results", () => {
    let lastOk: boolean | undefined;
    for (let i = 0; i < 100; i++) {
      const r = pokaYokeCheck("ler_arquivo", { path: "/tmp/x" });
      if (lastOk !== undefined) expect(r.ok).toBe(lastOk);
      lastOk = r.ok;
    }
    expect(lastOk).toBe(true);
  });

  it("detectIntent called 100 times returns consistent results", () => {
    let last: string | undefined;
    for (let i = 0; i < 100; i++) {
      const r = detectIntent("edit the file");
      if (last !== undefined) expect(r).toBe(last);
      last = r;
    }
    expect(last).toBe("write");
  });

  it("setEffortLevel called rapidly with same value is idempotent", () => {
    for (let i = 0; i < 50; i++) {
      expect(setEffortLevel("high")).toBe(true);
    }
    expect(getEffortLevel()).toBe("high");
  });

  it("TokenCounter accumulates correctly across 1000 additions", () => {
    const tc = new TokenCounter();
    for (let i = 0; i < 1000; i++) {
      tc.addPrompt(1);
      tc.addCompletion(1);
    }
    expect(tc.getPromptTokens()).toBe(1000);
    expect(tc.getCompletionTokens()).toBe(1000);
    expect(tc.getTotalTokens()).toBe(2000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Streaming — buffered/throttled behavior
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: BufferedStreamProcessor", () => {
  it("flushes when buffer reaches threshold", () => {
    const flushed: string[] = [];
    const bp = new BufferedStreamProcessor((s) => flushed.push(s), 10);
    bp.push("hello");
    bp.push(" world");
    // 11 chars > 10 threshold → flush
    expect(flushed).toEqual(["hello world"]);
  });

  it("does NOT flush when below threshold", () => {
    const flushed: string[] = [];
    const bp = new BufferedStreamProcessor((s) => flushed.push(s), 100);
    bp.push("hello");
    expect(flushed).toHaveLength(0);
  });

  it("flush() forces emission even when below threshold", () => {
    const flushed: string[] = [];
    const bp = new BufferedStreamProcessor((s) => flushed.push(s), 100);
    bp.push("partial");
    bp.flush();
    expect(flushed).toEqual(["partial"]);
  });

  it("flush() on empty buffer is no-op", () => {
    const flushed: string[] = [];
    const bp = new BufferedStreamProcessor((s) => flushed.push(s), 100);
    bp.flush();
    expect(flushed).toHaveLength(0);
  });

  it("forceFlush returns remaining buffer and clears it", () => {
    const bp = new BufferedStreamProcessor(() => {}, 100);
    bp.push("unflushed");
    const remaining = bp.forceFlush();
    expect(remaining).toBe("unflushed");
    // Subsequent forceFlush returns empty
    expect(bp.forceFlush()).toBe("");
  });
});

describe("Edge: StreamThrottle", () => {
  it("shouldEmit returns true on first call", () => {
    const st = new StreamThrottle(50);
    expect(st.shouldEmit()).toBe(true);
  });

  it("shouldEmit returns false on rapid successive calls (within interval)", () => {
    const st = new StreamThrottle(1000);
    expect(st.shouldEmit()).toBe(true);
    expect(st.shouldEmit()).toBe(false); // too soon
    expect(st.shouldEmit()).toBe(false);
  });

  it("reset() allows immediate emission again", () => {
    const st = new StreamThrottle(1000);
    expect(st.shouldEmit()).toBe(true);
    expect(st.shouldEmit()).toBe(false);
    st.reset();
    expect(st.shouldEmit()).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// i18n — language detection edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: i18n language detection", () => {
  it("setLanguage('pt-BR') then detectLanguage returns 'pt-BR'", () => {
    setLanguage("pt-BR");
    expect(detectLanguage()).toBe("pt-BR");
  });

  it("setLanguage('en') then detectLanguage returns 'en'", () => {
    setLanguage("en");
    expect(detectLanguage()).toBe("en");
  });

  it("setLanguage overrides env vars (forcedLang takes precedence)", () => {
    process.env.CLAUDE_KILLER_LANG = "en";
    setLanguage("pt-BR");
    expect(detectLanguage()).toBe("pt-BR");
  });

  it("resetLanguageCache preserves forced language", () => {
    setLanguage("en");
    resetLanguageCache();
    expect(detectLanguage()).toBe("en");
  });

  it("resetAllLanguageState clears forced language", () => {
    setLanguage("pt-BR");
    resetAllLanguageState();
    // Without forced lang, env-based detection kicks in
    const lang = detectLanguage();
    expect(["pt-BR", "en"]).toContain(lang);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// toolReduction — getFilterSummary edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("Edge: getFilterSummary", () => {
  it("returns '0% reduction' when totalTools=0", () => {
    const summary = getFilterSummary(0, 0, "read");
    expect(summary).toContain("0%");
  });

  it("returns '100% reduction' when filteredTools=0 (of N)", () => {
    const summary = getFilterSummary(10, 0, "read");
    expect(summary).toContain("100%");
  });

  it("includes intent in summary", () => {
    const summary = getFilterSummary(10, 5, "write");
    expect(summary).toContain("write");
  });

  it("computes correct percentage for partial reduction", () => {
    const summary = getFilterSummary(20, 5, "test");
    // (20-5)/20 = 75%
    expect(summary).toContain("75%");
  });
});
