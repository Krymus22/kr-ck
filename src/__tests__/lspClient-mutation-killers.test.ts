/**
 * lspClient-mutation-killers.test.ts — Targeted tests to kill survived
 * mutations in src/lspClient.ts that are NOT covered by
 * lspClient-mutation-env.test.ts (which covers L74/L99).
 *
 * Target mutations (MEDIUM priority, survived):
 *   - L68: `if (raw === "false" || raw === "0") return false` in envBool()
 *           mutation: `===` → `!==` on first `===`
 *           Effect: LSP_ENABLED="false" no longer disables LSP (returns
 *           fallback `true` instead of `false`).
 *
 * FALSE POSITIVES (documented, NOT tested):
 *   - L67: `if (raw === "true" || raw === "1") return true` → `|| → &&`.
 *           When fallback=true (the only use in lspClient), both "true" and
 *           "1" produce the same result (true) via the fallback at L69.
 *   - L91: `return candidates[1]` → `candidates[0]`. detectTsserverPath()
 *           return value is only checked for null vs non-null in
 *           resolveLspCommand(); the actual string is never used.
 *   - L139/L142/L157/L164: `return null → return undefined`. All callers
 *           check truthiness (`if (!fresh)`, `if (!cmdSpec)`, etc.) — both
 *           null and undefined are falsy.
 *
 * Per BUSINESS_RULES.md §17: this file does NOT modify any source code, only
 * adds regression tests. No `require()` calls (ESM `import` only).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(),
  warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { isLspAvailable } from "../lspClient.js";

describe("mutation-killers / lspClient.ts — L68 envBool `=== → !==` on false branch", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  /**
   * Mutation: L68 `if (raw === "false" || raw === "0") return false`
   *           mutation: `===` → `!==` on first `===`
   *
   * Effect: `raw !== "false"` → for raw="false", this is false.
   *   `false || (raw === "0")` → `false || false` → false.
   *   Falls through to `return fallback` (true for LSP_ENABLED).
   *   So LSP_ENABLED="false" no longer disables LSP.
   *
   * Killing strategy: set LSP_ENABLED="false" and LSP_TSSERVER_PATH to
   * a non-empty string. Call isLspAvailable("typescript").
   *
   * Without mutation: envBool returns false → cfg.enabled=false →
   *   isLspAvailable returns false.
   * With mutation: envBool returns true (fallback) → cfg.enabled=true →
   *   tsserverPath is set → isLspAvailable returns true.
   *   Test asserts false → fails. ✓ KILLED.
   */
  it("LSP_ENABLED='false' disables LSP (kills `=== → !==` on L68)", () => {
    process.env.LSP_ENABLED = "false";
    process.env.LSP_TSSERVER_PATH = "/fake/typescript-language-server";
    delete process.env.LSP_PYLSP_PATH;

    // Without mutation: envBool("LSP_ENABLED", true) with raw="false" → false.
    //   cfg.enabled=false → isLspAvailable returns false.
    // With mutation `=== → !==` on L68: raw !== "false" → false, falls to
    //   fallback (true) → cfg.enabled=true → isLspAvailable returns true.
    expect(isLspAvailable("typescript")).toBe(false);
  });

  /**
   * Sanity: LSP_ENABLED="0" also disables LSP (confirms the second half
   * of L68 works — `raw === "0"` is unaffected by the first `===` mutation).
   */
  it("LSP_ENABLED='0' disables LSP (confirms baseline for L68 second operand)", () => {
    process.env.LSP_ENABLED = "0";
    process.env.LSP_TSSERVER_PATH = "/fake/typescript-language-server";
    delete process.env.LSP_PYLSP_PATH;

    expect(isLspAvailable("typescript")).toBe(false);
  });
});
