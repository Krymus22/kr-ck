/**
 * project-cwd-autoload.test.tsx — Tests for projectCwd restoration on startup.
 *
 * Covers the App.tsx auto-load flow:
 *   1. FolderBrowser opens when no session exists.
 *   2. Session is loaded + projectCwd is restored via process.chdir when a
 *      session exists — and the chdir happens AFTER loadSessionMessages and
 *      setActiveSession (race-condition fix). The session file lives in the
 *      hash of the cwd at startSession time, NOT in projectCwd; calling
 *      chdir before the lookup breaks the load (file silently not found).
 *   3. /cd <path> calls updateSessionProjectCwd with the new cwd.
 *
 * Uses hoisted session.js spies so we can control getLastSession's return
 * value per-test and assert call order against process.chdir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ─── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.5, contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: vi.fn(() => []),
  getExtensionsByCategory: vi.fn(() => []),
  getHubSummary: vi.fn(() => ({
    total: 0, enabled: 0, byCategory: {
      tool: { total: 0, enabled: 0 }, skill: { total: 0, enabled: 0 },
      mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
      feature: { total: 0, enabled: 0 },
    },
  })),
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn((m: string) => m.toUpperCase()),
  getTriggerModes: vi.fn(() => ["disabled", "on_file", "on_task", "always"]),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn(() => "T"),
  discoverExtensions: vi.fn(),
  executeTrigger: vi.fn(() => Promise.resolve()),
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

vi.mock("../modes.js", () => ({
  getAllModes: vi.fn(() => []),
  getActiveModeName: vi.fn(() => null),
  getActiveMode: vi.fn(() => null),
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
  getMode: vi.fn(() => null),
  suggestMode: vi.fn(() => null),
  confirmAndSaveMode: vi.fn(async () => true),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
}));

vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn(() => 1),
  formatPoolStats: vi.fn(() => "1 keys, 40 RPM"),
}));

vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => [
    { cmd: "/help", desc: "Show commands" },
    { cmd: "/cd", desc: "Change directory" },
    { cmd: "/exit", desc: "Exit" },
  ]),
  getCommandI18n: vi.fn((cmd: string) => ({ cmd, desc: `Description for ${cmd}` })),
}));

vi.mock("../history.js", () => ({
  isPlanMode: vi.fn(() => false),
  setPlanMode: vi.fn(),
  resetHistory: vi.fn(),
  getHistory: vi.fn(() => []),
  addUserMessage: vi.fn(),
  addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(),
  addSystemMessage: vi.fn(),
  historySummary: vi.fn(() => "0 msgs"),
  historyLength: vi.fn(() => 0),
  compactHistory: vi.fn(() => null),
  getCavemanLevel: vi.fn(() => null),
  setCavemanLevel: vi.fn(),
  reloadProjectMemory: vi.fn(() => null),
  loadHistoryDirect: vi.fn(),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn() })),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(async () => {}),
}));

vi.mock("../agent.js", () => ({
  runAgentLoop: vi.fn(async () => "mocked response"),
}));

vi.mock("../todo.js", () => ({
  resetTodo: vi.fn(),
  renderTodoBar: vi.fn(() => ""),
  getTodos: vi.fn(() => []),
}));

vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({})),
  runDream: vi.fn(async () => ({ reviewedSessions: 0, extractedSkills: 0, deduplicatedEntries: 0 })),
  runDistill: vi.fn(async () => ({ skillsExtracted: 0 })),
}));

vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn(async () => ({ updatesAvailable: false })) }));
vi.mock("../readBeforeWrite.js", () => ({ clearReadPaths: vi.fn() }));
vi.mock("../fileRehydration.js", () => ({ clearSessionFiles: vi.fn() }));
vi.mock("../skillTracker.js", () => ({ clearInvokedSkills: vi.fn() }));
vi.mock("../stateCleanup.js", () => ({ clearAllModuleState: vi.fn() }));
vi.mock("../inboxOrganizer.js", () => ({
  organizeInbox: vi.fn(() => ({ organized: [], ignored: [], errors: [] })),
  formatOrganizeResult: vi.fn(() => ""),
}));
vi.mock("../toolConfigurator.js", () => ({
  configureTool: vi.fn(async () => ({ success: true, message: "OK" })),
  detectToolsWithoutManifest: vi.fn(() => []),
}));
vi.mock("../searxManager.js", () => ({ getSearxStatus: vi.fn(() => "stopped") }));
vi.mock("../planExecutor.js", () => ({
  getPlan: vi.fn(() => null),
  createPlan: vi.fn(),
  subscribeToPlanChanges: vi.fn(() => () => {}),
  getPlanVersion: vi.fn(() => 0),
}));
vi.mock("../dotfileConfig.js", () => ({
  loadConfig: vi.fn(() => ({})),
  updateConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

// ─── Hoisted session.js spies (so we can control return values per-test) ───

const sessionSpies = vi.hoisted(() => ({
  startSession: vi.fn(() => "test-session"),
  appendMessage: vi.fn(),
  getLastSession: vi.fn((): null => null),
  loadSessionMessages: vi.fn((): null => null),
  setActiveSession: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  updateSessionProjectCwd: vi.fn(),
  listSessions: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  renameSession: vi.fn(() => true),
  appendCompactionSnapshot: vi.fn(),
}));

vi.mock("../session.js", () => sessionSpies);

// ─── Imports (AFTER mocks) ─────────────────────────────────────────────────

import { App } from "../tui/App.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendCommand(
  stdin: { write: (s: string) => void },
  command: string,
  postDelay = 250,
): Promise<void> {
  stdin.write(command);
  await delay(50);
  stdin.write("\r");
  await delay(postDelay);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("App auto-load — projectCwd restoration (race fix)", () => {
  let originalCwd: string;
  let chdirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
    // Spy on process.chdir — App.tsx calls it directly (not via a module).
    // Delegate to the real impl so the cwd actually changes (needed for /cd
    // effect-side tests). For the race tests, App.tsx wraps chdir in a
    // try/catch, so even if the path doesn't exist, the spy records the call.
    chdirSpy = vi.spyOn(process, "chdir");
  });

  afterEach(() => {
    chdirSpy.mockRestore();
    try { process.chdir(originalCwd); } catch { /* ignore */ }
  });

  it("opens FolderBrowser on startup when no session exists", async () => {
    // getLastSession returns null → no session to resume → FolderBrowser opens
    // (via the useEffect that fires after mount).
    sessionSpies.getLastSession.mockReturnValue(null);
    const { lastFrame } = render(<App />);
    // Wait for the mount useEffect to fire (setShowFolderBrowser(true)).
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Select working directory");
    expect(out).toContain("Path:");
    // Session-load functions should NOT have been called.
    expect(sessionSpies.loadSessionMessages).not.toHaveBeenCalled();
    expect(sessionSpies.setActiveSession).not.toHaveBeenCalled();
  });

  it("loads session + restores projectCwd via chdir when a session exists", async () => {
    // Session exists with projectCwd != startup cwd. The race fix ensures
    // loadSessionMessages + setActiveSession are called BEFORE chdir, so the
    // session is correctly loaded (messages appear, FolderBrowser does NOT
    // open). The chdir still happens AFTER, so subsequent tools run in the
    // right project.
    const projectCwd = "/some/project/dir";
    sessionSpies.getLastSession.mockReturnValue({
      id: "2026-01-01_00-00-00_abc1",
      path: "/fake/path.jsonl",
      projectCwd,
    });
    sessionSpies.loadSessionMessages.mockReturnValue({
      messages: [{ role: "user", content: "hello world" }],
      lastSnapshot: null,
      postSnapshotMessages: [{ role: "user", content: "hello world" }],
    });

    const { lastFrame } = render(<App />);
    // Wait for the mount useEffect (setMessages from loadedVisualMessagesRef).
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");

    // Session was loaded — loadSessionMessages called with the correct id.
    expect(sessionSpies.loadSessionMessages).toHaveBeenCalledWith("2026-01-01_00-00-00_abc1");
    // setActiveSession called with the correct id (BEFORE loadHistoryDirect —
    // §17.3.10 — verified by import order in App.tsx, not asserted here).
    expect(sessionSpies.setActiveSession).toHaveBeenCalledWith("2026-01-01_00-00-00_abc1");
    // chdir called with projectCwd.
    expect(chdirSpy).toHaveBeenCalledWith(projectCwd);
    // FolderBrowser did NOT open (session was loaded).
    expect(out).not.toContain("Select working directory");
    // Loaded message appears in the chat display.
    expect(out).toContain("hello world");
  });

  it("does NOT chdir if projectCwd is null (old session without the field)", () => {
    // Old sessions (pre-projectCwd) have cwd but no projectCwd. getLastSession
    // falls back to cwd, but if it returns null for some reason, we must NOT
    // chdir. This is a defensive guard against the chdir call.
    sessionSpies.getLastSession.mockReturnValue({
      id: "old-session",
      path: "/fake/old.jsonl",
      projectCwd: null,
    });
    sessionSpies.loadSessionMessages.mockReturnValue({
      messages: [{ role: "user", content: "old msg" }],
      lastSnapshot: null,
      postSnapshotMessages: [{ role: "user", content: "old msg" }],
    });

    render(<App />);

    expect(sessionSpies.loadSessionMessages).toHaveBeenCalledWith("old-session");
    expect(sessionSpies.setActiveSession).toHaveBeenCalledWith("old-session");
    // chdir must NOT be called when projectCwd is null.
    expect(chdirSpy).not.toHaveBeenCalled();
  });

  it("race fix: loadSessionMessages + setActiveSession are called BEFORE chdir", () => {
    // This is the core race-condition test. We capture the order of calls
    // across the mocked session.js spies and the process.chdir spy, then
    // assert that chdir happens AFTER both loadSessionMessages and
    // setActiveSession. Without the fix, chdir happens FIRST, which changes
    // process.cwd() and makes loadSessionMessages (which uses cwd to find
    // the session file) return null — the session is silently dropped.
    const projectCwd = "/another/project/dir";
    sessionSpies.getLastSession.mockReturnValue({
      id: "race-test-session",
      path: "/fake/race.jsonl",
      projectCwd,
    });
    sessionSpies.loadSessionMessages.mockReturnValue({
      messages: [{ role: "user", content: "race-fix-msg" }],
      lastSnapshot: null,
      postSnapshotMessages: [{ role: "user", content: "race-fix-msg" }],
    });

    render(<App />);

    // All three should have been called (chdir is in the useState initializer,
    // which runs synchronously during render — no need to await effects).
    expect(sessionSpies.loadSessionMessages).toHaveBeenCalled();
    expect(sessionSpies.setActiveSession).toHaveBeenCalled();
    expect(chdirSpy).toHaveBeenCalledWith(projectCwd);

    // Now assert the ORDER using mock.invocationCallOrder (monotonic across
    // all mocks on the same spy registry).
    const loadOrder = sessionSpies.loadSessionMessages.mock.invocationCallOrder[0];
    const setActiveOrder = sessionSpies.setActiveSession.mock.invocationCallOrder[0];
    const chdirOrder = chdirSpy.mock.invocationCallOrder[0];

    expect(loadOrder).toBeDefined();
    expect(setActiveOrder).toBeDefined();
    expect(chdirOrder).toBeDefined();
    // loadSessionMessages BEFORE setActiveSession BEFORE chdir.
    // §17.3.10: setActiveSession before loadHistoryDirect (not asserted here —
    // loadHistoryDirect is a history.ts mock, but the order in App.tsx source
    // guarantees it: setActiveSession → clearReadPaths → loadHistoryDirect).
    expect(loadOrder).toBeLessThan(setActiveOrder);
    expect(setActiveOrder).toBeLessThan(chdirOrder);
  });
});

