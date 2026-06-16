/**
 * session.test.ts — Tests for session persistence module.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { saveSession, loadSession, listSessions, deleteSession, autoSave } from "../session.js";
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

  it("should load session with assistant messages with tool_calls", () => {
    const sessionData = {
      id: "tool_calls_test",
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      messageCount: 3,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "test" },
        { role: "assistant", content: "calling tool", tool_calls: [{ id: "tc_1", type: "function", function: { name: "test_tool", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "tc_1", content: "tool result" },
      ],
    };

    const filePath = path.join(SESSION_DIR, "tool_calls_test.json");
    fs.writeFileSync(filePath, JSON.stringify(sessionData), "utf8");

    history.resetHistory();
    const loaded = loadSession("tool_calls_test");
    expect(loaded).toBe(true);

    fs.unlinkSync(filePath);
  });

  it("should return false for corrupt session file", () => {
    const filePath = path.join(SESSION_DIR, "corrupt_test.json");
    fs.writeFileSync(filePath, "not valid json {{{", "utf8");

    history.resetHistory();
    const loaded = loadSession("corrupt_test");
    expect(loaded).toBe(false);

    fs.unlinkSync(filePath);
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

describe("autoSave", () => {
  it("should autoSave and return session ID", () => {
    history.resetHistory();
    history.addUserMessage("autosave test");
    const id = autoSave();
    expect(id).not.toBeNull();
    expect(typeof id).toBe("string");
    if (id) deleteSession(id);
  });

  it("should return null when saveSession throws", async () => {
    vi.resetModules();
    vi.doMock("../history.js", () => ({
      getHistory: () => { throw new Error("disk full"); },
      getCavemanLevel: () => 0,
      isPlanMode: () => false,
      resetHistory: () => {},
      addUserMessage: () => {},
      addRawAssistantMessage: () => {},
      addToolResult: () => {},
      setCavemanLevel: () => {},
      setPlanMode: () => {},
    }));
    vi.doMock("../logger.js", () => ({
      success: () => {},
      error: () => {},
      info: () => {},
      warn: () => {},
      debug: () => {},
    }));
    const { autoSave: mockedAutoSave } = await import("../session.js");
    const id = mockedAutoSave();
    expect(id).toBeNull();
    vi.doUnmock("../history.js");
    vi.doUnmock("../logger.js");
  });
});

afterAll(() => {
  deleteSession("test_session_1");
  deleteSession("load_test");
});
