/**
 * hub-mode-filter.test.tsx — Tests for the mode filter feature in ExtensionHub.
 *
 * Tests:
 *   - 'M' key toggles the mode filter on/off
 *   - When filter is on, only items from active mode are shown
 *   - Filter indicator "FILTER: active mode only" appears
 *   - Shortcuts bar includes 'M' for filter
 *   - 'M' does nothing on Modes tab
 *   - 'M' does nothing when no mode is active
 *   - Filter shows fewer items when active (roblox mode has subset of tools)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaBaseUrl: "https://test.api.com", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.6, contextCompactThreshold: 0.75,
    costPerKPrompt: 0, costPerKCompletion: 0, maxHealRetries: 2,
    temperature: 0.6, topP: 0.9, maxTokens: 4096,
  },
}));

vi.mock("../toolDetector.js", () => ({
  detectTool: vi.fn(() => ({ status: "missing", binaryPath: null, version: null, error: "", searchedPaths: [] })),
  detectAndVerify: vi.fn(async () => ({ status: "missing", binaryPath: null, version: null, error: "", searchedPaths: [], verified: false })),
  verifyToolWorks: vi.fn(async () => ({ works: false })),
  getSearchPathsForTool: vi.fn(() => []),
  isAutoDetectEnabled: vi.fn(() => false),
}));

vi.mock("../toolInstaller.js", () => ({
  installTool: vi.fn(async () => ({ success: false, toolName: "", version: null, binaryPath: null })),
  canInstall: vi.fn(() => true),
  listInstallableTools: vi.fn(() => ["rojo"]),
  getToolRepo: vi.fn(() => null),
  getInstallDir: vi.fn(() => ""),
}));

vi.mock("../extensions.js", () => ({
  getMCPToolDefinitions: vi.fn(() => []), callMCPTool: vi.fn(),
  loadAllExtensions: vi.fn(async () => {}), shutdownMCPServers: vi.fn(),
  getActiveSkills: vi.fn(() => []), getActiveMCPServers: vi.fn(() => []),
}));

// 10 extensions: 5 tools (3 in roblox mode), 3 skills (2 in roblox), 2 features (1 in roblox)
const allExts = [
  { id: "tool:rojo_build", name: "rojo_build", category: "tool", enabled: true, installed: true, triggerMode: "on_file", description: "Build" },
  { id: "tool:selene_lint", name: "selene_lint", category: "tool", enabled: true, installed: true, triggerMode: "on_file", description: "Lint" },
  { id: "tool:stylua_format", name: "stylua_format", category: "tool", enabled: true, installed: true, triggerMode: "on_file", description: "Format" },
  { id: "tool:darklua_process", name: "darklua_process", category: "tool", enabled: false, installed: false, triggerMode: "disabled", description: "Minify" },
  { id: "tool:terraform_validate", name: "terraform_validate", category: "tool", enabled: false, installed: false, triggerMode: "disabled", description: "TF validate" },
  { id: "skill:profilestore", name: "profilestore", category: "skill", enabled: true, installed: true, triggerMode: "always", description: "DataStore" },
  { id: "skill:bytenet", name: "bytenet", category: "skill", enabled: true, installed: true, triggerMode: "always", description: "Networking" },
  { id: "skill:custom_skill", name: "custom_skill", category: "skill", enabled: false, installed: true, triggerMode: "disabled", description: "Custom" },
  { id: "feature:think_tool", name: "think_tool", category: "feature", enabled: true, installed: true, triggerMode: "always", description: "Thinking" },
  { id: "feature:strict_gate", name: "strict_gate", category: "feature", enabled: false, installed: true, triggerMode: "disabled", description: "Gate" },
];

const mockedGetAllExtensions = vi.hoisted(() => vi.fn(() => allExts));
const mockedGetExtensionsByCategory = vi.hoisted(() => vi.fn((cat: string) => allExts.filter(e => e.category === cat)));
const mockedGetHubSummary = vi.hoisted(() => vi.fn(() => ({
  total: 10, enabled: 6, byCategory: {
    tool: { total: 5, enabled: 3 }, skill: { total: 3, enabled: 2 },
    mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 },
    feature: { total: 2, enabled: 1 },
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

// Mock modes — roblox mode with subset of items
const mockedGetAllModes = vi.hoisted(() => vi.fn(() => [
  { name: "roblox", label: "Roblox", description: "Roblox mode", builtIn: true,
    enableTools: ["tool:rojo_build", "tool:selene_lint", "tool:stylua_format"],
    enableSkills: ["skill:profilestore", "skill:bytenet"],
    enableFeatures: ["feature:think_tool"],
    icon: "R" },
]));
const mockedGetActiveModeName = vi.hoisted(() => vi.fn(() => "roblox"));
const mockedGetActiveMode = vi.hoisted(() => vi.fn(() => ({
  name: "roblox", label: "Roblox", description: "Roblox mode", builtIn: true,
  enableTools: ["tool:rojo_build", "tool:selene_lint", "tool:stylua_format"],
  enableSkills: ["skill:profilestore", "skill:bytenet"],
  enableFeatures: ["feature:think_tool"],
  icon: "R",
})));

vi.mock("../modes.js", () => ({
  getAllModes: mockedGetAllModes,
  getActiveModeName: mockedGetActiveModeName,
  getActiveMode: mockedGetActiveMode,
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
  // Reactive store hooks — required by useSyncExternalStore
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
}));

vi.mock("../apiKeyPool.js", () => ({
  getPoolSize: vi.fn(() => 1),
  formatPoolStats: vi.fn(() => ""),
}));

vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => []),
  getCommandI18n: vi.fn(() => ({})),
}));

vi.mock("../history.js", () => ({
  isPlanMode: vi.fn(() => false), setPlanMode: vi.fn(), resetHistory: vi.fn(),
  getHistory: vi.fn(() => []), addUserMessage: vi.fn(), addRawAssistantMessage: vi.fn(),
  addToolResult: vi.fn(), addSystemMessage: vi.fn(), historySummary: vi.fn(() => ""),
  historyLength: vi.fn(() => 0),
  loadHistoryDirect: vi.fn(),
  getSystemPrompt: vi.fn(() => "system prompt"),
  optimizeContext: vi.fn(),
}));

vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []),
    isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn(), getToolStatus: vi.fn(() => "missing") })),
  getDetector: vi.fn(() => ({ detect: vi.fn(), detectFromContext: vi.fn() })),
  getExecutor: vi.fn(() => ({ execute: vi.fn() })),
  getSuggester: vi.fn(() => ({ suggest: vi.fn() })),
  initializeTools: vi.fn(),
}));

vi.mock("../agent.js", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../todo.js", () => ({ resetTodo: vi.fn(), renderTodoBar: vi.fn(), getTodos: vi.fn() }));
vi.mock("../memory.js", () => ({ getMemoryConfig: vi.fn() }));
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
vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn() }));

import { ExtensionHub } from "../tui/ExtensionHub.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe("Hub mode filter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetAllExtensions.mockReturnValue(allExts);
    mockedGetActiveModeName.mockReturnValue("roblox");
    mockedGetActiveMode.mockReturnValue({
      name: "roblox", label: "Roblox", description: "Roblox mode", builtIn: true,
      enableTools: ["tool:rojo_build", "tool:selene_lint", "tool:stylua_format"],
      enableSkills: ["skill:profilestore", "skill:bytenet"],
      enableFeatures: ["feature:think_tool"],
      icon: "R",
    });
  });

  it("shortcuts bar includes 'M' for filter", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    // The compact help text uses "M" for the filter toggle
    expect(out).toMatch(/\bM\b/);
  });

  it("shows 'Active mode: roblox' when a mode is active", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("Active mode: roblox");
  });

  it("does NOT show filter indicator by default", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("FILTER");
  });

  it("pressing 'M' toggles filter ON — shows FILTER indicator", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("m");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("FILTER");
    expect(out).toContain("active mode only");
  });

  it("pressing 'M' twice toggles filter OFF — removes FILTER indicator", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("m");
    await delay(50);
    stdin.write("m");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("FILTER");
  });

  it("when filter is ON, only shows items from active mode (All tab)", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);

    // Before filter: should show all 10 items (including darklua, terraform, custom_skill)
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("darklua");
    expect(out).toContain("terraform");
    expect(out).toContain("custom_skill");

    // Turn on filter
    stdin.write("m");
    await delay(100);
    out = stripAnsi(lastFrame() ?? "");

    // After filter: should show only roblox mode items (6: 3 tools + 2 skills + 1 feature)
    // darklua, terraform, custom_skill should be filtered out
    expect(out).not.toContain("darklua");
    expect(out).not.toContain("terraform");
    expect(out).not.toContain("custom_skill");
    // But rojo, selene, stylua should still be visible
    expect(out).toContain("rojo_build");
    expect(out).toContain("selene_lint");
  });

  it("'M' does nothing on the Modes tab", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    // Tab to Modes (6 times: All→Skills→Tools→MCPs→Plugins→Features→Modes)
    for (let i = 0; i < 6; i++) {
      stdin.write("\t");
      await delay(30);
    }
    // Press M
    stdin.write("m");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    // Filter indicator should NOT appear on Modes tab
    expect(out).not.toContain("FILTER");
  });

  it("'M' does nothing when no mode is active", async () => {
    mockedGetActiveModeName.mockReturnValue(null);
    mockedGetActiveMode.mockReturnValue(null);

    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("m");
    await delay(100);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("FILTER");
  });

  it("filter works on Tools tab too (not just All tab)", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);

    // Tab to Tools (2 times: All→Skills→Tools)
    stdin.write("\t");
    await delay(30);
    stdin.write("\t");
    await delay(30);

    // Before filter: should show all 5 tools including darklua and terraform
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("darklua");
    expect(out).toContain("terraform");

    // Turn on filter
    stdin.write("m");
    await delay(100);
    out = stripAnsi(lastFrame() ?? "");

    // After filter: only 3 roblox tools (rojo, selene, stylua)
    expect(out).not.toContain("darklua");
    expect(out).not.toContain("terraform");
    expect(out).toContain("rojo_build");
  });

  it("filter count updates when filter is active", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);

    // Before filter: All tab shows 6/10 active
    let out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("6/10");

    // Turn on filter
    stdin.write("m");
    await delay(100);
    out = stripAnsi(lastFrame() ?? "");

    // After filter: 6 items visible (all active), so "6/6 active (filtered)"
    expect(out).toContain("6/6");
    expect(out).toContain("filtered");
  });
});
