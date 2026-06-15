/**
 * memory.test.ts — Tests for persistent memory system.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getMemoryConfig,
  ensureMemoryDirs,
  readProjectMemory,
  writeProjectMemory,
  appendProjectMemory,
  readCheckpoint,
  writeCheckpoint,
  readGlobalMemory,
  writeGlobalMemory,
  appendGlobalMemory,
  readNotes,
  writeNotes,
  appendNotes,
  saveSessionTrace,
  listSessionTraces,
  searchSessionTraces,
  saveSkill,
  listSkills,
  findMatchingSkills,
  injectMemory,
  formatInjectedMemory,
  runDream,
  runDistill,
  shouldWriteCheckpoint,
  createCheckpoint,
  type MemoryConfig,
  type SessionCheckpoint,
  type SessionTrace,
  type Skill,
  type FileChange,
} from "../memory.js";

// Use a temporary directory for all tests
const TEMP_DIR = path.join(os.tmpdir(), `claude-killer-memory-test-${Date.now()}`);
let testConfig: MemoryConfig;

beforeAll(() => {
  testConfig = getMemoryConfig(TEMP_DIR);
  ensureMemoryDirs(testConfig);
});

afterAll(() => {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  } catch {}
});

beforeEach(() => {
  // Clean up between tests
  try {
    const projectDir = testConfig.projectDir;
    if (fs.existsSync(projectDir)) {
      for (const f of fs.readdirSync(projectDir)) {
        if (f.endsWith(".md")) fs.unlinkSync(path.join(projectDir, f));
      }
    }
    const globalFile = path.join(testConfig.globalDir, "global.md");
    if (fs.existsSync(globalFile)) fs.unlinkSync(globalFile);

    const historyDir = testConfig.historyDir;
    if (fs.existsSync(historyDir)) {
      for (const f of fs.readdirSync(historyDir)) {
        if (f.endsWith(".json")) fs.unlinkSync(path.join(historyDir, f));
      }
    }
    const skillsDir = testConfig.skillsDir;
    if (fs.existsSync(skillsDir)) {
      for (const f of fs.readdirSync(skillsDir)) {
        if (f.endsWith(".json")) fs.unlinkSync(path.join(skillsDir, f));
      }
    }
  } catch {}
});

describe("getMemoryConfig", () => {
  it("should return correct config structure", () => {
    const config = getMemoryConfig("/tmp/test");
    expect(config.globalDir).toContain(".claude-killer");
    expect(config.globalDir).toContain("memory");
    expect(config.projectDir).toBe(path.join("/tmp/test", ".claude-killer"));
    expect(config.historyDir).toContain("history");
    expect(config.skillsDir).toContain("skills");
  });
});

describe("ensureMemoryDirs", () => {
  it("should create all required directories", () => {
    const testDir = path.join(TEMP_DIR, "test-dirs");
    const config = getMemoryConfig(testDir);
    ensureMemoryDirs(config);
    expect(fs.existsSync(config.globalDir)).toBe(true);
    expect(fs.existsSync(config.projectDir)).toBe(true);
    expect(fs.existsSync(config.historyDir)).toBe(true);
    expect(fs.existsSync(config.skillsDir)).toBe(true);
    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  });
});

describe("project memory", () => {
  it("should read empty project memory", () => {
    const content = readProjectMemory(testConfig);
    expect(content).toBe("");
  });

  it("should write and read project memory", () => {
    writeProjectMemory(testConfig, "# Project\n\nTest content");
    const content = readProjectMemory(testConfig);
    expect(content).toContain("Test content");
  });

  it("should append to project memory", () => {
    writeProjectMemory(testConfig, "# Initial");
    appendProjectMemory(testConfig, "New entry");
    const content = readProjectMemory(testConfig);
    expect(content).toContain("Initial");
    expect(content).toContain("New entry");
  });
});

describe("checkpoint", () => {
  it("should read null when no checkpoint exists", () => {
    const checkpoint = readCheckpoint(testConfig);
    expect(checkpoint).toBeNull();
  });

  it("should write and read checkpoint", () => {
    const checkpoint: SessionCheckpoint = {
      timestamp: "2026-06-15T10:00:00Z",
      sessionId: "test-session-1",
      taskTree: [],
      currentTask: "Fix bug in login",
      recentDecisions: [],
      fileChanges: [
        { path: "src/auth.ts", action: "modified", timestamp: "2026-06-15T09:50:00Z", summary: "Added JWT validation" },
      ],
      activeTools: ["ler_arquivo", "aplicar_diff"],
      contextSummary: "Working on auth module",
      projectMemorySnapshot: "",
    };

    writeCheckpoint(testConfig, checkpoint);
    const loaded = readCheckpoint(testConfig);

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("test-session-1");
    expect(loaded!.currentTask).toBe("Fix bug in login");
  });
});

describe("global memory", () => {
  it("should read empty global memory", () => {
    const content = readGlobalMemory(testConfig);
    expect(content).toBe("");
  });

  it("should write and read global memory", () => {
    writeGlobalMemory(testConfig, "# Preferences\n\nDark theme");
    const content = readGlobalMemory(testConfig);
    expect(content).toContain("Dark theme");
  });

  it("should append to global memory", () => {
    writeGlobalMemory(testConfig, "# Preferences");
    appendGlobalMemory(testConfig, "New preference");
    const content = readGlobalMemory(testConfig);
    expect(content).toContain("New preference");
  });
});

describe("notes", () => {
  it("should read empty notes", () => {
    const content = readNotes(testConfig);
    expect(content).toBe("");
  });

  it("should write and read notes", () => {
    writeNotes(testConfig, "# Notes\n\nSome notes");
    const content = readNotes(testConfig);
    expect(content).toContain("Some notes");
  });

  it("should append to notes", () => {
    writeNotes(testConfig, "# Notes");
    appendNotes(testConfig, "New note");
    const content = readNotes(testConfig);
    expect(content).toContain("New note");
  });
});

describe("session traces", () => {
  it("should save and list session traces", () => {
    const trace: SessionTrace = {
      id: "trace-1",
      startTime: "2026-06-15T10:00:00Z",
      endTime: "2026-06-15T10:05:00Z",
      summary: "Fixed login bug",
      decisions: ["Use bcrypt for passwords"],
      fileChanges: [{ path: "src/auth.ts", action: "modified", timestamp: "2026-06-15T10:02:00Z", summary: "Added bcrypt" }],
      toolsUsed: ["ler_arquivo", "aplicar_diff"],
      tokensUsed: 1500,
      messages: [
        { role: "user", content: "Fix the login bug", timestamp: "2026-06-15T10:00:00Z" },
        { role: "assistant", content: "I'll fix the login bug", timestamp: "2026-06-15T10:00:01Z" },
      ],
    };

    saveSessionTrace(testConfig, trace);
    const traces = listSessionTraces(testConfig);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces.some((t) => t.summary === "Fixed login bug")).toBe(true);
  });

  it("should search session traces by query", () => {
    const trace1: SessionTrace = {
      id: "trace-search-1",
      startTime: "2026-06-15T10:00:00Z",
      endTime: "2026-06-15T10:05:00Z",
      summary: "Fixed login bug with JWT",
      decisions: [],
      fileChanges: [],
      toolsUsed: ["ler_arquivo"],
      tokensUsed: 1000,
      messages: [],
    };

    const trace2: SessionTrace = {
      id: "trace-search-2",
      startTime: "2026-06-15T11:00:00Z",
      endTime: "2026-06-15T11:05:00Z",
      summary: "Refactored database module",
      decisions: [],
      fileChanges: [],
      toolsUsed: ["aplicar_diff"],
      tokensUsed: 1000,
      messages: [],
    };

    saveSessionTrace(testConfig, trace1);
    saveSessionTrace(testConfig, trace2);

    const results = searchSessionTraces(testConfig, "login");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].summary).toContain("login");
  });
});

describe("skills", () => {
  it("should save and list skills", () => {
    const skill: Skill = {
      id: "skill-1",
      name: "Auth Setup",
      description: "Set up authentication",
      trigger: "auth",
      steps: ["read auth.ts", "apply diff", "test"],
      createdAt: "2026-06-15T10:00:00Z",
      usageCount: 5,
    };

    saveSkill(testConfig, skill);
    const skills = listSkills(testConfig);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills.some((s) => s.name === "Auth Setup")).toBe(true);
  });

  it("should find matching skills by trigger", () => {
    const skill: Skill = {
      id: "skill-match-1",
      name: "Auth Workflow",
      description: "Complete auth setup",
      trigger: "authentication",
      steps: ["step1", "step2"],
      createdAt: "2026-06-15T10:00:00Z",
      usageCount: 3,
    };

    saveSkill(testConfig, skill);
    const matches = findMatchingSkills(testConfig, "authentication");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((s) => s.name === "Auth Workflow")).toBe(true);
  });
});

describe("injectMemory", () => {
  it("should return injected memory with zero tokens when empty", () => {
    const memory = injectMemory(testConfig);
    expect(memory.totalTokensEstimate).toBeGreaterThanOrEqual(0);
    expect(memory.projectMemory).toBeDefined();
    expect(memory.globalMemory).toBeDefined();
    expect(memory.recentHistory).toBeDefined();
    expect(memory.relevantSkills).toBeDefined();
  });

  it("should inject project memory", () => {
    writeProjectMemory(testConfig, "# Test Project\nImportant conventions");
    const memory = injectMemory(testConfig);
    expect(memory.projectMemory).toContain("Test Project");
  });
});

describe("formatInjectedMemory", () => {
  it("should format memory with project memory", () => {
    const memory = injectMemory(testConfig);
    const formatted = formatInjectedMemory(memory);
    expect(formatted).toContain("Estimated tokens:");
  });

  it("should format memory with checkpoint", () => {
    const checkpoint: SessionCheckpoint = {
      timestamp: "2026-06-15T10:00:00Z",
      sessionId: "test",
      taskTree: [],
      currentTask: "Test task",
      recentDecisions: [],
      fileChanges: [],
      activeTools: [],
      contextSummary: "Summary",
      projectMemorySnapshot: "",
    };
    writeCheckpoint(testConfig, checkpoint);

    const memory = injectMemory(testConfig);
    const formatted = formatInjectedMemory(memory);
    expect(formatted).toContain("Session Checkpoint");
    expect(formatted).toContain("Test task");
  });
});

describe("shouldWriteCheckpoint", () => {
  it("should return true at 20% context usage", () => {
    expect(shouldWriteCheckpoint(25600)).toBe(true); // 20% of 128000
  });

  it("should return true at 45% context usage", () => {
    expect(shouldWriteCheckpoint(57600)).toBe(true); // 45% of 128000
  });

  it("should return true at 70% context usage", () => {
    expect(shouldWriteCheckpoint(89600)).toBe(true); // 70% of 128000
  });

  it("should return false at 30% context usage", () => {
    expect(shouldWriteCheckpoint(38400)).toBe(false); // 30% of 128000
  });

  it("should return false at 10% context usage", () => {
    expect(shouldWriteCheckpoint(12800)).toBe(false); // 10% of 128000
  });
});

describe("createCheckpoint", () => {
  it("should create a checkpoint from messages", () => {
    const messages = [
      { role: "user", content: "Fix the login bug" },
      { role: "assistant", content: "I'll read the auth file first" },
      { role: "user", content: "Ok, continue" },
    ];

    const fileChanges: FileChange[] = [
      { path: "src/auth.ts", action: "modified", timestamp: "2026-06-15T10:00:00Z", summary: "Added validation" },
    ];

    const checkpoint = createCheckpoint("session-1", messages, fileChanges, ["ler_arquivo", "aplicar_diff"]);

    expect(checkpoint.sessionId).toBe("session-1");
    expect(checkpoint.currentTask).toBe("Ok, continue"); // extractCurrentTask gets the most recent user message
    expect(checkpoint.activeTools).toEqual(["ler_arquivo", "aplicar_diff"]);
    expect(checkpoint.fileChanges).toHaveLength(1);
    expect(checkpoint.contextSummary).toContain("2 user messages");
  });

  it("should extract decisions from assistant messages", () => {
    const messages = [
      { role: "user", content: "How to handle auth?" },
      { role: "assistant", content: "Decidi usar JWT para autenticação." },
      { role: "assistant", content: "Vamos implementar bcrypt." },
    ];

    const checkpoint = createCheckpoint("session-2", messages, [], []);
    expect(checkpoint.recentDecisions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("dream", () => {
  it("should run dream without errors", async () => {
    const result = await runDream(testConfig);
    expect(result.reviewedSessions).toBeGreaterThanOrEqual(0);
    expect(typeof result.extractedSkills).toBe("number");
  });
});

describe("distill", () => {
  it("should run distill without errors", async () => {
    const result = await runDistill(testConfig);
    expect(result.skillsExtracted).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.skills)).toBe(true);
  });
});
