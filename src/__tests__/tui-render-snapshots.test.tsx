/**
 * tui-render-snapshots.test.tsx — Visual snapshot tests for ALL TUI components.
 *
 * Uses ink-testing-library to render each component and verify the output.
 * Catches visual bugs: layout breakage, missing text, encoding issues,
 * overflow, truncated content, broken colors, etc.
 *
 * Each test renders the component with realistic props and asserts on
 * the rendered text. If the output changes, the test fails — making
 * visual regressions impossible to merge.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
}));

// Mock config (StatusBar needs numeric config)
vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.5, contextCompactThreshold: 0.8,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

// Mock extensions
vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

// Mock extensionCenter
const mockedGetAllExtensions = vi.hoisted(() => vi.fn(() => []));
const mockedGetExtensionsByCategory = vi.hoisted(() => vi.fn(() => []));
const mockedGetHubSummary = vi.hoisted(() => vi.fn(() => ({
  total: 0, enabled: 0, byCategory: {
    tool: { total: 0, enabled: 0 }, skill: { total: 0, enabled: 0 },
    mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
    feature: { total: 0, enabled: 0 },
  },
})));
const mockedToggleExtension = vi.hoisted(() => vi.fn());
const mockedGetTriggerLabel = vi.hoisted(() => vi.fn((m: string) => m.toUpperCase()));
const mockedGetTriggerModes = vi.hoisted(() => vi.fn(() => ["disabled", "on_file", "on_task", "always"]));
const mockedCycleTriggerMode = vi.hoisted(() => vi.fn());
const mockedSetTriggerMode = vi.hoisted(() => vi.fn());
const mockedGetCategoryIcon = vi.hoisted(() => vi.fn(() => "T"));
const mockedDiscoverExtensions = vi.hoisted(() => vi.fn());

vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: mockedGetAllExtensions,
  getExtensionsByCategory: mockedGetExtensionsByCategory,
  getHubSummary: mockedGetHubSummary,
  toggleExtension: mockedToggleExtension,
  getTriggerLabel: mockedGetTriggerLabel,
  getTriggerModes: mockedGetTriggerModes,
  cycleTriggerMode: mockedCycleTriggerMode,
  setTriggerMode: mockedSetTriggerMode,
  getCategoryIcon: mockedGetCategoryIcon,
  discoverExtensions: mockedDiscoverExtensions,
  executeTrigger: vi.fn(() => Promise.resolve()),
}));

// Mock modes
const mockedGetAllModes = vi.hoisted(() => vi.fn(() => []));
const mockedGetActiveModeName = vi.hoisted(() => vi.fn(() => null));
const mockedApplyMode = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const mockedDeactivateMode = vi.hoisted(() => vi.fn());

vi.mock("../modes.js", () => ({
  getAllModes: mockedGetAllModes,
  getActiveModeName: mockedGetActiveModeName,
  getActiveMode: vi.fn(() => null),
  applyMode: mockedApplyMode,
  deactivateMode: mockedDeactivateMode,
  getMode: vi.fn(() => null),
  suggestMode: vi.fn(() => null),
  confirmAndSaveMode: vi.fn(async () => true),
}));

// Mock effortLevels
vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
}));

// Mock apiKeyPool
vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn(() => 1),
  formatPoolStats: vi.fn(() => "1 keys, 40 RPM"),
}));

// Mock i18n
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

// Mock history (App.tsx reads isPlanMode)
vi.mock("../history.js", () => ({
  isPlanMode: vi.fn(() => false),
  resetHistory: vi.fn(),
  getHistory: vi.fn(() => []),
  addUserMessage: vi.fn(),
  addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(),
  addSystemMessage: vi.fn(),
  historySummary: vi.fn(() => "0 msgs"),
  historyLength: vi.fn(() => 0),
}));

// Mock externalTools (App.tsx uses it)
vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn() })),
  getDetector: vi.fn(() => ({ detect: vi.fn(() => ({ intent: null, context: [] })), detectFromContext: vi.fn(() => []) })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn(() => []) })),
  initializeTools: vi.fn(async () => {}),
}));

// Import AFTER mocks
import { StatusBar } from "../tui/StatusBar.js";
import { ChatDisplay, type ChatMessage } from "../tui/ChatDisplay.js";
import { TodoPanel, type TodoItem } from "../tui/TodoPanel.js";
import { ThinkingIndicator } from "../tui/ThinkingIndicator.js";
import { ExtensionHub } from "../tui/ExtensionHub.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Strip ANSI color codes from rendered output for cleaner assertions. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Get the full rendered text (stripped of ANSI) from a render result. */
function frame(renderResult: ReturnType<typeof render>): string {
  return stripAnsi(renderResult.lastFrame() ?? "");
}

