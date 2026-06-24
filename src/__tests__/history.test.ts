import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

const mockGetActiveSkills = vi.fn().mockReturnValue([]);
vi.mock("../extensions.js", () => ({
  getActiveSkills: (...args: any[]) => mockGetActiveSkills(...args),
}));

import {
  isPlanMode,
  setPlanMode,
  getCavemanLevel,
  setCavemanLevel,
  addUserMessage,
  addRawAssistantMessage,
  addToolResult,
  addSystemMessage,
  getHistory,
  historyLength,
  resetHistory,
  compactHistory,
  historySummary,
  estimateTokens,
  getSystemPrompt,
  reloadProjectMemory,
  optimizeContext,
} from "../history.js";

afterEach(() => {
  mockGetActiveSkills.mockReturnValue([]);
});

describe("Plan Mode", () => {
  beforeEach(() => {
    setPlanMode(false);
    resetHistory();
  });

  it("defaults to false", () => {
    expect(isPlanMode()).toBe(false);
  });

  it("toggles on and off", () => {
    setPlanMode(true);
    expect(isPlanMode()).toBe(true);
    setPlanMode(false);
    expect(isPlanMode()).toBe(false);
  });
});

describe("Caveman Level", () => {
  beforeEach(() => {
    setCavemanLevel(null);
    resetHistory();
  });

  it("defaults to null", () => {
    expect(getCavemanLevel()).toBeNull();
  });

  it("sets and gets level", () => {
    setCavemanLevel("ultra");
    expect(getCavemanLevel()).toBe("ultra");
  });

  it("clears level", () => {
    setCavemanLevel("lite");
    setCavemanLevel(null);
    expect(getCavemanLevel()).toBeNull();
  });
});

describe("History", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("starts with system prompt", () => {
    expect(historyLength()).toBe(1);
    expect(getHistory()[0].role).toBe("system");
  });

  it("adds user messages", () => {
    addUserMessage("hello");
    expect(historyLength()).toBe(2);
    expect(getHistory()[1].role).toBe("user");
  });

  it("resets properly", () => {
    addUserMessage("msg1");
    addUserMessage("msg2");
    resetHistory();
    expect(historyLength()).toBe(1);
  });

  it("summary shows role counts", () => {
    addUserMessage("hello");
    const summary = historySummary();
    expect(summary).toContain("system:1");
    expect(summary).toContain("user:1");
  });
});

describe("Token estimation", () => {
  it("returns positive number", () => {
    const tokens = estimateTokens([{ role: "user", content: "hello world" }]);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates proportional to content length", () => {
    const short = estimateTokens([{ role: "user", content: "hi" }]);
    const longContent = "a".repeat(1000);
    const long = estimateTokens([{ role: "user", content: longContent }]);
    expect(long).toBeGreaterThan(short);
  });
});

describe("compactHistory", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns null when history is short", () => {
    addUserMessage("msg");
    const result = compactHistory();
    expect(result).toBeNull();
  });

  it("compacts when history is long", () => {
    for (let i = 0; i < 15; i++) {
      addUserMessage(`message ${i}`);
    }
    const beforeCount = historyLength();
    const result = compactHistory();
    expect(result).not.toBeNull();
    expect(result!.removed).toBeGreaterThan(0);
    expect(historyLength()).toBeLessThan(beforeCount);
  });
});

