/**
 * tui-hub-pagination.test.tsx — Tests for Extension Hub with many extensions.
 *
 * Tests scenarios that the previous Hub tests didn't cover:
 *   - 30+ extensions (multi-page navigation)
 *   - Tab switching between categories
 *   - Cursor navigation across pages
 *   - Active mode indicator
 *   - Trigger modes display
 *   - Hub with empty categories
 *   - Hub with mixed installed/not-installed extensions
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
    contextWindowTokens: 256000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.75,
    costPerKPrompt: 0.01, costPerKCompletion: 0.03, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

// Build 30 extensions for pagination testing
function buildExtensions(count: number, category: string = "tool") {
  return Array.from({ length: count }, (_, i) => ({
    id: `${category}:${category}-${i}`,
    name: `${category}_${i}`,
    category,
    enabled: i % 2 === 0,
    installed: i % 3 !== 0,
    triggerMode: ["disabled", "on_file", "on_task", "always"][i % 4] as any,
    description: `${category} extension number ${i} — does something useful`,
  }));
}

const mockedGetAllExtensions = vi.hoisted(() => vi.fn(() => []));
const mockedGetExtensionsByCategory = vi.hoisted(() => vi.fn(() => []));
const mockedGetHubSummary = vi.hoisted(() => vi.fn(() => ({
  total: 30, enabled: 15, byCategory: {
    tool: { total: 13, enabled: 7 },
    skill: { total: 16, enabled: 8 },
    mcp: { total: 0, enabled: 0 },
    plugin: { total: 0, enabled: 0 },
    feature: { total: 1, enabled: 0 },
  },
})));
vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: mockedGetAllExtensions,
  getExtensionsByCategory: mockedGetExtensionsByCategory,
  getHubSummary: mockedGetHubSummary,
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn((m: string) => {
    const labels: Record<string, string> = {
      disabled: "OFF",
      on_file: "FILE",
      on_task: "TASK",
      always: "EVERY",
    };
    return labels[m] ?? m.toUpperCase();
  }),
  getTriggerModes: vi.fn(() => ["disabled", "on_file", "on_task", "always"]),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn((cat: string) => cat[0]?.toUpperCase() ?? "?"),
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
    { cmd: "/hub", desc: "Open Extension Hub" },
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
}));

vi.mock("../session.js", () => ({
  saveSession: vi.fn(() => "s1"), loadSession: vi.fn(() => true), listSessions: vi.fn(() => []),
}));

vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn(async () => ({ updatesAvailable: false })) }));

import { ExtensionHub } from "../tui/ExtensionHub.js";
import { App } from "../tui/App.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Hub with many extensions (pagination) ────────────────────────────────

describe("ExtensionHub — pagination with 30 extensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const extensions = buildExtensions(30, "tool");
    mockedGetAllExtensions.mockReturnValue(extensions);
    mockedGetExtensionsByCategory.mockReturnValue(extensions);
    mockedGetHubSummary.mockReturnValue({
      total: 30, enabled: 15, byCategory: {
        tool: { total: 30, enabled: 15 },
        skill: { total: 0, enabled: 0 },
        mcp: { total: 0, enabled: 0 },
        plugin: { total: 0, enabled: 0 },
        feature: { total: 0, enabled: 0 },
      },
    });
  });

  it("renders Hub with 30 extensions without crash", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    expect(out).toContain("EXTENSION HUB");
    expect(out).toContain("30");
  });

  it("shows pagination indicator when > 9 items", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // 30 items / 9 per page = 4 pages
    expect(out).toMatch(/Page\s+\d+\/4/);
  });

  it("shows first 9 extensions on page 1", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // First 9 = tool_0 to tool_8
    expect(out).toContain("tool_0");
    expect(out).toContain("tool_8");
    // tool_9+ should NOT be visible (page 2+)
    expect(out).not.toContain("tool_9");
    expect(out).not.toContain("tool_29");
  });

  it("shows '15/30 active' count", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("15/30");
  });

  it("renders ON/OFF labels for each extension", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // 15 enabled → "ON", 15 disabled → "OFF"
    expect(out).toContain("ON");
    expect(out).toContain("OFF");
  });

  it("renders trigger labels (OFF/FILE/TASK/EVERY)", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("[OFF]");
    expect(out).toContain("[FILE]");
    expect(out).toContain("[TASK]");
    expect(out).toContain("[EVERY]");
  });

  it("renders [FALTA] for not-installed tools", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // 10 of 30 are not installed (i % 3 === 0)
    expect(out).toContain("[FALTA]");
  });
});

// ─── Hub with empty categories ────────────────────────────────────────────

describe("ExtensionHub — empty categories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetAllExtensions.mockReturnValue([]);
    mockedGetExtensionsByCategory.mockReturnValue([]);
    mockedGetHubSummary.mockReturnValue({
      total: 0, enabled: 0, byCategory: {
        tool: { total: 0, enabled: 0 },
        skill: { total: 0, enabled: 0 },
        mcp: { total: 0, enabled: 0 },
        plugin: { total: 0, enabled: 0 },
        feature: { total: 0, enabled: 0 },
      },
    });
  });

  it("renders Hub with 0 extensions without crash", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(typeof out).toBe("string");
    expect(out).toContain("EXTENSION HUB");
  });

  it("shows 0/0 active count", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("0/0");
  });

  it("does NOT show pagination indicator when 0 items", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toMatch(/Page\s+\d+\/\d+/);
  });

  it("still shows all category tabs even when empty", () => {
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
});

// ─── Hub with active mode ─────────────────────────────────────────────────

describe("ExtensionHub — with active mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetAllExtensions.mockReturnValue([]);
    mockedGetHubSummary.mockReturnValue({
      total: 0, enabled: 0, byCategory: {
        tool: { total: 0, enabled: 0 }, skill: { total: 0, enabled: 0 },
        mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
        feature: { total: 0, enabled: 0 },
      },
    });
    mockedGetActiveModeName.mockReturnValue("roblox");
    mockedGetAllModes.mockReturnValue([
      { name: "roblox", label: "Roblox", description: "Roblox dev mode", builtIn: true, enableTools: [], enableSkills: [], enableFeatures: [], icon: "R" },
      { name: "devops", label: "DevOps", description: "DevOps mode", builtIn: true, enableTools: [], enableSkills: [], enableFeatures: [], icon: "D" },
    ]);
  });

  it("renders active mode indicator at top", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Active mode:");
    expect(out).toContain("roblox");
  });
});

// ─── Hub via App (Ctrl+E) ─────────────────────────────────────────────────

describe("ExtensionHub — via App Ctrl+E with 30 extensions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const extensions = buildExtensions(30, "tool");
    mockedGetAllExtensions.mockReturnValue(extensions);
    mockedGetExtensionsByCategory.mockReturnValue(extensions);
    mockedGetHubSummary.mockReturnValue({
      total: 30, enabled: 15, byCategory: {
        tool: { total: 30, enabled: 15 },
        skill: { total: 0, enabled: 0 },
        mcp: { total: 0, enabled: 0 },
        plugin: { total: 0, enabled: 0 },
        feature: { total: 0, enabled: 0 },
      },
    });
  });

  it("Ctrl+E opens Hub with 30 extensions", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05"); // Ctrl+E
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("EXTENSION HUB");
    expect(out).toContain("15/30");
    expect(out).toMatch(/Page\s+\d+\/4/);
  });

  it("Hub shows first 9 extensions on page 1 via App", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("tool_0");
    expect(out).toContain("tool_8");
    expect(out).not.toContain("tool_9");
  });

  it("Esc closes Hub and returns to normal chat", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05"); // Open Hub
    await delay(200);
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("EXTENSION HUB");

    stdin.write("\x1b"); // Esc
    await delay(200);
    out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("EXTENSION HUB");
    // Should be back to normal chat input
    expect(out).toContain("Claude-Killer");
  });

  it("input field shows '[ Hub aberto ]' message when Hub is open", async () => {
    const { stdin, lastFrame } = render(<App />);
    stdin.write("\x05");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    // When Hub is open, the input field is replaced with a message
    expect(out).toContain("Hub");
  });
});

// ─── Hub category navigation ──────────────────────────────────────────────

describe("ExtensionHub — category filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tools = buildExtensions(5, "tool");
    const skills = buildExtensions(3, "skill");
    const features = buildExtensions(2, "feature");
    const all = [...tools, ...skills, ...features];

    mockedGetAllExtensions.mockReturnValue(all);
    mockedGetExtensionsByCategory.mockImplementation((cat: string) => {
      if (cat === "tool") return tools;
      if (cat === "skill") return skills;
      if (cat === "feature") return features;
      return [];
    });
    mockedGetHubSummary.mockReturnValue({
      total: 10, enabled: 5, byCategory: {
        tool: { total: 5, enabled: 3 },
        skill: { total: 3, enabled: 2 },
        mcp: { total: 0, enabled: 0 },
        plugin: { total: 0, enabled: 0 },
        feature: { total: 2, enabled: 0 },
      },
    });
  });

  it("All tab shows all 10 extensions", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // All tab is default — should show first 9 of 10 (page 1)
    expect(out).toContain("tool_0");
    expect(out).toContain("skill_0");
  });

  it("shows correct counts in tabs (All: 10, Tools: 5, Skills: 3, Features: 2)", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("(10)");  // All
    expect(out).toContain("(5)");   // Tools
    expect(out).toContain("(3)");   // Skills
    expect(out).toContain("(2)");   // Features
  });
});

// ─── Hub with modes tab ───────────────────────────────────────────────────

describe("ExtensionHub — Modes tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetAllExtensions.mockReturnValue([]);
    mockedGetHubSummary.mockReturnValue({
      total: 0, enabled: 0, byCategory: {
        tool: { total: 0, enabled: 0 }, skill: { total: 0, enabled: 0 },
        mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
        feature: { total: 0, enabled: 0 },
      },
    });
    mockedGetAllModes.mockReturnValue([
      { name: "roblox", label: "Roblox", description: "Roblox dev mode", builtIn: true, enableTools: ["rojo"], enableSkills: ["profilestore"], enableFeatures: ["think_tool"], icon: "R" },
      { name: "devops", label: "DevOps", description: "DevOps mode", builtIn: true, enableTools: ["terraform"], enableSkills: [], enableFeatures: ["strict_gate"], icon: "D" },
      { name: "custom", label: "Custom", description: "User-created mode", builtIn: false, enableTools: [], enableSkills: [], enableFeatures: [], icon: "C" },
    ]);
  });

  it("Modes tab shows count (3)", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // The Modes tab should show (3)
    expect(out).toMatch(/Modes\s*\(3\)/);
  });

  it("Modes tab shows modes when navigated to (via Tab key)", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    // Press Tab 7 times to cycle from All → Skills → Tools → MCPs → Plugins → Features → Modes
    // (All=0, Skills=1, Tools=2, MCPs=3, Plugins=4, Features=5, Modes=6)
    for (let i = 0; i < 6; i++) {
      stdin.write("\t");
      await delay(50);
    }
    const out = stripAnsi(lastFrame() ?? "");
    // Should show mode cards now
    expect(out).toContain("roblox");
    expect(out).toContain("devops");
    expect(out).toContain("custom");
  });
});
