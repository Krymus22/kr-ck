/**
 * autoMemory-mutation-killers.test.ts — Targeted tests to kill LOW + MEDIUM
 * priority survived mutations in src/autoMemory.ts.
 *
 * This file is named `autoMemory-mutation-killers.test.ts` so the
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

// ─── autoMemory.ts ──────────────────────────────────────────────────────────

describe("mutation-killers / autoMemory.ts — file/dir creation guards", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-automem-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * Mutation: L42 `if (!fs.existsSync(dir))` → `if (fs.existsSync(dir))`
   *           (remove negation)
   *
   * Without mutation: if dir doesn't exist → mkdir. With mutation: if
   * dir DOES exist → mkdir (no-op since recursive). When dir doesn't
   * exist, mkdir is NOT called → writeFileSync later fails because dir
   * doesn't exist (or, in our case, ensureAutoMemoryFile silently
   * leaves dir un-created).
   *
   * Killing strategy: start with a fresh HOME where the .claude-killer
   * dir doesn't exist. Call ensureAutoMemoryFile(). Verify the dir IS
   * created. With mutation, dir is NOT created (and the file isn't
   * either).
   */
  it("ensureAutoMemoryFile creates the .claude-killer dir when missing (kills `! → remove` on L42)", async () => {
    const { ensureAutoMemoryFile, getAutoMemoryPath } = await import("./../autoMemory.js");
    const dir = path.dirname(getAutoMemoryPath());
    expect(fs.existsSync(dir)).toBe(false);
    ensureAutoMemoryFile();
    expect(fs.existsSync(dir)).toBe(true);
  });

  /**
   * Mutation: L45 `if (!fs.existsSync(AUTO_MEMORY_FILE))` → `if (fs.existsSync(AUTO_MEMORY_FILE))`
   *           (remove negation)
   *
   * Without mutation: if file doesn't exist → write header. With
   * mutation: if file DOES exist → write header (overwrites). When file
   * doesn't exist, header is NOT written → file is not created.
   *
   * Killing strategy: fresh HOME, call ensureAutoMemoryFile(), verify
   * the file IS created and contains the header text. With mutation,
   * the file is NOT created.
   */
  it("ensureAutoMemoryFile creates the auto-memory.md file with header when missing (kills `! → remove` on L45)", async () => {
    const { ensureAutoMemoryFile, getAutoMemoryPath } = await import("./../autoMemory.js");
    const file = getAutoMemoryPath();
    expect(fs.existsSync(file)).toBe(false);
    ensureAutoMemoryFile();
    expect(fs.existsSync(file)).toBe(true);
    const content = fs.readFileSync(file, "utf8");
    expect(content).toContain("Auto Memory");
  });
});

describe("mutation-killers / autoMemory.ts — MAX_BYTES truncation (L67/L68)", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-automem-bytes-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * Mutations on L67-68:
   *   - `result.length > MAX_BYTES` → `>= MAX_BYTES` (truncate at exactly MAX_BYTES)
   *   - `result.slice(0, MAX_BYTES) + "\n... (truncated)"` → `result.slice(0, MAX_BYTES) - "\n... (truncated)"`
   *     (string + string → string concat; with `-`, becomes `string - string` = NaN)
   *
   * Killing strategy: write an auto-memory file larger than MAX_BYTES
   * (25 * 1024 = 25600). Call readAutoMemory(). Verify the result
   * CONTAINS "... (truncated)" and is a non-NaN string.
   *
   * Mutation `> → >=`: only matters at exactly MAX_BYTES; for content
   * MUCH larger than MAX_BYTES, both > and >= are true. So we need a
   * separate test at EXACTLY MAX_BYTES to kill `>=`.
   *
   * Mutation `+ → -`: result becomes `NaN` (string - string). The
   * function returns "NaN" — test asserting "... (truncated)" present
   * fails.
   */
  it("readAutoMemory truncates content > MAX_BYTES and appends marker (kills `+ → -` on L68)", async () => {
    const { ensureAutoMemoryFile, readAutoMemory, getAutoMemoryPath } = await import("./../autoMemory.js");
    ensureAutoMemoryFile();
    const file = getAutoMemoryPath();
    // Write content MUCH larger than MAX_BYTES (25*1024 = 25600)
    // ensureAutoMemoryFile already wrote a ~200-byte header; we overwrite
    // with a huge payload.
    const huge = "x".repeat(50_000);
    fs.writeFileSync(file, huge, "utf8");

    const result = readAutoMemory();
    expect(typeof result).toBe("string");
    expect(result).not.toBe("NaN"); // mutation `+ → -` produces NaN → "NaN"
    expect(result).toContain("... (truncated)");
  });

  /**
   * Mutation: L67 `result.length > MAX_BYTES` → `result.length >= MAX_BYTES`
   *
   * Killing strategy: write content whose truncated result has length
   * EXACTLY equal to MAX_BYTES. Without mutation: NOT truncated (no
   * marker). With mutation: truncated (marker present).
   *
   * The truncation uses `lines = content.split("\n").slice(0, 200)` and
   * then `result = lines.join("\n")`. So we need lines that join to
   * exactly 25600 chars. Simplest: 200 lines of 128 chars each (200*128
   * + 199 newlines = 25600 + 199 = 25799). Hmm, hard to hit exactly
   * 25600. Let me try a single line of exactly 25600 chars (no newlines).
   * Then split("\n") = [line], slice(0,200) = [line], join = line, length
   * = 25600. `> 25600` is false → no truncation. `>= 25600` is true →
   * truncation.
   */
  it("readAutoMemory at exactly MAX_BYTES does NOT truncate (kills `> → >=` on L67)", async () => {
    const { ensureAutoMemoryFile, readAutoMemory, getAutoMemoryPath } = await import("./../autoMemory.js");
    ensureAutoMemoryFile();
    const file = getAutoMemoryPath();
    // 25600 chars exactly = MAX_BYTES. Single line, no newlines.
    // (MAX_BYTES is `25 * 1024` per src/autoMemory.ts L35)
    const exact = "y".repeat(25 * 1024);
    fs.writeFileSync(file, exact, "utf8");

    const result = readAutoMemory();
    // Without mutation: length === MAX_BYTES → not truncated → no marker.
    // With mutation `> → >=`: length === MAX_BYTES → truncated → marker present.
    expect(result).not.toContain("... (truncated)");
  });
});