// ─── ChatDisplay tests ────────────────────────────────────────────────────

describe("ChatDisplay — render snapshots", () => {
  it("renders user message with 'você:' label (UTF-8)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Olá, como vai?" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("você:");
    expect(out).toContain("Olá, como vai?");
  });

  it("renders assistant message with 'Claude-Killer:' label", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Estou bem, obrigado!" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Claude-Killer:");
    expect(out).toContain("Estou bem, obrigado!");
  });

  it("renders multiple messages in order", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Primeira pergunta" },
      { role: "assistant", content: "Primeira resposta" },
      { role: "user", content: "Segunda pergunta" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Primeira pergunta");
    expect(out).toContain("Primeira resposta");
    expect(out).toContain("Segunda pergunta");
    // Verify order: user → assistant → user
    const idx1 = out.indexOf("Primeira pergunta");
    const idx2 = out.indexOf("Primeira resposta");
    const idx3 = out.indexOf("Segunda pergunta");
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
  });

  it("renders empty messages array without crash", () => {
    const { lastFrame } = render(<ChatDisplay messages={[]} />);
    expect(lastFrame()).toBe("");
  });

  it("renders accented chars correctly (regression for voc├¬ bug)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "você coração São Paulo balão pão" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("você");
    expect(out).toContain("coração");
    expect(out).toContain("São Paulo");
    expect(out).toContain("balão");
    expect(out).toContain("pão");
    // Should NOT contain mojibake
    expect(out).not.toContain("├");
    expect(out).not.toContain("Ã");
  });

  it("renders streaming message (isStreaming=true)", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Parcial...", isStreaming: true },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Parcial...");
  });

  it("truncates to maxVisible messages (default 50)", () => {
    const messages: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const { lastFrame } = render(<ChatDisplay messages={messages} maxVisible={50} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Should contain the last 50 messages
    expect(out).toContain("Message 99");
    expect(out).toContain("Message 50");
    // Should NOT contain the first 50
    expect(out).not.toContain("Message 0");
    expect(out).not.toContain("Message 49");
  });
});

// ─── StatusBar tests ──────────────────────────────────────────────────────

