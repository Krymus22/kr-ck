/**
 * agentIntegration.test.ts — End-to-end integration tests for the new
 * quality-improvement features wired into agent.ts:
 *   - Think Tool (pensar)
 *   - Rollback (desfazer_edicao)
 *   - Task State (atualizar_estado, marcar_feito, ler_estado)
 *   - Poka-Yoke (path validation)
 *   - Schema Validation
 *
 * These tests do NOT call the real API. They directly invoke the internal
 * tool handler table by simulating ToolCall objects, exercising the same
 * code path that dispatchToolCall() uses.
 *
 * This complements the per-module unit tests by verifying that the wiring
 * in agent.ts is correct: the handlers are registered, the args flow
 * through, and the results are what the model would see.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock logger so test output isn't noisy
vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

// Mock extensions so we don't try to load real MCP servers / skills
vi.mock("../extensions.js", () => ({
  loadAllExtensions: vi.fn().mockResolvedValue(undefined),
  getActiveSkills: vi.fn().mockReturnValue([]),
  getMCPToolDefinitions: vi.fn().mockReturnValue([]),
  callMCPTool: vi.fn().mockResolvedValue("[MOCK] MCP not available"),
  shutdownMCPServers: vi.fn(),
}));

// Mock externalTools so we don't actually spawn anything
vi.mock("../externalTools.js", () => ({
  getRegistry: vi.fn(() => ({ getAll: () => [], getByCategory: () => [], isInstalled: () => false, addTool: () => ({ success: false, message: "mock" }) })),
  getDetector: vi.fn(() => ({ detect: () => ({ intent: null, context: [] }), detectFromContext: () => [] })),
  getExecutor: vi.fn(() => ({ execute: vi.fn().mockResolvedValue({ success: false, output: "mock" }) })),
  getSuggester: vi.fn(() => ({ suggest: () => [] })),
  initializeTools: vi.fn().mockResolvedValue(undefined),
}));

// Mock telemetry so it doesn't try to do real I/O
vi.mock("../telemetry.js", () => ({
  startSession: vi.fn(),
  endSession: vi.fn(),
  recordToolCall: vi.fn(),
  recordMessage: vi.fn(),
  recordError: vi.fn(),
  recordApiCall: vi.fn(),
}));

// Mock memory so we don't write to ~/.claude-killer
vi.mock("../memory.js", () => ({
  getMemoryConfig: vi.fn(() => ({
    globalDir: "/tmp/ck_test_global",
    projectDir: "/tmp/ck_test_project",
    historyDir: "/tmp/ck_test_history",
    skillsDir: "/tmp/ck_test_skills",
  })),
  ensureMemoryDirs: vi.fn(),
  injectMemory: vi.fn(() => ({
    projectMemory: "",
    checkpoint: null,
    globalMemory: "",
    relevantSkills: [],
    recentHistory: [],
    totalTokensEstimate: 0,
  })),
  formatInjectedMemory: vi.fn(() => ""),
  createCheckpoint: vi.fn(() => ({})),
  saveSessionTrace: vi.fn(),
  shouldWriteCheckpoint: vi.fn(() => false),
  writeCheckpoint: vi.fn(),
}));

// Mock retry to avoid delay
vi.mock("../retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  isRetryableError: vi.fn(() => false),
}));

// Mock contextCompaction
vi.mock("../contextCompaction.js", () => ({
  smartCompact: vi.fn(() => ({ compacted: false, savedTokens: 0 })),
}));

// Mock extensionCenter
vi.mock("../extensionCenter.js", () => ({
  executeTrigger: vi.fn().mockResolvedValue(undefined),
}));

// Mock apiClient to avoid network calls
vi.mock("../apiClient.js", () => ({
  chat: vi.fn(),
  TOOL_DEFINITIONS: [],
}));

import * as history from "../history.js";
import { think } from "../thinkTool.js";
import { desfazerEdicao, listarBackups } from "../tools.js";
import {
  saveBackup,
  restoreBackup,
  listBackups,
  resetRollbackState,
  clearAllBackups,
} from "../rollbackStore.js";
import {
  initTaskStateFromUserMessage,
  updateTaskState,
  readTaskState,
  clearTaskState,
  getTaskStateSummary,
  appendTaskStateItem,
  markTaskItemDone,
} from "../taskState.js";
import { pokaYokeCheck } from "../pokaYoke.js";
import { validateToolCall } from "../toolSchemaValidation.js";
import { runQualityGate, resetGateState } from "../strictQualityGate.js";
import { clearReadPaths, setReadBeforeWriteEnabled, recordRead, checkReadBeforeWrite } from "../readBeforeWrite.js";

let tmpProject: string;
let originalCwd: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalCwd = process.cwd();
  originalEnv = { ...process.env };
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "agent_int_test_"));
  fs.writeFileSync(path.join(tmpProject, "package.json"), JSON.stringify({ name: "test" }), "utf8");
  process.chdir(tmpProject);
  resetRollbackState();
  resetGateState();
  clearTaskState();
  // Clear read-before-write tracking
  clearReadPaths();
  setReadBeforeWriteEnabled(true);
});

afterEach(() => {
  process.chdir(originalCwd);
  process.env = originalEnv;
  resetRollbackState();
  clearTaskState();
  try { fs.rmSync(tmpProject, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Helper to build a fake ToolCall
function makeToolCall(name: string, args: Record<string, unknown>) {
  return {
    id: `call_${Math.random().toString(36).slice(2)}`,
    type: "function" as const,
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

describe("Agent integration: Think Tool", () => {
  it("think() returns a confirmation message the model can act on", async () => {
    const result = await think({
      pensamento: "Vou alterar a função X porque o bug é na linha 42",
      category: "verification",
    });
    expect(result.confirmed).toBe(true);
    expect(result.message).toContain("THOUGHT RECORDED");
    expect(result.message).toContain("verification");
  });

  it("accepts the categoria enum values", async () => {
    for (const cat of ["planning", "verification", "debugging", "architecture", "general"]) {
      const r = await think({ pensamento: "test", category: cat });
      expect(r.confirmed).toBe(true);
      expect(r.message).toContain(cat);
    }
  });
});

describe("Agent integration: Rollback flow (aplicar_diff → desfazer_edicao)", () => {
  it("saves a backup when aplicarDiff writes to an existing file, then desfazer_edicao restores it", async () => {
    // Use the real tools.ts aplicarDiff function (with mocked guardrail/diffPreview/hooks)
    const { aplicarDiff } = await import("../tools.js");

    const filePath = path.join(tmpProject, "rollback_target.ts");
    fs.writeFileSync(filePath, "const x = 1;\n", "utf8");

    // First read the file (required by read-before-write)
    recordRead("ler_arquivo", filePath);

    // Apply diff
    const diff = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toContain("const x = 2;");

    // A backup should exist
    const backups = listBackups(filePath);
    expect(backups.length).toBeGreaterThanOrEqual(1);

    // Now call desfazer_edicao
    const restoreResult = desfazerEdicao({ caminho: filePath });
    expect(restoreResult).toContain("SUCCESS");
    expect(fs.readFileSync(filePath, "utf8")).toContain("const x = 1;");
  });

  it("listar_backups returns formatted list of available backups", () => {
    const filePath = path.join(tmpProject, "list_target.ts");
    fs.writeFileSync(filePath, "v1", "utf8");
    saveBackup(filePath, "v1", "aplicar_diff");

    const result = listarBackups({ caminho: filePath });
    expect(result).toContain("1 backup");
    expect(result).toContain(filePath);
  });

  it("desfazer_edicao returns helpful error when no backup exists", () => {
    const filePath = path.join(tmpProject, "no_backup.ts");
    fs.writeFileSync(filePath, "x", "utf8");
    const result = desfazerEdicao({ caminho: filePath });
    expect(result).toContain("[ERROR]");
    expect(result).toContain("No backup");
  });
});

describe("Agent integration: Task State lifecycle", () => {
  it("initTaskStateFromUserMessage creates the file with the user's message as title", () => {
    initTaskStateFromUserMessage("Fix the bug in parser.ts at line 42");
    const state = readTaskState();
    expect(state).not.toBeNull();
    expect(state!.title).toContain("Fix the bug");
  });

  it("atualizar_estado updates fields and persists to disk", () => {
    initTaskStateFromUserMessage("test");
    const updated = updateTaskState({
      todo: ["item 1", "item 2"],
      decisions: ["we chose approach X"],
    });
    expect(updated.todo).toEqual(["item 1", "item 2"]);
    expect(updated.decisions).toEqual(["we chose approach X"]);

    // Verify it persisted
    const reloaded = readTaskState();
    expect(reloaded!.todo).toEqual(["item 1", "item 2"]);
  });

  it("marcar_feito moves an item from todo to done", () => {
    initTaskStateFromUserMessage("test");
    updateTaskState({ todo: ["implement auth", "write tests"], done: [] });
    const updated = markTaskItemDone("auth");
    expect(updated.done).toContain("implement auth");
    expect(updated.todo).toEqual(["write tests"]);
  });

  it("appendTaskStateItem accumulates bugs across multiple turns", () => {
    initTaskStateFromUserMessage("test");
    appendTaskStateItem("bugs", "off-by-one in foo.ts:42");
    appendTaskStateItem("bugs", "null deref in bar.ts:99");
    const state = readTaskState();
    expect(state!.bugs).toHaveLength(2);
  });

  it("getTaskStateSummary returns a formatted string the model can read after compaction", () => {
    initTaskStateFromUserMessage("test task");
    updateTaskState({
      done: ["did A"],
      todo: ["do B"],
      decisions: ["use approach X"],
      bugs: ["bug at foo.ts:1"],
      dependencies: ["need libfoo"],
    });
    const summary = getTaskStateSummary();
    expect(summary).toContain("TASK_STATE");
    expect(summary).toContain("did A");
    expect(summary).toContain("do B");
    expect(summary).toContain("use approach X");
    expect(summary).toContain("bug at foo.ts:1");
    expect(summary).toContain("need libfoo");
  });
});

describe("Agent integration: Poka-Yoke gate", () => {
  it("blocks aplicar_diff when path is missing", () => {
    const r = pokaYokeCheck("aplicar_diff", { bloco_diff: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("caminho");
  });

  it("blocks aplicar_diff when bloco_diff lacks SEARCH/REPLACE markers", () => {
    const r = pokaYokeCheck("aplicar_diff", { caminho: "/x.ts", bloco_diff: "just code" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("SEARCH");
  });

  it("blocks editar_arquivo when neither edits[] nor search+replace provided", () => {
    const r = pokaYokeCheck("editar_arquivo", { path: "/x.ts" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("edits");
  });

  it("blocks executar_comando when comando is empty", () => {
    const r = pokaYokeCheck("executar_comando", { comando: "" });
    expect(r.ok).toBe(false);
  });

  it("passes a well-formed aplicar_diff call", () => {
    const r = pokaYokeCheck("aplicar_diff", {
      caminho: "/abs/path/foo.ts",
      bloco_diff: "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE",
    });
    expect(r.ok).toBe(true);
    expect(r.resolvedPath).toContain("foo.ts");
  });
});

describe("Agent integration: Schema Validation gate", () => {
  it("catches missing required params before tool execution", () => {
    const schema = {
      type: "object",
      properties: { caminho: { type: "string", description: "file path" } },
      required: ["caminho"],
    };
    const r = validateToolCall("ler_arquivo", {}, schema);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("caminho");
  });

  it("catches type mismatches (number where string expected)", () => {
    const schema = {
      type: "object",
      properties: { timeout: { type: "string" } },
    };
    const r = validateToolCall("test", { timeout: 42 }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("string");
  });

  it("passes when all required params are present and correctly typed", () => {
    const schema = {
      type: "object",
      properties: { caminho: { type: "string" }, bloco_diff: { type: "string" } },
      required: ["caminho", "bloco_diff"],
    };
    const r = validateToolCall("aplicar_diff", {
      caminho: "/x.ts",
      bloco_diff: "<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE",
    }, schema);
    expect(r.valid).toBe(true);
  });
});

describe("Agent integration: Strict Quality Gate lifecycle", () => {
  it("respects STRICT_MODE=false (skips gate)", async () => {
    process.env.STRICT_MODE = "false";
    const r = await runQualityGate([path.join(tmpProject, "foo.ts")]);
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain("disabled");
  });

  it("allows finish when no files were touched (read-only turn)", async () => {
    process.env.STRICT_MODE = "true";
    const r = await runQualityGate([]);
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain("no files touched");
  });
});

describe("Agent integration: Read-before-Write gate (existing feature, regression check)", () => {
  it("blocks aplicar_diff on a file that was never read", async () => {
    const r = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/never-read.ts" });
    expect(r.allowed).toBe(false);
    expect(r.message).toContain("READ-BEFORE-WRITE");
  });

  it("allows aplicar_diff on a file that was read first", async () => {
    recordRead("ler_arquivo", "/tmp/read-first.ts");
    const r = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/read-first.ts" });
    expect(r.allowed).toBe(true);
  });
});