describe("mutation-killers / autoMemory.ts — L83 timestamp format", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-automem-ts-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * Mutation: L83 `new Date().toISOString().split("T")[0]`
   *           mutation: `[0]` → `[1]` (returns time part instead of date)
   *
   * Survived because existing appendAutoMemory tests only check that the
   * entry text appears in the file, not the format of the timestamp
   * header.
   *
   * Killing strategy: call appendAutoMemory(), read the file, find the
   * `## <timestamp>` header. Without mutation: timestamp is `YYYY-MM-DD`
   * (date only). With mutation: timestamp is `HH:MM:SS.mmmZ` (time only).
   * Assert timestamp matches `/^\d{4}-\d{2}-\d{2}$/`.
   */
  it("appendAutoMemory uses date-only timestamp in header (kills `[0] → [1]` on L83)", async () => {
    const { ensureAutoMemoryFile, appendAutoMemory, getAutoMemoryPath } = await import("./../autoMemory.js");
    ensureAutoMemoryFile();
    appendAutoMemory("test entry for timestamp check");
    const file = getAutoMemoryPath();
    const content = fs.readFileSync(file, "utf8");

    // Find the `## <timestamp>` header line (not the "# Auto Memory" title)
    const headerMatch = content.match(/^## (\S+)$/m);
    expect(headerMatch).not.toBeNull();
    const timestamp = headerMatch![1];
    // Without mutation: "YYYY-MM-DD" — matches /^\d{4}-\d{2}-\d{2}$/.
    // With mutation `[0] → [1]`: "HH:MM:SS.mmmZ" — does NOT match.
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("mutation-killers / autoMemory.ts — L109/L118/L119 correction regexes", () => {
  /**
   * Mutations on L109/L118/L119: `\s+` → `\s-` (the regex `\s+` becomes
   * `\s-`, which only matches whitespace followed by a hyphen).
   *
   *   L109: /nunca\s+(use|faça|escreva|coloque)/ → /nunca\s-(use|faça|escreva|coloque)/
   *   L118: /never\s+(use|do|write|put)/ → /never\s-(use|do|write|put)/
   *   L119: /always\s+(use|do|write|put)/ → /always\s-(use|do|write|put)/
   *
   * Survived because existing tests use multi-pattern messages that
   * match OTHER patterns:
   *   - "Never use var, use let instead" also matches /instead/ (L122)
   *     → so the L118 mutation survives.
   *   - No existing test for "nunca use" or "always use" alone.
   *
   * Killing strategy: use messages that match ONLY the targeted pattern.
   * Assert detectUserCorrection returns non-null.
   */
  it("detectUserCorrection matches 'nunca use X' (kills `+ → -` on L109)", async () => {
    const { detectUserCorrection } = await import("./../autoMemory.js");
    // "nunca use print" matches ONLY /nunca\s+(use|faça|escreva|coloque)/.
    // With mutation `\s-`, doesn't match → returns null. Test fails.
    expect(detectUserCorrection("nunca use print")).not.toBeNull();
  });

  it("detectUserCorrection matches 'Never use X' alone (kills `+ → -` on L118)", async () => {
    const { detectUserCorrection } = await import("./../autoMemory.js");
    // Plain "Never use print" — no "instead", "actually", "wrong", etc.
    // Without mutation: matches /never\s+use/. With mutation: doesn't.
    expect(detectUserCorrection("Never use print")).not.toBeNull();
  });

  it("detectUserCorrection matches 'Always use X' alone (kills `+ → -` on L119)", async () => {
    const { detectUserCorrection } = await import("./../autoMemory.js");
    // "Always use pcall" without "always" being followed by another trigger.
    expect(detectUserCorrection("Always use pcall")).not.toBeNull();
  });
});

describe("mutation-killers / autoMemory.ts — L150/L151 acknowledged-correction check", () => {
  /**
   * Mutations on L150-151:
   *   L150: `iaLower.includes("anotad") || iaLower.includes("noted")`
   *         mutation: `||` → `&&`
   *   L151: `iaLower.includes("lembrarei") || iaLower.includes("i'll remember")`
   *         mutation: `||` → `&&`
   *
   * Survived because existing tests use "Anotado!" which matches
   * "anotad" only. With `|| → &&`, the condition becomes
   * `iaLower.includes("anotad") && iaLower.includes("noted")` —
   * "anotado" doesn't contain "noted", so the condition is false →
   * function returns a suggestion instead of null. But the existing
   * test asserts `result).toBeNull()` — that should fail!
   *
   * Wait, let me re-check the existing test. The test at
   * autoMemory.test.ts L80-85 uses message "Anotado! Vou lembrar disso."
   * — let's analyze:
   *   - "anotado" → matches "anotad" (L150 first half)
   *   - "lembrar" → does NOT match "lembrarei" exactly (L151 first half
   *     is "lembrarei", not "lembrar"). Wait, "lembrarei" is a substring
   *     check, so "lembrarei" must be IN the string. "Anotado! Vou
   *     lembrar disso." does NOT contain "lembrarei". So L151 first half
   *     is false. L151 second half: "i'll remember" — not in the string
   *     either. So L151 is false.
   *
   *   - L150 first half: "anotad" → matches "anotado" → TRUE.
   *   - L150 with mutation `|| → &&`: "anotad" && "noted" → true && false = FALSE.
   *   - L151: false (either way).
   *   - Overall (L150 || L151): original = true || false = true → returns null.
   *     mutated = false || false = false → returns suggestion.
   *
   *   - Test `expect(result).toBeNull()` — original passes, mutated FAILS.
   *
   * Wait, but the mutation report says L150 survives. Let me re-verify.
   * Looking at the report:
   *   src/autoMemory.ts:150 — || → && | ("noted") ||
   *
   * So the mutation IS `|| → &&` on the SECOND `||` (between "noted" and
   * "lembrarei"). The expression is:
   *   `iaLower.includes("anotad") || iaLower.includes("noted") || iaLower.includes("lembrarei") || iaLower.includes("i'll remember")`
   *
   * The mutation flips the SECOND `||` to `&&`. The expression becomes:
   *   `iaLower.includes("anotad") || (iaLower.includes("noted") && iaLower.includes("lembrarei")) || iaLower.includes("i'll remember")`
   *
   * For "anotado! vou lembrar disso.": 
   *   - "anotad" → true. Short-circuits, no need to check the rest.
   *   - Original: true || ... → true.
   *   - Mutated: true || (false && false) || false → true.
   *   - SAME result! Both return null.
   *
   * So the existing test passes either way, and the mutation survives.
   *
   * Killing strategy: use a message that matches "noted" only (NOT
   * "anotad"). With mutation, "noted" && "lembrarei" must BOTH be true.
   * "noted" alone → original true, mutated false.
   */
  it("maybeSuggestMemoryWrite returns null when IA says 'noted' alone (kills `|| → &&` on L150)", async () => {
    const { maybeSuggestMemoryWrite } = await import("./../autoMemory.js");
    // User corrects; IA responds with just "Noted." (English only).
    // Without mutation: "noted" matches L150 second half → returns null.
    // With mutation `|| → &&`: needs "noted" AND "lembrarei" — false →
    // returns suggestion (non-null). Test fails.
    const result = maybeSuggestMemoryWrite("Never use print", "Noted.");
    expect(result).toBeNull();
  });

  /**
   * Mutation on L151: `|| → &&` between "lembrarei" and "i'll remember".
   * Killing strategy: IA says "i'll remember" alone (no "lembrarei").
   */
  it("maybeSuggestMemoryWrite returns null when IA says \"i'll remember\" alone (kills `|| → &&` on L151)", async () => {
    const { maybeSuggestMemoryWrite } = await import("./../autoMemory.js");
    // Without mutation: "i'll remember" matches L151 second half → null.
    // With mutation `|| → &&`: needs "lembrarei" AND "i'll remember" — false →
    // returns suggestion (non-null). Test fails.
    const result = maybeSuggestMemoryWrite("Always use pcall", "I'll remember this.");
    expect(result).toBeNull();
  });
});