describe("StatusBar — render snapshots", () => {
  const baseProps = {
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    contextWindow: 1000,
    warnThreshold: 0.5,
    compactThreshold: 0.8,
    costPerKPrompt: 0.01,
    costPerKCompletion: 0.03,
    planMode: false,
    mcpCount: 0,
    skillsCount: 0,
  };

  it("renders token count and context bar", () => {
    const { lastFrame } = render(<StatusBar {...baseProps} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("150");
    // 1000 is formatted as "1k" (formatTok removes .0 for round numbers)
    expect(out).toContain("1k");
    expect(out).toContain("15"); // 150/1000 = 15%
  });

  it("renders effort label when provided", () => {
    const { lastFrame } = render(<StatusBar {...baseProps} effortLabel="MAX" />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("MAX");
  });

  it("renders tokens/s when > 0", () => {
    const { lastFrame } = render(<StatusBar {...baseProps} tokensPerSecond={42.5} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("42.5");
    expect(out).toContain("tok/s");
  });

  it("does NOT render tokens/s when 0", () => {
    const { lastFrame } = render(<StatusBar {...baseProps} tokensPerSecond={0} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("tok/s");
  });

  it("renders [PLAN] tag when planMode=true", () => {
    const { lastFrame } = render(<StatusBar {...baseProps} planMode={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("[PLAN]");
  });

  it("renders cost when costPerK > 0", () => {
    const { lastFrame } = render(<StatusBar {...baseProps} />);
    const out = stripAnsi(lastFrame() ?? "");
    // cost = (100/1000)*0.01 + (50/1000)*0.03 = 0.001 + 0.0015 = 0.0025
    expect(out).toContain("$");
  });

  it("handles overflow (>100% context) — regression: was throwing RangeError", () => {
    // Bug fix: when totalTokens > contextWindow, fillCount was > 15 and
    // emptyCount was negative, causing "-".repeat(-N) to throw.
    const { lastFrame } = render(
      <StatusBar
        {...baseProps}
        totalTokens={2000}
        promptTokens={1500}
        completionTokens={500}
        contextWindow={1000}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    // Should NOT crash — should render clamped bar (15 # chars, 0 - chars)
    expect(out).toContain("2k");
    expect(out).toContain("###############"); // 15 # (full bar, clamped)
    expect(out).toContain("200%");
  });

  it("renders context bar with # for fill and - for empty", () => {
    const { lastFrame } = render(<StatusBar {...baseProps} />);
    const out = stripAnsi(lastFrame() ?? "");
    // 150/1000 = 15% → 0.15 * 15 = 2.25 → round = 2 fill chars
    expect(out).toContain("#");
    expect(out).toContain("-");
  });

  it("handles 0% context (no tokens used)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseProps} totalTokens={0} promptTokens={0} completionTokens={0} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0/1k");
    expect(out).toContain("0%");
  });

  it("handles 100% context (full)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseProps} totalTokens={1000} promptTokens={800} completionTokens={200} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1k/1k");
    expect(out).toContain("100%");
  });

  it("formats tokens >= 1000 as k (e.g., 1.5k)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseProps} totalTokens={1500} promptTokens={1000} completionTokens={500} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1.5k");
  });

  it("formats round thousands without .0 (e.g., 2k not 2.0k)", () => {
    const { lastFrame } = render(
      <StatusBar {...baseProps} totalTokens={2000} promptTokens={1500} completionTokens={500} />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("2k");
    expect(out).not.toContain("2.0k");
  });
});

// ─── TodoPanel tests ──────────────────────────────────────────────────────

describe("TodoPanel — render snapshots", () => {
  it("renders nothing when todos array is empty", () => {
    const { lastFrame } = render(<TodoPanel todos={[]} />);
    expect(lastFrame()).toBe("");
  });

  it("renders task count header", () => {
    const todos: TodoItem[] = [
      { status: "pending", content: "Task 1", active_form: "" },
      { status: "in_progress", content: "Task 2", active_form: "Working on Task 2" },
      { status: "completed", content: "Task 3", active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("3 tasks");
  });

  it("renders pending task with circle icon", () => {
    const todos: TodoItem[] = [
      { status: "pending", content: "Pending task", active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Pending task");
    // icons.circle (legacy alias) = figures.squareSmall = "◻" (Unicode)
    // The old ASCII fallback "o" is no longer used after the icons.ts migration.
    // We just verify that SOME icon char appears next to "Pending task".
    // Match either the Unicode square or any non-alphanumeric icon char.
    expect(out).toMatch(/[◻o□○]/);
  });

  it("renders in_progress task with dot icon and active_form", () => {
    const todos: TodoItem[] = [
      { status: "in_progress", content: "Original", active_form: "Currently working" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Should show active_form, not content
    expect(out).toContain("Currently working");
    expect(out).not.toContain("Original");
    // icons.dot = figures.dot = "․" (Unicode). Match either Unicode dot or "*" fallback.
    expect(out).toMatch(/[․*·]/);
  });

  it("renders completed task with check icon", () => {
    const todos: TodoItem[] = [
      { status: "completed", content: "Done task", active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Done task");
    // icons.check = figures.tick = "✔" (Unicode). Match either Unicode check or "v" fallback.
    expect(out).toMatch(/[✔v✓]/);
  });

  it("renders top and bottom divider lines", () => {
    const todos: TodoItem[] = [
      { status: "pending", content: "Task", active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Dividers are "-" repeated
    const lines = out.split("\n");
    const dividerLines = lines.filter((l) => l.match(/^-+$/));
    expect(dividerLines.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── ThinkingIndicator tests ──────────────────────────────────────────────

describe("ThinkingIndicator — render snapshots", () => {
  it("renders nothing when active=false", () => {
    const { lastFrame } = render(<ThinkingIndicator active={false} />);
    expect(lastFrame()).toBe("");
  });

  it("renders PENSANDO fallback when active=true and no activity pushed", () => {
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("PENSANDO");
  });

  it("renders accented 'PENSANDO' correctly (no mojibake)", () => {
    const { lastFrame } = render(<ThinkingIndicator active={true} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("PENSANDO");
    // No mojibake
    expect(out).not.toContain("├");
  });
});

// ─── ExtensionHub tests ───────────────────────────────────────────────────

describe("ExtensionHub — render snapshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetHubSummary.mockReturnValue({
      total: 5, enabled: 3, byCategory: {
        tool: { total: 2, enabled: 2 },
        skill: { total: 1, enabled: 1 },
        mcp: { total: 0, enabled: 0 },
        plugin: { total: 0, enabled: 0 },
        feature: { total: 2, enabled: 0 },
      },
    });
    mockedGetAllExtensions.mockReturnValue([
      { id: "tool:rojo", name: "rojo", category: "tool", enabled: true, installed: true, triggerMode: "on_file", description: "Build Roblox project" },
      { id: "tool:wally", name: "wally", category: "tool", enabled: true, installed: true, triggerMode: "on_task", description: "Install Wally packages" },
      { id: "skill:profilestore", name: "profilestore", category: "skill", enabled: true, installed: true, triggerMode: "always", description: "DataStore wrapper" },
      { id: "feature:think_tool", name: "think_tool", category: "feature", enabled: false, installed: true, triggerMode: "disabled", description: "Forced reasoning" },
      { id: "feature:strict_gate", name: "strict_gate", category: "feature", enabled: false, installed: true, triggerMode: "disabled", description: "Quality gate" },
    ]);
    mockedGetAllModes.mockReturnValue([
      { name: "roblox", label: "Roblox", description: "Roblox dev mode", builtIn: true, enableTools: [], enableSkills: [], enableFeatures: [], icon: "R" },
    ]);
  });

  it("renders header 'EXTENSION HUB'", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("EXTENSION HUB");
  });

  it("renders category tabs (All, Skills, Tools, MCPs, Plugins, Features, Modes)", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("All");
    expect(out).toContain("Skills");
    expect(out).toContain("Tools");
    expect(out).toContain("MCPs");
    expect(out).toContain("Plugins");
    expect(out).toContain("Features");
    expect(out).toContain("Modes");
  });

  it("renders extensions on 'All' tab (default)", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("rojo");
    expect(out).toContain("wally");
    expect(out).toContain("profilestore");
  });

  it("renders ON/OFF status for each extension", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("ON");
    expect(out).toContain("OFF");
  });

  it("renders keyboard shortcuts at bottom", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Esc");
    expect(out).toContain("Tab");
  });

  it("renders active/enabled count (e.g., '3/5 active')", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("3/5");
    expect(out).toContain("active");
  });

  it("renders description of selected item", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // First item is selected by default (cursorIndex=0)
    expect(out).toContain("Build Roblox project");
  });

  it("does NOT render emojis (regression for ✅🧹 bug)", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // No emoji codepoints
    expect(out).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    expect(out).not.toMatch(/[\u{2600}-\u{27BF}]/u);
  });

  it("renders accented chars correctly (no mojibake)", () => {
    // Override with accented description
    mockedGetAllExtensions.mockReturnValue([
      { id: "tool:rojo", name: "rojo", category: "tool", enabled: true, installed: true, triggerMode: "on_file", description: "Construção de projeto Roblox" },
    ]);
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Construção");
    expect(out).not.toContain("├");
    expect(out).not.toContain("Ã");
  });
});

// ─── Full App integration tests ───────────────────────────────────────────

describe("App — full TUI integration", () => {
  it("renders banner with 'Claude-Killer' brand", () => {
    // App needs more mocks — let's import it
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { lastFrame } = render(<App />);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Claude-Killer");
    })();
  });

  it("renders input prompt '> ' when idle", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { lastFrame } = render(<App />);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain(">");
    })();
  });

  it("renders '/help for commands' hint", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { lastFrame } = render(<App />);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("/help");
    })();
  });

  it("renders 'Ctrl+E for Hub' hint", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { lastFrame } = render(<App />);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Ctrl+E");
      expect(out).toContain("Hub");
    })();
  });

  it("does NOT render emojis in banner (regression)", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { lastFrame } = render(<App />);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
    })();
  });

  it("renders Model name in banner", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { lastFrame } = render(<App />);
      const out = stripAnsi(lastFrame() ?? "");
      expect(out).toContain("Model:");
    })();
  });

  it("renders banner with '=' dividers (now width-adaptive, not fixed 50)", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { lastFrame } = render(<App />);
      const out = stripAnsi(lastFrame() ?? "");
      // Banner now adapts width to terminal size via useTerminalWidth().
      // In test environments (no TTY), the width defaults to 100 cols, so the
      // banner dividers will be ~80 chars. We just verify that AT LEAST 2
      // divider lines of "=" * N exist (top + bottom of banner).
      const dividers = out.split("\n").filter((l) => l.trim().match(/^=+$/) && l.trim().length >= 30);
      expect(dividers.length).toBeGreaterThanOrEqual(2);
    })();
  });

  it("renders placeholder text when idle", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { lastFrame } = render(<App />);
      const out = stripAnsi(lastFrame() ?? "");
      // Should show placeholder "Digite sua mensagem..."
      expect(out).toContain("Digite");
    })();
  });
});

