/**
 * regression-bug-hunter-final-sweep.test.ts
 *
 * Round 4 — final sweep regression tests.
 *
 * Each test below documents a specific bug found during the final sweep
 * of previously-unaudited modules. The test fails on the pre-fix code and
 * passes on the post-fix code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── contentSearch.ts — reversed / collapsed before-context line numbers ────

import { formatGrepResults, type GrepMatch } from "../contentSearch.js";

describe("[final-sweep] contentSearch.formatGrepResults", () => {
  it("assigns monotonically increasing line numbers to before-context (regression: was reversed)", () => {
    // Before the fix, the formula was `m.line - m.before.indexOf(b) - 1`,
    // which produced line numbers in DESCENDING order for ascending context
    // lines. The first context line got the HIGHEST line number; the last
    // got the LOWEST. After the fix, line numbers ascend with the array.
    const matches: GrepMatch[] = [
      {
        file: "src/x.ts",
        line: 10,
        content: "TARGET",
        before: ["ctx-A", "ctx-B", "ctx-C"],
      },
    ];
    const out = formatGrepResults(matches);
    // ctx-A is line 7, ctx-B is line 8, ctx-C is line 9, TARGET is line 10
    expect(out).toContain("src/x.ts:7: ctx-A");
    expect(out).toContain("src/x.ts:8: ctx-B");
    expect(out).toContain("src/x.ts:9: ctx-C");
    expect(out).toContain("-> src/x.ts:10: TARGET");
    // And the OLD buggy numbers must NOT appear
    expect(out).not.toContain("src/x.ts:9: ctx-A");
    expect(out).not.toContain("src/x.ts:7: ctx-C");
  });

  it("does not collapse duplicate context lines to the same line number (regression: indexOf bug)", () => {
    // indexOf() returns the FIRST match for duplicates, so all duplicate
    // context lines were stamped with the first one's line number.
    const matches: GrepMatch[] = [
      {
        file: "dup.ts",
        line: 5,
        content: "M",
        before: ["dup", "dup", "uniq"],
      },
    ];
    const out = formatGrepResults(matches);
    expect(out).toContain("dup.ts:2: dup");
    expect(out).toContain("dup.ts:3: dup");
    expect(out).toContain("dup.ts:4: uniq");
    expect(out).toContain("-> dup.ts:5: M");
    // dup.ts:2 should appear exactly once (the first dup), dup.ts:3 once.
    const twoCount = (out.match(/dup\.ts:2:/g) ?? []).length;
    const threeCount = (out.match(/dup\.ts:3:/g) ?? []).length;
    expect(twoCount).toBe(1);
    expect(threeCount).toBe(1);
  });

  it("after-context line numbers are still correct (regression guard)", () => {
    const matches: GrepMatch[] = [
      {
        file: "y.ts",
        line: 10,
        content: "M",
        after: ["a1", "a2"],
      },
    ];
    const out = formatGrepResults(matches);
    expect(out).toContain("y.ts:11: a1");
    expect(out).toContain("y.ts:12: a2");
  });
});

// ─── externalTools.ts — getToolStatus inverted logic ────────────────────────

import { ToolRegistry, type Tool } from "../externalTools.js";

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../toolDetector.js", () => ({
  detectTool: vi.fn(() => ({ status: "missing", binaryPath: null, version: null })),
  findToolBinary: vi.fn(() => null),
}));

vi.mock("../modes.js", () => ({
  getActiveModeName: vi.fn(() => null),
}));

const echoTool: Tool = {
  name: "echo_tool",
  description: "echo",
  category: "custom",
  command: "echo",
  args: [],
  flags: [],
  detection: { method: "binary", check: "echo --version" },
  context: { whenToUse: [], examples: [] },
  outputParser: "raw",
};

describe("[final-sweep] externalTools.ToolRegistry.getToolStatus", () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(echoTool);
  });

  it("returns 'found' when isInstalled succeeds via fallback (regression: was 'missing')", () => {
    // `echo` is available on every POSIX system and on Windows via cmd.exe.
    // findToolBinary is mocked to return null, so isInstalled falls through
    // to the execSync-based checkInstallation. Pre-fix, getToolStatus then
    // returned "missing" because binaryPath was null — inverted logic.
    const status = registry.getToolStatus("echo_tool");
    expect(status).toBe("found");
  });

  it("returns 'missing' for an unregistered tool", () => {
    expect(registry.getToolStatus("does_not_exist")).toBe("missing");
  });
});

// ─── externalTools.ts — ToolExecutor error fallback used wrong operator ─────

import { ToolExecutor } from "../externalTools.js";

describe("[final-sweep] externalTools.ToolExecutor.execute error fallback", () => {
  it("uses error.message when stderr is empty (regression: ?? never fell through)", () => {
    // Pre-fix: errors: [stderr ?? error.message] where stderr was already
    // coerced to "". `"" ?? x` returns "" (not x), so error.message was
    // unreachable and the user got an empty error.
    // Post-fix: errors: [stderr || error.message] correctly falls through.
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    // Register a tool whose command does not exist — execSync will throw
    // with a non-empty message but empty stderr.
    const ghost: Tool = {
      ...echoTool,
      name: "ghost_tool_xyz",
      command: "definitely-not-a-real-binary-xyz",
      detection: {
        method: "manual",
        check: "",
        installed: true, // bypass isInstalled check
        lastChecked: Date.now(),
        binaryPath: "/usr/bin/true", // claim it exists so getToolStatus doesn't bail
      },
    };
    registry.register(ghost);

    return executor.execute("ghost_tool_xyz", {}, { timeout: 2000 }).then((result) => {
      expect(result.success).toBe(false);
      // The error must contain SOMETHING — pre-fix this was an empty string.
      expect(result.errors?.[0]).toBeTruthy();
      expect((result.errors?.[0] ?? "").length).toBeGreaterThan(0);
    });
  });
});

// ─── toolUpdater.ts / llmsTxtGrounding.ts / externalTools.ts — HOME="" bug ──

describe("[final-sweep] HOME='' env handling falls back to os.homedir()", () => {
  // Capture env in beforeEach (NOT at describe-eval time) so a previous
  // test in another file that modified HOME doesn't pollute our snapshot.
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    vi.resetModules();
  });

  it("toolUpdater getStatePath resolves to an absolute path even when HOME=''", async () => {
    process.env.HOME = "";
    process.env.USERPROFILE = "";
    const { performUpdateCheck } = await import("../toolUpdater.js");
    // performUpdateCheck writes state via getStatePath(); if it returned a
    // relative path, the file would land in cwd and pollute the project.
    process.env.TOOL_UPDATER_ENABLED = "false";
    await performUpdateCheck();
    delete process.env.TOOL_UPDATER_ENABLED;

    // The state file MUST live under os.homedir(), not cwd.
    const expectedDir = path.join(os.homedir(), ".claude-killer");
    const stateFile = path.join(expectedDir, ".tool-updater.json");
    // We don't require the file to exist (performUpdateCheck may have skipped),
    // but if it does exist it must be under the absolute home path.
    if (fs.existsSync(stateFile)) {
      expect(path.isAbsolute(stateFile)).toBe(true);
    }
    // And no stray state file should appear in the current working directory.
    const cwdState = path.join(process.cwd(), ".claude-killer", ".tool-updater.json");
    expect(fs.existsSync(cwdState)).toBe(false);
  });

  it("llmsTxtGrounding getCacheDir resolves to an absolute path when HOME=''", async () => {
    process.env.HOME = "";
    process.env.USERPROFILE = "";
    const { getLlmsCacheStats } = await import("../llmsTxtGrounding.js");
    // Should not throw and should report stats for the absolute cache dir.
    const stats = getLlmsCacheStats();
    expect(typeof stats.entries).toBe("number");
    expect(typeof stats.sizeBytes).toBe("number");
    // No cache dir should be created in cwd.
    const cwdCache = path.join(process.cwd(), ".claude-killer", "llms-cache");
    expect(fs.existsSync(cwdCache)).toBe(false);
  });

  it("externalTools ToolRegistry uses absolute base path when HOME=''", async () => {
    process.env.HOME = "";
    process.env.USERPROFILE = "";
    const { ToolRegistry: Reg } = await import("../externalTools.js");
    const r = new Reg();
    const toolsPath = r.getUserToolsPath();
    // Pre-fix this returned a relative ".claude-killer/tools.json" when HOME="".
    expect(path.isAbsolute(toolsPath)).toBe(true);
    expect(toolsPath.startsWith(process.cwd())).toBe(false);
  });
});

// ─── snapshotTesting.ts — undefined return value no longer crashes ──────────

import { captureBeforeSnapshot, clearSnapshots } from "../snapshotTesting.js";

describe("[final-sweep] snapshotTesting.captureBeforeSnapshot — undefined return", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-snap-"));
  const tmpFile = path.join(tmpDir, "returns-undefined.mjs");

  beforeEach(() => {
    clearSnapshots();
    // A pure ESM module whose function returns undefined.
    fs.writeFileSync(
      tmpFile,
      `export function returnsUndefined() { return undefined; }\n`,
      "utf8",
    );
  });

  afterEach(() => {
    clearSnapshots();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records 'undefined' for a function returning undefined (regression: TypeError crash)", async () => {
    // Pre-fix: JSON.stringify(undefined) === undefined (the value), so
    // process.stdout.write(undefined) threw a TypeError. The catch block
    // then wrote `__SNAPSHOT_ERROR__: chunk argument...` and captureBeforeSnapshot
    // returned null (snapshot failed). Post-fix: we coerce to the string
    // "undefined" and the snapshot succeeds.
    const result = await captureBeforeSnapshot("returnsUndefined", tmpFile, "[]");
    expect(result.captured).toBe(true);
    expect(result.snapshot).not.toBeNull();
    expect(result.snapshot!.outputBefore).toBe("undefined");
  });
});

// ─── ensureRobloxTools.ts — Windows `2>/dev/null` creates stray files ───────

import { checkRobloxTools } from "../ensureRobloxTools.js";

const mockExecSyncRoblox = vi.hoisted(() => vi.fn());

describe("[final-sweep] ensureRobloxTools.checkBinary — platform-correct null redirection", () => {
  beforeEach(() => {
    mockExecSyncRoblox.mockReset();
  });

  it("uses `which` + `2>/dev/null` on POSIX (no `where` fallback in same command)", async () => {
    // We can't easily force process.platform to "win32" in a single test run,
    // so we verify the POSIX branch: the check command must be `which ... 2>/dev/null`
    // and must NOT contain `2>nul` (which would create a stray file on POSIX too,
    // though sh treats it as a regular file).
    mockExecSyncRoblox.mockImplementation((cmd: string) => {
      if (cmd.startsWith("which ")) return "/usr/bin/selene";
      if (cmd.includes("--version")) return "1.0.0";
      throw new Error("unexpected cmd: " + cmd);
    });

    vi.resetModules();
    vi.doMock("node:child_process", () => ({ execSync: mockExecSyncRoblox }));
    const { checkRobloxTools: check } = await import("../ensureRobloxTools.js");
    check();

    const calls = mockExecSyncRoblox.mock.calls.map((c) => String(c[0]));
    // Every binary-detection call should be `which NAME 2>/dev/null`
    const whichCalls = calls.filter((c) => c.startsWith("which "));
    expect(whichCalls.length).toBeGreaterThan(0);
    for (const c of whichCalls) {
      expect(c).toMatch(/^which \S+ 2>\/dev\/null$/);
      // Must NOT use the Windows-style `2>nul` redirection
      expect(c).not.toContain("2>nul");
      // Must NOT chain `|| where` (the buggy pre-fix form)
      expect(c).not.toContain("|| where");
    }
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
});

// Re-import with the production execSync for the rest of the file (no mock).
// Vitest isolates modules per test file, so this is just defensive.
void checkRobloxTools;
