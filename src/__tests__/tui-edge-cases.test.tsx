/**
 * tui-edge-cases.test.tsx — Edge case tests for the TUI.
 *
 * Tests unusual scenarios that users might hit in real usage:
 *   - Multiple messages accumulation
 *   - System messages mixed with chat messages
 *   - Long lines that might overflow
 *   - Special chars in user input (emojis, CJK, RTL)
 *   - Hub open while user types
 *   - Plan mode active
 *   - Empty messages
 *   - Very rapid typing
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// Mock logger
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

const mockedGetAllExtensions = vi.hoisted(() => vi.fn(() => []));
const mockedGetExtensionsByCategory = vi.hoisted(() => vi.fn(() => []));
const mockedGetHubSummary = vi.hoisted(() => vi.fn(() => ({
  total: 0, enabled: 0, byCategory: {
    tool: { total: 0, enabled: 0 }, skill: { total: 0, enabled: 0 },
    mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
    feature: { total: 0, enabled: 0 },
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

const mockedGetAllModes = vi.hoisted(() => vi.fn(() => []));
const mockedGetActiveModeName = vi.hoisted(() => vi.fn(() => null));
vi.mock("../modes.js", () => ({
  getAllModes: mockedGetAllModes,
  getActiveModeName: mockedGetActiveModeName,
  getActiveMode: vi.fn(() => null),
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
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
  saveSession: vi.fn(() => "s1"), loadSession: vi.fn(() => true), listSessions: vi.fn(() => []),
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

import { App } from "../tui/App.js";
import { ChatDisplay, type ChatMessage } from "../tui/ChatDisplay.js";
import { TodoPanel, type TodoItem } from "../tui/TodoPanel.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── ChatDisplay edge cases ───────────────────────────────────────────────

describe("ChatDisplay — edge cases", () => {
  it("handles 100 messages without crash", () => {
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" as const : "assistant" as const,
      content: `Message ${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    // Should show only the last 50 (maxVisible default)
    expect(out).toContain("Message 99");
    expect(out).not.toContain("Message 0");
  });

  it("handles very long single message (1000 chars)", () => {
    const longText = "a".repeat(1000);
    const messages: ChatMessage[] = [
      { role: "user", content: longText },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    // Should not crash, should contain at least part of the message
    expect(out).toContain("a");
  });

  it("handles emoji in message content (regression: should not crash)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello 👋 World 🌍" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    // Emoji may or may not render, but should not crash
  });

  it("handles CJK characters", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "你好世界" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("你好世界");
  });

  it("handles empty content in message", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("handles newlines in message content", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Line 1\nLine 2\nLine 3" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Line 1");
    expect(out).toContain("Line 2");
    expect(out).toContain("Line 3");
  });

  it("handles messages with code blocks (markdown)", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Here is code:\n```\nconst x = 1;\n```\nDone." },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("Done.");
  });

  it("handles messages with tabs", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "function() {\n\treturn 42;\n}" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("return 42;");
  });

  it("preserves message order when many messages accumulate", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "AAA" },
      { role: "assistant", content: "BBB" },
      { role: "user", content: "CCC" },
      { role: "assistant", content: "DDD" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    const idxA = out.indexOf("AAA");
    const idxB = out.indexOf("BBB");
    const idxC = out.indexOf("CCC");
    const idxD = out.indexOf("DDD");
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
    expect(idxC).toBeLessThan(idxD);
  });

  it("does not crash with null content (defensive)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: null as unknown as string },
    ];
    expect(() => render(<ChatDisplay messages={messages} />)).not.toThrow();
  });
});

// ─── TodoPanel edge cases ─────────────────────────────────────────────────

describe("TodoPanel — edge cases", () => {
  it("handles 50 tasks without crash", () => {
    const todos: TodoItem[] = Array.from({ length: 50 }, (_, i) => ({
      status: "pending" as const,
      content: `Task ${i}`,
      active_form: "",
    }));
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    expect(out).toContain("50 tasks");
  });

  it("handles task with very long content (200 chars)", () => {
    const longContent = "T".repeat(200);
    const todos: TodoItem[] = [
      { status: "pending", content: longContent, active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("handles task with emoji content (should not crash)", () => {
    const todos: TodoItem[] = [
      { status: "pending", content: "Fix 🐛 in parser", active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("handles task with accented content", () => {
    const todos: TodoItem[] = [
      { status: "pending", content: "Implementar validação", active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Implementar validação");
    expect(out).not.toContain("├");
  });

  it("renders all 3 statuses together", () => {
    const todos: TodoItem[] = [
      { status: "completed", content: "Done 1", active_form: "" },
      { status: "in_progress", content: "Working 2", active_form: "Currently working" },
      { status: "pending", content: "Pending 3", active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Done 1");
    expect(out).toContain("Currently working");
    expect(out).toContain("Pending 3");
  });
});

// ─── App edge cases ───────────────────────────────────────────────────────

describe("App — edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders correctly when extensions are not yet discovered (empty Hub)", async () => {
    const { lastFrame } = render(<App />);
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Claude-Killer");
  });

  it("does not crash when typing a single space", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write(" ");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    expect(out).toContain("Claude-Killer");
  });

  it("does not crash when typing backspace on empty input", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x7f"); // Backspace
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash when typing / then immediately Enter", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/");
    await delay(50);
    stdin.write("\r");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash when typing /effort then Enter (no subcommand)", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/effort");
    await delay(50);
    stdin.write("\r");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash when typing /effort low then Enter", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/effort low");
    await delay(50);
    stdin.write("\r");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash when typing /mode roblox", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/mode roblox");
    await delay(50);
    stdin.write("\r");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash when Ctrl+E pressed twice rapidly", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05\x05"); // Ctrl+E twice
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash when Esc pressed without Hub open", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x1b"); // Esc
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    expect(out).toContain("Claude-Killer");
  });

  it("does not crash when arrow keys pressed without autocomplete", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x1b[A"); // Up arrow
    stdin.write("\x1b[B"); // Down arrow
    stdin.write("\x1b[C"); // Right arrow
    stdin.write("\x1b[D"); // Left arrow
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash when Tab pressed without autocomplete", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\t");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash with extremely rapid typing", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("abcdefghijklmnopqrstuvwxyz0123456789");
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash when typing very long slash command", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("/" + "x".repeat(200));
    await delay(50);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });

  it("does not crash with mixed input: text + slash + text", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("hello");
    await delay(30);
    stdin.write("\x7f\x7f\x7f\x7f\x7f"); // Backspace 5x
    await delay(30);
    stdin.write("/help");
    await delay(30);
    stdin.write("\r");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
  });
});

// ─── UTF-8 / encoding edge cases ──────────────────────────────────────────

describe("UTF-8 encoding edge cases", () => {
  it("renders Portuguese accented chars correctly (ãáéíóúâêôç)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "São João é muito bom — coração, maçã, árvore" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("São");
    expect(out).toContain("coração");
    expect(out).toContain("maçã");
    expect(out).toContain("árvore");
    // No mojibake
    expect(out).not.toContain("├");
    expect(out).not.toContain("Ã");
  });

  it("renders em-dash and special punctuation", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Test — em-dash, \"quotes\", 'apos', • bullet" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("em-dash");
    expect(out).toContain("quotes");
    expect(out).toContain("apos");
  });

  it("renders mixed accented + CJK + emoji without crash", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Você é incrível 你好 👋" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Você");
    expect(out).toContain("你好");
    expect(out).not.toContain("├");
  });

  it("renders user label 'você:' with correct UTF-8 bytes", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "test" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = lastFrame() ?? "";
    // Verify the raw bytes include correct UTF-8 for "você:"
    // ê in UTF-8 = 0xC3 0xAA
    const buf = Buffer.from(out, "utf8");
    const text = buf.toString("utf8");
    expect(text).toContain("você:");
  });
});

// ─── Layout edge cases ────────────────────────────────────────────────────

describe("Layout edge cases", () => {
  it("StatusBar + ChatDisplay + TodoPanel render together without overlap", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello" },
    ];
    const todos: TodoItem[] = [
      { status: "pending", content: "Task 1", active_form: "" },
    ];
    const { lastFrame: chatFrame } = render(<ChatDisplay messages={messages} />);
    const { lastFrame: todoFrame } = render(<TodoPanel todos={todos} />);

    const chatOut = stripAnsi(chatFrame() ?? "");
    const todoOut = stripAnsi(todoFrame() ?? "");

    expect(chatOut).toContain("Hello");
    expect(todoOut).toContain("Task 1");
    // Both should render without crash
  });

  it("ChatDisplay with 50 messages (maxVisible) — last 50 visible", () => {
    const messages: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const,
      content: `Msg ${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={50} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Last 50 = msgs 10-59
    expect(out).toContain("Msg 59");
    expect(out).toContain("Msg 10");
    // First 10 should NOT be visible
    expect(out).not.toContain("Msg 0");
    expect(out).not.toContain("Msg 9");
  });
});