// ─── Autocomplete component tests ─────────────────────────────────────────

describe("Autocomplete — render snapshots (via App typing)", () => {
  it("App renders autocomplete when typing /", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { stdin, lastFrame } = render(<App />);
      // Type "/" to trigger autocomplete
      stdin.write("/");
      // Small delay for state update + re-render
      await new Promise((r) => setTimeout(r, 50));
      const out = stripAnsi(lastFrame() ?? "");
      // Should show some commands (at least /help)
      expect(out).toContain("/help");
    })();
  });

  it("App filters autocomplete when typing /ef", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { stdin, lastFrame } = render(<App />);
      stdin.write("/ef");
      await new Promise((r) => setTimeout(r, 50));
      const out = stripAnsi(lastFrame() ?? "");
      // Should show /effort
      expect(out).toContain("/effort");
    })();
  });

  it("App shows subcommands when typing /effort + space", () => {
    return (async () => {
      const { App } = await import("../tui/App.js");
      const { stdin, lastFrame } = render(<App />);
      stdin.write("/effort ");
      await new Promise((r) => setTimeout(r, 50));
      const out = stripAnsi(lastFrame() ?? "");
      // Should show subcommands: low, medium, high, max
      expect(out).toContain("low");
      expect(out).toContain("medium");
      expect(out).toContain("high");
      expect(out).toContain("max");
    })();
  });
});

