/**
 * regression-bug-hunter-2b-compaction.test.ts
 *
 * Regression tests for bugs found and fixed by Bug Hunter #2b
 * (Compaction modules: contextCompaction.ts, llmCompactor.ts,
 *  fileRehydration.ts, skillTracker.ts).
 *
 * Bugs covered:
 *   1. modelBasedCompactionAsync DROPPED PRESERVE_PREFIXES messages
 *      (TASK_STATE, [PLAN, [SESSION CONTINUATION], ## Recently Modified Files,
 *       ## Invoked Skills, etc.) when summarizing the oldest 70%.
 *      Violated BUSINESS_RULES.md §6.4 + §6.6 — all PRESERVE_PREFIXES must
 *      survive compaction. (contextCompaction.ts)
 *
 *   2. smartCompact never injected the 3 post-compaction messages required
 *      by §6.3 + §6.6:
 *        - [SESSION CONTINUATION] (Gap 2)
 *        - ## Recently Modified Files (Gap 1 — fileRehydration)
 *        - ## Invoked Skills (Gap 9 — skillTracker)
 *      Only the manual /compact path (compactHistoryAsync) injected them;
 *      the automatic pre-turn path (smartCompact) skipped them.
 *      (contextCompaction.ts)
 *
 *   3. remove-consecutive-same-role strategy MUTATED input message objects
 *      (prev.content += curr.content). The caller's array (live history or
 *      test fixtures) had its objects' content replaced in-place.
 *      (contextCompaction.ts)
 *
 *   4. renderMessageContent (private helper used by buildSummaryPrompt)
 *      DROPPED tool_calls when the assistant message had BOTH string
 *      content AND tool_calls. The summarizer therefore never saw which
 *      tools the agent called. (contextCompaction.ts)
 *
 *   5. fileRehydration.ts and skillTracker.ts loaded the ENTIRE file via
 *      fs.readFileSync before checking length / truncating. For huge files
 *      (100MB+ minified bundles, generated data) this caused OOM kills.
 *      Now both modules cap the read at a byte budget via fs.readSync.
 *      (fileRehydration.ts + skillTracker.ts)
 *
 * BUSINESS_RULES.md §17 compliance: no §17 rule was violated. The 9-section
 * prompt and "DIRECTLY QUOTE" anti-drift text are unchanged. Re-hydration
 * limits (5 files, 5k tokens/file, 50k total) and skill re-injection limits
 * (5k/skill, 25k total) are unchanged. PRESERVE_PREFIXES list unchanged.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Shared mocks (hoisted) ─────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
    setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

vi.mock("../config.js", () => ({
  config: {
    nvidiaApiKey: "test-key", nvidiaApiKeys: "", nvidiaApiKeysFile: "",
    nvidiaBaseUrl: "https://test.api.com/v1", model: "test-model",
    contextWindowTokens: 128000, contextWarnThreshold: 0.6,
    contextCompactThreshold: 0.65, costPerKPrompt: 0, costPerKCompletion: 0,
    maxHealRetries: 2, temperature: 0.6, topP: 0.9,
    maxTokens: 4096, diffPreview: false, rateLimitRpm: 1000, maxConcurrency: 1,
  },
}));

// Mock apiClient — chat is a vi.fn so each test can configure its return value.
const { chatMock, effortState, mockHistoryState } = vi.hoisted(() => ({
  chatMock: vi.fn(),
  effortState: { intelligent: false },
  mockHistoryState: {
    messages: [] as any[],
    tokens: 0,
    compactResult: null as any,
  },
}));

vi.mock("../apiClient.js", () => ({ chat: chatMock }));

vi.mock("../history.js", () => ({
  estimateTokens: vi.fn((msgs?: any) => {
    if (msgs !== undefined) {
      // Sum content lengths / 4 (mirrors real estimateTokens).
      let chars = 0;
      for (const m of msgs) {
        if (typeof m.content === "string") chars += m.content.length;
        if (Array.isArray(m.tool_calls)) chars += JSON.stringify(m.tool_calls).length;
      }
      return Math.max(1, Math.ceil(chars / 4));
    }
    return mockHistoryState.tokens;
  }),
  getHistory: vi.fn(() => mockHistoryState.messages),
  replaceHistory: vi.fn((m: any[]) => {
    mockHistoryState.messages = m;
    let chars = 0;
    for (const mm of m) {
      if (typeof mm.content === "string") chars += mm.content.length;
      if (Array.isArray(mm.tool_calls)) chars += JSON.stringify(mm.tool_calls).length;
    }
    mockHistoryState.tokens = Math.max(1, Math.ceil(chars / 4));
  }),
  compactHistory: vi.fn(() => mockHistoryState.compactResult),
  resetHistory: vi.fn(() => {
    mockHistoryState.messages = [];
    mockHistoryState.tokens = 0;
    mockHistoryState.compactResult = null;
  }),
}));

// Mock effortLevels — controlled per-test via the mutable flag above.
vi.mock("../effortLevels.js", () => ({
  shouldUseIntelligentCompaction: vi.fn(() => effortState.intelligent),
  getEffortLevel: vi.fn(() => "medium"),
  setEffortLevel: vi.fn(),
  getEffortLabel: vi.fn(() => "MEDIUM"),
  getEffortPromptSnippet: vi.fn(() => ""),
  shouldAutoGenerateTests: vi.fn(() => false),
  shouldUseSubAgents: vi.fn(() => false),
}));

// Mock session so any history.compactHistory snapshot path doesn't touch disk.
vi.mock("../session.js", () => ({
  appendMessage: vi.fn(),
  appendCompactionSnapshot: vi.fn(),
  getActiveSessionId: vi.fn(() => null),
  setActiveSession: vi.fn(),
}));

// ─── Imports AFTER mocks ───────────────────────────────────────────────────

import { compactIntelligently, smartCompact, strategies } from "../contextCompaction.js";
import {
  recordSessionFileEdit, buildRehydrationMessage, clearSessionFiles,
} from "../fileRehydration.js";
import {
  recordSkillInvocation, buildSkillReInjectionMessage, clearInvokedSkills,
} from "../skillTracker.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

function resetMockHistory(): void {
  mockHistoryState.messages = [];
  mockHistoryState.tokens = 0;
  mockHistoryState.compactResult = null;
}

/** Build a fake history with N user+assistant turns after a system prompt. */
function buildFakeHistory(n: number): any[] {
  const msgs: any[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "user", content: `user msg ${i} with enough text to be meaningful` });
    msgs.push({ role: "assistant", content: `assistant reply ${i} with enough text` });
  }
  return msgs;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bug 1: modelBasedCompactionAsync preserves PRESERVE_PREFIXES
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2b — Bug 1: modelBasedCompactionAsync preserves PRESERVE_PREFIXES", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockHistory();
    effortState.intelligent = true;
    // chat returns a valid summary (>50 chars) so model-based compaction succeeds
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "## User's Original Intent\n- Test summary with enough length to pass the 50 char minimum threshold." } }],
    } as any);
  });

  it("preserves '## TASK_STATE' system message in toSummarize range", async () => {
    // History: system, [TASK_STATE], 18 user/assistant turns (so cutoff > 1)
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "## TASK_STATE\nProject: TestProject with gacha system" },
      ...buildFakeHistory(18).slice(1),
    ];
    // Force token count high enough that smartCompact triggers and > 1.2x threshold
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasTaskState = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("## TASK_STATE")
    );
    expect(hasTaskState, "## TASK_STATE must survive model-based compaction (§6.6)").toBe(true);
  });

  it("preserves '[PLAN' system message (Gap 3)", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "[PLAN - 3 steps]\n1. Do X\n2. Do Y\n3. Do Z" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasPlan = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("[PLAN")
    );
    expect(hasPlan, "[PLAN must survive model-based compaction (§6.4)").toBe(true);
  });

  it("preserves '## Recently Modified Files' system message (Gap 1)", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "## Recently Modified Files (re-hydrated after compaction)\n/file.ts content" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasRehydration = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("## Recently Modified Files")
    );
    expect(hasRehydration, "## Recently Modified Files must survive model-based compaction (§6.6)").toBe(true);
  });

  it("preserves '## Invoked Skills' system message (Gap 9)", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "## Invoked Skills (re-injected after compaction)\n/skill.md content" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasSkills = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("## Invoked Skills")
    );
    expect(hasSkills, "## Invoked Skills must survive model-based compaction (§6.6)").toBe(true);
  });

  it("preserves '[SESSION CONTINUATION' system message (Gap 2)", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "[SESSION CONTINUATION] Previous session continuation message" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasContinuation = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("[SESSION CONTINUATION")
    );
    expect(hasContinuation, "[SESSION CONTINUATION must survive model-based compaction").toBe(true);
  });

  it("preserves '[CONVERSATION MEMORY' system message (accumulated summaries)", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "[CONVERSATION MEMORY - prev compaction]\nold summary" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasMemory = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("[CONVERSATION MEMORY")
    );
    expect(hasMemory, "[CONVERSATION MEMORY must survive (§6.4)").toBe(true);
  });

  it("preserves '## Persistent Memory' system message", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "system", content: "## Persistent Memory\nUser prefers tabs over spaces" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasMem = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("## Persistent Memory")
    );
    expect(hasMem, "## Persistent Memory must survive (§6.4)").toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug 2: smartCompact injects the 3 post-compaction messages
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2b — Bug 2: smartCompact injects 3 post-compaction messages (§6.3 + §6.6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockHistory();
    clearSessionFiles();
    clearInvokedSkills();
    // Use heuristic path (disable intelligent compaction) to isolate the
    // post-compaction injection logic from the model-based path.
    effortState.intelligent = false;
  });

  it("injects [SESSION CONTINUATION] after heuristic compaction succeeds", async () => {
    // Build history with consecutive assistant messages so remove-consecutive-same-role fires
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "a3" },
    ];
    mockHistoryState.tokens = 100000;

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasContinuation = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("[SESSION CONTINUATION")
    );
    expect(hasContinuation, "[SESSION CONTINUATION must be injected after compaction (§6.6)").toBe(true);
  });

  it("continuation message instructs IA not to ask user what to do", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    mockHistoryState.tokens = 100000;

    await smartCompact(10000);

    const contMsg = mockHistoryState.messages.find(
      (m) => typeof m.content === "string" && m.content.startsWith("[SESSION CONTINUATION")
    );
    expect(contMsg).toBeDefined();
    expect(contMsg!.content).toContain("do NOT ask the user");
    expect(contMsg!.content).toContain("Continue working");
  });

  it("injects [SESSION CONTINUATION] after aggressive compactHistory path", async () => {
    // Force the aggressive path: heuristic strategies don't apply (no compaction
    // triggers), but compactHistory returns a result so we mark compacted=true.
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      ...buildFakeHistory(10).slice(1),
    ];
    mockHistoryState.tokens = 100000;
    // compactHistory returns a non-null result (so smartCompact marks compacted=true)
    mockHistoryState.compactResult = {
      removed: 5, beforeTokens: 100000, afterTokens: 50000, method: "mechanical" as const,
    };

    const result = await smartCompact(10000);
    expect(result.compacted).toBe(true);

    const hasContinuation = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("[SESSION CONTINUATION")
    );
    expect(hasContinuation, "continuation injected even when compactHistory path runs").toBe(true);
  });

  it("injects ## Recently Modified Files when a session file was edited", async () => {
    // Create a temp file and record it as edited this session
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-bh2b-"));
    const tempFile = path.join(tempDir, "edited.ts");
    fs.writeFileSync(tempFile, "export const x = 1;\n", "utf8");
    try {
      recordSessionFileEdit(tempFile);

      mockHistoryState.messages = [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "a1" },
        { role: "assistant", content: "a2" },
      ];
      mockHistoryState.tokens = 100000;

      await smartCompact(10000);

      const hasRehydration = mockHistoryState.messages.some(
        (m) => typeof m.content === "string" && m.content.startsWith("## Recently Modified Files")
      );
      expect(hasRehydration, "## Recently Modified Files must be injected (§6.3 Gap 1)").toBe(true);
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("injects ## Invoked Skills when a skill was invoked this session", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-bh2b-skill-"));
    const skillFile = path.join(tempDir, "my-skill.md");
    fs.writeFileSync(skillFile, "# My Skill\n\ntest skill content\n", "utf8");
    try {
      recordSkillInvocation(skillFile);

      mockHistoryState.messages = [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "a1" },
        { role: "assistant", content: "a2" },
      ];
      mockHistoryState.tokens = 100000;

      await smartCompact(10000);

      const hasSkills = mockHistoryState.messages.some(
        (m) => typeof m.content === "string" && m.content.startsWith("## Invoked Skills")
      );
      expect(hasSkills, "## Invoked Skills must be injected (§6.3 Gap 9)").toBe(true);
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("does NOT inject [SESSION CONTINUATION] when no compaction occurred", async () => {
    // Under threshold — no compaction
    mockHistoryState.tokens = 100;
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hi" },
    ];

    const result = await smartCompact(50000);
    expect(result.compacted).toBe(false);

    const hasContinuation = mockHistoryState.messages.some(
      (m) => typeof m.content === "string" && m.content.startsWith("[SESSION CONTINUATION")
    );
    expect(hasContinuation, "should NOT inject continuation when no compaction").toBe(false);
  });

  it("is idempotent — does not double-inject continuation on second compaction", async () => {
    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    mockHistoryState.tokens = 100000;

    await smartCompact(10000);
    const firstCount = mockHistoryState.messages.filter(
      (m) => typeof m.content === "string" && m.content.startsWith("[SESSION CONTINUATION")
    ).length;
    expect(firstCount).toBe(1);

    // Add more consecutive assistants to trigger compaction again
    mockHistoryState.messages = [
      ...mockHistoryState.messages,
      { role: "assistant", content: "a3" },
      { role: "assistant", content: "a4" },
    ];
    mockHistoryState.tokens = 100000;

    await smartCompact(10000);
    const secondCount = mockHistoryState.messages.filter(
      (m) => typeof m.content === "string" && m.content.startsWith("[SESSION CONTINUATION")
    ).length;
    expect(secondCount, "continuation should not be double-injected").toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug 3: remove-consecutive-same-role does NOT mutate input messages
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2b — Bug 3: remove-consecutive-same-role does not mutate input", () => {
  it("does not mutate the content of input assistant messages", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ];
    // Snapshot original content values
    const originalContents = msgs.map((m) => (typeof m.content === "string" ? m.content : ""));

    compactIntelligently(msgs);

    // After compactIntelligently, the input array's message CONTENTS must be
    // unchanged (only the result array should contain merged content).
    expect(msgs[0].content).toBe(originalContents[0]);
    expect(msgs[1].content).toBe(originalContents[1]); // was "first", must still be "first"
    expect(msgs[2].content).toBe(originalContents[2]); // was "second", must still be "second"
  });

  it("does not mutate input when merging 3+ consecutive assistant messages", () => {
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "a3" },
    ];
    const originalContents = msgs.map((m) => m.content);

    const { messages: result } = compactIntelligently(msgs);

    // Result has merged content
    const assistants = result.filter((m) => m.role === "assistant");
    expect(assistants.length).toBe(1);
    expect(assistants[0].content).toContain("a1");
    expect(assistants[0].content).toContain("a2");
    expect(assistants[0].content).toContain("a3");

    // Input array's contents are unchanged
    expect(msgs[0].content).toBe(originalContents[0]);
    expect(msgs[1].content).toBe(originalContents[1]);
    expect(msgs[2].content).toBe(originalContents[2]);
    expect(msgs[3].content).toBe(originalContents[3]);
  });

  it("strategy.apply directly does not mutate input (single strategy test)", () => {
    const s = strategies.find((x) => x.name === "remove-consecutive-same-role")!;
    const msgs = [
      { role: "system", content: "p" },
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ];
    const result = s.apply(msgs);

    // Result has merged content
    expect(result.filter((m) => m.role === "assistant").length).toBe(1);
    expect(result[1].content).toBe("first\nsecond");

    // Input array's contents are unchanged
    expect(msgs[1].content).toBe("first");
    expect(msgs[2].content).toBe("second");
  });

  it("handles empty input array without producing [undefined]", () => {
    const s = strategies.find((x) => x.name === "remove-consecutive-same-role")!;
    const result = s.apply([]);
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug 4: renderMessageContent preserves tool_calls when content is a string
// (Tested indirectly by inspecting the prompt that modelBasedCompactionAsync
//  sends to chat().)
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2b — Bug 4: renderMessageContent preserves tool_calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockHistory();
    effortState.intelligent = true;
  });

  it("summary prompt includes tool_call names when assistant has both content and tool_calls", async () => {
    // chat returns a valid summary so modelBasedCompactionAsync completes
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "## User's Original Intent\n- summary long enough to pass the minimum length check for compaction." } }],
    } as any);

    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      {
        role: "assistant",
        content: "I will read the file now.",
        tool_calls: [{
          id: "call_1", type: "function",
          function: { name: "ler_arquivo", arguments: JSON.stringify({ path: "src/main.lua" }) },
        }],
      },
      { role: "tool", content: "file content here", tool_call_id: "call_1" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    await smartCompact(10000);

    expect(chatMock).toHaveBeenCalledTimes(1);
    const promptArg = chatMock.mock.calls[0][0] as any[];
    // The user message is the summary prompt — it should contain the tool_call name
    const userPrompt = promptArg.find((m) => m.role === "user")?.content ?? "";
    expect(userPrompt, "prompt must mention ler_arquivo tool_call").toContain("ler_arquivo");
    expect(userPrompt, "prompt must contain the assistant content").toContain("I will read the file now.");
  });

  it("summary prompt includes multiple tool_call names when assistant called several tools", async () => {
    chatMock.mockResolvedValue({
      choices: [{ message: { content: "## User's Original Intent\n- summary long enough to pass the minimum length check for compaction." } }],
    } as any);

    mockHistoryState.messages = [
      { role: "system", content: "system prompt" },
      {
        role: "assistant",
        content: "Running multiple tools.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "ler_arquivo", arguments: "{}" } },
          { id: "c2", type: "function", function: { name: "buscar_texto", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "r1", tool_call_id: "c1" },
      { role: "tool", content: "r2", tool_call_id: "c2" },
      ...buildFakeHistory(18).slice(1),
    ];
    mockHistoryState.tokens = 100000;

    await smartCompact(10000);

    const promptArg = chatMock.mock.calls[0][0] as any[];
    const userPrompt = promptArg.find((m) => m.role === "user")?.content ?? "";
    expect(userPrompt).toContain("ler_arquivo");
    expect(userPrompt).toContain("buscar_texto");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Bug 5: fileRehydration + skillTracker handle huge files without OOM
// ═══════════════════════════════════════════════════════════════════════════

describe("Bug Hunter #2b — Bug 5: fileRehydration handles huge files without OOM", () => {
  let tempDir: string;

  beforeEach(() => {
    clearSessionFiles();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-bh2b-huge-"));
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("truncates a huge file (5MB) without loading all of it into memory", () => {
    const hugeFile = path.join(tempDir, "huge.ts");
    // 5MB of repeated content — well above the 5K-token (20KB char) per-file budget
    const hugeContent = "// huge file\n" + "x".repeat(5 * 1024 * 1024);
    fs.writeFileSync(hugeFile, hugeContent, "utf8");

    recordSessionFileEdit(hugeFile);

    // This call should NOT cause OOM — it reads only the first ~80KB chunk
    const msg = buildRehydrationMessage();
    expect(msg).not.toBeNull();
    expect(msg).toContain("## Recently Modified Files");
    expect(msg).toContain("[TRUNCATED");
    // Resulting message should be bounded by the per-file budget + truncation marker
    // (well under 100KB, definitely not 5MB).
    expect(msg!.length).toBeLessThan(100_000);
  });

  it("skips a huge binary file (NUL byte in first chunk)", () => {
    const binaryFile = path.join(tempDir, "huge.bin");
    // 1MB of NUL bytes — binary, and huge
    const binaryContent = Buffer.alloc(1024 * 1024, 0);
    fs.writeFileSync(binaryFile, binaryContent);

    recordSessionFileEdit(binaryFile);

    const msg = buildRehydrationMessage();
    // Should be null because the only file is binary (skipped)
    expect(msg).toBeNull();
  });

  it("reads a small file in full (no truncation marker)", () => {
    const smallFile = path.join(tempDir, "small.ts");
    const smallContent = "export const x = 1;\n";
    fs.writeFileSync(smallFile, smallContent, "utf8");

    recordSessionFileEdit(smallFile);

    const msg = buildRehydrationMessage();
    expect(msg).not.toBeNull();
    expect(msg).toContain(smallContent);
    expect(msg).not.toContain("[TRUNCATED");
  });
});

describe("Bug Hunter #2b — Bug 5: skillTracker handles huge files without OOM", () => {
  let tempDir: string;

  beforeEach(() => {
    clearInvokedSkills();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-bh2b-skill-huge-"));
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("truncates a huge skill file (5MB) without loading all of it into memory", () => {
    const hugeSkill = path.join(tempDir, "huge-skill.md");
    const hugeContent = "# Huge Skill\n\n" + "x".repeat(5 * 1024 * 1024);
    fs.writeFileSync(hugeSkill, hugeContent, "utf8");

    recordSkillInvocation(hugeSkill);

    const msg = buildSkillReInjectionMessage();
    expect(msg).not.toBeNull();
    expect(msg).toContain("## Invoked Skills");
    expect(msg).toContain("[TRUNCATED");
    // Resulting message should be bounded, not 5MB
    expect(msg!.length).toBeLessThan(100_000);
  });

  it("skips a huge binary skill file (NUL byte)", () => {
    const binarySkill = path.join(tempDir, "binary.md");
    fs.writeFileSync(binarySkill, Buffer.alloc(1024 * 1024, 0));

    recordSkillInvocation(binarySkill);

    const msg = buildSkillReInjectionMessage();
    expect(msg).toBeNull();
  });
});
