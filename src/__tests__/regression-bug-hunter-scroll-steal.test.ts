/**
 * regression-bug-hunter-scroll-steal.test.ts
 *
 * Bug Hunter: scroll stealing during streaming (3rd attempt to fix).
 *
 * ROOT CAUSE (found on 3rd investigation):
 *   The previous fixes (throttle STREAM_FLUSH_INTERVAL = 80ms, banner moved
 *   to process.stdout.write, Static/Live split with <Static>) didn't address
 *   the actual root cause: logger.info / logger.warn / logger.error and
 *   direct console.log calls (CHECKPOINT, COMPACTION, BUG_HUNTER, COMPACT)
 *   were writing to stdout/stderr BETWEEN Ink renders. Each write caused the
 *   terminal to scroll, snapping the user's scroll position back to the top
 *   of the live view.
 *
 * FIX:
 *   1. logger.ts: gate ALL console output functions (info, warn, error,
 *      success, banner, divider, throttle, debug, statusBar) by tuiMode.
 *      Previously only reply / toolCall / toolResult were gated.
 *   2. history.ts: convert direct console.log / console.warn / console.error
 *      / console.debug calls to log.* (which is now gated).
 *   3. contextCompaction.ts: remove the direct console.log "[COMPACTION]
 *      Auto-compacting..." (the activityTracker already shows
 *      "Compactando contexto…" via ThinkingIndicator).
 *   4. bugHunter.ts: convert console.log "[BUG_HUNTER_TEST]..." to log.info.
 *
 * §17 COMPLIANCE:
 *   - §17.2.6 (STREAM_FLUSH_INTERVAL = 80ms): unchanged.
 *   - §17.2.7 (MIN_LIVE_MESSAGES = 4): unchanged.
 *   - §17.2.9 (banner fora da live view): unchanged — the banner is still
 *     printed via process.stdout.write BEFORE Ink renders (see index.ts).
 *     logger.banner() is now also gated (it was never called in production
 *     anyway — the pre-printed banner in index.ts uses process.stdout.write
 *     directly).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { debug: true }, // enable debug so log.debug would call console.debug if not gated
}));

import {
  banner,
  info,
  success,
  warn,
  error,
  throttle,
  debug,
  divider,
  statusBar,
  setTuiMode,
  _resetTuiModeForTests,
  type StatusBarInput,
} from "../logger.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let debugSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  _resetTuiModeForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetTuiModeForTests();
});

describe("Bug Hunter: scroll stealing during streaming — logger gated by tuiMode", () => {
  const baseStatusBarInput: StatusBarInput = {
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
    contextWindow: 128000,
    warnThreshold: 0.7,
    compactThreshold: 0.9,
    costPerKPrompt: 0.001,
    costPerKCompletion: 0.002,
  };

  it("TUI mode OFF: all logger functions write to console (backwards compat)", () => {
    setTuiMode(false);
    banner("banner");
    info("info");
    success("success");
    warn("warn");
    error("error");
    throttle("throttle");
    debug("debug"); // config.debug = true in this test file
    divider();
    statusBar(baseStatusBarInput);
    // Each function should call its respective console method at least once
    expect(logSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalled();
  });

  it("TUI mode ON: NO logger function writes to console (scroll-steal fix)", () => {
    setTuiMode(true);
    banner("banner");
    info("info");
    success("success");
    warn("warn");
    error("error");
    throttle("throttle");
    debug("debug");
    divider();
    statusBar(baseStatusBarInput);
    // CRITICAL: in TUI mode, NO console output should happen — otherwise
    // the terminal scrolls and steals the user's scroll position during
    // streaming.
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("regression: log.info([CHECKPOINT]...) does NOT write to stdout in TUI mode", () => {
    // This is the EXACT call pattern from agent.ts line 1461:
    //   log.info(`[CHECKPOINT] Triggering checkpoint ${checkpointNum} at ~${currentTokens} tokens`)
    // Before the fix, this wrote to stdout BETWEEN Ink renders, causing the
    // terminal to scroll during streaming.
    setTuiMode(true);
    info("[CHECKPOINT] Triggering checkpoint 1 at ~33000 tokens");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("regression: log.info([COMPACTION]...) does NOT write to stdout in TUI mode", () => {
    // From contextCompaction.ts and history.ts: compaction messages were
    // written to stdout during streaming, causing scroll steal.
    setTuiMode(true);
    info("[COMPACTION] Context at 90000 tokens (threshold 83200) — compacting");
    info("[COMPACT] Generating LLM-based summary...");
    info("[COMPACT] LLM summary generated successfully.");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("regression: log.warn([BUG_HUNTER]...) does NOT write to stderr in TUI mode", () => {
    // From bugHunter.ts: BUG_HUNTER warnings were written to stderr during
    // streaming. Most terminals display stderr inline with stdout, causing
    // the same scroll-steal effect.
    setTuiMode(true);
    warn("[BUG_HUNTER] Found 2 critical/high bug(s) — BLOCKING finish");
    warn("[BUG_HUNTER] ✗ [CRITICAL] src/foo.ts:42 — null pointer deref");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("regression: log.error([SESSION]...) does NOT write to stderr in TUI mode", () => {
    // From history.ts:1591 — session persistence errors were written to
    // stderr. In TUI mode, these should be surfaced via the chat (setMessages
    // with isError=true), not via console.error.
    setTuiMode(true);
    error("[SESSION] Failed to persist message: disk full");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("regression: log.debug([COMPACT]...) does NOT write to stderr in TUI mode", () => {
    // From history.ts — debug messages were written via console.debug.
    // Even though config.debug must be true for log.debug to fire, when it
    // does fire in TUI mode it should be suppressed.
    setTuiMode(true);
    debug("[COMPACT] Failed to re-hydrate files: ENOENT");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("regression: statusBar() does NOT write to stdout in TUI mode", () => {
    // logger.statusBar() writes 3+ lines to stdout (the context bar). In TUI
    // mode, the Ink StatusBar component renders this instead. The logger
    // version must be suppressed to avoid scroll steal.
    setTuiMode(true);
    statusBar(baseStatusBarInput);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe("Bug Hunter: scroll stealing — direct console.log calls converted to log.*", () => {
  // These tests verify that modules which previously called console.log /
  // console.warn / console.error directly now route through log.* (which is
  // gated by tuiMode). We do this by importing the module and checking that
  // the logger mock is called instead of console.* directly.

  // Note: full integration tests for history.ts / contextCompaction.ts /
  // bugHunter.ts already exist in their respective test files. These tests
  // focus on the specific scroll-steal regression: in TUI mode, these
  // modules must NOT write to stdout/stderr.

  it("history.ts: tryAppendToSession uses log.error (gated) instead of console.error", async () => {
    // Setup: mock session.appendMessage to throw, then call addUserMessage
    // (which calls tryAppendToSession internally). In TUI mode, log.error
    // should NOT call console.error.
    vi.doMock("../session.js", () => ({
      appendMessage: vi.fn(() => {
        throw new Error("disk full");
      }),
      appendCompactionSnapshot: vi.fn(),
      listSessions: vi.fn(() => []),
      loadSession: vi.fn(),
    }));
    vi.doMock("../extensions.js", () => ({ getActiveSkills: vi.fn(() => []) }));
    vi.doMock("../effortLevels.js", () => ({
      getEffortPromptSnippet: vi.fn(() => ""),
      shouldUseIntelligentCompaction: vi.fn(() => false),
      getEffortLevel: vi.fn(() => "medium"),
      setEffortLevel: vi.fn(),
      getEffortLabel: vi.fn(() => "MEDIUM"),
    }));
    vi.doMock("../patternExtractor.js", () => ({ getPatternsCached: vi.fn(() => "") }));

    const historyMod = await import("../history.js");
    setTuiMode(true);
    // addUserMessage calls tryAppendToSession → log.error (was console.error)
    expect(() => historyMod.addUserMessage("test")).not.toThrow();
    // CRITICAL: in TUI mode, console.error must NOT be called (was the bug).
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