describe("History - Extended", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("addRawAssistantMessage stores raw message", () => {
    const msg = { role: "assistant", content: "hi", tool_calls: [] };
    addRawAssistantMessage(msg as any);
    expect(historyLength()).toBe(2);
    expect(getHistory()[1].role).toBe("assistant");
  });

  it("addToolResult stores tool result with call id", () => {
    addUserMessage("test");
    addToolResult("call_123", "result content");
    const h = getHistory();
    expect(h.length).toBe(3);
    expect(h[2].role).toBe("tool");
    expect((h[2] as any).tool_call_id).toBe("call_123");
  });

  it("addSystemMessage adds system message", () => {
    addSystemMessage("injected system msg");
    const h = getHistory();
    expect(h.length).toBe(2);
    expect(h[1].role).toBe("system");
    expect(h[1].content).toBe("injected system msg");
  });

  it("getSystemPrompt includes base prompt", () => {
    const prompt = getHistory()[0].content as string;
    expect(prompt.length).toBeGreaterThan(0);
    expect(typeof prompt).toBe("string");
  });

  it("setCavemanLevel updates existing system prompt", () => {
    addUserMessage("msg"); // triggers ensureHistoryInitialized
    setCavemanLevel("ultra");
    const sysContent = getHistory()[0].content as string;
    expect(sysContent).toContain("CAVEMAN MODE");
    expect(sysContent).toContain("ultra");
  });

  it("estimateTokens counts tool_calls JSON", () => {
    const messages = [
      { role: "assistant", content: "text", tool_calls: [{ id: "1", type: "function", function: { name: "fn", arguments: "{}" } }] }
    ];
    const tokens = estimateTokens(messages as any);
    expect(tokens).toBeGreaterThan(0);
  });

  it("compactHistory drops orphan tool messages", () => {
    addUserMessage("msg0");
    addUserMessage("msg1");
    addUserMessage("msg2");
    addToolResult("orphan_call", "orphan result");
    // Now we have 5 messages: system + user + user + user + tool
    for (let i = 5; i < 15; i++) {
      addUserMessage(`msg${i}`);
    }
    const result = compactHistory();
    expect(result).not.toBeNull();
    // Orphan tool message should be removed
    const h = getHistory();
    const toolMsgs = h.filter(m => m.role === "tool");
    // All orphan tool messages should be cleaned up after compaction
    expect(toolMsgs.length).toBe(0);
  });

  it("historySummary includes all role counts", () => {
    addUserMessage("u1");
    addUserMessage("u2");
    addSystemMessage("sys1");
    const summary = historySummary();
    expect(summary).toContain("system:");
    expect(summary).toContain("user:");
  });

  it("resetHistory clears custom messages", () => {
    addUserMessage("before reset");
    resetHistory();
    expect(historyLength()).toBe(1);
  });
});

describe("optimizeContext", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("does nothing on short history", () => {
    addUserMessage("short");
    optimizeContext();
    expect(historyLength()).toBe(2);
  });

  it("summarizes read tool results when flow advanced", () => {
    addUserMessage("read file");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc1", "a".repeat(1000));
    addUserMessage("next task");
    optimizeContext();
    const h = getHistory();
    const toolMsg = h.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect((toolMsg as any).content).toContain("OMITIDO");
  });

  it("summarizes error messages when later success", () => {
    addUserMessage("run command");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc1", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc1", "[ERRO] something failed");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc2", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc2", "success output");
    addUserMessage("ok");
    optimizeContext();
    const h = getHistory();
    const toolMsgs = h.filter((m) => m.role === "tool");
    const errored = toolMsgs.find((m) => (m as any).content?.includes("ANTERIOR"));
    expect(errored).toBeDefined();
  });
});

describe("getSystemPrompt", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns a non-empty string", () => {
    const prompt = getSystemPrompt();
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes base instructions", () => {
    const prompt = getSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
  });
});

describe("reloadProjectMemory", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns null or string without errors", () => {
    const result = reloadProjectMemory();
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("getToolName edge cases", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns empty string when no assistant message has matching tool_call_id", () => {
    addUserMessage("start");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_real", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("call_real", "result");
    addUserMessage("next");
    // Add a tool result referencing a tool_call_id that doesn't exist in any assistant message
    addToolResult("call_nonexistent", "orphan result");
    const h = getHistory();
    // optimizeContext should not crash and should leave the orphan tool message intact
    // since getToolName returns "" and isReadTool("") is false
    const toolCountBefore = h.filter(m => m.role === "tool").length;
    optimizeContext();
    const h2 = getHistory();
    const toolCountAfter = h2.filter(m => m.role === "tool").length;
    // The orphan tool message should remain (no optimization applied)
    expect(toolCountAfter).toBe(toolCountBefore);
  });
});

