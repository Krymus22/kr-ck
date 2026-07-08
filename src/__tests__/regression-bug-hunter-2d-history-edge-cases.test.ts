/**
 * regression-bug-hunter-2d-history-edge-cases.test.ts
 *
 * Regression tests for bugs found and fixed by Bug Hunter #2d
 * (History edge cases + project memory + session interaction focus).
 *
 * Bugs covered:
 *   A. reloadProjectMemory() doesn't refresh history[0] system prompt.
 *      After /memory reload (or /cd to a new dir), the cache is updated but
 *      history[0] still has the OLD memory content. The IA continues to see
 *      stale memory until the next /reset — defeating the purpose of reload.
 *      Fix: refresh history[0] in-place (mirrors setCavemanLevel pattern).
 *
 *   B. loadProjectMemoryFiles() race condition: if a memory file is deleted
 *      between fs.existsSync() and fs.statSync()/fs.readFileSync(), the
 *      function throws ENOENT. This propagates up to getSystemPrompt() →
 *      ensureHistoryInitialized() → addUserMessage(), crashing the app on
 *      the user's first message after they (or a watcher) deleted a memory
 *      file. Fix: wrap stat/read in try/catch, skip files that disappear.
 *
 *   C. replaceHistory() doesn't repair orphan tool_calls. Compaction
 *      strategies in contextCompaction.ts (merge-adjacent-tool-results,
 *      remove-consecutive-same-role, remove-old-error-messages) can drop
 *      tool messages while keeping the corresponding assistant tool_calls.
 *      The OpenAI API rejects this with 400, permanently breaking the
 *      session. Fix: replaceHistory now calls repairOrphanToolCalls()
 *      (shared with loadHistoryDirect's BS-4 fix).
 *
 * Rules honored:
 *   - MEMORY_FILENAMES list NOT changed (§17 not affected).
 *   - "ler_arquivo NÃO trunca" NOT changed.
 *   - tryAppendToSession behavior NOT changed.
 *   - Uses `import` not `require()`.
 *   - loadHistoryDirect's "Session interrupted" message preserved.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Mocks ─────────────────────────────────────────────────────────────────
// Mock extensions.getActiveSkills and effortLevels.getEffortPromptSnippet so
// getSystemPrompt() is deterministic and doesn't touch the real extensions system.

const mockGetActiveSkills = vi.fn().mockReturnValue([]);
vi.mock("../extensions.js", () => ({
  getActiveSkills: (...args: any[]) => mockGetActiveSkills(...args),
}));

vi.mock("../effortLevels.js", () => ({
  getEffortPromptSnippet: vi.fn().mockReturnValue(""),
  setEffortLevel: vi.fn(),
}));

// Mock session to avoid file I/O during tests
vi.mock("../session.js", () => ({
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  setActiveSession: vi.fn(),
}));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import {
  addUserMessage,
  addRawAssistantMessage,
  addToolResult,
  getHistory,
  historyLength,
  resetHistory,
  replaceHistory,
  loadHistoryDirect,
  reloadProjectMemory,
  loadProjectMemoryFiles,
  getLoadedMemoryFiles,
  getSystemPrompt,
  setCavemanLevel,
} from "../history.js";

// ─── Setup / Teardown ──────────────────────────────────────────────────────

beforeEach(() => {
  resetHistory();
  setCavemanLevel(null);
  mockGetActiveSkills.mockReturnValue([]);
});

afterEach(() => {
  resetHistory();
  setCavemanLevel(null);
  mockGetActiveSkills.mockReturnValue([]);
});

// ─── Helper: create a temp dir with memory files ───────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bh2d-"));
}

function withCwd<T>(newCwd: string, fn: () => T): T {
  const original = process.cwd();
  try {
    process.chdir(newCwd);
    return fn();
  } finally {
    process.chdir(original);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug A: reloadProjectMemory() doesn't refresh history[0] system prompt
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2d — Bug A: reloadProjectMemory refreshes history[0]", () => {
  it("history[0] picks up new memory content after reloadProjectMemory", () => {
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        // Initially: no memory file. Cache is empty.
        reloadProjectMemory();
        const promptBefore = getHistory()[0].content as string;
        expect(promptBefore).not.toContain("Project Memory (CLAUDE.md / AGENTS.md)");

        // Create a CLAUDE.md after init
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "MARKER_INITIAL_MEMORY_CONTENT");

        // Reload — should refresh BOTH the cache AND history[0]
        reloadProjectMemory();
        const promptAfter = getHistory()[0].content as string;

        // Bug A: without the fix, promptAfter would NOT contain the new content
        // (history[0] still has the old system prompt without memory).
        expect(promptAfter).toContain("Project Memory (CLAUDE.md / AGENTS.md)");
        expect(promptAfter).toContain("MARKER_INITIAL_MEMORY_CONTENT");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history[0] picks up CHANGED memory content after reloadProjectMemory", () => {
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        // Start with one content
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "VERSION_1_OF_MEMORY");
        reloadProjectMemory();
        const promptV1 = getHistory()[0].content as string;
        expect(promptV1).toContain("VERSION_1_OF_MEMORY");

        // Edit the file
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "VERSION_2_OF_MEMORY");

        // Reload — history[0] should reflect VERSION_2
        reloadProjectMemory();
        const promptV2 = getHistory()[0].content as string;

        // Bug A: without the fix, promptV2 would still contain VERSION_1
        // because history[0] was not refreshed.
        expect(promptV2).toContain("VERSION_2_OF_MEMORY");
        expect(promptV2).not.toContain("VERSION_1_OF_MEMORY");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("history[0] drops memory section after reloadProjectMemory when file is deleted", () => {
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "TEMPORARY_MEMORY_FILE");
        reloadProjectMemory();
        expect((getHistory()[0].content as string)).toContain("TEMPORARY_MEMORY_FILE");

        // Delete the memory file
        fs.unlinkSync(path.join(dir, "CLAUDE.md"));

        // Reload — memory section should be gone from history[0]
        reloadProjectMemory();
        const prompt = getHistory()[0].content as string;

        // Bug A: without the fix, history[0] would still have the stale
        // "Project Memory" section with the deleted file's content.
        expect(prompt).not.toContain("TEMPORARY_MEMORY_FILE");
        expect(prompt).not.toContain("Project Memory (CLAUDE.md / AGENTS.md)");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloadProjectMemory does NOT crash when history is empty (no system prompt yet)", () => {
    // Edge case: if reloadProjectMemory is called before any history init,
    // history[0] doesn't exist. The refresh should be skipped gracefully.
    // We test this by calling reloadProjectMemory right after resetHistory
    // (which leaves history with just the system prompt — but we can also
    // verify the guard `history.length > 0` works by checking no crash occurs
    // when memory files exist but history is in its initial state).
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "EDGE_CASE_MEMORY");

        // resetHistory gives us history = [system prompt] (length 1).
        // reloadProjectMemory should refresh history[0] with the new memory.
        resetHistory();
        expect(() => reloadProjectMemory()).not.toThrow();

        // history[0] should now contain the memory content.
        const prompt = getHistory()[0].content as string;
        expect(prompt).toContain("EDGE_CASE_MEMORY");
        expect(prompt).toContain("Project Memory");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug B: loadProjectMemoryFiles() race condition
// ═══════════════════════════════════════════════════════════════════════════
// Bug B tests live in a SEPARATE file: regression-bug-hunter-2d-fs-race.test.ts
// They mock `node:fs` at the module level, which would break the other tests
// in this file (which need real fs for temp dir operations).

// Verify the fix is in place by checking the source code has try/catch around
// statSync and readFileSync in loadProjectMemoryFiles.
describe("Bug Hunter #2d — Bug B: loadProjectMemoryFiles source has try/catch", () => {
  it("loadProjectMemoryFiles wraps statSync and readFileSync in try/catch", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "history.ts"),
      "utf8"
    );
    // Find the loadProjectMemoryFiles function body
    const funcStart = source.indexOf("export function loadProjectMemoryFiles");
    expect(funcStart).toBeGreaterThan(-1);
    const funcEnd = source.indexOf("\n}", funcStart);
    const funcBody = source.slice(funcStart, funcEnd);
    // The walk loop should have try/catch
    expect(funcBody).toContain("try {");
    expect(funcBody).toContain("} catch {");
    // The .map() / .flatMap() should also have try/catch
    expect(funcBody).toMatch(/flatMap|map/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug C: replaceHistory() repairs orphan tool_calls (compaction side-effect)
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2d — Bug C: replaceHistory repairs orphan tool_calls", () => {
  /**
   * Helper: count assistant tool_call_ids that have NO matching tool result.
   */
  function countOrphanToolCalls(history: any[]): number {
    const toolCallIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const m of history) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc?.id) toolCallIds.add(tc.id);
        }
      }
      if (m.role === "tool" && typeof m.tool_call_id === "string") {
        toolResultIds.add(m.tool_call_id);
      }
    }
    return [...toolCallIds].filter((id) => !toolResultIds.has(id)).length;
  }

  it("replaceHistory repairs orphans created by merge-adjacent-tool-results strategy", () => {
    // Simulate the output of compactIntelligently's merge-adjacent-tool-results
    // strategy: 3 tool messages merged into 1, but the assistant still has all
    // 3 tool_calls. This is the EXACT scenario that breaks the API.
    const compacted = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          { id: "call_3", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        ],
      },
      // Only call_1's tool result remains (call_2 and call_3 were merged away)
      { role: "tool", tool_call_id: "call_1", content: "merged result" },
    ];

    replaceHistory(compacted as any);
    const h = getHistory();

    // Bug C: without the fix, this would be 2 (call_2 and call_3 are orphans).
    expect(countOrphanToolCalls(h as any[])).toBe(0);

    // Verify synthetic tool results were injected for call_2 and call_3
    const toolResults = h.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(3);
    const ids = toolResults.map((m: any) => m.tool_call_id).sort();
    expect(ids).toEqual(["call_1", "call_2", "call_3"]);
  });

  it("replaceHistory repairs orphans created by remove-old-error-messages strategy", () => {
    // Simulate the output of compactIntelligently's remove-old-error-messages
    // strategy: 4 error tool messages pruned to 3, but the assistant still has
    // all 4 tool_calls.
    const compacted = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "err_1", type: "function", function: { name: "executar_comando", arguments: "{}" } },
          { id: "err_2", type: "function", function: { name: "executar_comando", arguments: "{}" } },
          { id: "err_3", type: "function", function: { name: "executar_comando", arguments: "{}" } },
          { id: "err_4", type: "function", function: { name: "executar_comando", arguments: "{}" } },
        ],
      },
      // Strategy kept first 3 errors, dropped err_4
      { role: "tool", tool_call_id: "err_1", content: "[ERROR] fail 1" },
      { role: "tool", tool_call_id: "err_2", content: "[ERROR] fail 2" },
      { role: "tool", tool_call_id: "err_3", content: "[ERROR] fail 3" },
    ];

    replaceHistory(compacted as any);
    const h = getHistory();

    // Bug C: without the fix, err_4 would be an orphan.
    expect(countOrphanToolCalls(h as any[])).toBe(0);

    // Verify synthetic tool result was injected for err_4
    const toolResults = h.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(4);
    const err4Result = toolResults.find((m: any) => m.tool_call_id === "err_4");
    expect(err4Result).toBeDefined();
    expect((err4Result as any).content).toContain("compaction");
  });

  it("replaceHistory does NOT inject synthetic results when there are no orphans", () => {
    // Sanity check: valid history should not be modified by the repair logic.
    const validHistory = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result 1" },
    ];

    replaceHistory(validHistory as any);
    const h = getHistory();

    expect(countOrphanToolCalls(h as any[])).toBe(0);
    // No synthetic tool results injected
    const toolResults = h.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(1);
    expect((toolResults[0] as any).content).toBe("result 1");
  });

  it("replaceHistory repairs multiple orphans across multiple assistant messages", () => {
    // Edge case: 2 separate assistant messages, each with orphan tool_calls.
    const compacted = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "task 1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "a1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          { id: "a2", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        ],
      },
      // Only a1 has a result; a2 is orphan
      { role: "tool", tool_call_id: "a1", content: "result a1" },
      { role: "user", content: "task 2" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "b1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          { id: "b2", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        ],
      },
      // Only b2 has a result; b1 is orphan
      { role: "tool", tool_call_id: "b2", content: "result b2" },
    ];

    replaceHistory(compacted as any);
    const h = getHistory();

    expect(countOrphanToolCalls(h as any[])).toBe(0);
    // Should have 4 tool results total (a1, a2, b1, b2)
    const toolResults = h.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(4);
    const ids = toolResults.map((m: any) => m.tool_call_id).sort();
    expect(ids).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("replaceHistory synthetic tool result is placed right after the owning assistant message", () => {
    // Verify the synthetic result is inserted in the correct position
    // (immediately after the assistant message that owns the orphan tool_call).
    const compacted = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "orphan_1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        ],
      },
      // No tool result for orphan_1 — pure orphan
      { role: "user", content: "next task" },
    ];

    replaceHistory(compacted as any);
    const h = getHistory();

    // The synthetic tool result should be at index 3 (right after assistant at index 2)
    expect(h[3].role).toBe("tool");
    expect((h[3] as any).tool_call_id).toBe("orphan_1");
    // The "next task" user message should now be at index 4 (shifted down)
    expect(h[4].role).toBe("user");
    expect(h[4].content).toBe("next task");
  });

  it("replaceHistory with empty array does NOT trigger orphan repair (no orphans)", () => {
    // Edge case: empty messages → just system prompt. No orphans to repair.
    replaceHistory([]);
    const h = getHistory();
    expect(h.length).toBe(1);
    expect(h[0].role).toBe("system");
  });

  it("loadHistoryDirect still repairs orphans with 'Session interrupted' message (BS-4 compat)", () => {
    // Verify the refactor (extracting repairOrphanToolCalls helper) didn't
    // break loadHistoryDirect's existing behavior. The synthetic tool result
    // must still contain "Session interrupted" (tested in blind-spots.test.ts).
    const messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "do task" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "bs4_call", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        ],
      },
      // No tool result — orphan (simulates terminal closed mid-tool-call)
    ];

    loadHistoryDirect(messages as any);
    const h = getHistory();

    expect(countOrphanToolCalls(h as any[])).toBe(0);
    const synthetic = h.find(
      (m: any) => m.role === "tool" && m.tool_call_id === "bs4_call"
    );
    expect(synthetic).toBeDefined();
    expect((synthetic as any).content).toContain("Session interrupted");
  });

  it("compactIntelligently → replaceHistory end-to-end: no orphans after compaction", async () => {
    // End-to-end: simulate what contextCompaction.smartCompact does.
    // 1. Build history with 3 consecutive tool messages (each from a tool_call).
    // 2. Run compactIntelligently (which merges them, creating orphans).
    // 3. Call replaceHistory with the compacted result.
    // 4. Verify no orphans remain (replaceHistory repaired them).
    const { compactIntelligently } = await import("../contextCompaction.js");

    // Set up history: assistant with 3 tool_calls, followed by 3 tool results
    addUserMessage("do 3 reads");
    addRawAssistantMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "tc_1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        { id: "tc_2", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        { id: "tc_3", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
      ],
    } as any);
    addToolResult("tc_1", "content 1");
    addToolResult("tc_2", "content 2");
    addToolResult("tc_3", "content 3");

    const beforeCompaction = getHistory();
    expect(countOrphanToolCalls(beforeCompaction as any[])).toBe(0); // no orphans initially

    // Run compactIntelligently — this merges the 3 tool results into 1,
    // creating 2 orphans (tc_2 and tc_3 lose their results).
    const { messages: compacted } = compactIntelligently(beforeCompaction as any);

    // Confirm compactIntelligently created orphans (proves the bug exists)
    const orphansBeforeReplace = countOrphanToolCalls(compacted as any[]);
    expect(orphansBeforeReplace).toBeGreaterThan(0);

    // Now call replaceHistory — should repair the orphans.
    replaceHistory(compacted as any);
    const afterReplace = getHistory();

    // Bug C: without the fix, this would be > 0 (orphans remain).
    expect(countOrphanToolCalls(afterReplace as any[])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Additional edge case tests for the focus areas
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2d — Edge cases: reloadProjectMemory + getLoadedMemoryFiles consistency", () => {
  it("getLoadedMemoryFiles returns the same files as reloadProjectMemory's output mentions", () => {
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "consistency check content");
        reloadProjectMemory();
        const files = getLoadedMemoryFiles();
        const reloadOutput = reloadProjectMemory();

        expect(files.length).toBe(1);
        expect(reloadOutput).not.toBeNull();
        // The reload output should mention the file's relativePath
        expect(reloadOutput).toContain(files[0]!.relativePath);
        expect(reloadOutput).toContain("consistency check content");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reloadProjectMemory after setCavemanLevel preserves caveman prefix in history[0]", () => {
    // setCavemanLevel updates history[0]. reloadProjectMemory should also
    // update history[0] but PRESERVE the caveman prefix (because getSystemPrompt
    // reads currentCavemanLevel).
    const dir = makeTempDir();
    try {
      withCwd(dir, () => {
        fs.writeFileSync(path.join(dir, "CLAUDE.md"), "caveman + memory combo");
        addUserMessage("init"); // ensures history is initialized
        setCavemanLevel("ultra");

        const promptBefore = getHistory()[0].content as string;
        expect(promptBefore).toContain("CAVEMAN MODE");
        expect(promptBefore).not.toContain("caveman + memory combo"); // memory not loaded yet

        reloadProjectMemory();
        const promptAfter = getHistory()[0].content as string;

        // Both caveman AND memory should be in history[0]
        expect(promptAfter).toContain("CAVEMAN MODE");
        expect(promptAfter).toContain("ultra");
        expect(promptAfter).toContain("caveman + memory combo");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Bug Hunter #2d — Edge cases: replaceHistory + tool_calls preservation", () => {
  it("replaceHistory preserves assistant tool_calls array structure", () => {
    // Verify the repair logic doesn't accidentally corrupt the existing tool_calls.
    const messages = [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "keep_1", type: "function", function: { name: "ler_arquivo", arguments: '{"path":"/a"}' } },
          { id: "keep_2", type: "function", function: { name: "ler_arquivo", arguments: '{"path":"/b"}' } },
        ],
      },
      { role: "tool", tool_call_id: "keep_1", content: "a content" },
      { role: "tool", tool_call_id: "keep_2", content: "b content" },
    ];

    replaceHistory(messages as any);
    const h = getHistory();

    // The assistant's tool_calls should be intact
    const asst = h.find((m) => m.role === "assistant") as any;
    expect(asst.tool_calls).toHaveLength(2);
    expect(asst.tool_calls[0].id).toBe("keep_1");
    expect(asst.tool_calls[1].id).toBe("keep_2");
    expect(asst.tool_calls[0].function.name).toBe("ler_arquivo");
    expect(asst.tool_calls[1].function.arguments).toBe('{"path":"/b"}');
  });

  it("replaceHistory does not duplicate tool results when called twice with same messages", () => {
    // Edge case: calling replaceHistory twice with the same orphan-containing
    // messages should not stack duplicate synthetic tool results.
    const messages = [
      { role: "system", content: "system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "dup_1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
        ],
      },
      // No tool result — orphan
    ];

    replaceHistory(messages as any);
    const h1 = getHistory();
    const toolCount1 = h1.filter((m) => m.role === "tool").length;
    expect(toolCount1).toBe(1); // synthetic injected

    // Call again — should RESET history, not append
    replaceHistory(messages as any);
    const h2 = getHistory();
    const toolCount2 = h2.filter((m) => m.role === "tool").length;
    expect(toolCount2).toBe(1); // still 1, not 2 (no duplication)
  });
});
