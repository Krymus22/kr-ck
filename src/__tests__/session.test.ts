/**
 * session.test.ts — Tests for session persistence module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveSession, loadSession, listSessions, deleteSession } from "../session.js";
import * as history from "../history.js";

const SESSION_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? ".",
  ".claude-killer",
  "sessions"
);

beforeAll(() => {
  history.resetHistory();
  history.addUserMessage("test message");
});

describe("saveSession", () => {
  it("should save a session and return ID", () => {
    const id = saveSession("test_session_1");
    expect(id).toBe("test_session_1");
    expect(fs.existsSync(path.join(SESSION_DIR, "test_session_1.json"))).toBe(true);
  });

  it("should auto-generate ID if not provided", () => {
    const id = saveSession();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    deleteSession(id);
  });
});

describe("listSessions", () => {
  it("should list saved sessions", () => {
    const sessions = listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s) => s.id === "test_session_1")).toBe(true);
  });
});

describe("loadSession", () => {
  it("should load a saved session", () => {
    history.resetHistory();
    history.addUserMessage("before save");
    saveSession("load_test");

    history.resetHistory();
    const loaded = loadSession("load_test");
    expect(loaded).toBe(true);
  });

  it("should return false for non-existent session", () => {
    const loaded = loadSession("nonexistent_session_xyz");
    expect(loaded).toBe(false);
  });
});

describe("deleteSession", () => {
  it("should delete a session", () => {
    saveSession("delete_test");
    const deleted = deleteSession("delete_test");
    expect(deleted).toBe(true);
    expect(fs.existsSync(path.join(SESSION_DIR, "delete_test.json"))).toBe(false);
  });

  it("should return false for non-existent session", () => {
    const deleted = deleteSession("nonexistent_xyz");
    expect(deleted).toBe(false);
  });
});

afterAll(() => {
  deleteSession("test_session_1");
  deleteSession("load_test");
});
