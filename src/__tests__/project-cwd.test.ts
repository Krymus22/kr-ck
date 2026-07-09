/**
 * project-cwd.test.ts — Testes para projectCwd persistence.
 *
 * Verifica que o diretório do projeto é salvo no session header e
 * restaurado no auto-load.
 *
 * Also covers the race condition between `process.chdir` and
 * `loadSessionMessages`/`setActiveSession` in App.tsx auto-load:
 * the session file lives in the hash of the cwd at startSession time,
 * NOT in `projectCwd`. Calling chdir before the lookup breaks the load.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: { contextWindowTokens: 256000, model: "test", nvidiaApiKey: "test" },
}));

import * as session from "../session.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ck-cwd-"));
}

function getHashDir(cwd: string): string {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  return path.join(home, ".claude-killer", "sessions", hash);
}

describe("projectCwd persistence", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("startSession saves projectCwd in header", () => {
    const id = session.startSession(tempDir);
    const hashDir = getHashDir(tempDir);
    const filePath = path.join(hashDir, `${id}.jsonl`);
    const content = fs.readFileSync(filePath, "utf8");
    const header = JSON.parse(content.split("\n")[0]!);
    expect(header.projectCwd).toBe(tempDir);
  });

  it("getSessionProjectCwd reads projectCwd from session file", () => {
    const id = session.startSession(tempDir);
    const hashDir = getHashDir(tempDir);
    const filePath = path.join(hashDir, `${id}.jsonl`);
    const cwd = session.getSessionProjectCwd(filePath);
    expect(cwd).toBe(tempDir);
  });

  it("getSessionProjectCwd falls back to cwd field for old sessions", () => {
    // Create a session file with old format (no projectCwd, only cwd)
    const hashDir = getHashDir(tempDir);
    fs.mkdirSync(hashDir, { recursive: true });
    const filePath = path.join(hashDir, "old-session.jsonl");
    const header = JSON.stringify({
      type: "session-header",
      id: "old-session",
      createdAt: "2026-01-01",
      cwd: tempDir,
    });
    fs.writeFileSync(filePath, header + "\n", "utf8");
    const cwd = session.getSessionProjectCwd(filePath);
    expect(cwd).toBe(tempDir);
  });

  it("getSessionProjectCwd returns null for missing file", () => {
    expect(session.getSessionProjectCwd("/nonexistent/file.jsonl")).toBeNull();
  });

  it("updateSessionProjectCwd updates the header in place", () => {
    const id = session.startSession(tempDir);
    // Simulate /cd to a new directory
    const newDir = makeTempDir();
    session.updateSessionProjectCwd(newDir);
    // Verify header was updated
    const hashDir = getHashDir(tempDir);
    const filePath = path.join(hashDir, `${id}.jsonl`);
    const content = fs.readFileSync(filePath, "utf8");
    const header = JSON.parse(content.split("\n")[0]!);
    expect(header.projectCwd).toBe(newDir);
    // Old cwd field should still be the original
    expect(header.cwd).toBe(tempDir);
    // Clean up
    try { fs.rmSync(newDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("updateSessionProjectCwd does nothing when no active session", () => {
    // No session started — should not throw
    expect(() => session.updateSessionProjectCwd("/some/path")).not.toThrow();
  });

  it("getLastSession returns projectCwd from header", () => {
    const id = session.startSession(tempDir);
    const last = session.getLastSession(tempDir);
    expect(last).not.toBeNull();
    expect(last!.projectCwd).toBe(tempDir);
  });

  it("getLastSession returns null projectCwd for old sessions without field", () => {
    // Create old-format session
    const hashDir = getHashDir(tempDir);
    fs.mkdirSync(hashDir, { recursive: true });
    const filePath = path.join(hashDir, "2026-01-01_00-00-00_test.jsonl");
    const header = JSON.stringify({
      type: "session-header",
      id: "2026-01-01_00-00-00_test",
      createdAt: "2026-01-01",
      cwd: tempDir,
    });
    // Add a message so it's not empty
    fs.writeFileSync(filePath, header + "\n" + JSON.stringify({ role: "user", content: "test", ts: 1 }) + "\n", "utf8");
    const last = session.getLastSession(tempDir);
    expect(last).not.toBeNull();
    // Old session has cwd but no projectCwd — should fall back to cwd
    expect(last!.projectCwd).toBe(tempDir);
  });
});

// ─── Race condition: chdir vs loadSessionMessages ──────────────────────────
//
// The session file lives in the hash of the cwd at startSession time.
// `updateSessionProjectCwd` rewrites the header's projectCwd field but does
// NOT move the file. So when projectCwd differs from the startup cwd, calling
// `loadSessionMessages(id)` AFTER `process.chdir(projectCwd)` looks in the
// wrong hash dir and returns null — the session is silently dropped.
//
// The fix (in App.tsx): call loadSessionMessages + setActiveSession BEFORE
// process.chdir, or pass the original cwd explicitly. These tests prove the
// bug exists at the session.ts level and document the correct usage.

describe("projectCwd race condition (chdir vs loadSessionMessages)", () => {
  let startupDir: string;
  let projectDir: string;
  let sessionId: string;

  beforeEach(() => {
    startupDir = makeTempDir();
    projectDir = makeTempDir();
    // Start a session in startupDir — file is saved in hash(startupDir).
    sessionId = session.startSession(startupDir);
    session.appendMessage({ role: "user", content: "race-test-msg" });
    // Simulate /cd to projectDir: update projectCwd in the header.
    // The session FILE stays in hash(startupDir); only the header changes.
    session.updateSessionProjectCwd(projectDir);
  });

  afterEach(() => {
    // Clean up both hash dirs (startupDir and projectDir).
    for (const dir of [startupDir, projectDir]) {
      try {
        fs.rmSync(getHashDir(dir), { recursive: true, force: true });
      } catch { /* ignore */ }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  });

  it("loadSessionMessages with explicit startup cwd finds the session", () => {
    // Pass startupDir explicitly — looks in hash(startupDir), finds the file.
    const loaded = session.loadSessionMessages(sessionId, startupDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(1);
    expect((loaded!.messages[0] as { content?: string }).content).toBe("race-test-msg");
  });

  it("loadSessionMessages WITHOUT cwd returns null after chdir to projectCwd", () => {
    // Simulate the buggy auto-load: chdir to projectDir FIRST, then call
    // loadSessionMessages(id) without cwd. It uses process.cwd()=projectDir,
    // looks in hash(projectDir) — the file is in hash(startupDir), so it
    // returns null. This is the race-condition bug.
    const originalCwd = process.cwd();
    try {
      process.chdir(projectDir);
      const loaded = session.loadSessionMessages(sessionId);
      // BUG: returns null because the file is in hash(startupDir), not
      // hash(projectDir). This is the exact scenario the App.tsx fix
      // prevents by calling loadSessionMessages BEFORE chdir.
      expect(loaded).toBeNull();
    } finally {
      try { process.chdir(originalCwd); } catch { /* ignore */ }
    }
  });

  it("getLastSession + loadSessionMessages roundtrip with explicit cwd", () => {
    // Simulate the CORRECT auto-load flow: find session (startupDir), load
    // messages (startupDir), THEN chdir. All lookups use the original cwd.
    const last = session.getLastSession(startupDir);
    expect(last).not.toBeNull();
    expect(last!.projectCwd).toBe(projectDir);
    // Load messages using the SAME cwd (startupDir) — works correctly.
    const loaded = session.loadSessionMessages(last!.id, startupDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.messages.length).toBe(1);
  });
});
