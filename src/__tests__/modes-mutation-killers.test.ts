/**
 * modes-mutation-killers.test.ts — Targeted tests to kill LOW + MEDIUM
 * priority survived mutations in src/modes.ts.
 *
 * This file is named `modes-mutation-killers.test.ts` so the
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

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  throttle: vi.fn(),
}));

// ─── modes.ts ───────────────────────────────────────────────────────────────

describe("mutation-killers / modes.ts — L349 catch-block of dirNames filter (SKIPPED — real bug found)", () => {
  /**
   * Mutation: L349 `} catch { return false; }` → `} catch { return true; }`
   *
   * ANALYSIS: This mutation is NOT testable as-is because of a REAL BUG in
   * the surrounding code. The for-loop at L282/L357 calls
   * `fs.statSync(entryPath).isDirectory()` WITHOUT a try/catch. When a
   * broken entry (e.g., a broken symlink) is in the modes dir, the
   * dirNames filter (L274/L349) catches the error gracefully, but the
   * for-loop CRASHES on the same entry. The outer try/catch swallows
   * the crash, and the function returns an empty/partial result.
   *
   * This means:
   *   - Without mutation: broken entry crashes the for-loop → returns [].
   *   - With mutation: broken entry crashes the for-loop → returns [].
   *   - Same result either way → mutation is masked by the bug.
   *
   * REAL BUG: modes.ts getUserModes() (L357) and getBuiltInModes() (L282)
   * for-loops do NOT wrap `fs.statSync(entryPath).isDirectory()` in a
   * try/catch. A single broken entry (broken symlink, permission denied,
   * etc.) causes the ENTIRE function to silently return [] (or partial),
   * losing all other valid modes. This is a robustness bug, not a §17
   * violation. Recommended fix: wrap the statSync call in try/catch and
   * `continue` on error, mirroring the dirNames filter pattern.
   *
   * Per task brief: "Focus on writing TESTS that kill the mutations, not
   * fixing code." — so this mutation is SKIPPED (not killed) and the bug
   * is REPORTED for a future fix.
   */
  it.skip("SKIPPED: L349 mutation masked by for-loop crash bug (see comment above)", () => {
    // Intentionally empty — see the describe-block comment for analysis.
  });
});

describe("mutation-killers / modes.ts — L364 builtIn flag via NEW dir-format branch", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-modes-new-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * Mutation: L364 `getBuiltInModes().find((m) => m.name === mode.name)`
   *           mutation: `===` → `!==` (finds first NON-matching built-in)
   *
   * The existing mutation-modes-builtin.test.ts writes user modes via
   * `saveUserMode()` which produces the LEGACY flat .json file. That
   * exercises L391 (legacy branch), NOT L364 (new dir-format branch).
   * So L364 survives.
   *
   * Killing strategy: create the user mode directly as
   * `<home>/.claude-killer/modes/<name>/config.json` (new format). Then
   * `getUserModes()` loads it via L357-372 (new dir-format branch), and
   * L364's `find(m => m.name === mode.name)` is exercised.
   *
   * For a UNIQUE name (no built-in match): builtIn must be false.
   *   Mutation `=== → !==`: find() returns the first built-in whose name
   *   is NOT equal to "unique-new-format-mode" — truthy → builtIn = true.
   *   Test fails. ✓ KILLED.
   */
  it("user mode in NEW <mode>/config.json format with unique name has builtIn=false (kills `=== → !==` on L364)", async () => {
    const { getUserModes } = await import("./../modes.js");

    // Create the new dir-format user mode manually
    const modeDir = path.join(tmpHome, ".claude-killer", "modes", "unique-new-format-mode");
    fs.mkdirSync(modeDir, { recursive: true });
    fs.writeFileSync(
      path.join(modeDir, "config.json"),
      JSON.stringify({
        name: "unique-new-format-mode",
        label: "Unique New Format",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      }),
      "utf8",
    );

    const users = getUserModes();
    const mode = users.find((m) => m.name === "unique-new-format-mode");
    expect(mode).toBeDefined();
    // CRITICAL: builtIn must be false because no built-in has this name.
    // Mutation `=== → !==` makes find() return the first built-in (truthy)
    // → builtIn becomes true.
    expect(mode!.builtIn).toBe(false);
  });

  /**
   * Mutation: L365 `mode.builtIn = !!builtIn`
   *           mutation: `! → (remove negation)` → `mode.builtIn = !builtIn`
   *
   * Killing strategy: user mode in NEW dir-format with SAME name as a
   * built-in (e.g. "roblox"). Without mutation: builtIn=true (matches
   * built-in). With mutation `!!builtIn → !builtIn`: builtIn=false.
   * Test fails. ✓ KILLED.
   */
  it("user mode in NEW dir-format with built-in name has builtIn=true (kills `!!builtIn → !builtIn` on L365)", async () => {
    const { getUserModes } = await import("./../modes.js");

    const modeDir = path.join(tmpHome, ".claude-killer", "modes", "roblox");
    fs.mkdirSync(modeDir, { recursive: true });
    fs.writeFileSync(
      path.join(modeDir, "config.json"),
      JSON.stringify({
        name: "roblox",
        label: "Override New Format",
        description: "",
        builtIn: false,
        enableTools: [],
        enableSkills: [],
        enableFeatures: [],
      }),
      "utf8",
    );

    const users = getUserModes();
    const mode = users.find((m) => m.name === "roblox" && m.label === "Override New Format");
    expect(mode).toBeDefined();
    // CRITICAL: builtIn must be TRUE because the name matches a built-in.
    // Mutation `!!builtIn → !builtIn` makes this false.
    expect(mode!.builtIn).toBe(true);
  });
});
