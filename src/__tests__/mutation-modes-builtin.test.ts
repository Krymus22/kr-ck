/**
 * mutation-modes-builtin.test.ts — Kills survived mutations in src/modes.ts.
 *
 * Target mutations (MEDIUM priority, survived):
 *   - L364: `getBuiltInModes().find((m) => m.name === mode.name)`
 *           mutation: `===` → `!==` (finds first NON-matching built-in)
 *   - L391: same pattern in the legacy flat-file branch of getUserModes()
 *   - L365/L392: `mode.builtIn = !!builtIn`
 *           mutation: `!!builtIn` → `!builtIn` (inverts flag)
 *
 * Why they survived: existing tests save user modes but never assert the
 * `builtIn` flag value after load. saveUserMode() sets builtIn=false on
 * save, but getUserModes() RECOMPUTES it via `!!builtIn` based on name
 * match with built-in modes. Without an assertion on the loaded flag,
 * flipping `===` to `!==` or `!!` to `!` goes undetected.
 *
 * Killing strategy:
 *   1. Save a user mode with a UNIQUE name (no built-in match).
 *      → loaded builtIn must be `false`.
 *      Mutation `=== → !==`: find() returns first built-in (truthy) →
 *      builtIn=true. Test fails. ✓ KILLED.
 *      Mutation `!! → !`: builtIn = !undefined = true. Test fails. ✓ KILLED.
 *
 *   2. Save a user mode with same name as a built-in (e.g. "roblox").
 *      → loaded builtIn must be `true` (recomputed, not the saved false).
 *      Mutation `!! → !`: builtIn = !robloxBuiltIn = false. Test fails. ✓ KILLED.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("modes — builtIn flag (mutation killers for L364/L391)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-modes-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("user mode with UNIQUE name has builtIn=false after load (kills === → !== on L364)", async () => {
    const { saveUserMode, getUserModes } = await import("./../modes.js");
    saveUserMode({
      name: "unique-mutation-test-mode",
      label: "Unique",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });

    const users = getUserModes();
    const mode = users.find((m) => m.name === "unique-mutation-test-mode");
    expect(mode).toBeDefined();
    // CRITICAL assertion: builtIn must be false for a user mode whose name
    // does NOT match any built-in. If `===` is mutated to `!==`, find()
    // returns the first built-in mode (truthy) and builtIn becomes true.
    expect(mode!.builtIn).toBe(false);
  });

  it("user mode with same name as built-in has builtIn=true after load (kills !! → ! on L365)", async () => {
    const { saveUserMode, getUserModes } = await import("./../modes.js");
    // Save a user mode named "roblox" — same as the built-in roblox mode.
    // saveUserMode sets builtIn=false on save, but getUserModes recomputes
    // it: `const builtIn = getBuiltInModes().find(m => m.name === mode.name)`
    // → finds the roblox built-in → `mode.builtIn = !!builtIn` → true.
    saveUserMode({
      name: "roblox",
      label: "Custom Roblox Override",
      description: "user override",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });

    const users = getUserModes();
    const mode = users.find((m) => m.name === "roblox");
    expect(mode).toBeDefined();
    // CRITICAL assertion: builtIn must be TRUE because the name matches a
    // built-in. If `!!builtIn` is mutated to `!builtIn`, this becomes false.
    expect(mode!.builtIn).toBe(true);
  });

  it("user mode with UNIQUE name loaded via getMode has builtIn=false (kills === → !== on L391 legacy branch)", async () => {
    const { saveUserMode, getMode } = await import("./../modes.js");
    saveUserMode({
      name: "another-unique-mode",
      label: "Another",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });

    const loaded = getMode("another-unique-mode");
    expect(loaded).not.toBeNull();
    // getMode → getAllModes → getUserModes (L391 legacy branch). Same
    // mutation risk: `===` → `!==` would set builtIn=true.
    expect(loaded!.builtIn).toBe(false);
  });

  it("multiple user modes: built-in names get builtIn=true, unique names get builtIn=false", async () => {
    const { saveUserMode, getUserModes } = await import("./../modes.js");
    saveUserMode({
      name: "roblox",
      label: "Override",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });
    saveUserMode({
      name: "my-custom-thing",
      label: "Custom",
      description: "",
      builtIn: false,
      enableTools: [],
      enableSkills: [],
      enableFeatures: [],
    });

    const users = getUserModes();
    const robloxMode = users.find((m) => m.name === "roblox");
    const customMode = users.find((m) => m.name === "my-custom-thing");
    expect(robloxMode).toBeDefined();
    expect(customMode).toBeDefined();
    // Both flags must be correct simultaneously — this catches mutations
    // that might pass one assertion but not the other.
    expect(robloxMode!.builtIn).toBe(true);
    expect(customMode!.builtIn).toBe(false);
  });
});