describe("hasFlowAdvancedAfterIndex with aplicar_diff success", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns true when a future aplicar_diff tool result contains [SUCESSO]", () => {
    addUserMessage("read file");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_read", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc_read", "a".repeat(1000));
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_write", type: "function", function: { name: "aplicar_diff", arguments: "{}" } }],
    } as any);
    addToolResult("tc_write", "[SUCESSO] Diff aplicado");
    optimizeContext();
    const h = getHistory();
    const readTool = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_read");
    expect(readTool).toBeDefined();
    expect((readTool as any).content).toContain("OMITIDO");
  });
});

describe("hasErrorBeenOvercomeAfterIndex with same-tool success", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("replaces error when same tool succeeds later", () => {
    addUserMessage("run cmd");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_fail", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_fail", "[ERRO] Command failed");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_ok", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_ok", "success output");
    optimizeContext();
    const h = getHistory();
    const failedTool = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_fail");
    expect(failedTool).toBeDefined();
    expect((failedTool as any).content).toContain("ANTERIOR SUPERADO");
  });
});

describe("optimizeContext with mixed messages", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("optimizes read and error messages while leaving user/assistant untouched", () => {
    addUserMessage("do something");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc1", "a".repeat(1000));
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc2", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc2", "[ERRO] something broke");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc3", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc3", "fixed output");
    addUserMessage("next task");
    optimizeContext();
    const h = getHistory();
    const userMsgs = h.filter(m => m.role === "user");
    expect(userMsgs.length).toBe(2);
    expect(userMsgs[0].content).toBe("do something");
    expect(userMsgs[1].content).toBe("next task");
    const toolMsgs = h.filter(m => m.role === "tool");
    const readResult = toolMsgs.find(m => (m as any).tool_call_id === "tc1");
    expect((readResult as any).content).toContain("OMITIDO");
    const errorResult = toolMsgs.find(m => (m as any).tool_call_id === "tc2");
    expect((errorResult as any).content).toContain("ANTERIOR SUPERADO");
  });
});

describe("hasFlowAdvancedAfterIndex false path (line 371)", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns false when no future message advances flow", () => {
    addUserMessage("start");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_fail", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_fail", "[ERRO] failed");
    // No user message or aplicar_diff success after this - flow has NOT advanced
    optimizeContext();
    const h = getHistory();
    const errorTool = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_fail");
    // Error should NOT be optimized because hasFlowAdvancedAfterIndex returns false
    // AND hasErrorBeenOvercomeAfterIndex returns false (no same-tool success)
    expect(errorTool).toBeDefined();
    expect((errorTool as any).content).toBe("[ERRO] failed");
  });
});

describe("hasErrorBeenOvercomeAfterIndex false path (line 387)", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns false when no same-tool success exists after error", () => {
    addUserMessage("start");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_err", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_err", "[ERRO] failed");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_other", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc_other", "some read result");
    // No user message and no executar_comando success after error
    optimizeContext();
    const h = getHistory();
    const errorTool = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_err");
    expect(errorTool).toBeDefined();
    expect((errorTool as any).content).toBe("[ERRO] failed");
  });
});