// ─── /cd calls updateSessionProjectCwd ─────────────────────────────────────

describe("App /cd command — calls updateSessionProjectCwd", () => {
  let originalCwd: string;
  let chdirSpy: ReturnType<typeof vi.spyOn>;
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    originalCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-cd-test-"));
    // Mock getLastSession to return a session WITH messages so the auto-load
    // succeeds and FolderBrowser does NOT open (otherwise the TextInput is
    // hidden and /cd keystrokes never reach handleSubmit).
    sessionSpies.getLastSession.mockReturnValue({
      id: "cd-test-session",
      path: "/fake/cd-test.jsonl",
      projectCwd: tmpDir,
    });
    sessionSpies.loadSessionMessages.mockReturnValue({
      messages: [{ role: "user", content: "previous msg" }],
      lastSnapshot: null,
      postSnapshotMessages: [{ role: "user", content: "previous msg" }],
    });
    // Real chdir so /cd's effect side (process.cwd()) actually changes —
    // the /cd handler calls process.chdir(resolved) then reads process.cwd()
    // to pass to updateSessionProjectCwd.
    chdirSpy = vi.spyOn(process, "chdir");
  });

  afterEach(() => {
    chdirSpy.mockRestore();
    try { process.chdir(originalCwd); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("/cd <existing dir> calls updateSessionProjectCwd with the new cwd", async () => {
    const { stdin } = render(<App />);
    // Wait for mount useEffect so the session is loaded and TextInput is
    // rendered (not hidden behind FolderBrowser).
    await delay(50);
    await sendCommand(stdin, `/cd ${tmpDir}`, 300);

    // process.chdir was called with tmpDir (resolved by /cd handler).
    expect(chdirSpy).toHaveBeenCalledWith(tmpDir);
    // updateSessionProjectCwd was called with the new cwd (which is tmpDir
    // after chdir — process.cwd() returns tmpDir).
    expect(sessionSpies.updateSessionProjectCwd).toHaveBeenCalledWith(tmpDir);
  });

  it("/cd <nonexistent path> does NOT call updateSessionProjectCwd", async () => {
    const { stdin } = render(<App />);
    await delay(50);
    await sendCommand(stdin, "/cd /this/path/does/not/exist/12345", 300);

    // chdir not called (path validation failed before chdir).
    expect(chdirSpy).not.toHaveBeenCalledWith("/this/path/does/not/exist/12345");
    // updateSessionProjectCwd not called for the failed path.
    expect(sessionSpies.updateSessionProjectCwd).not.toHaveBeenCalledWith(
      "/this/path/does/not/exist/12345",
    );
  });
});
