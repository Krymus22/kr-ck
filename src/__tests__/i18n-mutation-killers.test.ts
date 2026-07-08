/**
 * i18n-mutation-killers.test.ts — Targeted tests to kill LOW + MEDIUM
 * priority survived mutations in src/i18n.ts.
 *
 * This file is named `i18n-mutation-killers.test.ts` so the
 * mutation-test.py script picks it up via the `{basename}*.test.ts` glob
 * (scripts/mutation-test.py:find_test_files).
 *
 * Per BUSINESS_RULES.md §17: this file does NOT modify any source code, only
 * adds regression tests. No `require()` calls (ESM `import` only). The
 * existing source is assumed correct — these tests close gaps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── i18n.ts ────────────────────────────────────────────────────────────────

describe("mutation-killers / i18n.ts — L52 locale detection OR chain", () => {
  let prevLang: string | undefined;
  let prevLcAll: string | undefined;
  let prevLcMessages: string | undefined;
  let prevLanguage: string | undefined;
  let prevCkLang: string | undefined;

  beforeEach(() => {
    prevLang = process.env.LANG;
    prevLcAll = process.env.LC_ALL;
    prevLcMessages = process.env.LC_MESSAGES;
    prevLanguage = process.env.LANGUAGE;
    prevCkLang = process.env.CLAUDE_KILLER_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    delete process.env.LANGUAGE;
    delete process.env.CLAUDE_KILLER_LANG;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
    if (prevLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prevLcAll;
    if (prevLcMessages === undefined) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = prevLcMessages;
    if (prevLanguage === undefined) delete process.env.LANGUAGE;
    else process.env.LANGUAGE = prevLanguage;
    if (prevCkLang === undefined) delete process.env.CLAUDE_KILLER_LANG;
    else process.env.CLAUDE_KILLER_LANG = prevCkLang;
    vi.resetModules();
  });

  /**
   * Mutations on L52:
   *   `if (lower.includes("pt_br") || lower.includes("pt-br") || lower.startsWith("pt"))`
   *
   *   - `("pt_br") ||` → `&&`: becomes
   *     `(lower.includes("pt_br") && lower.includes("pt-br")) || lower.startsWith("pt")`
   *   - `("pt-br") ||` → `&&`: becomes
   *     `lower.includes("pt_br") || (lower.includes("pt-br") && lower.startsWith("pt"))`
   *
   * Survived because typical locale strings like "pt_BR.UTF-8" or "pt-BR"
   * also `startsWith("pt")`, so the third operand catches them and the
   * mutated ANDs are masked.
   *
   * Killing strategy: use a locale string that contains "pt_br" but
   * does NOT start with "pt". A realistic example: "fr_FR:pt_BR:pt_PT"
   * (LANGUAGE env var on Linux supports `:`-separated fallback list).
   *   - "fr_fr:pt_br:pt_pt".toLowerCase() = "fr_fr:pt_br:pt_pt"
   *   - includes("pt_br") = true
   *   - includes("pt-br") = false
   *   - startsWith("pt") = false
   *   - Original: true || false || false = true → returns "pt-BR".
   *   - Mutation 1 (`("pt_br") ||` → `&&`): (true && false) || false = false
   *     → falls through to "en" check (also false) → returns default "pt-BR".
   *     Hmm, that's the same result.
   *
   * Wait, the default at L63 is "pt-BR" too! So if all checks fail, it
   * returns "pt-BR" anyway. The mutation is not killable via the result
   * alone for a "pt_br"-containing string.
   *
   * Better strategy: use a locale string that contains "pt-br" but not
   * "pt_br" and doesn't start with "pt". e.g., "en_US:pt-BR".
   *   - toLowerCase = "en_us:pt-br"
   *   - includes("pt_br") = false
   *   - includes("pt-br") = true
   *   - startsWith("pt") = false
   *   - Original: false || true || false = true → returns "pt-BR".
   *   - Mutation 2 (`("pt-br") ||` → `&&`): false || (true && false) = false
   *     → falls through to "en" check (startsWith("en")? "en_us:pt-br" — yes!)
   *     → returns "en".
   *
   *   That's different! Test asserts "pt-BR" → mutation returns "en" → fails.
   */
  it("LANGUAGE='en_US:pt-BR' detects pt-BR via the includes('pt-br') branch (kills `|| → &&` on L52 second operator)", async () => {
    const { detectLanguage, resetAllLanguageState } = await import("./../i18n.js");
    resetAllLanguageState();
    process.env.LANGUAGE = "en_US:pt-BR";
    // Without mutation: includes("pt-br") is true → returns "pt-BR".
    // With mutation `("pt-br") ||` → `&&`: needs (includes("pt-br") && startsWith("pt"))
    //   = (true && false) = false. Then checks startsWith("en") = true → returns "en".
    expect(detectLanguage()).toBe("pt-BR");
  });
});

describe("mutation-killers / i18n.ts — L360/L383 false-promise attempt counter", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => { vi.resetModules(); });

  /**
   * Mutations on L360 and L383:
   *   `const suffix = attempt > 1 ? \` (attempt ${attempt} of 2)\` : "";`
   *   mutation: `>` → `>=`
   *
   * Effect: with `>= 1`, attempt=1 makes `1 >= 1` true → adds suffix
   * " (attempt 1 of 2)" even on the FIRST attempt.
   *
   * Killing strategy: call t("promise.false_detected", "phrase", 1) —
   * the FIRST attempt. Without mutation: no suffix. With mutation:
   * suffix " (attempt 1 of 2)" present.
   *
   * Both L360 (pt-BR) and L383 (en) need testing.
   */
  it("pt-BR: first attempt (1) does NOT include suffix (kills `> → >=` on L360)", async () => {
    const { t, setLanguage } = await import("./../i18n.js");
    setLanguage("pt-BR");
    const result = t("promise.false_detected", "vou investigar", 1);
    // Without mutation: 1 > 1 is false → suffix is "".
    // With mutation `> → >=`: 1 >= 1 is true → suffix added.
    expect(result).not.toContain("tentativa 1 de 2");
  });

  it("en: first attempt (1) does NOT include suffix (kills `> → >=` on L383)", async () => {
    const { t, setLanguage } = await import("./../i18n.js");
    setLanguage("en");
    const result = t("promise.false_detected", "I will investigate", 1);
    // Without mutation: 1 > 1 is false → suffix is "".
    // With mutation `> → >=`: 1 >= 1 is true → suffix added.
    expect(result).not.toContain("attempt 1 of 2");
  });

  /**
   * Sanity: second attempt (2) DOES include suffix. This confirms the
   * branch is reachable and the suffix template is correct.
   */
  it("second attempt (2) DOES include suffix (confirms baseline)", async () => {
    const { t, setLanguage } = await import("./../i18n.js");
    setLanguage("en");
    const result = t("promise.false_detected", "I will investigate", 2);
    expect(result).toContain("attempt 2 of 2");
  });
});
