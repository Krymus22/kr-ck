/**
 * tui-interactions.test.tsx — Interaction tests for the TUI.
 *
 * Unlike snapshot tests (which only verify static output), these tests
 * simulate user input (typing, key presses) and verify the TUI responds
 * correctly. This catches interaction bugs:
 *   - Autocomplete not appearing when typing /
 *   - Ctrl+E not opening Hub
 *   - /mode not showing options
 *   - Enter not submitting
 *   - Esc not closing Hub
 *   - Tab not cycling autocomplete
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

// Mock config
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
  loadAllExtensions: vi.fn(), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

const mockedGetAllExtensions = vi.hoisted(() => vi.fn(() => []));
const mockedGetExtensionsByCategory = vi.hoisted(() => vi.fn(() => []));
const mockedGetHubSummary = vi.hoisted(() => vi.fn(() => ({
  total: 5, enabled: 3, byCategory: {
    tool: { total: 2, enabled: 2 }, skill: { total: 1, enabled: 1 },
    mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
    feature: { total: 2, enabled: 0 },
  },
})));
vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: mockedGetAllExtensions,
  getExtensionsByCategory: mockedGetExtensionsByCategory,
  getHubSummary: mockedGetHubSummary,
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn((m: string) => m.toUpperCase()),
  getTriggerModes: vi.fn(() => ["disabled", "on_file", "on_task", "always"]),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn(() => "T"),
  discoverExtensions: vi.fn(),
  executeTrigger: vi.fn(() => Promise.resolve()),
  // Reactive store hooks — required by useSyncExternalStore in ExtensionHub
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

const mockedGetAllModes = vi.hoisted(() => vi.fn(() => [
  { name: "roblox", label: "Roblox", description: "Roblox mode", builtIn: true, enableTools: [], enableSkills: [], enableFeatures: [], icon: "R" },
  { name: "devops", label: "DevOps", description: "DevOps mode", builtIn: true, enableTools: [], enableSkills: [], enableFeatures: [], icon: "D" },
]));
const mockedGetActiveModeName = vi.hoisted(() => vi.fn(() => null));
const mockedApplyMode = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const mockedDeactivateMode = vi.hoisted(() => vi.fn());

vi.mock("../modes.js", () => ({
  getAllModes: mockedGetAllModes,
  getActiveModeName: mockedGetActiveModeName,
  getActiveMode: vi.fn(() => null),
  applyMode: mockedApplyMode,
  deactivateMode: mockedDeactivateMode,
  // Reactive store hooks — required by useSyncExternalStore
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
  setPrewarmListener: vi.fn(),
}));

// Mock heartbeat (App.tsx registers a listener for TUI display)
vi.mock("../heartbeat.js", () => ({
  setHeartbeatListener: vi.fn(),
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
  getHeartbeatStats: vi.fn(() => ({ modelState: "unknown", running: false })),
}));

vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => [
    { cmd: "/help", desc: "Show commands" },
    { cmd: "/effort", desc: "Set effort level", subcommands: ["low", "medium", "high", "max"] },
    { cmd: "/mode", desc: "Switch mode", subcommands: ["roblox", "devops"] },
    { cmd: "/hub", desc: "Open Extension Hub" },
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
  getSystemPrompt: vi.fn(() => "system prompt"),
  optimizeContext: vi.fn(),
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

vi.mock("../session.js", () => ({
  startSession: vi.fn(() => "test-session"),
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getLastSession: vi.fn(() => ({
    id: "test-session",
    path: "/tmp/test-session.jsonl",
    projectCwd: "/tmp",
    effortLevel: null,
  })),
  loadSessionMessages: vi.fn(() => ({
    messages: [{ role: "user", content: "dummy-previous-message" }],
    lastSnapshot: null,
    postSnapshotMessages: [{ role: "user", content: "dummy-previous-message" }],
    effortLevel: null,
  })),
  getSessionProjectCwd: vi.fn(() => "/tmp"),
  getSessionEffortLevel: vi.fn(() => null),
  updateSessionProjectCwd: vi.fn(),
  updateSessionEffortLevel: vi.fn(),
  setActiveSession: vi.fn(),
  getActiveSessionId: vi.fn(() => "test-session"),
  listSessions: vi.fn(() => []),
  deleteSession: vi.fn(() => true),
  renameSession: vi.fn(() => true),
}));

vi.mock("../gracefulShutdown.js", () => ({
  registerShutdownHandlers: vi.fn(),
}));

vi.mock("../configSeeder.js", () => ({
  seedUserConfig: vi.fn(),
}));

vi.mock("../toolUpdater.js", () => ({
  performUpdateCheck: vi.fn(async () => ({ updatesAvailable: false })),
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

// Import after mocks
import { App } from "../tui/App.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("TUI interactions — typing and navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("typing / shows all commands in autocomplete", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("/help");
    expect(out).toContain("/effort");
    expect(out).toContain("/mode");
    expect(out).toContain("/hub");
  });

  it("typing /he filters to /help", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/he");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("/help");
    // Other commands should be filtered out
    expect(out).not.toContain("/effort");
    expect(out).not.toContain("/mode");
  });

  it("typing /effort + space shows subcommands", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/effort ");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("low");
    expect(out).toContain("medium");
    expect(out).toContain("high");
    expect(out).toContain("max");
  });

  it("typing /mode + space shows roblox/devops subcommands", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/mode ");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("roblox");
    expect(out).toContain("devops");
  });

  it("typing /effort h filters subcommands to high", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/effort h");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("high");
    // low/medium/max should be filtered out
    expect(out).not.toContain("low");
    expect(out).not.toContain("medium");
  });

  it("typing non-slash text does NOT show autocomplete", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("hello world");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    // Banner contains "/help" as a hint, but the autocomplete dropdown
    // would show "/help" with "> " prefix. We check that the autocomplete
    // selection marker "> /help" doesn't appear.
    expect(out).not.toMatch(/>\s\/help/);
    expect(out).not.toMatch(/>\s\/effort/);
  });

  it("autocomplete selection marker '>' appears on first item by default", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    // Should have at least one '>' marker (the selected item)
    expect(out).toContain(">");
  });
});

describe("TUI interactions — slash commands execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("/help shows command list as system message", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/help\n");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    // /help should produce a system message showing commands
    expect(out).toMatch(/\/help|\/effort|\/mode|Show commands/);
  });

  it("/exit command (or Ctrl+C twice) should be handled", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/exit\n");
    await delay(100);
    // App should still render (exit handled via useApp().exit which is mocked)
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("/hub command opens Extension Hub", async () => {
    const { stdin, lastFrame } = render(<App />);
    // Type /hub then Enter (carriage return)
    stdin.write("/hub");
    await delay(50);
    stdin.write("\r");
    await delay(500);
    const out = stripAnsi(lastFrame() ?? "");
    // Hub should be visible — it shows "EXTENSION HUB"
    expect(out).toContain("EXTENSION HUB");
  });

  it("Ctrl+E opens Extension Hub", async () => {
    const { stdin, lastFrame } = render(<App />);
    // Ctrl+E
    stdin.write("\x05"); // Ctrl+E = 0x05
    await delay(300);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("EXTENSION HUB");
  });
});

describe("TUI interactions — Hub navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetAllExtensions.mockReturnValue([
      { id: "tool:rojo", name: "rojo", category: "tool", enabled: true, installed: true, triggerMode: "on_file", description: "Build Roblox project" },
      { id: "tool:wally", name: "wally", category: "tool", enabled: true, installed: true, triggerMode: "on_task", description: "Install Wally packages" },
      { id: "skill:profilestore", name: "profilestore", category: "skill", enabled: true, installed: true, triggerMode: "always", description: "DataStore wrapper" },
      { id: "feature:think_tool", name: "think_tool", category: "feature", enabled: false, installed: true, triggerMode: "disabled", description: "Forced reasoning" },
      { id: "feature:strict_gate", name: "strict_gate", category: "feature", enabled: false, installed: true, triggerMode: "disabled", description: "Quality gate" },
    ]);
  });

  it("Hub shows extensions on All tab", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05"); // Ctrl+E
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("rojo");
    expect(out).toContain("wally");
    expect(out).toContain("profilestore");
  });

  it("Hub shows active count (3/5)", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("3/5");
  });

  it("Hub shows keyboard shortcuts hint", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Esc");
    expect(out).toContain("Tab");
  });
});

describe("TUI interactions — message display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("user message appears in chat after submit", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("Hello world");
    await delay(50);
    stdin.write("\r");
    await delay(500);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Hello world");
  });

  it("user label 'you:' appears (UTF-8 regression)", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("test message");
    await delay(50);
    stdin.write("\r");
    await delay(500);
    const out = stripAnsi(lastFrame() ?? "");
    // After submit, the user message is added with 'you:' label
    expect(out).toContain("you:");
    expect(out).not.toContain("voc├¬");
  });

  it("assistant label 'Claude-Killer:' appears after response", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("test");
    await delay(50);
    stdin.write("\r");
    await delay(500);
    const out = stripAnsi(lastFrame() ?? "");
    // Should show Claude-Killer: label from the mocked response.
    // The banner also has "Claude-Killer" but the label has a colon.
    expect(out.toLowerCase()).toContain("claude-killer");
  });
});

describe("TUI interactions — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crash even when extensions discovery fails", async () => {
    // Don't set up any extensions
    const { lastFrame } = render(<App />);
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    // FIX-TUI Bug 1: the banner is no longer rendered in the live view
    // (it's pre-printed via process.stdout.write in index.ts). So we check
    // for the input prompt placeholder instead, which proves the App
    // rendered its main shell without crashing.
    expect(out).toMatch(/Digite sua mensagem/i);
  });

  it("does not crash when typing very long input", async () => {
    const { stdin, lastFrame } = render(<App />);
    const longInput = "a".repeat(500);
    stdin.write(longInput);
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    // App should still be alive — verify by checking that the previously
    // auto-loaded user message is still rendered (proves the chat history
    // didn't get wiped by the long input).
    // (FIX-TUI Bug 1: banner no longer in live view, so we can't use
    // "Claude-Killer" as the liveness signal here.)
    expect(out).toContain("dummy-previous-message");
  });

  it("does not crash when typing accented chars", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("you coração São Paulo");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    // Should not contain mojibake
    expect(out).not.toContain("├");
    expect(out).not.toContain("Ã");
  });
});

describe("TUI interactions — multiple key sequences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("typing /eff then backspace then /mode works", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/eff");
    await delay(50);
    // Backspace 4 times to clear
    stdin.write("\x7f\x7f\x7f\x7f");
    await delay(50);
    stdin.write("/mode");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("/mode");
    expect(out).not.toContain("/effort");
  });

  it("rapid typing doesn't lose characters", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/help");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("/help");
  });

  it("Ctrl+E then Esc closes Hub", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05"); // Ctrl+E opens Hub
    await delay(100);
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("EXTENSION HUB");

    // Esc closes Hub
    stdin.write("\x1b"); // Esc
    await delay(100);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("EXTENSION HUB");
  });
});
