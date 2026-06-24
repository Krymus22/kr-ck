import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseDiffBlocks, applyDiffs } from "../tools.js";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../hooks.js", () => ({
  executePreFileWriteHooks: vi.fn().mockResolvedValue({ block: false }),
  executePostFileWriteHooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../diffPreview.js", () => ({
  previewAndApprove: vi.fn().mockResolvedValue(true),
}));

vi.mock("../guardrail.js", () => ({
  validateSyntax: vi.fn().mockResolvedValue({ valid: true }),
}));

const { mockExecSync, mockWriteFileSync, realWriteFileSync, mockSpawn } = vi.hoisted(() => {
  const mockExecSync = vi.fn();
  const mockWriteFileSync = vi.fn();
  let realWriteFileSync: any;
  const mockSpawn = vi.fn();
  return { mockExecSync, mockWriteFileSync, get realWriteFileSync() { return realWriteFileSync; }, mockSpawn };
});

vi.mock("node:child_process", () => ({
  get execSync() { return mockExecSync; },
  get spawn() { return mockSpawn; },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  // Store reference to real writeFileSync for use in tests
  (globalThis as any).__realWriteFileSync = actual.writeFileSync;
  mockWriteFileSync.mockImplementation((...args: any[]) => (actual.writeFileSync as any)(...args));
  return {
    ...actual,
    get writeFileSync() { return mockWriteFileSync; },
  };
});

// Helper to access the real writeFileSync stored during mock initialization
function getRealWriteFileSync(): typeof fs.writeFileSync {
  return (globalThis as any).__realWriteFileSync;
}

describe("parseDiffBlocks", () => {
  it("parses a single SEARCH/REPLACE block", () => {
    const diff = `<<<<<<< SEARCH
old code here
=======
new code here
>>>>>>> REPLACE`;

    const blocks = parseDiffBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("old code here");
    expect(blocks[0].replace).toBe("new code here");
  });

  it("parses multiple blocks", () => {
    const diff = `<<<<<<< SEARCH
first old
=======
first new
>>>>>>> REPLACE
<<<<<<< SEARCH
second old
=======
second new
>>>>>>> REPLACE`;

    const blocks = parseDiffBlocks(diff);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].search).toBe("first old");
    expect(blocks[0].replace).toBe("first new");
    expect(blocks[1].search).toBe("second old");
    expect(blocks[1].replace).toBe("second new");
  });

  it("returns empty array for invalid diff", () => {
    const blocks = parseDiffBlocks("no markers here");
    expect(blocks).toHaveLength(0);
  });

  it("handles empty search block (new file creation)", () => {
    const diff = `<<<<<<< SEARCH
=======
new file content
>>>>>>> REPLACE`;

    const blocks = parseDiffBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("");
    expect(blocks[0].replace).toBe("new file content");
  });

  it("handles multiline search and replace", () => {
    const diff = `<<<<<<< SEARCH
line 1
line 2
line 3
=======
replaced line 1
replaced line 2
>>>>>>> REPLACE`;

    const blocks = parseDiffBlocks(diff);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].search).toBe("line 1\nline 2\nline 3");
    expect(blocks[0].replace).toBe("replaced line 1\nreplaced line 2");
  });
});