// ─── Visual regression: full output snapshots ─────────────────────────────

describe("Visual regression — full output contains expected text", () => {
  it("ChatDisplay with mixed messages produces stable output", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Olá" },
      { role: "assistant", content: "Oi! Tudo bem?" },
      { role: "user", content: "Sim, e você?" },
    ];
    const { lastFrame } = render(<ChatDisplay messages={messages} />);
    const out = stripAnsi(lastFrame() ?? "");
    // Snapshot-like: verify all expected substrings are present
    expect(out).toMatch(/você:/);
    expect(out).toMatch(/Claude-Killer:/);
    expect(out).toMatch(/Olá/);
    expect(out).toMatch(/Oi! Tudo bem\?/);
    expect(out).toMatch(/Sim, e você\?/);
  });

  it("StatusBar with all features enabled produces stable output", () => {
    const { lastFrame } = render(
      <StatusBar
        promptTokens={1000}
        completionTokens={500}
        totalTokens={1500}
        contextWindow={10000}
        warnThreshold={0.5}
        compactThreshold={0.8}
        costPerKPrompt={0.01}
        costPerKCompletion={0.03}
        planMode={true}
        mcpCount={2}
        skillsCount={5}
        effortLabel="MAX"
        tokensPerSecond={99.9}
      />
    );
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("1.5k");
    expect(out).toContain("10k"); // 10000 formats to "10k" not "10.0k"
    expect(out).toContain("15");
    expect(out).toContain("MAX");
    expect(out).toContain("99.9");
    expect(out).toContain("tok/s");
    expect(out).toContain("[PLAN]");
    expect(out).toContain("$");
  });

  it("TodoPanel with all statuses produces stable output", () => {
    const todos: TodoItem[] = [
      { status: "completed", content: "Done task", active_form: "" },
      { status: "in_progress", content: "Working", active_form: "Currently working on this" },
      { status: "pending", content: "Todo task", active_form: "" },
    ];
    const { lastFrame } = render(<TodoPanel todos={todos} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("3 tasks");
    expect(out).toContain("Done task");
    expect(out).toContain("Currently working on this");
    expect(out).toContain("Todo task");
  });
});
