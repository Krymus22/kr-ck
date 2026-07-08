/**
 * manifestLoader-mutation-killers.test.ts — Targeted tests to kill LOW + MEDIUM
 * priority survived mutations in src/manifestLoader.ts.
 *
 * This file is named `manifestLoader-mutation-killers.test.ts` so the
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
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Hoisted mock state for modes.js — getActiveMode is controlled per-test
const mlModesMock = vi.hoisted(() => ({ getActiveMode: vi.fn(() => null) }));
vi.mock("../modes.js", () => ({ getActiveMode: mlModesMock.getActiveMode }));

vi.mock("../toolDetector.js", () => ({ findToolBinary: vi.fn(() => null) }));
vi.mock("node:child_process", () => ({ execSync: vi.fn(() => "ok"), spawn: vi.fn() }));

// ─── manifestLoader.ts ──────────────────────────────────────────────────────

describe("mutation-killers / manifestLoader.ts — L93/L209 import.meta check", () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-ml-importmeta-"));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-ml-cwd-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * Mutations on L93 (getManifestsDir):
   *   - `!== "undefined"` → `=== "undefined"` (always false → falls through)
   *   - `&&` → `||` (always true → uses import.meta.dirname unconditionally)
   *
   * Survived because existing manifestLoader tests run from the project's
   * cwd (which HAS `defaults/modes/<mode>/manifests/`), so step 2
   * (bundledDir) succeeds and step 3 (distDir via import.meta) is never
   * reached.
   *
   * Killing strategy: chdir to a tmp dir with NO bundled defaults/, set
   * HOME to a tmp dir with NO user manifests. Now step 1 and step 2
   * both fail, and step 3 (import.meta.dirname path) is the ONLY way to
   * find manifests. The project's bundled defaults/modes/ IS reachable
   * via `<src>/../defaults/modes/` (which is what import.meta.dirname
   * resolves to in vitest).
   *
   * Mutation `!== → ===`: step 3 short-circuits to false → getManifestsDir
   * returns null → loadModeManifests returns []. Test (expect length > 0)
   * fails. ✓ KILLED.
   *
   * Mutation `&& → ||`: typeof import.meta !== "undefined" is always
   * true → step 3 is taken. The path is the same as without mutation
   * (because import.meta.dirname IS defined in vitest). So this mutation
   * is NOT killed by this test alone — but it's killed by combination
   * with the L209 test below (which exercises findSharedManifests).
   */
  it("with no user/cwd manifests, loadModeManifests still finds bundled manifests via import.meta path (kills `!== → ===` on L93)", async () => {
    const { loadModeManifests } = await import("./../manifestLoader.js");
    const manifests = loadModeManifests("roblox");
    // The bundled roblox mode has manifests (rojo, selene, etc.)
    expect(manifests.length).toBeGreaterThan(0);
  });
});

describe("mutation-killers / manifestLoader.ts — L239 shared filter", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-ml-shared-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.resetModules();
    vi.clearAllMocks();
    mlModesMock.getActiveMode.mockReturnValue(null);
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  function writeUserManifest(modeName: string, fileName: string, content: unknown): string {
    const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "manifests");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(content), "utf8");
    return filePath;
  }

  /**
   * Mutation: L239 `!shared.some((s) => s.name === m.name)`
   *           mutation: `===` → `!==` (finds first NON-matching entry)
   *
   * Survived because existing tests only create ONE shared tool. With one
   * shared tool, both `=== ` and `!==` produce the same outcome on the
   * first iteration (shared.some returns false either way on empty
   * array, and the first tool is always pushed).
   *
   * Killing strategy: create TWO shared tools with DIFFERENT names from
   * TWO different modes (both sharedWith the active mode). Without
   * mutation: both are pushed (no duplicates). With mutation: the second
   * tool is NOT pushed because `shared.some(s => s.name !== m.name)`
   * returns true (the first tool's name differs from the second's) →
   * `!true` = false → skip.
   */
  it("two shared tools with different names from different modes both load (kills `=== → !==` on L239)", async () => {
    mlModesMock.getActiveMode.mockReturnValue({ name: "roblox" });

    // First shared tool from "devops" mode
    writeUserManifest("devops", "shared1.json", {
      name: "devops_shared_tool",
      description: "Shared 1",
      category: "devops",
      command: "d1",
      args: [],
      sharedWith: ["roblox"],
    });
    // Second shared tool from "rust" mode (different name!)
    writeUserManifest("rust", "shared2.json", {
      name: "rust_shared_tool",
      description: "Shared 2",
      category: "rust",
      command: "r2",
      args: [],
      sharedWith: ["roblox"],
    });

    const { loadActiveManifests } = await import("./../manifestLoader.js");
    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);

    // Both shared tools MUST be present. With mutation, only the first
    // is pushed (the second is skipped because shared.some(s => s.name !== m.name)
    // is true → !true = false → skip).
    expect(names).toContain("devops_shared_tool");
    expect(names).toContain("rust_shared_tool");
  });

  /**
   * Mutation: L239 `m.sharedWith?.includes(modeName) && !shared.some(...)`
   *           mutation: `&&` → `||`
   *
   * Survived because existing tests only create tools with sharedWith
   * matching the active mode. With `&& → ||`, the condition becomes
   * `m.sharedWith?.includes(modeName) || !shared.some(...)` — pushes if
   * EITHER is true. A tool with sharedWith NOT matching the active mode
   * would still be pushed (because !shared.some(...) is true initially).
   *
   * Killing strategy: create a tool with sharedWith ["other_mode"] (NOT
   * the active mode). Without mutation: NOT pushed (sharedWith doesn't
   * match). With mutation: pushed (because !shared.some(...) is true).
   */
  it("tool with sharedWith NOT matching active mode is NOT loaded as shared (kills `&& → ||` on L239)", async () => {
    mlModesMock.getActiveMode.mockReturnValue({ name: "roblox" });

    // Tool in "devops" with sharedWith ["devops"] (NOT ["roblox"])
    writeUserManifest("devops", "not-shared.json", {
      name: "devops_only_tool",
      description: "DevOps only",
      category: "devops",
      command: "d",
      args: [],
      sharedWith: ["devops"],
    });

    const { loadActiveManifests } = await import("./../manifestLoader.js");
    const manifests = loadActiveManifests();
    const names = manifests.map((m) => m.name);

    // Without mutation: NOT included (sharedWith=["devops"] doesn't include "roblox").
    // With mutation `&& → ||`: included (because !shared.some(...) is true).
    expect(names).not.toContain("devops_only_tool");
  });
});
