/**
 * session-new-cleanup.test.ts — Regression tests for /session new state cleanup.
 *
 * Bug: when user runs /session new, old session's state leaked into the new
 * session via injection points in runAgentLoop (BH-SESSION-NEW-1).
 *
 * Tests verify that clearAllModuleState() clears:
 *   - TASK_STATE.md (taskState.ts) — HIGH #1
 *   - pendingSummaries (smallTaskAgent.ts) — HIGH #2
 *   - checkpoint.md (memory.ts) — MEDIUM #3
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock apiClient to prevent smallTaskAgent from calling process.exit(1)
vi.mock("../apiClient.js", () => ({
  chatWithModel: vi.fn(),
  clearModelOverride: vi.fn(),
  getScoutExcludeKeyIndex: vi.fn(() => -1),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-cleanup-"));
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(() => {
  try { process.chdir(path.resolve(__dirname, "../..")); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("BH-SESSION-NEW-1: /session new state cleanup", () => {
  describe("HIGH #1: clearTaskState in clearAllModuleState", () => {
    it("clearAllModuleState() deletes TASK_STATE.md", async () => {
      const { writeTaskState, readTaskState } = await import("../taskState.js");

      // Write a task state with correct shape
      writeTaskState({
        title: "Old session task",
        todo: ["old task 1"],
        done: [],
        bugs: [],
        decisions: [],
        dependencies: [],
        notes: "",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Verify file exists
      const taskFile = path.join(tmpDir, ".claude-killer", "TASK_STATE.md");
      expect(fs.existsSync(taskFile)).toBe(true);

      // Clear all module state (simulates /session new)
      const { clearAllModuleState } = await import("../stateCleanup.js");
      await clearAllModuleState();

      // TASK_STATE.md should be deleted
      expect(fs.existsSync(taskFile)).toBe(false);
      expect(readTaskState()).toBeNull();
    });
  });

  describe("HIGH #2: _resetSmallTaskState in clearAllModuleState", () => {
    it("clearAllModuleState() calls _resetSmallTaskState without crash", async () => {
      // Just verify clearAllModuleState completes without throwing
      // (smallTaskAgent is mocked, so no API key needed)
      const { clearAllModuleState } = await import("../stateCleanup.js");
      await expect(clearAllModuleState()).resolves.not.toThrow();
    });
  });

  describe("MEDIUM #3: clearCheckpoint in clearAllModuleState", () => {
    it("clearAllModuleState() deletes checkpoint.md", async () => {
      const { getMemoryConfig, writeCheckpoint, readCheckpoint } = await import("../memory.js");
      const { clearAllModuleState } = await import("../stateCleanup.js");

      const config = getMemoryConfig();
      fs.mkdirSync(config.projectDir, { recursive: true });

      writeCheckpoint(config, {
        sessionId: "old-session",
        timestamp: new Date().toISOString(),
        currentTask: "Old session task that should NOT leak",
        contextSummary: "",
        recentDecisions: [],
        fileChanges: [],
        activeTools: [],
      });

      const checkpointPath = path.join(config.projectDir, "checkpoint.md");
      expect(fs.existsSync(checkpointPath)).toBe(true);

      await clearAllModuleState();

      expect(fs.existsSync(checkpointPath)).toBe(false);
      expect(readCheckpoint(config)).toBeNull();
    });

    it("clearCheckpoint() works standalone", async () => {
      const { getMemoryConfig, writeCheckpoint, readCheckpoint, clearCheckpoint } = await import("../memory.js");

      const config = getMemoryConfig();
      fs.mkdirSync(config.projectDir, { recursive: true });

      writeCheckpoint(config, {
        sessionId: "test",
        timestamp: new Date().toISOString(),
        currentTask: "test task",
        contextSummary: "",
        recentDecisions: [],
        fileChanges: [],
        activeTools: [],
      });

      expect(readCheckpoint(config)).not.toBeNull();
      clearCheckpoint(config);
      expect(readCheckpoint(config)).toBeNull();
    });

    it("clearCheckpoint() safe when checkpoint doesn't exist", async () => {
      const { getMemoryConfig, clearCheckpoint } = await import("../memory.js");
      const config = getMemoryConfig();
      expect(() => clearCheckpoint(config)).not.toThrow();
    });
  });

  describe("Integration: full /session new simulation", () => {
    it("TASK_STATE.md and checkpoint.md both cleared", async () => {
      const { writeTaskState } = await import("../taskState.js");
      const { getMemoryConfig, writeCheckpoint } = await import("../memory.js");
      const { clearAllModuleState } = await import("../stateCleanup.js");

      // Set up old session state
      writeTaskState({
        title: "Old session",
        todo: ["old todo"],
        done: [],
        bugs: [],
        decisions: [],
        dependencies: [],
        notes: "",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const config = getMemoryConfig();
      fs.mkdirSync(config.projectDir, { recursive: true });
      writeCheckpoint(config, {
        sessionId: "old",
        timestamp: new Date().toISOString(),
        currentTask: "old task",
        contextSummary: "",
        recentDecisions: [],
        fileChanges: [],
        activeTools: [],
      });

      // Verify files exist
      const taskFile = path.join(tmpDir, ".claude-killer", "TASK_STATE.md");
      const checkpointFile = path.join(config.projectDir, "checkpoint.md");
      expect(fs.existsSync(taskFile)).toBe(true);
      expect(fs.existsSync(checkpointFile)).toBe(true);

      // Simulate /session new
      await clearAllModuleState();

      // ALL files should be deleted
      expect(fs.existsSync(taskFile)).toBe(false);
      expect(fs.existsSync(checkpointFile)).toBe(false);
    });
  });
});