describe("compactHistory with tool_calls (lines 311, 316-317)", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("preserves valid tool messages and removes orphans during compaction", () => {
    addUserMessage("msg0");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_valid", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc_valid", "valid result");
    addUserMessage("msg1");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_orphan", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc_orphan", "orphan result that will be dropped");
    // Add enough messages to trigger compaction
    for (let i = 2; i < 15; i++) {
      addUserMessage(`msg${i}`);
    }
    compactHistory();
    const h = getHistory();
    // tc_valid and tc_orphan assistant messages should be in the dropped portion
    // Their tool results should be removed as orphans
    const toolMsgs = h.filter(m => m.role === "tool");
    // After compaction, orphan tool messages should be cleaned up
    for (const tm of toolMsgs) {
      const tcId = (tm as any).tool_call_id;
      // Each remaining tool message should have a matching assistant tool_call
      const hasMatch = h.some(m =>
        m.role === "assistant" &&
        Array.isArray((m as any).tool_calls) &&
        (m as any).tool_calls.some((tc: any) => tc.id === tcId)
      );
      expect(hasMatch).toBe(true);
    }
  });

  it("removes orphan tool messages when assistant with tool_calls is in recent but orphan tool's assistant was dropped (lines 311, 316-317)", () => {
    // Build history so that after compaction:
    // - recent contains: assistant(tc_valid), tool(tc_valid), tool(tc_orphan)
    // - tc_orphan's matching assistant was dropped
    addUserMessage("msg0");
    addUserMessage("msg1");
    addUserMessage("msg2");
    addUserMessage("msg3");
    addUserMessage("msg4");
    // Now add assistant+tool that will be in recent
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_valid", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc_valid", "valid result content here");
    // Add an orphan tool whose assistant was already dropped (never added)
    addToolResult("tc_orphan", "orphan tool content here");
    addUserMessage("msg5");

    const result = compactHistory();
    expect(result).not.toBeNull();
    const h = getHistory();
    const toolMsgs = h.filter(m => m.role === "tool");
    // tc_orphan should be removed, tc_valid should remain
    const orphanStillPresent = toolMsgs.some((m: any) => m.tool_call_id === "tc_orphan");
    expect(orphanStillPresent).toBe(false);
    const validStillPresent = toolMsgs.some((m: any) => m.tool_call_id === "tc_valid");
    expect(validStillPresent).toBe(true);
  });
});

describe("hasFlowAdvancedAfterIndex false path (line 371)", () => {
  beforeEach(() => {
    resetHistory();
  });

  it("returns false when no future user or aplicar_diff success exists after read tool", () => {
    addUserMessage("read file");
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_read", type: "function", function: { name: "ler_arquivo", arguments: "{}" } }],
    } as any);
    addToolResult("tc_read", "a".repeat(1000));
    // Add only assistant+tool that is NOT aplicar_diff and NOT a user message after
    addRawAssistantMessage({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "tc_other", type: "function", function: { name: "executar_comando", arguments: "{}" } }],
    } as any);
    addToolResult("tc_other", "some output");

    optimizeContext();
    const h = getHistory();
    const readTool = h.find(m => m.role === "tool" && (m as any).tool_call_id === "tc_read");
    // hasFlowAdvancedAfterIndex returned false, so read tool content is NOT optimized
    expect(readTool).toBeDefined();
    expect((readTool as any).content).toBe("a".repeat(1000));
  });
});

describe("getSystemPrompt with skills (lines 169-180)", () => {
  beforeEach(() => {
    mockGetActiveSkills.mockReturnValue([]);
    setCavemanLevel(null);
    resetHistory();
  });

  it("renders skills and includes caveman reinforcement when skill name is caveman and level is active (lines 169-180)", () => {
    mockGetActiveSkills.mockReturnValue([
      {
        name: "caveman",
        description: "Caveman mode skill",
        path: "/fake/path",
        content: "Speak like caveman.",
      },
      {
        name: "other-skill",
        description: "Another skill",
        path: "/fake/other",
        content: "Do other things.",
      },
    ]);
    setCavemanLevel("ultra");
    // Sprint C: skills now inject only name+description, not full content
    const sysContent = getHistory()[0].content as string;
    expect(sysContent).toContain("## Available Skills");
    expect(sysContent).toContain("caveman");
    expect(sysContent).toContain("other-skill");
    // Full content is NOT injected anymore — IA reads via ler_arquivo
    expect(sysContent).not.toContain("--- START SKILL: caveman ---");
    expect(sysContent).not.toContain("Speak like caveman.");
  });

  it("ensureHistoryInitialized pushes system prompt when history is empty (line 206)", () => {
    resetHistory();
    const len = historyLength();
    addUserMessage("test");
    expect(historyLength()).toBe(len + 1);
    expect(getHistory()[len].role).toBe("user");
  });
});

describe("ensureHistoryInitialized with truly empty history (line 206)", () => {
  it("pushes system prompt when history starts empty", async () => {
    vi.resetModules();
    const freshHistory = await import("../history.js");
    const len = freshHistory.historyLength();
    expect(len).toBe(1);
    expect(freshHistory.getHistory()[0].role).toBe("system");
  });
});
