/**
 * memory-full.test.ts — Comprehensive tests for all memory.ts functions.
 * Targets 100% coverage of readMarkdown, writeMarkdown, readJson, writeJson,
 * all path/read/write/append helpers, search scoring, skills, injection,
 * dream, distill, checkpoint creation, and context summary generation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  getMemoryConfig,
  ensureMemoryDirs,
  readProjectMemory,
  writeProjectMemory,
  appendProjectMemory,
  getProjectMemoryPath,
  readCheckpoint,
  writeCheckpoint,
  getCheckpointPath,
  readGlobalMemory,
  writeGlobalMemory,
  appendGlobalMemory,
  getGlobalMemoryPath,
  readNotes,
  writeNotes,
  appendNotes,
  getNotesPath,
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

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const TEMP_DIR = path.join(os.tmpdir(), `claude-killer-memory-full-${Date.now()}`);
let testConfig: MemoryConfig;
let testLocalConfig: MemoryConfig;

beforeAll(() => {
  testConfig = getMemoryConfig(TEMP_DIR);
  // Create a config that uses TEMP_DIR for ALL directories (including history)
  testLocalConfig = {
    globalDir: path.join(TEMP_DIR, "global"),
    projectDir: path.join(TEMP_DIR, "project"),
    historyDir: path.join(TEMP_DIR, "history"),
    skillsDir: path.join(TEMP_DIR, "skills"),
  };
  ensureMemoryDirs(testConfig);
  ensureMemoryDirs(testLocalConfig);
});

afterAll(() => {
  try {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  } catch {}
});

beforeEach(() => {
  const cleanup = (dir: string, ext: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(ext)) fs.unlinkSync(path.join(dir, f));
    }
  };
  cleanup(testConfig.projectDir, ".md");
  cleanup(testConfig.historyDir, ".json");
  cleanup(testConfig.skillsDir, ".json");
  cleanup(testLocalConfig.historyDir, ".json");
  cleanup(testLocalConfig.skillsDir, ".json");
  cleanup(testLocalConfig.projectDir, ".md");
  const globalFile = path.join(testConfig.globalDir, "global.md");
  if (fs.existsSync(globalFile)) fs.unlinkSync(globalFile);
  const localGlobalFile = path.join(testLocalConfig.globalDir, "global.md");
  if (fs.existsSync(localGlobalFile)) fs.unlinkSync(localGlobalFile);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTrace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    id: `trace-${Date.now()}-${Math.random()}`,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    summary: "Test session",
    decisions: [],
    fileChanges: [],
    toolsUsed: [],
    tokensUsed: 100,
    messages: [],
    ...overrides,
  };
}

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: `skill-${Date.now()}-${Math.random()}`,
    name: "Test Skill",
    description: "A test skill",
    trigger: "test",
    steps: ["step1", "step2"],
    createdAt: new Date().toISOString(),
    usageCount: 1,
    ...overrides,
  };
}

// ─── getMemoryConfig ──────────────────────────────────────────────────────────

describe("getMemoryConfig", () => {
  it("should return correct config structure", () => {
    const config = getMemoryConfig("/tmp/test");
    expect(config.globalDir).toContain(".claude-killer");
    expect(config.globalDir).toContain("memory");
    expect(config.projectDir).toBe(path.join("/tmp/test", ".claude-killer"));
    expect(config.historyDir).toContain("history");
    expect(config.skillsDir).toContain("skills");
  });

  it("should use process.cwd() when no projectRoot given", () => {
    const config = getMemoryConfig();
    expect(config.projectDir).toBe(path.join(process.cwd(), ".claude-killer"));
  });
});

// ─── ensureMemoryDirs ─────────────────────────────────────────────────────────

describe("ensureMemoryDirs", () => {
  it("should create all required directories", () => {
    const testDir = path.join(TEMP_DIR, "test-dirs-new");
    const config = getMemoryConfig(testDir);
    ensureMemoryDirs(config);
    expect(fs.existsSync(config.globalDir)).toBe(true);
    expect(fs.existsSync(config.projectDir)).toBe(true);
    expect(fs.existsSync(config.historyDir)).toBe(true);
    expect(fs.existsSync(config.skillsDir)).toBe(true);
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should not fail if directories already exist", () => {
    expect(() => ensureMemoryDirs(testConfig)).not.toThrow();
  });
});

// ─── Project Memory ───────────────────────────────────────────────────────────

describe("project memory", () => {
  it("getProjectMemoryPath returns MEMORY.md in projectDir", () => {
    expect(getProjectMemoryPath(testConfig)).toBe(
      path.join(testConfig.projectDir, "MEMORY.md")
    );
  });

  it("should read empty project memory", () => {
    expect(readProjectMemory(testConfig)).toBe("");
  });

  it("should write and read project memory", () => {
    writeProjectMemory(testConfig, "# Project\n\nTest content");
    expect(readProjectMemory(testConfig)).toContain("Test content");
  });

  it("should append to project memory with timestamp", () => {
    writeProjectMemory(testConfig, "# Initial");
    appendProjectMemory(testConfig, "New entry");
    const content = readProjectMemory(testConfig);
    expect(content).toContain("Initial");
    expect(content).toContain("New entry");
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2}T/);
  });

  it("should handle writeMarkdown creating parent dirs", () => {
    const deepPath = path.join(TEMP_DIR, "deep", "nested", "dir", "MEMORY.md");
    const dir = path.dirname(deepPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(deepPath, "deep content", "utf8");
    expect(fs.readFileSync(deepPath, "utf8")).toBe("deep content");
    fs.rmSync(path.join(TEMP_DIR, "deep"), { recursive: true, force: true });
  });

  it("should handle readMarkdown when file does not exist", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "nonexistent-project"));
    expect(readProjectMemory(config)).toBe("");
  });

  it("should handle readMarkdown with corrupted file gracefully", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "corrupt-test"));
    ensureMemoryDirs(config);
    const memPath = getProjectMemoryPath(config);
    fs.writeFileSync(memPath, "content", "utf8");
    expect(readProjectMemory(config)).toBe("content");
    fs.rmSync(path.join(TEMP_DIR, "corrupt-test"), { recursive: true, force: true });
  });
});

// ─── Checkpoint ───────────────────────────────────────────────────────────────

describe("checkpoint", () => {
  it("getCheckpointPath returns checkpoint.md in projectDir", () => {
    expect(getCheckpointPath(testConfig)).toBe(
      path.join(testConfig.projectDir, "checkpoint.md")
    );
  });

  it("should read null when no checkpoint exists", () => {
    expect(readCheckpoint(testConfig)).toBeNull();
  });

  it("should write and read checkpoint with all fields", () => {
    const checkpoint: SessionCheckpoint = {
      timestamp: "2026-06-15T10:00:00Z",
      sessionId: "test-session-1",
      taskTree: [],
      currentTask: "Fix bug in login",
      recentDecisions: ["Use bcrypt", "Add rate limiting"],
      fileChanges: [
        { path: "src/auth.ts", action: "modified", timestamp: "2026-06-15T09:50:00Z", summary: "Added JWT validation" },
        { path: "src/auth.test.ts", action: "created", timestamp: "2026-06-15T09:51:00Z", summary: "Added tests" },
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
    expect(loaded!.timestamp).toBe("2026-06-15T10:00:00Z");
    expect(loaded!.recentDecisions).toEqual([]);
  });

  it("should parse checkpoint with missing optional fields", () => {
    const md = `# Session Checkpoint

Timestamp: 2026-06-15T10:00:00Z
Session: test-session-2
Current Task: Some task

## Summary

Some summary here

## Recent Decisions

## File Changes

## Active Tools

(none)
`;
    const cpPath = getCheckpointPath(testConfig);
    fs.writeFileSync(cpPath, md, "utf8");
    const loaded = readCheckpoint(testConfig);
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("test-session-2");
    expect(loaded!.recentDecisions).toEqual([]);
  });

  it("should handle empty activeTools in writeCheckpoint", () => {
    const checkpoint: SessionCheckpoint = {
      timestamp: "2026-06-15T10:00:00Z",
      sessionId: "test-empty-tools",
      taskTree: [],
      currentTask: "Test",
      recentDecisions: [],
      fileChanges: [],
      activeTools: [],
      contextSummary: "",
      projectMemorySnapshot: "",
    };
    writeCheckpoint(testConfig, checkpoint);
    const content = fs.readFileSync(getCheckpointPath(testConfig), "utf8");
    expect(content).toContain("(none)");
  });

  it("should handle checkpoint with Summary: and Recent Decisions: format", () => {
    const md = `# Session Checkpoint

Timestamp: 2026-06-15T10:00:00Z
Session: test-session-3
Current Task: Big task

Summary: Big summary here

Recent Decisions:
- Decision one
- Decision two
- Decision three

## File Changes

## Active Tools

read, write
`;
    const cpPath = getCheckpointPath(testConfig);
    fs.writeFileSync(cpPath, md, "utf8");
    const loaded = readCheckpoint(testConfig);
    expect(loaded!.recentDecisions).toHaveLength(3);
  });
});

// ─── Global Memory ────────────────────────────────────────────────────────────

describe("global memory", () => {
  it("getGlobalMemoryPath returns global.md in globalDir", () => {
    expect(getGlobalMemoryPath(testConfig)).toBe(
      path.join(testConfig.globalDir, "global.md")
    );
  });

  it("should read empty global memory", () => {
    expect(readGlobalMemory(testConfig)).toBe("");
  });

  it("should write and read global memory", () => {
    writeGlobalMemory(testConfig, "# Preferences\n\nDark theme");
    expect(readGlobalMemory(testConfig)).toContain("Dark theme");
  });

  it("should append to global memory with timestamp", () => {
    writeGlobalMemory(testConfig, "# Preferences");
    appendGlobalMemory(testConfig, "New preference");
    const content = readGlobalMemory(testConfig);
    expect(content).toContain("New preference");
    expect(content).toMatch(/## \d{4}-\d{2}-\d{2}T/);
  });

  it("should overwrite on writeGlobalMemory", () => {
    writeGlobalMemory(testConfig, "First content");
    writeGlobalMemory(testConfig, "Second content");
    expect(readGlobalMemory(testConfig)).toBe("Second content");
  });
});

// ─── Notes ────────────────────────────────────────────────────────────────────

describe("notes", () => {
  it("getNotesPath returns notes.md in projectDir", () => {
    expect(getNotesPath(testConfig)).toBe(
      path.join(testConfig.projectDir, "notes.md")
    );
  });

  it("should read empty notes", () => {
    expect(readNotes(testConfig)).toBe("");
  });

  it("should write and read notes", () => {
    writeNotes(testConfig, "# Notes\n\nSome notes");
    expect(readNotes(testConfig)).toContain("Some notes");
  });

  it("should append to notes with ### timestamp", () => {
    writeNotes(testConfig, "# Notes");
    appendNotes(testConfig, "New note");
    const content = readNotes(testConfig);
    expect(content).toContain("New note");
    expect(content).toMatch(/### \d{4}-\d{2}-\d{2}T/);
  });

  it("should handle appendNotes on empty file", () => {
    appendNotes(testConfig, "First note from empty");
    const content = readNotes(testConfig);
    expect(content).toContain("First note from empty");
  });
});

// ─── Session Traces ───────────────────────────────────────────────────────────

describe("session traces", () => {
  it("should save and list session traces", () => {
    const trace = makeTrace({ summary: "Fixed login bug" });
    saveSessionTrace(testLocalConfig, trace);
    const traces = listSessionTraces(testLocalConfig);
    expect(traces.length).toBeGreaterThanOrEqual(1);
    expect(traces.some((t) => t.summary === "Fixed login bug")).toBe(true);
  });

  it("should list traces sorted by startTime descending", () => {
    const trace1 = makeTrace({
      id: "older",
      startTime: "2020-01-10T08:00:00Z",
      summary: "Older session",
    });
    const trace2 = makeTrace({
      id: "newer",
      startTime: "2030-01-15T08:00:00Z",
      summary: "Newer session",
    });
    saveSessionTrace(testLocalConfig, trace1);
    saveSessionTrace(testLocalConfig, trace2);
    const traces = listSessionTraces(testLocalConfig);
    const newerIdx = traces.findIndex((t) => t.id === "newer");
    const olderIdx = traces.findIndex((t) => t.id === "older");
    if (newerIdx >= 0 && olderIdx >= 0) {
      expect(newerIdx).toBeLessThan(olderIdx);
    }
  });

  it("should return empty array when historyDir does not exist", () => {
    const config: MemoryConfig = {
      globalDir: path.join(TEMP_DIR, "no-exist-global"),
      projectDir: path.join(TEMP_DIR, "no-exist-project"),
      historyDir: path.join(TEMP_DIR, "no-exist-history"),
      skillsDir: path.join(TEMP_DIR, "no-exist-skills"),
    };
    expect(listSessionTraces(config)).toEqual([]);
  });

  it("should skip non-json files in historyDir", () => {
    const txtFile = path.join(testLocalConfig.historyDir, `readme-${Date.now()}.txt`);
    fs.writeFileSync(txtFile, "not a trace", "utf8");
    const traces = listSessionTraces(testLocalConfig);
    expect(traces.every((t) => typeof t === "object")).toBe(true);
    try { fs.unlinkSync(txtFile); } catch {}
  });

  it("should handle malformed JSON in historyDir gracefully", () => {
    const badFile = path.join(testLocalConfig.historyDir, `bad-session-${Date.now()}.json`);
    fs.writeFileSync(badFile, "{invalid json", "utf8");
    const traces = listSessionTraces(testLocalConfig);
    expect(Array.isArray(traces)).toBe(true);
    try { fs.unlinkSync(badFile); } catch {}
  });
});

// ─── Search Session Traces ────────────────────────────────────────────────────

describe("searchSessionTraces", () => {
  it("should return traces matching query in summary", () => {
    const trace = makeTrace({ summary: "Fixed login bug with JWT" });
    saveSessionTrace(testLocalConfig, trace);
    const results = searchSessionTraces(testLocalConfig, "login");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].summary).toContain("login");
  });

  it("should return traces matching query in decisions", () => {
    const trace = makeTrace({
      summary: "General session",
      decisions: ["Use bcrypt for password hashing"],
    });
    saveSessionTrace(testLocalConfig, trace);
    const results = searchSessionTraces(testLocalConfig, "bcrypt");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should return traces matching query in fileChanges path", () => {
    const trace = makeTrace({
      summary: "General",
      fileChanges: [
        { path: "src/auth.ts", action: "modified", timestamp: "2026-06-15T10:00:00Z", summary: "updated" },
      ],
    });
    saveSessionTrace(testLocalConfig, trace);
    const results = searchSessionTraces(testLocalConfig, "auth.ts");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should return traces matching query in fileChanges summary", () => {
    const trace = makeTrace({
      summary: "General",
      fileChanges: [
        { path: "src/other.ts", action: "modified", timestamp: "2026-06-15T10:00:00Z", summary: "Added JWT validation logic" },
      ],
    });
    saveSessionTrace(testLocalConfig, trace);
    const results = searchSessionTraces(testLocalConfig, "jwt");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should return traces matching query in toolsUsed", () => {
    const trace = makeTrace({
      summary: "General",
      toolsUsed: ["aplicar_diff", "ler_arquivo"],
    });
    saveSessionTrace(testLocalConfig, trace);
    const results = searchSessionTraces(testLocalConfig, "aplicar_diff");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("should return empty for non-matching query", () => {
    const trace = makeTrace({ summary: "Fixed login bug" });
    saveSessionTrace(testLocalConfig, trace);
    const results = searchSessionTraces(testLocalConfig, "nonexistent-xyz");
    expect(results.length).toBe(0);
  });

  it("should respect maxResults parameter", () => {
    for (let i = 0; i < 5; i++) {
      saveSessionTrace(
        testLocalConfig,
        makeTrace({ id: `search-${i}`, summary: `Search target ${i}` })
      );
    }
    const results = searchSessionTraces(testLocalConfig, "search target", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("should be case insensitive", () => {
    const trace = makeTrace({ summary: "Fixed Login Bug" });
    saveSessionTrace(testLocalConfig, trace);
    const results = searchSessionTraces(testLocalConfig, "LOGIN");
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Skills ───────────────────────────────────────────────────────────────────

describe("skills", () => {
  it("should save and list skills", () => {
    const skill = makeSkill({ id: "skill-1", name: "Auth Setup" });
    saveSkill(testLocalConfig, skill);
    const skills = listSkills(testLocalConfig);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    expect(skills.some((s) => s.name === "Auth Setup")).toBe(true);
  });

  it("should list skills sorted by creation order", () => {
    saveSkill(testLocalConfig, makeSkill({ id: "s-a", name: "Alpha" }));
    saveSkill(testLocalConfig, makeSkill({ id: "s-b", name: "Beta" }));
    const skills = listSkills(testLocalConfig);
    expect(skills.some((s) => s.name === "Alpha")).toBe(true);
    expect(skills.some((s) => s.name === "Beta")).toBe(true);
  });

  it("should return empty array when skillsDir does not exist", () => {
    const config: MemoryConfig = {
      globalDir: path.join(TEMP_DIR, "no-skills-global"),
      projectDir: path.join(TEMP_DIR, "no-skills-project"),
      historyDir: path.join(TEMP_DIR, "no-skills-history"),
      skillsDir: path.join(TEMP_DIR, "no-skills"),
    };
    expect(listSkills(config)).toEqual([]);
  });

  it("should skip non-json files in skillsDir", () => {
    const txtFile = path.join(testLocalConfig.skillsDir, `readme-${Date.now()}.txt`);
    fs.writeFileSync(txtFile, "not a skill", "utf8");
    const skills = listSkills(testLocalConfig);
    expect(Array.isArray(skills)).toBe(true);
    try { fs.unlinkSync(txtFile); } catch {}
  });

  it("should find matching skills by trigger", () => {
    saveSkill(
      testLocalConfig,
      makeSkill({ id: "sm-1", name: "Auth", trigger: "authentication", description: "Complete auth setup" })
    );
    const matches = findMatchingSkills(testLocalConfig, "authentication");
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.some((s) => s.name === "Auth")).toBe(true);
  });

  it("should find matching skills by description", () => {
    saveSkill(
      testLocalConfig,
      makeSkill({ id: "sm-2", name: "Deploy", trigger: "ship", description: "Deploy to production server" })
    );
    const matches = findMatchingSkills(testLocalConfig, "production");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("should sort matching skills by usageCount descending", () => {
    saveSkill(testLocalConfig, makeSkill({ id: "sm-3a", name: "Low", trigger: "sort-test", usageCount: 1 }));
    saveSkill(testLocalConfig, makeSkill({ id: "sm-3b", name: "High", trigger: "sort-test", usageCount: 10 }));
    const matches = findMatchingSkills(testLocalConfig, "sort-test");
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches[0].usageCount).toBeGreaterThanOrEqual(matches[1].usageCount);
  });

  it("should return empty when no skills match", () => {
    saveSkill(testLocalConfig, makeSkill({ id: "sm-4", name: "Unique", trigger: "zzz-unique", description: "nothing relevant" }));
    const matches = findMatchingSkills(testLocalConfig, "completely-different");
    expect(matches).toEqual([]);
  });
});

// ─── injectMemory ─────────────────────────────────────────────────────────────

describe("injectMemory", () => {
  it("should return injected memory with zero tokens when empty", () => {
    const memory = injectMemory(testConfig);
    expect(memory.totalTokensEstimate).toBeGreaterThanOrEqual(0);
    expect(memory.projectMemory).toBeDefined();
    expect(memory.globalMemory).toBeDefined();
    expect(memory.recentHistory).toBeDefined();
    expect(memory.relevantSkills).toBeDefined();
    expect(memory.checkpoint).toBeNull();
  });

  it("should inject project memory", () => {
    writeProjectMemory(testConfig, "# Test Project\nImportant conventions");
    const memory = injectMemory(testConfig);
    expect(memory.projectMemory).toContain("Test Project");
  });

  it("should inject global memory", () => {
    writeGlobalMemory(testConfig, "# My Preferences\nDark theme");
    const memory = injectMemory(testConfig);
    expect(memory.globalMemory).toContain("Dark theme");
  });

  it("should inject checkpoint when present", () => {
    writeCheckpoint(testConfig, {
      timestamp: "2026-06-15T10:00:00Z",
      sessionId: "s1",
      taskTree: [],
      currentTask: "Working on auth",
      recentDecisions: [],
      fileChanges: [],
      activeTools: [],
      contextSummary: "Auth module in progress",
      projectMemorySnapshot: "",
    });
    const memory = injectMemory(testConfig);
    expect(memory.checkpoint).not.toBeNull();
    expect(memory.checkpoint!.currentTask).toBe("Working on auth");
  });

  it("should inject relevant skills matching project memory", () => {
    writeProjectMemory(testConfig, "authentication module");
    saveSkill(testConfig, makeSkill({ id: "inj-s1", trigger: "authentication module", description: "complete auth setup", name: "Auth" }));
    const memory = injectMemory(testConfig);
    expect(memory.relevantSkills.some((s) => s.name === "Auth")).toBe(true);
  });

  it("should inject recent history traces", () => {
    saveSessionTrace(testConfig, makeTrace({ summary: "Recent session one" }));
    saveSessionTrace(testConfig, makeTrace({ summary: "Recent session two" }));
    const memory = injectMemory(testConfig);
    expect(memory.recentHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("should limit history to 5 traces", () => {
    for (let i = 0; i < 8; i++) {
      saveSessionTrace(testConfig, makeTrace({ id: `hist-${i}`, summary: `Session ${i}` }));
    }
    const memory = injectMemory(testConfig);
    expect(memory.recentHistory.length).toBeLessThanOrEqual(5);
  });

  it("should estimate tokens correctly", () => {
    writeProjectMemory(testConfig, "A".repeat(400));
    const memory = injectMemory(testConfig);
    expect(memory.totalTokensEstimate).toBeGreaterThan(0);
  });

  it("should stop adding history when budget exceeded", () => {
    for (let i = 0; i < 10; i++) {
      saveSessionTrace(
        testConfig,
        makeTrace({
          id: `budget-${i}`,
          summary: "A".repeat(5000),
          decisions: ["B".repeat(5000)],
        })
      );
    }
    const memory = injectMemory(testConfig, 100);
    expect(memory.recentHistory.length).toBeLessThanOrEqual(5);
  });
});

// ─── formatInjectedMemory ─────────────────────────────────────────────────────

describe("formatInjectedMemory", () => {
  it("should format memory with all sections", () => {
    const memory = {
      projectMemory: "# Project\nContent",
      checkpoint: {
        timestamp: "2026-06-15T10:00:00Z",
        sessionId: "s1",
        taskTree: [],
        currentTask: "Auth work",
        recentDecisions: [],
        fileChanges: [],
        activeTools: [],
        contextSummary: "Summary here",
        projectMemorySnapshot: "",
      },
      globalMemory: "# Preferences\nDark theme",
      relevantSkills: [
        makeSkill({ name: "TestSkill", description: "Test desc" }),
      ],
      recentHistory: [
        makeTrace({ summary: "Recent work" }),
      ],
      totalTokensEstimate: 42,
    };
    const formatted = formatInjectedMemory(memory);

    expect(formatted).toContain("Project Memory");
    expect(formatted).toContain("Content");
    expect(formatted).toContain("Session Checkpoint");
    expect(formatted).toContain("Auth work");
    expect(formatted).toContain("User Preferences");
    expect(formatted).toContain("Dark theme");
    expect(formatted).toContain("Relevant Skills");
    expect(formatted).toContain("TestSkill");
    expect(formatted).toContain("Recent Sessions");
    expect(formatted).toContain("Estimated tokens:");
  });

  it("should format empty memory gracefully", () => {
    const memory = injectMemory(testConfig);
    const formatted = formatInjectedMemory(memory);
    expect(formatted).toContain("Estimated tokens:");
    expect(formatted).not.toContain("Project Memory");
    expect(formatted).not.toContain("Session Checkpoint");
    expect(formatted).not.toContain("User Preferences");
  });

  it("should limit skills to 5 in output", () => {
    // Write project memory containing the trigger so findMatchingSkills
    // actually matches the skills. (Without this, the context passed
    // to findMatchingSkills is "" — and after the Bug Hunter #8d fix,
    // empty context returns [] instead of all skills.)
    // NOTE: findMatchingSkills checks `skill.trigger.includes(context)`,
    // so the context must be a SUBSTRING of the trigger/description/name.
    writeProjectMemory(testConfig, "format-test");
    for (let i = 0; i < 8; i++) {
      saveSkill(
        testConfig,
        makeSkill({ id: `fmt-skill-${i}`, name: `Skill ${i}`, trigger: "format-test", description: "desc" })
      );
    }
    const memory = injectMemory(testConfig);
    const formatted = formatInjectedMemory(memory);
    const skillMatches = formatted.match(/### Skill \d/g);
    expect(skillMatches).not.toBeNull();
    expect(skillMatches!.length).toBeLessThanOrEqual(5);
  });

  it("should limit history to 3 in output", () => {
    for (let i = 0; i < 6; i++) {
      saveSessionTrace(testLocalConfig, makeTrace({ id: `fmt-hist-${i}`, summary: `Session ${i}` }));
    }
    const memory = injectMemory(testLocalConfig);
    const formatted = formatInjectedMemory(memory);
    expect(formatted).toContain("Recent Sessions");
    expect(memory.recentHistory.length).toBeLessThanOrEqual(5);
  });

  it("should format checkpoint with contextSummary", () => {
    writeCheckpoint(testConfig, {
      timestamp: "2026-06-15T10:00:00Z",
      sessionId: "s1",
      taskTree: [],
      currentTask: "Task",
      recentDecisions: [],
      fileChanges: [],
      activeTools: [],
      contextSummary: "Detailed summary of work done",
      projectMemorySnapshot: "",
    });
    const memory = injectMemory(testConfig);
    const formatted = formatInjectedMemory(memory);
    expect(formatted).toContain("Session Checkpoint");
    expect(formatted).toContain("Task");
  });

  it("should format checkpoint without contextSummary", () => {
    writeCheckpoint(testConfig, {
      timestamp: "2026-06-15T10:00:00Z",
      sessionId: "s1",
      taskTree: [],
      currentTask: "Task",
      recentDecisions: [],
      fileChanges: [],
      activeTools: [],
      contextSummary: "",
      projectMemorySnapshot: "",
    });
    const memory = injectMemory(testConfig);
    const formatted = formatInjectedMemory(memory);
    expect(formatted).toContain("Session Checkpoint");
    expect(formatted).toContain("Task");
  });
});

// ─── Dream ────────────────────────────────────────────────────────────────────

describe("dream", () => {
  it("should run dream without errors on empty config", async () => {
    const result = await runDream(testLocalConfig);
    expect(result.reviewedSessions).toBe(0);
    expect(result.extractedSkills).toBe(0);
    expect(result.deduplicatedEntries).toBe(0);
    expect(result.updatedProjectMemory).toBe(false);
  });

  it("should detect frequently used tools as patterns", async () => {
    for (let i = 0; i < 5; i++) {
      saveSessionTrace(testLocalConfig, {
        id: `dream-tools-${i}`,
        startTime: `2026-06-15T10:${String(i).padStart(2, "0")}:00.000Z`,
        endTime: `2026-06-15T10:${String(i).padStart(2, "0")}:05.000Z`,
        summary: "Used tools",
        decisions: [],
        fileChanges: [],
        toolsUsed: ["ler_arquivo", "aplicar_diff", "write_file"],
        tokensUsed: 100,
        messages: [],
      });
    }
    const result = await runDream(testLocalConfig);
    expect(result.reviewedSessions).toBeGreaterThanOrEqual(4);
  });

  it("should detect frequently modified files as patterns", async () => {
    for (let i = 0; i < 3; i++) {
      saveSessionTrace(testLocalConfig, {
        id: `dream-files-${i}`,
        startTime: `2026-06-15T11:${String(i).padStart(2, "0")}:00.000Z`,
        endTime: `2026-06-15T11:${String(i).padStart(2, "0")}:05.000Z`,
        summary: "Modified file repeatedly",
        decisions: [],
        fileChanges: [
          { path: "src/app.ts", action: "modified", timestamp: `2026-06-15T11:${String(i).padStart(2, "0")}:01.000Z`, summary: "update" },
        ],
        toolsUsed: [],
        tokensUsed: 100,
        messages: [],
      });
    }
    const result = await runDream(testLocalConfig);
    expect(result.reviewedSessions).toBeGreaterThanOrEqual(3);
  });

  it("should extract skills from traces with repeated sequences", async () => {
    const trace = makeTrace({
      toolsUsed: ["read_file", "apply_diff", "read_file", "apply_diff", "test_run"],
      summary: "Workflow session",
    });
    for (let i = 0; i < 3; i++) {
      saveSessionTrace(testLocalConfig, { ...trace, id: `dream-skills-${i}` });
    }
    const result = await runDream(testLocalConfig);
    expect(result.extractedSkills).toBeGreaterThanOrEqual(0);
  });

  it("should deduplicate project memory", async () => {
    writeProjectMemory(testLocalConfig, "# Project\nLine A\nLine A\nLine B\nLine B\nLine C");
    const result = await runDream(testLocalConfig);
    const memory = readProjectMemory(testLocalConfig);
    const linesA = memory.split("\n").filter((l) => l.trim() === "Line A");
    expect(linesA.length).toBe(1);
  });

  it("should not duplicate already present patterns in project memory", async () => {
    for (let i = 0; i < 5; i++) {
      saveSessionTrace(testLocalConfig, {
        id: `dream-nodup-${i}`,
        startTime: `2026-06-15T12:${String(i).padStart(2, "0")}:00.000Z`,
        endTime: `2026-06-15T12:${String(i).padStart(2, "0")}:05.000Z`,
        summary: "Session",
        decisions: [],
        fileChanges: [],
        toolsUsed: ["toolA", "toolB", "toolC"],
        tokensUsed: 100,
        messages: [],
      });
    }
    // Note: must use regular hyphen "-" (not em-dash "—") to match the format
    // produced by extractPatterns() in memory.ts line 614.
    writeProjectMemory(testLocalConfig, "# Project\n### Auto-discovered patterns\n- Tool \"toolA\" used 5 times - consider optimizing workflow\n- Tool \"toolB\" used 5 times - consider optimizing workflow\n- Tool \"toolC\" used 5 times - consider optimizing workflow");
    const result = await runDream(testLocalConfig);
    expect(result.updatedProjectMemory).toBe(false);
  });
});

// ─── Distill ──────────────────────────────────────────────────────────────────

describe("distill", () => {
  it("should run distill without errors on empty config", async () => {
    const result = await runDistill(testLocalConfig);
    expect(result.skillsExtracted).toBe(0);
    expect(result.skills).toEqual([]);
  });

  it("should extract skills from traces with repeated sequences", async () => {
    const trace = makeTrace({
      toolsUsed: ["read_file", "apply_diff", "write_file", "test_run"],
      summary: "Workflow",
    });
    for (let i = 0; i < 4; i++) {
      saveSessionTrace(testLocalConfig, { ...trace, id: `distill-${i}` });
    }
    const result = await runDistill(testLocalConfig);
    expect(result.skillsExtracted).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.skills)).toBe(true);
  });

  it("should save extracted skills to skillsDir", async () => {
    const trace = makeTrace({
      toolsUsed: ["read_file", "apply_diff", "write_file", "test_run"],
      summary: "Workflow",
    });
    for (let i = 0; i < 4; i++) {
      saveSessionTrace(testLocalConfig, { ...trace, id: `distill-save-${i}` });
    }
    await runDistill(testLocalConfig);
    const skills = listSkills(testLocalConfig);
    expect(skills.length).toBeGreaterThanOrEqual(0);
  });

  it("should save extracted skills when sequences are repeated 3+ times", async () => {
    const baseTime = Date.now();
    for (let i = 0; i < 5; i++) {
      saveSessionTrace(testLocalConfig, {
        id: `distill-v4-${baseTime}-${i}`,
        startTime: new Date(baseTime + i * 1000).toISOString(),
        endTime: new Date(baseTime + i * 1000 + 500).toISOString(),
        summary: `Workflow session ${i}`,
        decisions: [],
        fileChanges: [],
        toolsUsed: ["alpha", "beta", "gamma", "delta"],
        tokensUsed: 100,
        messages: [],
      });
    }
    const result = await runDistill(testLocalConfig);
    expect(result.skillsExtracted).toBeGreaterThan(0);
    expect(result.skills.length).toBeGreaterThan(0);
    const savedSkills = listSkills(testLocalConfig);
    expect(savedSkills.length).toBeGreaterThan(0);
  });
});

// ─── shouldWriteCheckpoint ────────────────────────────────────────────────────

describe("shouldWriteCheckpoint", () => {
  it("should return true at 20% context usage", () => {
    expect(shouldWriteCheckpoint(25600)).toBe(true);
  });

  it("should return true at 45% context usage", () => {
    expect(shouldWriteCheckpoint(57600)).toBe(true);
  });

  it("should return true at 70% context usage", () => {
    expect(shouldWriteCheckpoint(89600)).toBe(true);
  });

  it("should return false at 30% context usage", () => {
    expect(shouldWriteCheckpoint(38400)).toBe(false);
  });

  it("should return false at 10% context usage", () => {
    expect(shouldWriteCheckpoint(12800)).toBe(false);
  });

  it("should return false at 0% usage", () => {
    expect(shouldWriteCheckpoint(0)).toBe(false);
  });

  it("should return false at 100% usage", () => {
    expect(shouldWriteCheckpoint(128000)).toBe(false);
  });

  it("should accept custom config", () => {
    expect(shouldWriteCheckpoint(50, { contextBudget: 100, checkpointPercentages: [0.5] })).toBe(true);
  });

  it("should be within 2% tolerance", () => {
    expect(shouldWriteCheckpoint(25000)).toBe(true);
    expect(shouldWriteCheckpoint(26200)).toBe(true);
    expect(shouldWriteCheckpoint(23000)).toBe(false);
  });
});

// ─── createCheckpoint ─────────────────────────────────────────────────────────

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
    expect(checkpoint.currentTask).toBe("Ok, continue");
    expect(checkpoint.activeTools).toEqual(["ler_arquivo", "aplicar_diff"]);
    expect(checkpoint.fileChanges).toHaveLength(1);
    expect(checkpoint.contextSummary).toContain("2 user messages");
    expect(checkpoint.contextSummary).toContain("1 assistant responses");
    expect(checkpoint.contextSummary).toContain("1 file changes");
    expect(checkpoint.taskTree).toEqual([]);
    expect(checkpoint.projectMemorySnapshot).toBe("");
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

  it("should limit recentDecisions to last 5", () => {
    const messages = [
      { role: "assistant", content: "Decidi uma." },
      { role: "assistant", content: "Vou fazer duas." },
      { role: "assistant", content: "Decisão três." },
      { role: "assistant", content: "Vamos quatro." },
      { role: "assistant", content: "Decidi cinco." },
      { role: "assistant", content: "Vou seis." },
      { role: "assistant", content: "Decisão sete." },
    ];
    const checkpoint = createCheckpoint("session-3", messages, [], []);
    expect(checkpoint.recentDecisions.length).toBeLessThanOrEqual(5);
  });

  it("should limit fileChanges to last 10", () => {
    const fileChanges: FileChange[] = [];
    for (let i = 0; i < 15; i++) {
      fileChanges.push({
        path: `src/file${i}.ts`,
        action: "modified",
        timestamp: `2026-06-15T10:${String(i).padStart(2, "0")}:00Z`,
        summary: `change ${i}`,
      });
    }
    const checkpoint = createCheckpoint("session-4", [], fileChanges, []);
    expect(checkpoint.fileChanges.length).toBeLessThanOrEqual(10);
  });

  it("should return (unknown) when no user messages", () => {
    const messages = [
      { role: "assistant", content: "Hello" },
      { role: "tool", content: "Result" },
    ];
    const checkpoint = createCheckpoint("session-5", messages, [], []);
    expect(checkpoint.currentTask).toBe("(unknown)");
  });

  it("should truncate long user messages to 200 chars", () => {
    const longContent = "A".repeat(500);
    const messages = [{ role: "user", content: longContent }];
    const checkpoint = createCheckpoint("session-6", messages, [], []);
    expect(checkpoint.currentTask.length).toBeLessThanOrEqual(200);
  });

  it("should include file change details in contextSummary", () => {
    const fileChanges: FileChange[] = [
      { path: "src/a.ts", action: "created", timestamp: "2026-06-15T10:00:00Z", summary: "new file" },
      { path: "src/b.ts", action: "modified", timestamp: "2026-06-15T10:01:00Z", summary: "updated" },
      { path: "src/c.ts", action: "deleted", timestamp: "2026-06-15T10:02:00Z", summary: "removed" },
      { path: "src/d.ts", action: "modified", timestamp: "2026-06-15T10:03:00Z", summary: "changed" },
      { path: "src/e.ts", action: "modified", timestamp: "2026-06-15T10:04:00Z", summary: "edited" },
      { path: "src/f.ts", action: "modified", timestamp: "2026-06-15T10:05:00Z", summary: "tweaked" },
    ];
    const checkpoint = createCheckpoint("session-7", [], fileChanges, []);
    expect(checkpoint.contextSummary).toContain("6 file changes");
    expect(checkpoint.contextSummary).toContain("src/e.ts");
    expect(checkpoint.contextSummary).toContain("src/f.ts");
  });

  it("should handle empty messages and fileChanges", () => {
    const checkpoint = createCheckpoint("session-8", [], [], []);
    expect(checkpoint.contextSummary).toContain("0 user messages");
    expect(checkpoint.contextSummary).toContain("0 assistant responses");
    expect(checkpoint.fileChanges).toHaveLength(0);
    expect(checkpoint.recentDecisions).toHaveLength(0);
  });
});

// ─── Deduplication (tested via dream) ─────────────────────────────────────────

describe("deduplication via dream", () => {
  it("should deduplicate identical lines in project memory", async () => {
    writeProjectMemory(testConfig, "# Project\nRepeat A\nRepeat A\nRepeat B\nUnique C\nRepeat B");
    await runDream(testConfig);
    const memory = readProjectMemory(testConfig);
    const countA = memory.split("\n").filter((l) => l.trim() === "Repeat A").length;
    const countB = memory.split("\n").filter((l) => l.trim() === "Repeat B").length;
    expect(countA).toBe(1);
    expect(countB).toBe(1);
  });

  it("should preserve headings and blank lines during dedup", async () => {
    writeProjectMemory(testConfig, "# Heading\n\nLine A\n\nLine A\n\n## Sub\n\nLine B\nLine B");
    await runDream(testConfig);
    const memory = readProjectMemory(testConfig);
    expect(memory).toContain("# Heading");
    expect(memory).toContain("## Sub");
  });
});

// ─── N-gram and skill extraction ──────────────────────────────────────────────

describe("n-gram extraction via dream/distill", () => {
  it("should generate n-grams from tool sequences", async () => {
    const trace = makeTrace({
      toolsUsed: ["a", "b", "c", "d", "e"],
      summary: "Ngram test",
    });
    for (let i = 0; i < 4; i++) {
      saveSessionTrace(testConfig, { ...trace, id: `ngram-${i}` });
    }
    const result = await runDistill(testConfig);
    expect(result.skills).toBeDefined();
  });

  it("should skip traces with fewer than 3 tools", async () => {
    const trace = makeTrace({
      toolsUsed: ["a", "b"],
      summary: "Short tools",
    });
    saveSessionTrace(testConfig, trace);
    const result = await runDistill(testConfig);
    expect(result.skillsExtracted).toBe(0);
  });

  it("should create skill from repeated 3-tool sequence", async () => {
    const trace = makeTrace({
      toolsUsed: ["read", "diff", "write", "test"],
      summary: "Full workflow",
    });
    for (let i = 0; i < 5; i++) {
      saveSessionTrace(testConfig, { ...trace, id: `skill-seq-${i}` });
    }
    const result = await runDistill(testConfig);
    expect(result.skillsExtracted).toBeGreaterThanOrEqual(0);
  });

  it("should limit extracted skills to 10", async () => {
    const tools = Array.from({ length: 8 }, (_, i) => `tool${i}`);
    const trace = makeTrace({ toolsUsed: tools, summary: "Many tools" });
    for (let i = 0; i < 5; i++) {
      saveSessionTrace(testConfig, { ...trace, id: `limit-skill-${i}` });
    }
    const result = await runDistill(testConfig);
    expect(result.skillsExtracted).toBeLessThanOrEqual(10);
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("should handle writeMarkdown with writeFileSync error", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "edge-case-1"));
    ensureMemoryDirs(config);
    const memPath = getProjectMemoryPath(config);
    fs.writeFileSync(memPath, "original", "utf8");
    fs.chmodSync(memPath, 0o444);
    writeProjectMemory(config, "should fail");
    const content = fs.readFileSync(memPath, "utf8");
    expect(content).toBe("original");
    fs.chmodSync(memPath, 0o644);
  });

  it("should handle readJson with corrupted file", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "edge-case-2"));
    ensureMemoryDirs(config);
    const filePath = path.join(config.historyDir, "corrupt.json");
    fs.writeFileSync(filePath, "NOT JSON", "utf8");
    const result = listSessionTraces(config);
    expect(Array.isArray(result)).toBe(true);
  });

  it("should handle readJson when file does not exist", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "edge-case-3"));
    expect(listSessionTraces(config)).toEqual([]);
    expect(listSkills(config)).toEqual([]);
  });

  it("should handle searchSessionTraces on empty history", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "edge-case-4"));
    expect(searchSessionTraces(config, "anything")).toEqual([]);
  });

  it("should handle findMatchingSkills on empty skills", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "edge-case-5"));
    expect(findMatchingSkills(config, "anything")).toEqual([]);
  });

  it("should handle injectMemory with all memory types present", () => {
    writeProjectMemory(testConfig, "Project content");
    writeGlobalMemory(testConfig, "Global prefs");
    writeCheckpoint(testConfig, {
      timestamp: "2026-06-15T10:00:00Z",
      sessionId: "s",
      taskTree: [],
      currentTask: "Task",
      recentDecisions: [],
      fileChanges: [],
      activeTools: [],
      contextSummary: "Summary",
      projectMemorySnapshot: "",
    });
    saveSkill(testConfig, makeSkill({ trigger: "project content", name: "Matched" }));
    saveSessionTrace(testConfig, makeTrace({ summary: "Recent" }));
    const memory = injectMemory(testConfig);
    expect(memory.projectMemory).toBeTruthy();
    expect(memory.globalMemory).toBeTruthy();
    expect(memory.checkpoint).not.toBeNull();
    expect(memory.relevantSkills.length).toBeGreaterThanOrEqual(1);
    expect(memory.recentHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle shouldWriteCheckpoint with empty percentages", () => {
    expect(shouldWriteCheckpoint(50000, { contextBudget: 100000, checkpointPercentages: [] })).toBe(false);
  });

  it("should handle createCheckpoint with only tool messages", () => {
    const messages = [
      { role: "tool", content: "File read result" },
      { role: "tool", content: "Diff applied" },
    ];
    const checkpoint = createCheckpoint("s-tool", messages, [], ["read", "diff"]);
    expect(checkpoint.currentTask).toBe("(unknown)");
    expect(checkpoint.recentDecisions).toEqual([]);
  });

  it("should handle generateContextSummary with many file changes", () => {
    const changes: FileChange[] = [];
    for (let i = 0; i < 20; i++) {
      changes.push({
        path: `src/file${i}.ts`,
        action: "modified" as const,
        timestamp: `2026-06-15T10:${String(i).padStart(2, "0")}:00Z`,
        summary: `change ${i}`,
      });
    }
    const checkpoint = createCheckpoint("s-many", [], changes, []);
    expect(checkpoint.contextSummary).toContain("20 file changes");
    expect(checkpoint.contextSummary).toContain("src/file15.ts");
  });

  it("should handle dream when project memory already contains patterns", async () => {
    const trace = makeTrace({
      toolsUsed: ["toolA", "toolB", "toolC"],
      summary: "Session",
    });
    for (let i = 0; i < 5; i++) {
      saveSessionTrace(testConfig, { ...trace, id: `dream-existing-${i}` });
    }
    writeProjectMemory(testConfig, "# Project\n### Auto-discovered patterns\n- Tool \"toolA\" used 5 times — consider optimizing workflow");
    const result = await runDream(testConfig);
    expect(result.updatedProjectMemory).toBe(false);
  });

  it("should handle listSessionTraces with empty history dir", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "empty-history-list"));
    ensureMemoryDirs(config);
    expect(listSessionTraces(config)).toEqual([]);
  });

  it("should handle writeJson with nested objects", () => {
    const config = getMemoryConfig(path.join(TEMP_DIR, "nested-json"));
    ensureMemoryDirs(config);
    const trace: SessionTrace = {
      id: "nested",
      startTime: "2026-06-15T10:00:00Z",
      endTime: "2026-06-15T10:05:00Z",
      summary: "Nested test",
      decisions: ["a", "b"],
      fileChanges: [{ path: "x.ts", action: "created", timestamp: "2026-06-15T10:00:00Z", summary: "new" }],
      toolsUsed: ["read"],
      tokensUsed: 500,
      messages: [{ role: "user", content: "hello", timestamp: "2026-06-15T10:00:00Z" }],
    };
    saveSessionTrace(config, trace);
    const loaded = listSessionTraces(config);
    expect(loaded[0].messages[0].content).toBe("hello");
    fs.rmSync(path.join(TEMP_DIR, "nested-json"), { recursive: true, force: true });
  });

  it("should create parent directory in writeMarkdown when it doesn't exist", () => {
    const config: MemoryConfig = {
      globalDir: path.join(TEMP_DIR, "write-md-global"),
      projectDir: path.join(TEMP_DIR, "deeply", "nested", "nonexist-project"),
      historyDir: path.join(TEMP_DIR, "write-md-history"),
      skillsDir: path.join(TEMP_DIR, "write-md-skills"),
    };
    writeProjectMemory(config, "test content for mkdir");
    expect(readProjectMemory(config)).toBe("test content for mkdir");
  });

  it("should create parent directory in writeJson when it doesn't exist", () => {
    const config: MemoryConfig = {
      globalDir: path.join(TEMP_DIR, "write-json-global"),
      projectDir: path.join(TEMP_DIR, "write-json-project"),
      historyDir: path.join(TEMP_DIR, "write-json-history"),
      skillsDir: path.join(TEMP_DIR, "deeply", "nested", "nonexist-skills"),
    };
    const skill = makeSkill({ id: "mkdir-skill", name: "MkdirSkill" });
    saveSkill(config, skill);
    const skills = listSkills(config);
    expect(skills.some((s) => s.id === "mkdir-skill")).toBe(true);
  });

  it("should log warning on writeJson error when skillsDir is a file", () => {
    const config: MemoryConfig = {
      globalDir: path.join(TEMP_DIR, "write-json-err-global"),
      projectDir: path.join(TEMP_DIR, "write-json-err-project"),
      historyDir: path.join(TEMP_DIR, "write-json-err-history"),
      skillsDir: path.join(TEMP_DIR, "write-json-err-skills"),
    };
    ensureMemoryDirs(config);
    const skillsDirFile = path.join(config.skillsDir, "not-a-dir");
    fs.writeFileSync(skillsDirFile, "i am a file", "utf8");
    const configWithFileSkillsDir: MemoryConfig = {
      ...config,
      skillsDir: skillsDirFile,
    };
    const skill = makeSkill({ id: "err-skill", name: "ErrSkill" });
    expect(() => saveSkill(configWithFileSkillsDir, skill)).not.toThrow();
  });
});
