/**
 * regression-bug-hunter-2d-fs-race.test.ts
 *
 * Regression tests for Bug Hunter #2d Bug B: loadProjectMemoryFiles() race
 * condition. If a memory file is deleted between fs.existsSync() and
 * fs.statSync()/fs.readFileSync(), the function used to throw ENOENT. This
 * propagated up to getSystemPrompt() → ensureHistoryInitialized() →
 * addUserMessage(), crashing the app on the user's first message after they
 * (or a watcher) deleted a memory file. Fix: wrap stat/read in try/catch.
 *
 * This file is SEPARATE from regression-bug-hunter-2d-history-edge-cases.test.ts
 * because we need to mock `node:fs` at the module level, which would break
 * the other file's tests (they need real fs for temp dir operations).
 *
 * Uses vi.mock with importOriginal so we can delegate to real fs by default
 * and override specific methods per-test.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ─── Track which fs methods should throw ───────────────────────────────────
// We can't reference outer variables in vi.mock factory (hoisted), so we use
// vi.hoisted to create a shared state object.
const mockState = vi.hoisted(() => ({
  statSyncThrows: false as boolean | string[], // false = no throw, string[] = throw for these paths
  readFileSyncThrows: false as boolean | string[],
  statSyncErrno: "ENOENT" as string,
  readFileSyncErrno: "EACCES" as string,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const buildMock = () => ({
    ...actual,
    statSync: vi.fn((p: fs.PathLike) => {
      const pp = String(p);
      if (Array.isArray(mockState.statSyncThrows) && mockState.statSyncThrows.some(s => pp.endsWith(s))) {
        const err = new Error(`${mockState.statSyncErrno}: no such file or directory`) as NodeJS.ErrnoException;
        err.code = mockState.statSyncErrno;
        throw err;
      }
      return actual.statSync(p);
    }),
    readFileSync: vi.fn((p: fs.PathLike | number, options?: any) => {
      const pp = String(p);
      if (Array.isArray(mockState.readFileSyncThrows) && mockState.readFileSyncThrows.some(s => pp.endsWith(s))) {
        const err = new Error(`${mockState.readFileSyncErrno}: permission denied`) as NodeJS.ErrnoException;
        err.code = mockState.readFileSyncErrno;
        throw err;
      }
      return actual.readFileSync(p as any, options);
    }),
    // existsSync delegates to real (it internally calls stat, but we want to
    // control only statSync/readFileSync behavior, not existsSync)
    existsSync: actual.existsSync,
  });
  const mocked = buildMock();
  // history.ts uses `import fs from "node:fs"` (default import). In Node.js
  // ESM, the default export of built-ins is the namespace itself. We must
  // set `default` to our mocked namespace so the default import picks up the
  // overridden statSync/readFileSync.
  return { ...mocked, default: mocked };
});

// Mock extensions/effortLevels/session to keep getSystemPrompt deterministic
vi.mock("../extensions.js", () => ({ getActiveSkills: () => [] }));
vi.mock("../effortLevels.js", () => ({ getEffortPromptSnippet: () => "" }));
vi.mock("../session.js", () => ({
  appendMessage: () => {},
  appendCompactionSnapshot: () => {},
  getActiveSessionId: () => null,
  setActiveSession: () => {},
}));

// Import AFTER mocks
import { loadProjectMemoryFiles, getSystemPrompt, reloadProjectMemory } from "../history.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bh2d-fs-"));
}

function withCwd<T>(newCwd: string, fn: () => T): T {
  const original = process.cwd();
  try {
    process.chdir(newCwd);
    return fn();
  } finally {
    process.chdir(original);
  }
}

beforeEach(() => {
  mockState.statSyncThrows = false;
  mockState.readFileSyncThrows = false;
  mockState.statSyncErrno = "ENOENT";
  mockState.readFileSyncErrno = "EACCES";
});

afterEach(() => {
  mockState.statSyncThrows = false;
  mockState.readFileSyncThrows = false;
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug B: loadProjectMemoryFiles() race condition
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2d — Bug B: loadProjectMemoryFiles handles file deletion gracefully", () => {
  it("does NOT throw when fs.statSync throws ENOENT after existsSync returned true", () => {
    const dir = makeTempDir();
    try {
      // Create a real file so existsSync naturally returns true
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "will disappear");

      withCwd(dir, () => {
        // Make statSync throw for CLAUDE.md (simulating deletion after existsSync)
        mockState.statSyncThrows = ["CLAUDE.md"];

        // Invalidate cache first
        reloadProjectMemory();

        // Bug B: without the fix, this throws ENOENT and crashes the caller.
        expect(() => loadProjectMemoryFiles()).not.toThrow();
        const files = loadProjectMemoryFiles();
        expect(Array.isArray(files)).toBe(true);
        // The file that "disappeared" should be skipped, not crash.
        expect(files.length).toBe(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT throw when fs.readFileSync throws EACCES (permission denied)", () => {
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "permission denied content");

        // statSync succeeds (file exists), but readFileSync throws EACCES
        mockState.readFileSyncThrows = ["CLAUDE.md"];

        // Invalidate cache
        reloadProjectMemory();

        expect(() => loadProjectMemoryFiles()).not.toThrow();
        const files = loadProjectMemoryFiles();
        expect(files.length).toBe(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT throw when fs.statSync throws in the .map() phase (after walk)", () => {
    // Simulate the race where the file is found in the walk loop but
    // disappears before the .map() phase reads it.
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "transient content");

        // Make statSync throw for ALL calls (both in walk loop and in .map())
        mockState.statSyncThrows = ["CLAUDE.md"];

        expect(() => loadProjectMemoryFiles()).not.toThrow();
        const files = loadProjectMemoryFiles();
        expect(files.length).toBe(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getSystemPrompt does NOT crash when memory file disappears mid-load", () => {
    // End-to-end: the bug B fix prevents getSystemPrompt from throwing
    // when memory files disappear. This is the actual user-facing scenario
    // (addUserMessage → ensureHistoryInitialized → getSystemPrompt →
    // loadProjectMemoryFilesCached → loadProjectMemoryFiles).
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "transient memory");

        // Make statSync throw on every call (persistent failure)
        mockState.statSyncThrows = ["CLAUDE.md"];

        // getSystemPrompt should not throw
        expect(() => getSystemPrompt()).not.toThrow();
        const prompt = getSystemPrompt();
        expect(typeof prompt).toBe("string");
        expect(prompt.length).toBeGreaterThan(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns valid files when one file fails but another succeeds", () => {
    // When AGENTS.md fails to read but CLAUDE.md succeeds, CLAUDE.md should
    // still be returned (skip only the failing one).
    // NOTE: MEMORY_FILENAMES has CLAUDE.md first, and the walk uses `break`
    // after finding the first match per dir. So if CLAUDE.md exists, AGENTS.md
    // is never checked. To test "skip failing file, return other", we need
    // CLAUDE.md to NOT exist and AGENTS.md to be the failing one — but then
    // there's no "other" file. So this test verifies: when AGENTS.md fails,
    // an empty array is returned (skip the failing file gracefully).
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents content");

        // readFileSync throws for AGENTS.md
        mockState.readFileSyncThrows = ["AGENTS.md"];

        reloadProjectMemory();
        const files = loadProjectMemoryFiles();
        // AGENTS.md failed to read — skipped. No other memory files in this dir.
        expect(files.length).toBe(0);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles ENOENT, EACCES, and EPERM errors uniformly (any error → skip file)", () => {
    // The fix should handle ANY error from stat/read, not just ENOENT.
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "content");

        // Test EPERM
        mockState.statSyncThrows = ["CLAUDE.md"];
        mockState.statSyncErrno = "EPERM";
        reloadProjectMemory();
        expect(() => loadProjectMemoryFiles()).not.toThrow();
        expect(loadProjectMemoryFiles().length).toBe(0);

        // Test EACCES
        mockState.statSyncErrno = "EACCES";
        reloadProjectMemory();
        expect(() => loadProjectMemoryFiles()).not.toThrow();
        expect(loadProjectMemoryFiles().length).toBe(0);

        // Reset — file should now be found
        mockState.statSyncThrows = false;
        reloadProjectMemory();
        expect(loadProjectMemoryFiles().length).toBe(1);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
