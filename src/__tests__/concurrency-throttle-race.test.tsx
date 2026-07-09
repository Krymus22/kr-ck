/**
 * concurrency-throttle-race.test.tsx — Race condition test for App.tsx's
 * streaming throttle.
 *
 * CONCURRENCY HAZARD UNDER TEST:
 *   The throttle schedules a trailing `setTimeout` flush when tokens arrive
 *   within the STREAM_FLUSH_INTERVAL (80ms) window. The question is:
 *
 *     "If the trailing setTimeout fires AFTER finalizeMessage has already
 *      replaced the streaming message with the finalized response
 *      (isStreaming=false), does the trailing flush overwrite it?"
 *
 *   Analysis of src/tui/App.tsx:
 *     - finalizeMessage calls clearTimeout(streamFlushTimerRef.current)
 *       (cancels pending timer).
 *     - If the timer has ALREADY fired (callback queued in the event loop),
 *       clearTimeout is a no-op — the callback WILL run.
 *     - The trailing flush's setMessages updater checks
 *       `if (updated[i].role === "assistant" && updated[i].isStreaming)`.
 *       After finalize, the message has isStreaming=false, so the updater
 *       is a no-op — it CANNOT overwrite the finalized response.
 *
 *   This test exercises that exact race: schedule the trailing flush, let
 *   it fire (callback queues setMessages), THEN call finalize, and verify
 *   the final rendered message is the finalized response — not the stale
 *   streaming snapshot.
 *
 * Strategy: mirror streaming-stress.test.tsx mocks. Use REAL timers with
 * controlled delays inside the runAgentLoop mock so the trailing flush
 * fires BEFORE runAgentLoop returns (which triggers finalizeMessage).
 * This deterministically reproduces the race without fake-timer
 * interference with React's rendering.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";

// ─── Mocks (espelham streaming-stress.test.tsx) ─────────────────────────────

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(), throttle: vi.fn(), success: vi.fn() },
  toolCall: vi.fn(), toolResult: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn(), throttle: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
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

vi.mock("../extensionCenter.js", () => ({
  getAllExtensions: vi.fn(() => []),
  getExtensionsByCategory: vi.fn(() => []),
  getHubSummary: vi.fn(() => ({ total: 0, enabled: 0, byCategory: {} })),
  toggleExtension: vi.fn(),
  getTriggerLabel: vi.fn(() => ""),
  getTriggerModes: vi.fn(() => []),
  cycleTriggerMode: vi.fn(),
  setTriggerMode: vi.fn(),
  getCategoryIcon: vi.fn(() => ""),
  discoverExtensions: vi.fn(),
  executeTrigger: vi.fn(() => Promise.resolve()),
  subscribeToHubChanges: vi.fn((_l: () => void) => () => {}),
  getHubVersion: vi.fn(() => 0),
}));

vi.mock("../modes.js", () => ({
  getAllModes: vi.fn(() => []),
  getActiveModeName: vi.fn(() => null),
  getActiveMode: vi.fn(() => null),
  getMode: vi.fn(() => null),
  applyMode: vi.fn(async () => ({ success: true })),
  deactivateMode: vi.fn(),
  subscribeToModesChanges: vi.fn((_l: () => void) => () => {}),
  getModesVersion: vi.fn(() => 0),
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
  formatPoolStats: vi.fn(() => ""),
}));

vi.mock("../i18n.js", () => ({
  getLocalizedSlashCommands: vi.fn(() => []),
  getCommandI18n: vi.fn(() => ({})),
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
  historySummary: vi.fn(() => ""),
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

vi.mock("../gracefulShutdown.js", () => ({ registerShutdownHandlers: vi.fn() }));
vi.mock("../configSeeder.js", () => ({ seedUserConfig: vi.fn() }));
vi.mock("../toolUpdater.js", () => ({ performUpdateCheck: vi.fn(async () => ({})) }));
vi.mock("../readBeforeWrite.js", () => ({ clearReadPaths: vi.fn() }));

// Import AFTER mocks
import { runAgentLoop } from "../agent.js";
import { App } from "../tui/App.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("CONCURRENCY — streaming throttle race (trailing flush vs finalizeMessage)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runAgentLoop).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("trailing setTimeout fires AFTER finalizeMessage — finalized response is NOT overwritten", async () => {
    // REAL timers (not fake) so React processes state updates normally.
    // The trailing flush has an 80ms window (STREAM_FLUSH_INTERVAL). We:
    //   1. Call onToken twice (first triggers immediate flush, second
    //      schedules the trailing flush).
    //   2. Wait 150ms inside runAgentLoop — the trailing flush FIRES at
    //      ~80ms, queuing a setMessages that writes staleStreamContent.
    //   3. runAgentLoop returns finalizedResponse — finalizeMessage runs,
    //      queues a setMessages that writes finalizedResponse with
    //      isStreaming=false.
    //   4. React processes both updaters in order: trailing flush first
    //      (writes stale, isStreaming still true), then finalize (writes
    //      finalizedResponse, isStreaming=false).
    // The final rendered message MUST be finalizedResponse.
    const finalizedResponse = "FINALIZED_RESPONSE_NOT_OVERWRITTEN";
    const staleStreamContent = "STALE_STREAM_SNAPSHOT";

    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, onUsage) => {
        onStreamStart?.();
        // First token: immediate flush (sinceLast is huge, lastStreamFlush=0).
        onToken?.(staleStreamContent);
        // Second token: within 80ms window → schedules trailing flush.
        onToken?.(staleStreamContent);
        // Wait 150ms — trailing flush fires at ~80ms, queuing setMessages.
        // This is the race: the trailing flush fires BEFORE runAgentLoop
        // returns, so its setMessages is queued before finalize's.
        await delay(150);
        onUsage?.({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        return finalizedResponse;
      },
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("race");
    await delay(50);
    stdin.write("\r");
    // Wait for runAgentLoop (150ms) + finalize + React re-render.
    await delay(500);

    const out = stripAnsi(lastFrame() ?? "");

    // ─── The critical assertion ─────────────────────────────────────────
    // The finalized response MUST be visible — the trailing flush's
    // setMessages (queued before finalize's) must NOT have overwritten it.
    // React processes updaters in order: trailing flush writes stale
    // (isStreaming=true), then finalize writes finalizedResponse
    // (isStreaming=false). Final state = finalizedResponse.
    expect(out).toContain(finalizedResponse);
    expect(out).toContain("Claude-Killer"); // App didn't crash
  });

  it("finalizeMessage cancels pending trailing flush (no late fire when timer was still pending)", async () => {
    // Complementary scenario: the trailing flush timer has NOT yet fired
    // when finalizeMessage runs. finalizeMessage's clearTimeout cancels
    // it. The finalized response is shown, and the stale snapshot is NOT
    // written by a late fire.
    const finalizedResponse = "CANCELLED_TIMER_FINALIZE";
    const staleStreamContent = "PENDING_FLUSH_SNAPSHOT";

    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, _onThinking, onUsage) => {
        onStreamStart?.();
        onToken?.(staleStreamContent);
        onToken?.(staleStreamContent);
        // Return IMMEDIATELY — the trailing flush timer is still pending
        // (hasn't fired yet, < 80ms). finalizeMessage's clearTimeout
        // cancels it.
        onUsage?.({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
        return finalizedResponse;
      },
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("cancel");
    await delay(50);
    stdin.write("\r");
    // Wait well past the 80ms trailing-flush window. The timer was
    // cancelled by finalizeMessage, so it must NOT fire.
    await delay(400);

    const out = stripAnsi(lastFrame() ?? "");

    expect(out).toContain(finalizedResponse);
    expect(out).toContain("Claude-Killer");
  });

  it("multiple streams in one turn: each finalize cancels its own trailing flush", async () => {
    // Two streams in one agent turn (e.g., after a tool call). Each stream
    // schedules its own trailing flush. finalizeMessage (called once at the
    // end) must cancel the LAST pending flush and write the final response.
    const finalResponse = "MULTI_STREAM_FINAL";

    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, onThinking, onUsage) => {
        // Stream 1
        onStreamStart?.();
        onToken?.("stream1-content");
        onThinking?.(); // cancels stream 1's trailing flush
        // Stream 2 (after tool call)
        onStreamStart?.();
        onToken?.("stream2-content");
        onThinking?.(); // cancels stream 2's trailing flush
        onUsage?.({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
        return finalResponse;
      },
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("multi");
    await delay(50);
    stdin.write("\r");
    await delay(400);

    const out = stripAnsi(lastFrame() ?? "");

    // The final response must be visible — not stale content from either
    // stream's trailing flush.
    expect(out).toContain(finalResponse);
    expect(out).toContain("Claude-Killer");
  });

  it("trailing flush scheduled but stream ends quickly — final content matches finalized response", async () => {
    // Edge case: a single token arrives, scheduling a trailing flush.
    // The stream ends immediately (onThinking). onStreamEnd cancels the
    // trailing flush and does a final flush. Then finalizeMessage runs.
    // The final rendered message must be the finalized response.
    const finalizedResponse = "QUICK_STREAM_FINAL";

    vi.mocked(runAgentLoop).mockImplementation(
      async (_input, onStreamStart, onToken, onThinking, onUsage) => {
        onStreamStart?.();
        onToken?.("partial");
        onThinking?.(); // stream ends — cancels trailing flush
        onUsage?.({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 });
        return finalizedResponse;
      },
    );

    const { stdin, lastFrame } = render(<App />);
    stdin.write("quick");
    await delay(50);
    stdin.write("\r");
    await delay(400);

    const out = stripAnsi(lastFrame() ?? "");

    expect(out).toContain(finalizedResponse);
    expect(out).toContain("Claude-Killer");
  });
});