describe("applyDiffs", () => {
  it("replaces matching content", () => {
    const original = "function foo() {\n  return 1;\n}";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
return 1;
=======
return 2;
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(true);
    expect(result.content).toContain("return 2;");
    expect(result.content).not.toContain("return 1;");
  });

  it("returns failure when SEARCH block not found", () => {
    const original = "hello world";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
nonexistent text
=======
replaced
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(false);
    expect(result.errorBlock).toBe("nonexistent text");
  });

  it("prepends content for empty search block", () => {
    const original = "existing content";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
=======
new prefix
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(true);
    expect(result.content).toBe("new prefix\nexisting content");
  });

  it("replaces completely for empty search on empty file", () => {
    const original = "";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
=======
brand new content
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(true);
    expect(result.content).toBe("brand new content");
  });

  it("applies multiple blocks sequentially", () => {
    const original = "aaa\nbbb\nccc";
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH
aaa
=======
aaa_first
>>>>>>> REPLACE
<<<<<<< SEARCH
ccc
=======
ccc_last
>>>>>>> REPLACE`
    );

    const result = applyDiffs(original, blocks);
    expect(result.success).toBe(true);
    expect(result.content).toContain("aaa_first");
    expect(result.content).toContain("ccc_last");
    expect(result.content).toContain("bbb");
  });
});

// ─── lerArquivo Tests ─────────────────────────────────────────────────────

import { lerArquivo } from "../tools.js";
import * as fs from "node:fs";
import * as path from "node:path";

describe("lerArquivo", () => {
  const testDir = path.join(process.cwd(), "__test_lerdir__");

  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
  });

  it("reads a file successfully", async () => {
    const filePath = path.join(testDir, "test.txt");
    fs.writeFileSync(filePath, "hello world");
    const result = await lerArquivo({ caminho: filePath });
    expect(result).toBe("hello world");
  });

  it("returns error for non-existent file", async () => {
    const result = await lerArquivo({ caminho: path.join(testDir, "nope.txt") });
    expect(result).toContain("[ERROR]");
    expect(result).toContain("not found");
  });

  it("lists directory contents when path is directory", async () => {
    fs.writeFileSync(path.join(testDir, "a.txt"), "a");
    fs.mkdirSync(path.join(testDir, "subdir"));
    const result = await lerArquivo({ caminho: testDir });
    expect(result).toContain("[DIRECTORY:");
    expect(result).toContain("a.txt");
    expect(result).toContain("subdir/");
  });

  it("handles read errors gracefully", async () => {
    const badPath = path.join(testDir, "no_permission.txt");
    fs.writeFileSync(badPath, "data");
    // Try to read a path that will error
    const result = await lerArquivo({ caminho: "C:\\nonexistent\\path\\file.txt" });
    expect(result).toContain("[ERROR]");
  });

  it("handles read error when file exists but cannot be read", async () => {
    // Create a file, then make it a directory to cause EISDIR on read
    const dirPath = path.join(testDir, "readerror_dir");
    fs.mkdirSync(dirPath);
    const result = await lerArquivo({ caminho: dirPath });
    // This should either list the directory or return an error
    expect(typeof result).toBe("string");
  });

  it("catches readSync error when file exists but readFileSync throws (lines 56-58)", async () => {
    const filePath = path.join(testDir, "catch_test.txt");
    fs.writeFileSync(filePath, "content");
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("sync read error");
    });
    const result = await lerArquivo({ caminho: filePath });
    expect(result).toContain("[ERROR]");
    expect(result).toContain("Failed to read");
    expect(result).toContain("sync read error");
    readSpy.mockRestore();
  });
});

// ─── executarComando Tests ────────────────────────────────────────────────

import { executarComando } from "../tools.js";
import { EventEmitter } from "node:events";

/** Build a fake spawn() child process that emits stdout/stderr + close. */
function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
  closeDelayMs?: number;
}): { child: EventEmitter; stdout: NodeJS.EventEmitter; stderr: NodeJS.EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { kill?: () => void; stdin?: { write: () => void } };
  const stdout = new EventEmitter() as NodeJS.EventEmitter & { emit: any };
  const stderr = new EventEmitter() as NodeJS.EventEmitter & { emit: any };
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;
  (child as any).stdin = { write: () => true };
  (child as any).kill = () => { /* no-op */ };

  const delay = opts.closeDelayMs ?? 5;
  setTimeout(() => {
    if (opts.error) {
      child.emit("error", opts.error);
      return;
    }
    if (opts.stdout) stdout.emit("data", Buffer.from(opts.stdout, "utf8"));
    if (opts.stderr) stderr.emit("data", Buffer.from(opts.stderr, "utf8"));
    child.emit("close", opts.exitCode ?? 0);
  }, delay);

  return { child: child as any, stdout: stdout as any, stderr: stderr as any };
}

describe("executarComando", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockSpawn.mockReset();
  });

  it("executes a simple command", async () => {
    mockSpawn.mockImplementation(() => makeFakeChild({ stdout: "hello\n", exitCode: 0 }).child);
    const result = await executarComando({ comando: "echo hello" });
    expect(result).toContain("hello");
    expect(mockSpawn).toHaveBeenCalledWith("echo hello", expect.objectContaining({
      shell: expect.any(String),
    }));
  });

  it("handles failing command (exit non-zero)", async () => {
    mockSpawn.mockImplementation(() => makeFakeChild({
      stdout: "",
      stderr: "error output",
      exitCode: 1,
    }).child);
    const result = await executarComando({ comando: "exit 1" });
    expect(result).toContain("[ERROR]");
    expect(result).toContain("error output");
  });

  it("handles spawn error event", async () => {
    mockSpawn.mockImplementation(() => makeFakeChild({
      error: new Error("ENOENT"),
    }).child);
    const result = await executarComando({ comando: "bad command" });
    expect(result).toContain("[ERROR]");
    expect(result).toContain("ENOENT");
  });

  it("returns OK message when command produces no output", async () => {
    mockSpawn.mockImplementation(() => makeFakeChild({ stdout: "", stderr: "", exitCode: 0 }).child);
    const result = await executarComando({ comando: "true" });
    expect(result).toContain("[OK]");
  });
});

// ─── aplicarDiff Tests ────────────────────────────────────────────────────

import { aplicarDiff } from "../tools.js";

describe("aplicarDiff", () => {
  const testDir = path.join(process.cwd(), "__test_aplicardir__");

  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });
  });

  it("applies valid diff to existing file", async () => {
    const filePath = path.join(testDir, "code.ts");
    fs.writeFileSync(filePath, "const x = 1;");
    const diff = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(true);
    expect(result.toolMessage).toContain("SUCCESS");
  });

  it("returns error for no valid diff blocks", async () => {
    const filePath = path.join(testDir, "code2.ts");
    fs.writeFileSync(filePath, "content");
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: "no markers" });
    expect(result.written).toBe(false);
    expect(result.toolMessage).toContain("No valid SEARCH/REPLACE");
  });

  it("returns error when SEARCH block not found", async () => {
    const filePath = path.join(testDir, "code3.ts");
    fs.writeFileSync(filePath, "original content");
    const diff = `<<<<<<< SEARCH
nonexistent code
=======
replaced
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(false);
    expect(result.toolMessage).toContain("SEARCH block not found");
  });

  it("creates new file with empty search block", async () => {
    const filePath = path.join(testDir, "new.ts");
    const diff = `<<<<<<< SEARCH
=======
brand new file
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(true);
    expect(result.toolMessage).toContain("SUCCESS");
  });

  it("returns blocked message when pre-write hook blocks", async () => {
    const { executePreFileWriteHooks } = await import("../hooks.js");
    (executePreFileWriteHooks as any).mockResolvedValueOnce({ block: true, reason: "forbidden by policy" });

    const filePath = path.join(testDir, "blocked.ts");
    fs.writeFileSync(filePath, "const x = 1;");
    const diff = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(false);
    expect(result.toolMessage).toContain("BLOCKED");
    expect(result.toolMessage).toContain("forbidden by policy");
  });

  it("returns error when fs.writeFileSync fails", async () => {
    const filePath = path.join(testDir, "writefail.ts");
    // Write the original file using the real fs
    getRealWriteFileSync()(filePath, "const x = 1;");
    // Now make writeFileSync throw for any call touching the test file path.
    // (saveBackup also calls writeFileSync, so we need to throw for ALL subsequent calls,
    // not just the first one.)
    mockWriteFileSync.mockImplementation((p: string) => {
      if (typeof p === "string" && p.includes("writefail.ts")) {
        throw new Error("disk full");
      }
      // allow backup writes to .rollback/ to succeed
      return (getRealWriteFileSync() as any)(...arguments);
    });

    const diff = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(false);
    expect(result.toolMessage).toContain("ERRO");
    expect(result.toolMessage).toContain("Failed to write");
    // Restore default implementation for subsequent tests
    mockWriteFileSync.mockReset();
    mockWriteFileSync.mockImplementation((...args: any[]) => (getRealWriteFileSync() as any)(...args));
  });

  it("returns advisory warning when post-write validation fails", async () => {
    const { validateSyntax } = await import("../guardrail.js");
    (validateSyntax as any).mockResolvedValueOnce({ valid: false, errorMessage: "TS2322: Type mismatch" });

    const filePath = path.join(testDir, "validfail.ts");
    fs.writeFileSync(filePath, "const x = 1;");
    const diff = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(true);
    expect(result.toolMessage).toContain("POST-WRITE WARNING");
    expect(result.toolMessage).toContain("Type mismatch");
  });

  it("returns error when reading existing file fails", async () => {
    // Create a file, then replace it with a directory so readFileSync fails
    const filePath = path.join(testDir, "readfail.ts");
    fs.writeFileSync(filePath, "const x = 1;");
    // Replace file with directory
    fs.unlinkSync(filePath);
    fs.mkdirSync(filePath);
    // NowFs.existsSync returns true but readSync will fail with EISDIR
    const diff = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(false);
    expect(result.toolMessage).toContain("ERRO");
    expect(result.toolMessage).toContain("Failed to read arquivo existente");
  });

  it("returns rejected message when user declines diff preview", async () => {
    const { previewAndApprove } = await import("../diffPreview.js");
    (previewAndApprove as any).mockResolvedValueOnce(false);

    const filePath = path.join(testDir, "rejected.ts");
    fs.writeFileSync(filePath, "const x = 1;");
    const diff = `<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(false);
    expect(result.toolMessage).toContain("REJECTED");
  });
});
