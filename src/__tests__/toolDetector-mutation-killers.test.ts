/**
 * toolDetector-mutation-killers.test.ts — Targeted tests to kill survived
 * mutations in src/toolDetector.ts that are NOT covered by
 * toolDetector-mutation-platform.test.ts (which covers L117/L175/L195/L273).
 *
 * Target mutations (MEDIUM priority, survived):
 *   - L154: `return found || null` in findInPath()  (Unix branch)
 *           mutation: `||` → `&&` (returns null when found, "" when not)
 *   - L178: `stat.isFile() && (stat.mode & 0o111) !== 0` in isExecutable()
 *           mutation: `&&` → `||` (directories with exec bit treated as executable)
 *
 * FALSE POSITIVES (documented, NOT tested):
 *   - L165: `return null → return undefined` in findInPath catch block.
 *           Caller checks `if (pathResult)` — both null and undefined are falsy.
 *   - L199: `match?.[1] → match?.[0]` in getVersion().
 *           Regex `(\d+\.\d+\.\d+)` has one capture group; [0] and [1] are
 *           identical when the whole match IS the capture group.
 *   - L201: `return null → return undefined` in getVersion catch block.
 *           Caller checks `if (version)` — both falsy.
 *
 * Per BUSINESS_RULES.md §17: this file does NOT modify any source code, only
 * adds regression tests. No `require()` calls (ESM `import` only).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), success: vi.fn(), throttle: vi.fn(),
}));

import { execSync } from "node:child_process";
import { detectTool } from "../toolDetector.js";

const mockedExecSync = vi.mocked(execSync);

describe("mutation-killers / toolDetector.ts — L154 findInPath `|| → &&`", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-td-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Mutation: L154 `return found || null` → `return found && null`
   *
   * In findInPath() (Unix branch):
   *   const result = execSync(`which ${toolName}`, ...);
   *   const found = result.trim().split("\n")[0]?.trim();
   *   return found || null;
   *
   * Without mutation: if `which rojo` returns "/usr/local/bin/rojo\n",
   *   found = "/usr/local/bin/rojo" (truthy) → returns it.
   * With mutation `|| → &&`: found && null → null. findInPath returns null
   *   even when the binary IS in PATH.
   *
   * Killing strategy: mock execSync so `which rojo` returns a path and
   * `<path> --version` returns a version. Call detectTool("rojo").
   * Without mutation: status="found", binaryPath="/usr/local/bin/rojo".
   * With mutation: findInPath returns null → deep search → no rojo in
   *   tmpHome paths → status="missing".
   */
  it("detectTool finds binary in PATH via findInPath (kills `|| → &&` on L154)", () => {
    // Mock execSync: "which rojo" → path; "<path> --version" → version
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which ")) return "/usr/local/bin/rojo\n";
      if (cmd.includes("--version")) return "rojo 7.6.1\n";
      throw new Error("unexpected command: " + cmd);
    });

    const result = detectTool("rojo");
    // Without mutation: found in PATH → status="found".
    // With mutation `|| → &&`: findInPath returns null → deep search →
    //   no rojo in tmpHome → status="missing". Test fails. ✓ KILLED.
    expect(result.status).toBe("found");
    expect(result.binaryPath).toContain("rojo");
  });
});

describe("mutation-killers / toolDetector.ts — L178 isExecutable `&& → ||`", () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevProfile: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-mut-td-exec-"));
    prevHome = process.env.HOME;
    prevProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  /**
   * Mutation: L178 `stat.isFile() && (stat.mode & 0o111) !== 0` → `||`
   *
   * isExecutable() on Unix returns true if the path is a regular file AND
   * has at least one execute bit. With mutation `||`, it returns true if
   * the path is a regular file OR has execute bit. Directories typically
   * have execute bit (mode 0o755), so a directory would be "executable".
   *
   * Killing strategy: create a DIRECTORY at a search path
   * (~/.claude-killer/bin/rojo as a dir). Mock execSync so `which` fails
   * (findInPath returns null) and `--version` fails. Call detectTool with
   * forceDeepSearch=true.
   *
   * Without mutation: isExecutable(dirPath) = isFile() && ... = false →
   *   detectTool continues → status="missing".
   * With mutation `||`: isExecutable = isFile() || (mode & 0o111) →
   *   false || true → true → getVersion called → fails → status="found",
   *   version=null. Test asserts "missing" → fails. ✓ KILLED.
   */
  it("isExecutable returns false for a directory at a search path (kills `&& → ||` on L178)", () => {
    // Skip on Windows — isExecutable has different logic there
    if (process.platform === "win32") return;

    // Create a DIRECTORY at the first search path
    const dirPath = path.join(tmpHome, ".claude-killer", "bin", "rojo");
    fs.mkdirSync(dirPath, { recursive: true });

    // Mock execSync: "which rojo" fails, "<path> --version" fails
    mockedExecSync.mockImplementation(() => {
      throw new Error("not found");
    });

    const result = detectTool("rojo", { forceDeepSearch: true });
    // Without mutation: isExecutable(dir) = false → status="missing".
    // With mutation `||`: isExecutable(dir) = true → getVersion fails →
    //   status="found", version=null. Test fails. ✓ KILLED.
    expect(result.status).toBe("missing");
  });
});
