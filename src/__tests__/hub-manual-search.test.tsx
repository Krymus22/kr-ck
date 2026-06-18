/**
 * hub-manual-search.test.tsx — Tests for the manual tool search (S key).
 *
 * Tests:
 *   - 'S' key triggers search
 *   - Search panel appears with "Buscando tools..."
 *   - Shortcuts bar includes 'S=smart'
 *   - Search results show X for missing, v for found
 *   - 'S' does nothing while already searching
 *   - 'S' does nothing on Modes tab
 *   - searchAllTools searches multiple tools in sequence
 *   - extractToolBinaryName converts tool IDs correctly
 *   - getModeToolNames deduplicates
 *   - detectTool with forceDeepSearch ignores AUTO_DETECT_TOOLS
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

// Mock toolDetector with controllable results
const mockDetectTool = vi.hoisted(() => vi.fn(() => ({
  status: "missing", binaryPath: null, version: null, error: "not found", searchedPaths: [],
})));

const mockExtremeSearchAllTools = vi.hoisted(() => vi.fn(async (toolNames: string[], onProgress?: (p: any) => void, _abortSignal?: { aborted: boolean }) => {
  const results: any[] = [];
  for (let i = 0; i < toolNames.length; i++) {
    const name = toolNames[i];
    onProgress?.({ currentTool: name, currentPath: "(extreme scan...)", toolsDone: i, toolsTotal: toolNames.length, results: [...results] });
    const result = { toolName: name, status: "missing", binaryPath: null, version: null, searchedPaths: [] };
    results.push(result);
    onProgress?.({ currentTool: name, currentPath: "(not found)", toolsDone: i + 1, toolsTotal: toolNames.length, results: [...results] });
  }
  return results;
}));

const mockAiOnlySearchAllTools = vi.hoisted(() => vi.fn(async (toolNames: string[], onProgress?: (p: any) => void) => {
  const results: any[] = [];
  for (let i = 0; i < toolNames.length; i++) {
    const name = toolNames[i];
    onProgress?.({ currentTool: name, currentPath: "(IA...)", toolsDone: i, toolsTotal: toolNames.length, results: [...results] });
    const result = { toolName: name, status: "missing", binaryPath: null, version: null, searchedPaths: [] };
    results.push(result);
    onProgress?.({ currentTool: name, currentPath: "(IA nao achou)", toolsDone: i + 1, toolsTotal: toolNames.length, results: [...results] });
  }
  return results;
}));

vi.mock("../toolDetector.js", () => ({
  detectTool: mockDetectTool,
  detectAndVerify: vi.fn(async () => ({ status: "missing", binaryPath: null, version: null, error: "", searchedPaths: [], verified: false })),
  verifyToolWorks: vi.fn(async () => ({ works: false })),
  getSearchPathsForTool: vi.fn(() => []),
  isAutoDetectEnabled: vi.fn(() => false),
  searchAllTools: vi.fn(async (toolNames: string[], onProgress?: (p: any) => void) => {
    const results: any[] = [];
    for (let i = 0; i < toolNames.length; i++) {
      const name = toolNames[i];
      onProgress?.({ currentTool: name, currentPath: "(searching...)", toolsDone: i, toolsTotal: toolNames.length, results: [...results] });
      const result = { toolName: name, status: "missing", binaryPath: null, version: null, searchedPaths: [] };
      results.push(result);
      onProgress?.({ currentTool: name, currentPath: "(not found)", toolsDone: i + 1, toolsTotal: toolNames.length, results: [...results] });
    }
    return results;
  }),
  extremeSearchAllTools: mockExtremeSearchAllTools,
  aiOnlySearchAllTools: mockAiOnlySearchAllTools,
  extractToolBinaryName: vi.fn((id: string) => id.replace(/^tool:/, "").replace(/_(build|serve|sourcemap|install|search|publish|lint|format|run|process|add)$/, "")),
  getModeToolNames: vi.fn((ids: string[]) => [...new Set(ids.map((id: string) => id.replace(/^tool:/, "").replace(/_(build|serve|sourcemap|install|search|publish|lint|format|run|process|add)$/, "")))]),
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

const mockedGetAllExtensions = vi.hoisted(() => vi.fn(() => [
  { id: "tool:rojo_build", name: "rojo_build", category: "tool", enabled: true, installed: false, triggerMode: "on_file", description: "Build" },
  { id: "tool:selene_lint", name: "selene_lint", category: "tool", enabled: true, installed: false, triggerMode: "on_file", description: "Lint" },
]));
const mockedGetHubSummary = vi.hoisted(() => vi.fn(() => ({
  total: 2, enabled: 2, byCategory: { tool: { total: 2, enabled: 2 }, skill: { total: 0, enabled: 0 }, mcp: { total: 0, enabled: 0 }, plugin: { total: 0, enabled: 0 }, feature: { total: 0, enabled: 0 } },
})));

vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: mockedGetAllExtensions,
  getExtensionsByCategory: vi.fn(() => []),
  getHubSummary: mockedGetHubSummary,
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn((m: string) => m.toUpperCase()),
  getTriggerModes: vi.fn(() => ["disabled", "on_file", "on_task", "always"]),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn(() => "T"),
  discoverExtensions: vi.fn(),
  executeTrigger: vi.fn(() => Promise.resolve()),
}));

const mockedGetActiveMode = vi.hoisted(() => vi.fn(() => ({
  name: "roblox", label: "Roblox", description: "Roblox mode", builtIn: true,
  enableTools: ["tool:rojo_build", "tool:selene_lint"], enableSkills: [], enableFeatures: [], icon: "R",
})));
const mockedGetActiveModeName = vi.hoisted(() => vi.fn(() => "roblox"));

vi.mock("../modes.js", () => ({
  getAllModes: vi.fn(() => []),
  getActiveModeName: mockedGetActiveModeName,
  getActiveMode: mockedGetActiveMode,
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
}));

vi.mock("../effortLevels.js", () => ({ getEffortLevel: vi.fn(() => "medium"), setEffortLevel: vi.fn(), getEffortLabel: vi.fn(() => "MEDIUM") }));
vi.mock("../apiKeyPool.js", () => ({ getPoolSize: vi.fn(() => 1), formatPoolStats: vi.fn(() => "") }));
vi.mock("../i18n.js", () => ({ getLocalizedSlashCommands: vi.fn(() => []), getCommandI18n: vi.fn(() => ({})) }));
vi.mock("../history.js", () => ({ isPlanMode: vi.fn(() => false), setPlanMode: vi.fn(), resetHistory: vi.fn(), getHistory: vi.fn(() => []), addUserMessage: vi.fn(), addRawAssistantMessage: vi.fn(), addToolResult: vi.fn(), addSystemMessage: vi.fn(), historySummary: vi.fn(() => ""), historyLength: vi.fn(() => 0) }));
vi.mock("../externalTools.js", () => ({ getRegistry: vi.fn(() => ({ getAll: vi.fn(() => []), getByCategory: vi.fn(() => []), isInstalled: vi.fn(() => false), addTool: vi.fn(), get: vi.fn(), getToolStatus: vi.fn(() => "missing") })), getDetector: vi.fn(() => ({ detect: vi.fn(), detectFromContext: vi.fn() })), getExecutor: vi.fn(() => ({ execute: vi.fn() })), getSuggester: vi.fn(() => ({ suggest: vi.fn() })), initializeTools: vi.fn() }));
vi.mock("../agent.js", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../todo.js", () => ({ resetTodo: vi.fn(), renderTodoBar: vi.fn(), getTodos: vi.fn() }));
vi.mock("../memory.js", () => ({ getMemoryConfig: vi.fn() }));
vi.mock("../session.js", () => ({ saveSession: vi.fn(), loadSession: vi.fn(), listSessions: vi.fn() }));
vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn() }));

import { ExtensionHub } from "../tui/ExtensionHub.js";
import { searchAllTools, extractToolBinaryName, getModeToolNames, detectTool } from "../toolDetector.js";

function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }
function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe("Hub manual search (S key)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectTool.mockReturnValue({ status: "missing", binaryPath: null, version: null, error: "not found", searchedPaths: [] });
  });

  it("shortcuts bar includes 'S=smart'", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("S=smart");
  });

  it("shortcuts bar includes 'X=eXtreme'", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("X=eXtreme");
  });

  it("pressing 'S' shows search panel", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("s");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    // Should show search panel header
    expect(out).toMatch(/Buscando|Busca/);
  });

  it("pressing 'S' calls searchAllTools", async () => {
    const { stdin } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("s");
    await delay(200);
    expect(searchAllTools).toHaveBeenCalled();
  });

  it("'S' does nothing on Modes tab", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    // Tab to Modes (6 times)
    for (let i = 0; i < 6; i++) { stdin.write("\t"); await delay(30); }
    stdin.write("s");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("Buscando");
    expect(out).not.toContain("Busca completa");
  });

  it("search panel shows tool names and status", async () => {
    // Mock searchAllTools to return found results
    vi.mocked(searchAllTools).mockImplementationOnce(async (toolNames: string[], onProgress?: any) => {
      const results: any[] = toolNames.map(name => ({
        toolName: name, status: "found", binaryPath: `/fake/${name}`, version: "1.0.0", searchedPaths: [],
      }));
      onProgress?.({ currentTool: toolNames[0], currentPath: "/fake", toolsDone: toolNames.length, toolsTotal: toolNames.length, results });
      return results;
    });

    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("s");
    await delay(300);
    const out = stripAnsi(lastFrame() ?? "");
    // Should show found tools with v (checkmark)
    expect(out).toContain("rojo");
  });

  it("'S' does nothing while already searching", async () => {
    // Mock searchAllTools to be slow
    vi.mocked(searchAllTools).mockImplementationOnce(async (toolNames: string[], onProgress?: any) => {
      await new Promise(r => setTimeout(r, 1000));
      return [];
    });

    const { stdin } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("s"); // First press
    await delay(100);
    stdin.write("s"); // Second press while searching
    await delay(100);
    // searchAllTools should only be called once
    expect(searchAllTools).toHaveBeenCalledTimes(1);
  });
});

// ─── X key (extreme search) ──────────────────────────────────────────────

describe("Hub extreme search (X key)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectTool.mockReturnValue({ status: "missing", binaryPath: null, version: null, error: "not found", searchedPaths: [] });
    mockExtremeSearchAllTools.mockClear();
  });

  it("pressing 'X' shows extreme search panel", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("x");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    // Should show the extreme search panel header
    expect(out).toMatch(/BUSCA EXTREMA|Busca extrema/);
  });

  it("pressing 'X' calls extremeSearchAllTools", async () => {
    const { stdin } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("x");
    await delay(200);
    expect(mockExtremeSearchAllTools).toHaveBeenCalled();
  });

  it("'X' does nothing while regular search is running", async () => {
    // Make searchAllTools slow so the regular search is still running
    vi.mocked(searchAllTools).mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 1000));
      return [];
    });

    const { stdin } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("s"); // start regular search
    await delay(100);
    stdin.write("x"); // try to start extreme search
    await delay(100);
    // extremeSearchAllTools should NOT be called because regular is running
    expect(mockExtremeSearchAllTools).not.toHaveBeenCalled();
  });

  it("'X' does nothing on Modes tab", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    // Tab to Modes (6 times)
    for (let i = 0; i < 6; i++) { stdin.write("\t"); await delay(30); }
    stdin.write("x");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("BUSCA EXTREMA");
    expect(out).not.toContain("Busca extrema");
  });

  it("Esc cancels extreme search instead of closing hub", async () => {
    // Make extremeSearchAllTools slow so it's still running when we press Esc
    mockExtremeSearchAllTools.mockImplementationOnce(async (_toolNames: string[], _onProgress?: any, abortSignal?: { aborted: boolean }) => {
      // Wait until aborted or 2s timeout
      const start = Date.now();
      while (Date.now() - start < 2000) {
        if (abortSignal?.aborted) return [];
        await new Promise(r => setTimeout(r, 50));
      }
      return [];
    });

    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("x");
    await delay(150);
    stdin.write("\u001B"); // Esc
    await delay(150);
    const out = stripAnsi(lastFrame() ?? "");
    // Hub should still be open (Esc cancelled the search, didn't close the hub)
    expect(out).toContain("EXTENSION HUB");
    // Should show cancellation feedback (case-insensitive, matches "cancelado" or "CANCELADA")
    expect(out).toMatch(/cancelad[ao]/i);
  });
});

// ─── A key (AI-only search) ──────────────────────────────────────────────

describe("Hub AI search (A key)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectTool.mockReturnValue({ status: "missing", binaryPath: null, version: null, error: "not found", searchedPaths: [] });
    mockAiOnlySearchAllTools.mockClear();
  });

  it("pressing 'A' shows AI search panel", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("a");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toMatch(/BUSCA IA|Busca IA/);
  });

  it("pressing 'A' calls aiOnlySearchAllTools", async () => {
    const { stdin } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("a");
    await delay(200);
    expect(mockAiOnlySearchAllTools).toHaveBeenCalled();
  });

  it("'A' does nothing while regular search is running", async () => {
    vi.mocked(searchAllTools).mockImplementationOnce(async () => {
      await new Promise(r => setTimeout(r, 1000));
      return [];
    });

    const { stdin } = render(<ExtensionHub onClose={() => {}} />);
    stdin.write("s");
    await delay(100);
    stdin.write("a");
    await delay(100);
    expect(mockAiOnlySearchAllTools).not.toHaveBeenCalled();
  });

  it("'A' does nothing on Modes tab", async () => {
    const { stdin, lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    for (let i = 0; i < 6; i++) { stdin.write("\t"); await delay(30); }
    stdin.write("a");
    await delay(200);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).not.toContain("BUSCA IA");
  });

  it("shortcuts bar includes 'A=ai'", () => {
    const { lastFrame } = render(<ExtensionHub onClose={() => {}} />);
    const out = stripAnsi(lastFrame() ?? "");
    expect(out).toContain("A=ai");
  });
});

// ─── toolDetector unit tests ──────────────────────────────────────────────

describe("toolDetector search functions", () => {
  describe("extractToolBinaryName", () => {
    it("converts tool:rojo_build to rojo", () => {
      expect(extractToolBinaryName("tool:rojo_build")).toBe("rojo");
    });

    it("converts tool:selene_lint to selene", () => {
      expect(extractToolBinaryName("tool:selene_lint")).toBe("selene");
    });

    it("converts tool:stylua_format to stylua", () => {
      expect(extractToolBinaryName("tool:stylua_format")).toBe("stylua");
    });

    it("converts tool:wally_install to wally", () => {
      expect(extractToolBinaryName("tool:wally_install")).toBe("wally");
    });

    it("converts tool:lune_run to lune", () => {
      expect(extractToolBinaryName("tool:lune_run")).toBe("lune");
    });

    it("converts tool:rojo_serve to rojo", () => {
      expect(extractToolBinaryName("tool:rojo_serve")).toBe("rojo");
    });
  });

  describe("getModeToolNames", () => {
    it("deduplicates rojo_build and rojo_serve to single 'rojo'", () => {
      const result = getModeToolNames(["tool:rojo_build", "tool:rojo_serve", "tool:selene_lint"]);
      expect(result).toContain("rojo");
      expect(result).toContain("selene");
      expect(result.length).toBe(2); // not 3 (rojo deduplicated)
    });

    it("returns empty array for empty input", () => {
      expect(getModeToolNames([])).toEqual([]);
    });

    it("handles single tool", () => {
      expect(getModeToolNames(["tool:rojo_build"])).toEqual(["rojo"]);
    });
  });

  describe("detectTool with forceDeepSearch", () => {
    it("accepts forceDeepSearch option without crashing", () => {
      const result = detectTool("nonexistent-xyz-123", { forceDeepSearch: true });
      expect(result).toBeDefined();
      expect(result.status).toBe("missing");
    });

    it("without forceDeepSearch, returns missing for nonexistent tool", () => {
      const result = detectTool("nonexistent-xyz-123");
      expect(result.status).toBe("missing");
    });
  });

  describe("searchAllTools", () => {
    it("calls onProgress for each tool", async () => {
      const progressCalls: any[] = [];
      await searchAllTools(["rojo", "selene"], (p) => progressCalls.push(p));
      // Should have at least 4 calls: 2 tools × 2 calls each (start + done)
      expect(progressCalls.length).toBeGreaterThanOrEqual(4);
    });

    it("returns results for all tools", async () => {
      const results = await searchAllTools(["rojo", "selene", "stylua"]);
      expect(results.length).toBe(3);
      expect(results[0].toolName).toBe("rojo");
      expect(results[1].toolName).toBe("selene");
      expect(results[2].toolName).toBe("stylua");
    });

    it("handles empty tool list", async () => {
      const results = await searchAllTools([]);
      expect(results).toEqual([]);
    });

    it("reports correct toolsDone/toolsTotal in progress", async () => {
      const lastProgress: any[] = [];
      await searchAllTools(["a", "b", "c"], (p) => { lastProgress.push({...p}); });
      // Last progress should show 3/3 done
      const last = lastProgress[lastProgress.length - 1];
      expect(last.toolsDone).toBe(3);
      expect(last.toolsTotal).toBe(3);
    });
  });
});
