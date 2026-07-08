/**
 * regression-bug-hunter-8d.test.ts — Regression tests for Bug Hunter #8d.
 *
 * Focus area: Memory + misc modules (no fs/child_process mocking).
 *
 * Each test below fails BEFORE the corresponding fix and passes AFTER.
 *
 * Bugs covered (this file):
 *   1. memory.ts `findMatchingSkills`: empty context matched ALL skills.
 *   2. memory.ts `getMemoryConfig`: stale module-level HOME.
 *   3. hooks.ts `executePreFileWriteHooks`: empty modifiedContent ignored.
 *   4. hooks.ts `executePostToolCallHooks`: empty modifiedResult ignored.
 *   5. imagePaste.ts `imageToBase64`: invalid `image/jpg` MIME.
 *
 * Bugs 6 (searxManager fd leak) and 7 (inboxOrganizer EXDEV) live in
 * companion files because they require top-level `vi.mock("node:fs")`
 * which would break the other tests here that use the real fs.
 *   - regression-bug-hunter-8d-searx.test.ts
 *   - regression-bug-hunter-8d-inbox.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Shared logger mock ──────────────────────────────────────────────────────

vi.mock("../logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  toolCall: vi.fn(),
  toolResult: vi.fn(),
}));

// ─── Bug 1: memory.ts findMatchingSkills empty context ─────────────────────

describe("Bug Hunter #8d — memory.ts findMatchingSkills empty context", () => {
  let tmpDir: string;
  let config: import("../memory.js").MemoryConfig;

  beforeEach(async () => {
    const { ensureMemoryDirs } = await import("../memory.js");
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh8d-memory-"));
    config = {
      globalDir: path.join(tmpDir, "global"),
      projectDir: path.join(tmpDir, "project"),
      historyDir: path.join(tmpDir, "global", "history"),
      skillsDir: path.join(tmpDir, "global", "skills"),
    };
    ensureMemoryDirs(config);
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("returns [] when context is empty (does NOT match all skills)", async () => {
    const { saveSkill, findMatchingSkills } = await import("../memory.js");
    saveSkill(config, {
      id: "s1", name: "Auth", description: "login flow",
      trigger: "auth", steps: [], createdAt: new Date().toISOString(), usageCount: 5,
    });
    saveSkill(config, {
      id: "s2", name: "Deploy", description: "ship to prod",
      trigger: "deploy", steps: [], createdAt: new Date().toISOString(), usageCount: 3,
    });

    // BEFORE the fix: `"".includes("")` is true → all 2 skills returned.
    // AFTER the fix: empty context short-circuits to [].
    const matches = findMatchingSkills(config, "");
    expect(matches).toEqual([]);
  });

  it("returns [] when context is whitespace-only", async () => {
    const { saveSkill, findMatchingSkills } = await import("../memory.js");
    saveSkill(config, {
      id: "s3", name: "Test", description: "testing",
      trigger: "test", steps: [], createdAt: new Date().toISOString(), usageCount: 1,
    });

    const matches = findMatchingSkills(config, "   \t\n  ");
    expect(matches).toEqual([]);
  });

  it("still matches skills for a real (non-empty) context", async () => {
    const { saveSkill, findMatchingSkills } = await import("../memory.js");
    saveSkill(config, {
      id: "s4", name: "Auth", description: "Complete auth setup",
      trigger: "authentication", steps: [], createdAt: new Date().toISOString(), usageCount: 2,
    });

    const matches = findMatchingSkills(config, "authentication");
    expect(matches.length).toBe(1);
    expect(matches[0]!.name).toBe("Auth");
  });

  it("injectMemory does NOT pull all skills when project memory is empty", async () => {
    const { saveSkill, injectMemory, writeProjectMemory } = await import("../memory.js");
    saveSkill(config, {
      id: "inj1", name: "Should-Not-Appear", description: "x".repeat(2000),
      trigger: "nope", steps: ["x".repeat(2000)], createdAt: new Date().toISOString(), usageCount: 1,
    });
    saveSkill(config, {
      id: "inj2", name: "Also-Not-Appear", description: "y".repeat(2000),
      trigger: "nope2", steps: ["y".repeat(2000)], createdAt: new Date().toISOString(), usageCount: 1,
    });

    // Empty project memory → context passed to findMatchingSkills is "".
    // BEFORE the fix: both skills injected, token estimate ~1000+.
    // AFTER the fix: no skills injected, token estimate is 0.
    writeProjectMemory(config, "");
    const mem = injectMemory(config);
    expect(mem.relevantSkills).toEqual([]);
    expect(mem.totalTokensEstimate).toBe(0);
  });
});

// ─── Bug 2: memory.ts getMemoryConfig respects process.env.HOME at call time ─

describe("Bug Hunter #8d — memory.ts getMemoryConfig reads HOME at call time", () => {
  let realHome: string | undefined;
  let realUserprofile: string | undefined;

  beforeEach(() => {
    realHome = process.env.HOME;
    realUserprofile = process.env.USERPROFILE;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    if (realUserprofile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = realUserprofile;
  });

  it("getMemoryConfig reflects process.env.HOME set AFTER module import", async () => {
    const { getMemoryConfig } = await import("../memory.js");
    const fakeHome = path.join(os.tmpdir(), `bh8d-fake-home-${Date.now()}`);
    fs.mkdirSync(fakeHome, { recursive: true });

    // Set HOME AFTER the module is imported. BEFORE the fix, the module
    // had captured `os.homedir()` at load time and would ignore this.
    process.env.HOME = fakeHome;

    const config = getMemoryConfig();
    expect(config.globalDir).toBe(path.join(fakeHome, ".claude-killer", "memory"));

    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("getMemoryConfig reflects a SECOND change to process.env.HOME", async () => {
    const { getMemoryConfig } = await import("../memory.js");
    const fakeHome1 = path.join(os.tmpdir(), `bh8d-home1-${Date.now()}`);
    const fakeHome2 = path.join(os.tmpdir(), `bh8d-home2-${Date.now()}`);
    fs.mkdirSync(fakeHome1, { recursive: true });
    fs.mkdirSync(fakeHome2, { recursive: true });

    process.env.HOME = fakeHome1;
    const config1 = getMemoryConfig();
    expect(config1.globalDir).toContain(fakeHome1);

    process.env.HOME = fakeHome2;
    const config2 = getMemoryConfig();
    expect(config2.globalDir).toContain(fakeHome2);
    expect(config2.globalDir).not.toBe(config1.globalDir);

    fs.rmSync(fakeHome1, { recursive: true, force: true });
    fs.rmSync(fakeHome2, { recursive: true, force: true });
  });
});

// ─── Bug 3: hooks.ts executePreFileWriteHooks honors empty modifiedContent ──

describe("Bug Hunter #8d — hooks.ts preFileWrite empty modifiedContent", () => {
  beforeEach(async () => {
    const { clearAllHooks } = await import("../hooks.js");
    clearAllHooks();
  });
  afterEach(async () => {
    const { clearAllHooks } = await import("../hooks.js");
    clearAllHooks();
  });

  it("a hook that returns modifiedContent: '' clears the content", async () => {
    const { onPreFileWrite, executePreFileWriteHooks } = await import("../hooks.js");
    // Hook wants to clear the file (e.g. a "strip all secrets" hook that
    // decided the whole file is sensitive and must be emptied).
    onPreFileWrite(async () => ({ modifiedContent: "" }));

    const result = await executePreFileWriteHooks("/tmp/file.txt", "sensitive data");
    // BEFORE the fix: `if ("")` was false → original "sensitive data" returned.
    // AFTER the fix: `if ("" !== undefined)` is true → "" returned.
    expect(result.block).toBe(false);
    expect(result.modifiedContent).toBe("");
  });

  it("a hook that returns modifiedContent: undefined leaves content unchanged", async () => {
    const { onPreFileWrite, executePreFileWriteHooks } = await import("../hooks.js");
    onPreFileWrite(async () => ({})); // no modifiedContent field

    const result = await executePreFileWriteHooks("/tmp/file.txt", "original");
    expect(result.modifiedContent).toBe("original");
  });

  it("two hooks: first clears, second sees empty content", async () => {
    const { onPreFileWrite, executePreFileWriteHooks } = await import("../hooks.js");
    let secondSaw: string | undefined;
    onPreFileWrite(async () => ({ modifiedContent: "" }), 1);
    onPreFileWrite(async (_p, content) => { secondSaw = content; return {}; }, 2);

    await executePreFileWriteHooks("/tmp/file.txt", "original");
    // Second hook should see "" (the cleared content), not "original".
    expect(secondSaw).toBe("");
  });
});

// ─── Bug 4: hooks.ts executePostToolCallHooks honors empty modifiedResult ───

describe("Bug Hunter #8d — hooks.ts postToolCall empty modifiedResult", () => {
  beforeEach(async () => {
    const { clearAllHooks } = await import("../hooks.js");
    clearAllHooks();
  });
  afterEach(async () => {
    const { clearAllHooks } = await import("../hooks.js");
    clearAllHooks();
  });

  it("a hook that returns modifiedResult: '' overrides with empty string", async () => {
    const { onPostToolCall, executePostToolCallHooks } = await import("../hooks.js");
    // Hook wants to redact the entire tool result (e.g. it contained a
    // secret and the hook decided to blank it).
    onPostToolCall(async () => ({ modifiedResult: "" }));

    const result = await executePostToolCallHooks("tool", {}, "secret-output");
    // BEFORE the fix: `if ("")` was false → "secret-output" returned.
    // AFTER the fix: `if ("" !== undefined)` is true → "" returned.
    expect(result.modifiedResult).toBe("");
  });

  it("a hook that returns modifiedResult: undefined leaves result unchanged", async () => {
    const { onPostToolCall, executePostToolCallHooks } = await import("../hooks.js");
    onPostToolCall(async () => ({}));

    const result = await executePostToolCallHooks("tool", {}, "untouched");
    expect(result.modifiedResult).toBe("untouched");
  });
});

// ─── Bug 5: imagePaste.ts imageToBase64 normalizes jpg → jpeg MIME ──────────

describe("Bug Hunter #8d — imagePaste.ts imageToBase64 MIME normalization", () => {
  it("format 'jpg' produces data:image/jpeg (NOT data:image/jpg)", async () => {
    const { imageToBase64 } = await import("../imagePaste.js");
    const result = imageToBase64({ data: Buffer.from("abc"), format: "jpg" });
    // BEFORE the fix: `data:image/jpg;base64,...` (rejected by vision APIs).
    // AFTER the fix: `data:image/jpeg;base64,...` (IANA standard).
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    expect(result).not.toMatch(/^data:image\/jpg;base64,/);
  });

  it("format 'jpeg' produces data:image/jpeg", async () => {
    const { imageToBase64 } = await import("../imagePaste.js");
    const result = imageToBase64({ data: Buffer.from("abc"), format: "jpeg" });
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("format 'png' is unchanged (already valid IANA)", async () => {
    const { imageToBase64 } = await import("../imagePaste.js");
    const result = imageToBase64({ data: Buffer.from("abc"), format: "png" });
    expect(result).toMatch(/^data:image\/png;base64,/);
  });

  it("format 'gif' is unchanged (already valid IANA)", async () => {
    const { imageToBase64 } = await import("../imagePaste.js");
    const result = imageToBase64({ data: Buffer.from("abc"), format: "gif" });
    expect(result).toMatch(/^data:image\/gif;base64,/);
  });
});
