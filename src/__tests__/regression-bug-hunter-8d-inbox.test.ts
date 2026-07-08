/**
 * regression-bug-hunter-8d-inbox.test.ts — Bug Hunter #8d, Bug 7.
 *
 * Bug 7: inboxOrganizer.ts `moveFile` used `fs.renameSync` directly,
 * which throws `EXDEV` when source and destination live on different
 * filesystems (common on Linux when /tmp is tmpfs and ~/.claude-killer
 * is on the user's home partition). The error surfaced as a per-file
 * error in `organizeInbox`, causing inbox organization to fail
 * silently for affected files. Fix: catch EXDEV and fall back to
 * `copyFileSync` + `unlinkSync`.
 *
 * This test lives in a separate file because verifying the fallback
 * requires mocking `fs.renameSync` to throw EXDEV. The ESM `node:fs`
 * namespace is not configurable, so `vi.spyOn(fs, "renameSync")`
 * throws — we must use top-level `vi.mock("node:fs", ...)` with
 * `importActual` to pass through the real fs while overriding
 * `renameSync`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

// ─── Hoisted mocks + real-fs captures ───────────────────────────────────────
//
// `vi.hoisted` runs BEFORE `vi.mock` factories are evaluated, so we can
// safely create the mock fns here and reference them in the factory.
// We also capture the REAL fs functions inside the factory so test
// bodies can delegate to them without infinite recursion.

const mocks = vi.hoisted(() => ({
  renameSync: vi.fn(),
  copyFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  realRenameSync: null as null | ((s: string, d: string) => void),
  realCopyFileSync: null as null | ((s: string, d: string) => void),
  realUnlinkSync: null as null | ((p: string) => void),
  realExistsSync: null as null | ((p: string) => boolean),
  realMkdirSync: null as null | ((p: string, opts?: unknown) => void),
  realWriteFileSync: null as null | ((p: string, data: string | Buffer, enc?: string) => void),
  realMkdtempSync: null as null | ((p: string) => string),
  realRmSync: null as null | ((p: string, opts?: unknown) => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  // Capture the real implementations so test bodies can delegate to
  // them without recursing back through the mock.
  mocks.realRenameSync = actual.renameSync;
  mocks.realCopyFileSync = actual.copyFileSync;
  mocks.realUnlinkSync = actual.unlinkSync;
  mocks.realExistsSync = actual.existsSync;
  mocks.realMkdirSync = actual.mkdirSync;
  mocks.realWriteFileSync = actual.writeFileSync;
  mocks.realMkdtempSync = actual.mkdtempSync;
  mocks.realRmSync = actual.rmSync;
  return {
    ...actual,
    renameSync: mocks.renameSync,
    copyFileSync: mocks.copyFileSync,
    unlinkSync: mocks.unlinkSync,
  };
});

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// ─── Import module UNDER TEST after mocks are in place ──────────────────────

import { organizeInbox } from "../inboxOrganizer.js";

// ─── Setup / Teardown ───────────────────────────────────────────────────────

let tmpHome: string;
let realHome: string | undefined;
let realUserprofile: string | undefined;

beforeEach(() => {
  tmpHome = mocks.realMkdtempSync!(path.join(os.tmpdir(), "bh8d-inbox-"));
  realHome = process.env.HOME;
  realUserprofile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Create the inbox dir for the "roblox" mode.
  const inbox = path.join(tmpHome, ".claude-killer", "modes", "roblox", "inbox");
  mocks.realMkdirSync!(inbox, { recursive: true });

  // Reset mocks to delegate to the REAL fs (captured at mock-factory
  // time). This lets the happy-path test use real fs operations.
  mocks.renameSync.mockImplementation((s: string, d: string) =>
    mocks.realRenameSync!(s, d),
  );
  mocks.copyFileSync.mockImplementation((s: string, d: string) =>
    mocks.realCopyFileSync!(s, d),
  );
  mocks.unlinkSync.mockImplementation((p: string) =>
    mocks.realUnlinkSync!(p),
  );
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserprofile;
  try { mocks.realRmSync!(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  vi.clearAllMocks();
});

// Helper: write a file using the REAL fs (so the test setup isn't
// affected by the rename/copy/unlink mocks).
function realWrite(file: string, content: string): void {
  mocks.realWriteFileSync!(file, content, "utf8");
}
function realExists(file: string): boolean {
  return mocks.realExistsSync!(file);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Bug Hunter #8d — inboxOrganizer.ts moveFile EXDEV fallback", () => {
  it("moveFile falls back to copy+unlink when renameSync throws EXDEV", () => {
    const inbox = path.join(tmpHome, ".claude-killer", "modes", "roblox", "inbox");
    realWrite(path.join(inbox, "skill.md"), "# My Skill\n");

    // Make renameSync throw EXDEV, and use real copyFileSync/unlinkSync
    // for the fallback so the file actually moves.
    mocks.renameSync.mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("cross-device link not permitted");
      err.code = "EXDEV";
      throw err;
    });
    // copyFileSync and unlinkSync still delegate to real fs (set in beforeEach).

    const result = organizeInbox("roblox");

    // BEFORE the fix: renameSync threw EXDEV, organizeInbox put the file
    // in `errors[]`. AFTER the fix: copy+unlink succeeds, file is in
    // `organized[]`.
    expect(result.errors).toEqual([]);
    expect(result.organized).toHaveLength(1);
    expect(result.organized[0]!.fileName).toBe("skill.md");
    expect(mocks.renameSync).toHaveBeenCalledTimes(1);
    expect(mocks.copyFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.unlinkSync).toHaveBeenCalledTimes(1);

    // File was actually moved (via the real copy+unlink fallback).
    expect(realExists(path.join(inbox, "skill.md"))).toBe(false);
    const dest = path.join(tmpHome, ".claude-killer", "modes", "roblox", "skills", "skill.md");
    expect(realExists(dest)).toBe(true);
  });

  it("moveFile rethrows non-EXDEV errors from renameSync (lands in errors[])", () => {
    const inbox = path.join(tmpHome, ".claude-killer", "modes", "roblox", "inbox");
    realWrite(path.join(inbox, "skill.md"), "# My Skill\n");

    // EACCES (permission denied) is NOT EXDEV — should NOT fall back to
    // copy+unlink, the error should propagate up to organizeInbox's
    // try/catch and land in `errors[]`.
    mocks.renameSync.mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error("permission denied");
      err.code = "EACCES";
      throw err;
    });

    const result = organizeInbox("roblox");

    expect(result.organized).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.fileName).toBe("skill.md");
    expect(result.errors[0]!.error).toMatch(/permission denied/);
    expect(mocks.renameSync).toHaveBeenCalledTimes(1);
    // Copy fallback must NOT be triggered for non-EXDEV errors.
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
  });

  it("moveFile uses plain renameSync (no copy) when it succeeds", () => {
    const inbox = path.join(tmpHome, ".claude-killer", "modes", "roblox", "inbox");
    realWrite(path.join(inbox, "skill.md"), "# My Skill\n");

    // Default mock implementations delegate to real fs (set in beforeEach).
    const result = organizeInbox("roblox");

    expect(result.organized).toHaveLength(1);
    expect(mocks.copyFileSync).not.toHaveBeenCalled();
    expect(mocks.unlinkSync).not.toHaveBeenCalled();
    // File actually moved (real rename).
    expect(realExists(path.join(inbox, "skill.md"))).toBe(false);
    const dest = path.join(tmpHome, ".claude-killer", "modes", "roblox", "skills", "skill.md");
    expect(realExists(dest)).toBe(true);
  });
});
