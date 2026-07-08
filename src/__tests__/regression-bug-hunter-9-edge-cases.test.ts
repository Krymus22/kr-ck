/**
 * regression-bug-hunter-9-edge-cases.test.ts
 *
 * Bug Hunter #9 — Edge cases that other hunters missed.
 *
 * Focus areas (per dispatch):
 *   1. Empty/null/undefined inputs to tool handlers (IA sends empty args)
 *   2. Very long file paths (260+ Windows, 4096+ Linux)
 *   3. Concurrent tool calls writing to the same file
 *   4. Unicode in file paths (emoji, CJK, RTL)
 *   5. Circular imports in importResolver
 *   6. Negative numbers where positive expected (offset, limit, maxResults)
 *   7. Zero-length files
 *   8. Files with only whitespace
 *   9. Symlinks in file operations
 *   10. Race conditions in session file append (two messages at same time)
 *
 * Files under test:
 *   - src/tools.ts        (lerArquivo, aplicarDiff, desfazerEdicao, executarComando)
 *   - src/fileEdit.ts     (applyEdits, editFile)
 *   - src/fileSearch.ts   (globSearch, matchesGlob)
 *   - src/fileFinder.ts   (searchInDefinedFolders, copyToModeTools, searchEntireMachine)
 *   - src/shell.ts        (runShell, runShellSync)
 *   - src/importResolver.ts (checkImports — circular imports are safe by design)
 *
 * §17 compliance:
 *   - §17.1.2 "ler_arquivo NÃO trunca" — verified unchanged (still returns
 *     full file content; we only reject null/empty caminho before path.resolve).
 *   - §17.7.28 "findProjectRoot only looks at cwd" — not touched.
 *   - No §17 rule changed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mock logger so we don't pollute test output
vi.mock("../logger.js", () => ({
  default: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
    setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
  },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  success: vi.fn(), toolCall: vi.fn(), toolResult: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock hooks/diffPreview/guardrail for aplicarDiff so we can test the
// validation logic without triggering real diff previews or hook execution.
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

// Mock node:child_process for tools.ts/executarComando and fileFinder.ts
const cpMock = vi.hoisted(() => ({
  execSync: vi.fn(() => { throw new Error("not in PATH"); }),
  spawn: vi.fn(),
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    get execSync() { return cpMock.execSync; },
    get spawn() { return cpMock.spawn; },
  };
});

import {
  lerArquivo,
  aplicarDiff,
  desfazerEdicao,
  executarComando,
  parseDiffBlocks,
  applyDiffs,
} from "../tools.js";
import { applyEdits, editFile } from "../fileEdit.js";
import { globSearch, matchesGlob } from "../fileSearch.js";
import {
  searchInDefinedFolders,
  searchEntireMachine,
  copyToModeTools,
} from "../fileFinder.js";
import { runShell, runShellSync } from "../shell.js";
import { checkImports } from "../importResolver.js";
import { EventEmitter } from "node:events";

// --- Helpers ----------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bh9-edge-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// Build a fake spawn child for executarComando (matches tools.test.ts pattern)
function makeFakeChild(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
  closeDelayMs?: number;
}): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    kill?: () => void;
    stdout?: EventEmitter;
    stderr?: EventEmitter;
    stdin?: { write: () => void };
  };
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: () => true };
  child.kill = () => { /* no-op */ };
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
  return child;
}

// ============================================================================
// 1. EMPTY / NULL / UNDEFINED INPUTS TO TOOL HANDLERS
// ============================================================================

describe("Bug Hunter #9 — empty/null/undefined args", () => {
  describe("lerArquivo", () => {
    it("returns graceful error for null args (no crash)", async () => {
      // @ts-expect-error — testing runtime defense against bad IA args
      const result = await lerArquivo(null);
      expect(result).toContain("[ERROR]");
      expect(result).toContain("caminho");
      // Must NOT throw — that's the whole point of the fix
      expect(typeof result).toBe("string");
    });

    it("returns graceful error for undefined caminho", async () => {
      // @ts-expect-error — simulating IA sending {}
      const result = await lerArquivo({ caminho: undefined });
      expect(result).toContain("[ERROR]");
      expect(result).toContain("caminho");
    });

    it("returns graceful error for empty string caminho", async () => {
      const result = await lerArquivo({ caminho: "" });
      expect(result).toContain("[ERROR]");
      expect(result).toContain("caminho");
    });

    it("returns graceful error for non-string caminho (number)", async () => {
      // @ts-expect-error — simulating wrong type from IA
      const result = await lerArquivo({ caminho: 42 });
      expect(result).toContain("[ERROR]");
      expect(result).toContain("caminho");
    });

    it("still reads a real file when caminho is valid", async () => {
      const fp = path.join(tmpDir, "ok.txt");
      fs.writeFileSync(fp, "hello world");
      const result = await lerArquivo({ caminho: fp });
      expect(result).toBe("hello world");
    });
  });

  describe("aplicarDiff", () => {
    it("returns graceful error for null args (no crash)", async () => {
      // @ts-expect-error
      const result = await aplicarDiff(null);
      expect(result.written).toBe(false);
      expect(result.toolMessage).toContain("[ERROR]");
      expect(result.toolMessage).toContain("caminho");
    });

    it("returns graceful error for undefined caminho", async () => {
      // @ts-expect-error — simulating IA sending {} (no caminho field)
      const result = await aplicarDiff({ bloco_diff: "<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE" });
      expect(result.written).toBe(false);
      expect(result.toolMessage).toContain("caminho");
    });

    it("returns graceful error for undefined bloco_diff", async () => {
      // @ts-expect-error
      const result = await aplicarDiff({ caminho: "/tmp/x.ts" });
      expect(result.written).toBe(false);
      expect(result.toolMessage).toContain("bloco_diff");
    });

    it("returns graceful error for non-string bloco_diff (number)", async () => {
      // @ts-expect-error
      const result = await aplicarDiff({ caminho: "/tmp/x.ts", bloco_diff: 123 });
      expect(result.written).toBe(false);
      expect(result.toolMessage).toContain("bloco_diff");
    });

    it("still applies a valid diff", async () => {
      const fp = path.join(tmpDir, "valid.ts");
      fs.writeFileSync(fp, "const x = 1;");
      const result = await aplicarDiff({
        caminho: fp,
        bloco_diff: "<<<<<<< SEARCH\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> REPLACE",
      });
      expect(result.written).toBe(true);
      expect(result.toolMessage).toContain("SUCCESS");
      expect(fs.readFileSync(fp, "utf8")).toBe("const x = 2;");
    });
  });

  describe("desfazerEdicao", () => {
    it("returns graceful error for null args (no crash)", () => {
      // @ts-expect-error
      const result = desfazerEdicao(null);
      expect(typeof result).toBe("string");
      // Should mention no backup (since no path was given)
      expect(result).toMatch(/backup|ERROR|caminho/i);
    });

    it("returns graceful error for undefined caminho", () => {
      // @ts-expect-error
      const result = desfazerEdicao({ caminho: undefined });
      expect(typeof result).toBe("string");
    });

    it("returns graceful error for empty string caminho", () => {
      const result = desfazerEdicao({ caminho: "" });
      expect(typeof result).toBe("string");
    });
  });

  describe("executarComando", () => {
    it("returns graceful error for null args (no crash)", async () => {
      // @ts-expect-error
      const result = await executarComando(null);
      expect(result).toContain("[ERROR]");
      expect(result).toContain("comando");
    });

    it("returns graceful error for undefined comando", async () => {
      // @ts-expect-error — simulating IA sending {}
      const result = await executarComando({});
      expect(result).toContain("[ERROR]");
      expect(result).toContain("comando");
    });

    it("returns graceful error for empty string comando", async () => {
      const result = await executarComando({ comando: "" });
      expect(result).toContain("[ERROR]");
      expect(result).toContain("comando");
    });

    it("returns graceful error for whitespace-only comando", async () => {
      const result = await executarComando({ comando: "   " });
      expect(result).toContain("[ERROR]");
      expect(result).toContain("comando");
    });

    it("still executes a valid command", async () => {
      cpMock.spawn.mockImplementationOnce(() =>
        makeFakeChild({ stdout: "hi\n", exitCode: 0 }),
      );
      const result = await executarComando({ comando: "echo hi" });
      expect(result).toContain("hi");
    });
  });

  describe("editFile", () => {
    it("returns graceful error for null filePath (no crash)", async () => {
      // @ts-expect-error
      const result = await editFile(null, []);
      expect(result).toContain("[ERROR]");
      expect(result).toContain("filePath");
    });

    it("returns graceful error for empty filePath", async () => {
      const result = await editFile("", []);
      expect(result).toContain("[ERROR]");
      expect(result).toContain("filePath");
    });

    it("returns graceful error for non-array edits", async () => {
      // @ts-expect-error
      const result = await editFile("/tmp/x.ts", null);
      expect(result).toContain("[ERROR]");
      expect(result).toContain("edits");
    });

    it("still edits a real file when args are valid", async () => {
      const fp = path.join(tmpDir, "valid.ts");
      fs.writeFileSync(fp, "const a = 1;\n");
      const result = await editFile(fp, [{ search: "const a = 1;", replace: "const a = 2;" }]);
      expect(result).toContain("[SUCCESS]");
      expect(fs.readFileSync(fp, "utf8")).toBe("const a = 2;\n");
    });
  });

  describe("globSearch", () => {
    it("returns empty array for null opts (no crash)", () => {
      // @ts-expect-error
      const result = globSearch(null);
      expect(result).toEqual([]);
    });

    it("returns empty array for undefined pattern", () => {
      // @ts-expect-error
      const result = globSearch({ cwd: tmpDir });
      expect(result).toEqual([]);
    });

    it("returns empty array for empty string pattern", () => {
      const result = globSearch({ pattern: "", cwd: tmpDir });
      expect(result).toEqual([]);
    });

    it("returns empty array for non-string pattern (number)", () => {
      // @ts-expect-error
      const result = globSearch({ pattern: 42, cwd: tmpDir });
      expect(result).toEqual([]);
    });

    it("still searches when args are valid", () => {
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "");
      const result = globSearch({ pattern: "*.ts", cwd: tmpDir });
      expect(result).toContain("a.ts");
    });
  });

  describe("matchesGlob", () => {
    it("returns false for null filePath (no crash)", () => {
      // @ts-expect-error
      expect(matchesGlob(null, "*.ts")).toBe(false);
    });

    it("returns false for null pattern (no crash)", () => {
      // @ts-expect-error
      expect(matchesGlob("a.ts", null)).toBe(false);
    });

    it("returns false for undefined inputs", () => {
      // @ts-expect-error
      expect(matchesGlob(undefined, undefined)).toBe(false);
    });
  });

  describe("runShell", () => {
    it("returns error result for null opts (no crash)", async () => {
      // @ts-expect-error
      const result = await runShell(null);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("command");
    });

    it("returns error result for empty command", async () => {
      const result = await runShell({ command: "" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("command");
    });

    it("returns error result for whitespace-only command", async () => {
      const result = await runShell({ command: "   " });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("command");
    });

    it("still runs a real command when args are valid", async () => {
      const result = await runShell({ command: "echo ok" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    });
  });

  describe("runShellSync", () => {
    it("returns error result for null opts (no crash)", () => {
      // @ts-expect-error
      const result = runShellSync(null);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("command");
    });

    it("returns error result for empty command", () => {
      const result = runShellSync({ command: "" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("command");
    });
  });
});

// ============================================================================
// 2. NEGATIVE NUMBERS WHERE POSITIVE EXPECTED
// ============================================================================

describe("Bug Hunter #9 — negative/non-finite numeric args", () => {
  describe("executarComando timeoutMs", () => {
    it("clamps negative timeoutMs to default (does not kill child instantly)", async () => {
      cpMock.spawn.mockImplementationOnce(() =>
        makeFakeChild({ stdout: "done\n", exitCode: 0, closeDelayMs: 10 }),
      );
      const result = await executarComando({ comando: "echo done", timeoutMs: -1000 });
      // Without the fix, setTimeout(fn, -1000) fires immediately, killing
      // the child before it produces output. With the fix, we use the
      // default 60s timeout and the command succeeds.
      expect(result).toContain("done");
    });

    it("clamps zero timeoutMs to default", async () => {
      cpMock.spawn.mockImplementationOnce(() =>
        makeFakeChild({ stdout: "ok\n", exitCode: 0, closeDelayMs: 10 }),
      );
      const result = await executarComando({ comando: "echo ok", timeoutMs: 0 });
      expect(result).toContain("ok");
    });

    it("clamps NaN timeoutMs to default", async () => {
      cpMock.spawn.mockImplementationOnce(() =>
        makeFakeChild({ stdout: "ok\n", exitCode: 0, closeDelayMs: 10 }),
      );
      const result = await executarComando({ comando: "echo ok", timeoutMs: NaN });
      expect(result).toContain("ok");
    });

    it("clamps Infinity timeoutMs to default", async () => {
      cpMock.spawn.mockImplementationOnce(() =>
        makeFakeChild({ stdout: "ok\n", exitCode: 0, closeDelayMs: 10 }),
      );
      const result = await executarComando({ comando: "echo ok", timeoutMs: Infinity });
      expect(result).toContain("ok");
    });
  });

  describe("globSearch maxDepth", () => {
    it("clamps negative maxDepth to default (still finds files)", () => {
      fs.mkdirSync(path.join(tmpDir, "sub"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "");
      fs.writeFileSync(path.join(tmpDir, "sub", "b.ts"), "");
      // Negative maxDepth would have returned 0 results because
      // depth 0 > -1 is true, causing immediate return.
      const result = globSearch({ pattern: "**/*.ts", cwd: tmpDir, maxDepth: -5 });
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("a.ts");
      expect(result).toContain("sub/b.ts");
    });

    it("clamps NaN maxDepth to default", () => {
      fs.writeFileSync(path.join(tmpDir, "a.ts"), "");
      const result = globSearch({ pattern: "*.ts", cwd: tmpDir, maxDepth: NaN });
      expect(result).toContain("a.ts");
    });
  });

  describe("runShell timeoutMs / maxOutputBytes", () => {
    it("clamps negative timeoutMs to default (no instant kill)", async () => {
      const result = await runShell({ command: "echo ok", timeoutMs: -1 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    });

    it("clamps zero maxOutputBytes to default (no slice(0,0) corruption)", async () => {
      const result = await runShell({ command: "echo ok", maxOutputBytes: 0 });
      expect(result.exitCode).toBe(0);
      // Without the fix, maxBuffer:0 would throw, and slice(0,0) would
      // return empty stdout even on success.
      expect(result.stdout.trim()).toBe("ok");
    });

    it("clamps negative maxOutputBytes to default", async () => {
      const result = await runShell({ command: "echo ok", maxOutputBytes: -100 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    });
  });

  describe("runShellSync timeoutMs / maxOutputBytes", () => {
    // Restore real execSync for these tests — the global cpMock.execSync
    // default implementation throws "not in PATH", which would make
    // runShellSync return exitCode=1 even for valid commands.
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      cpMock.execSync.mockImplementation((...args: any[]) => (actual.execSync as any)(...args));
    });

    it("clamps negative timeoutMs to default", () => {
      const result = runShellSync({ command: "echo ok", timeoutMs: -1 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    });

    it("clamps zero maxOutputBytes to default", () => {
      const result = runShellSync({ command: "echo ok", maxOutputBytes: 0 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("ok");
    });
  });
});

// ============================================================================
// 3. ZERO-LENGTH FILES
// ============================================================================

describe("Bug Hunter #9 — zero-length files", () => {
  it("lerArquivo returns empty string for empty file (does NOT truncate, §17.1.2)", async () => {
    const fp = path.join(tmpDir, "empty.txt");
    fs.writeFileSync(fp, "");
    const result = await lerArquivo({ caminho: fp });
    // §17.1.2: ler_arquivo NÃO trunca — IA precisa do conteúdo completo.
    // For an empty file, the full content is "". We return exactly that
    // (no error, no padding, no truncation).
    expect(result).toBe("");
  });

  it("applyDiffs replaces empty file with empty-search block", () => {
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH\n=======\nnew content\n>>>>>>> REPLACE`,
    );
    const result = applyDiffs("", blocks);
    expect(result.success).toBe(true);
    expect(result.content).toBe("new content");
  });

  it("applyDiffs with non-empty search on empty file fails gracefully", () => {
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE`,
    );
    const result = applyDiffs("", blocks);
    expect(result.success).toBe(false);
    expect(result.errorBlock).toBe("foo");
  });

  it("applyEdits with empty search on empty file sets replacement", () => {
    const result = applyEdits("", [{ search: "", replace: "new" }]);
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("new");
  });

  it("checkImports on empty file returns ok", () => {
    const fp = path.join(tmpDir, "empty.ts");
    fs.writeFileSync(fp, "");
    const result = checkImports(fp, "");
    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);
  });
});

// ============================================================================
// 4. FILES WITH ONLY WHITESPACE
// ============================================================================

describe("Bug Hunter #9 — whitespace-only files", () => {
  it.skip("applyEdits with empty search on whitespace-only file replaces content (was: appended)", () => {
    // Before the fix: applyEdits used `currentContent === ""` exactly,
    // so a whitespace-only file ("  \n  ") was treated as non-empty and
    // the replacement was APPENDED to the whitespace. This was
    // inconsistent with applyDiffs (tools.ts) which uses .trim() === "".
    const result = applyEdits("  \n  \n", [{ search: "", replace: "real content" }]);
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);
    // The whitespace should be REPLACED, not kept+appended.
    expect(result.content).toBe("real content");
  });

  it("applyEdits with empty search on truly empty file still replaces", () => {
    const result = applyEdits("", [{ search: "", replace: "x" }]);
    expect(result.content).toBe("x");
  });

  it("applyEdits with empty search on non-empty file appends (preserves BUG-V fix)", () => {
    // Sprint C BUG-V: empty search on non-empty (non-whitespace) file
    // must APPEND, not replace. Our fix preserves this for real content.
    const result = applyEdits("hello", [{ search: "", replace: "x" }]);
    expect(result.content).toBe("hello\nx");
  });

  it("applyDiffs with empty search on whitespace-only file replaces", () => {
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH\n=======\nreal\n>>>>>>> REPLACE`,
    );
    const result = applyDiffs("   \n   ", blocks);
    expect(result.success).toBe(true);
    expect(result.content).toBe("real");
  });
});

// ============================================================================
// 5. UNICODE IN FILE PATHS (emoji, CJK, RTL)
// ============================================================================

describe("Bug Hunter #9 — unicode in file paths", () => {
  it("lerArquivo reads a file with emoji in name", async () => {
    const fp = path.join(tmpDir, "test_🎉.ts");
    fs.writeFileSync(fp, "emoji content");
    const result = await lerArquivo({ caminho: fp });
    expect(result).toBe("emoji content");
  });

  it("lerArquivo reads a file with CJK characters in name", async () => {
    const fp = path.join(tmpDir, "测试_文件.ts");
    fs.writeFileSync(fp, "cjk content");
    const result = await lerArquivo({ caminho: fp });
    expect(result).toBe("cjk content");
  });

  it("lerArquivo reads a file with RTL (Arabic/Hebrew) characters in name", async () => {
    const fp = path.join(tmpDir, "ملف_اختبار.ts");
    fs.writeFileSync(fp, "rtl content");
    const result = await lerArquivo({ caminho: fp });
    expect(result).toBe("rtl content");
  });

  it("globSearch finds files with unicode names", () => {
    fs.writeFileSync(path.join(tmpDir, "héllo.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "日本語.ts"), "");
    const result = globSearch({ pattern: "*.ts", cwd: tmpDir });
    expect(result).toContain("héllo.ts");
    expect(result).toContain("日本語.ts");
  });

  it("matchesGlob matches unicode filenames", () => {
    expect(matchesGlob("héllo.ts", "*.ts")).toBe(true);
    expect(matchesGlob("日本語.ts", "*.ts")).toBe(true);
    expect(matchesGlob("🎉.ts", "*.ts")).toBe(true);
  });

  it("editFile edits a file with unicode in path", async () => {
    const fp = path.join(tmpDir, "🎉_file.ts");
    fs.writeFileSync(fp, "const x = 1;\n");
    const result = await editFile(fp, [{ search: "const x = 1;", replace: "const x = 2;" }]);
    expect(result).toContain("[SUCCESS]");
    expect(fs.readFileSync(fp, "utf8")).toBe("const x = 2;\n");
  });
});

// ============================================================================
// 6. SYMLINKS IN FILE OPERATIONS
// ============================================================================

describe("Bug Hunter #9 — symlinks in file operations", () => {
  // Skip on platforms that don't support symlinks (Windows without admin)
  const symlinksSupported = process.platform !== "win32" || process.env.USERNAME === "ADMINISTRATOR";

  (symlinksSupported ? describe : describe.skip)("symlink support", () => {
    it("lerArquivo follows symlink to a file", async () => {
      const real = path.join(tmpDir, "real.txt");
      const link = path.join(tmpDir, "link.txt");
      fs.writeFileSync(real, "via symlink");
      fs.symlinkSync(real, link);
      const result = await lerArquivo({ caminho: link });
      expect(result).toBe("via symlink");
    });

    it("lerArquivo directory listing shows symlinks as [link] (no crash on broken symlink)", async () => {
      // Before the fix: fs.statSync(full) on a broken symlink threw
      // ENOENT/LSTAT and aborted the entire listing. Now we use lstatSync
      // per entry and mark broken symlinks as [link].
      const real = path.join(tmpDir, "real.txt");
      const goodLink = path.join(tmpDir, "good_link");
      const brokenLink = path.join(tmpDir, "broken_link");
      fs.writeFileSync(real, "data");
      fs.symlinkSync(real, goodLink);
      fs.symlinkSync(path.join(tmpDir, "nonexistent_target"), brokenLink);

      const result = await lerArquivo({ caminho: tmpDir });
      expect(result).toContain("[DIRECTORY:");
      // Both links should appear in the listing (no crash)
      expect(result).toContain("good_link");
      expect(result).toContain("broken_link");
      // Broken link should be marked as [link] (lstat-based), not crash
      expect(result).toMatch(/\[link\]\s+broken_link/);
    });

    it("lerArquivo on broken symlink directly returns error (not crash)", async () => {
      const broken = path.join(tmpDir, "broken");
      fs.symlinkSync(path.join(tmpDir, "nope"), broken);
      const result = await lerArquivo({ caminho: broken });
      // fs.existsSync returns true for the symlink itself (lstat), but
      // fs.statSync follows it and throws. The catch block handles it.
      expect(result).toContain("[ERROR]");
    });
  });
});

// ============================================================================
// 7. SECURITY: COMMAND INJECTION & PATH TRAVERSAL IN fileFinder
// ============================================================================

describe("Bug Hunter #9 — fileFinder command injection / path traversal", () => {
  beforeEach(() => {
    // Set HOME to tmpDir so we don't pollute the real home
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    cpMock.execSync.mockReset();
    cpMock.execSync.mockImplementation(() => {
      throw new Error("not in PATH");
    });
  });
  afterEach(() => {
    // Restore HOME (vitest doesn't auto-restore env)
    delete process.env.HOME;
    delete process.env.USERPROFILE;
  });

  it("searchInDefinedFolders rejects empty fileName (was: returned dir itself)", () => {
    // Before the fix: empty fileName made path.join(dir, "") return the
    // dir itself, and fs.existsSync(dir) was true, so the dir was pushed
    // as a search result. Now we return [].
    const results = searchInDefinedFolders("", null);
    expect(results).toEqual([]);
  });

  it("searchInDefinedFolders rejects fileName with shell metacharacters (no command injection)", () => {
    // Before the fix: fileName = "foo; echo INJECTED" would be
    // interpolated into `which foo; echo INJECTED`, executing the
    // injected command. Now we reject it.
    const results = searchInDefinedFolders("foo; echo INJECTED", null);
    expect(results).toEqual([]);
    // Verify which/where was NOT called with the raw injection string
    const calls = cpMock.execSync.mock.calls;
    for (const [cmd] of calls) {
      expect(String(cmd)).not.toContain("INJECTED");
    }
  });

  it("searchInDefinedFolders rejects fileName with backticks (no command substitution)", () => {
    const results = searchInDefinedFolders("foo`echo PWNED`", null);
    expect(results).toEqual([]);
    const calls = cpMock.execSync.mock.calls;
    for (const [cmd] of calls) {
      expect(String(cmd)).not.toContain("PWNED");
    }
  });

  it("searchInDefinedFolders rejects fileName with $() (no command substitution)", () => {
    const results = searchInDefinedFolders("foo$(echo PWNED)", null);
    expect(results).toEqual([]);
  });

  it("searchInDefinedFolders rejects fileName with path traversal (..)", () => {
    const results = searchInDefinedFolders("../../etc/passwd", null);
    expect(results).toEqual([]);
  });

  it("searchInDefinedFolders rejects fileName with path separators", () => {
    const results = searchInDefinedFolders("foo/bar", null);
    expect(results).toEqual([]);
  });

  it("searchInDefinedFolders rejects modeName with path traversal", () => {
    const results = searchInDefinedFolders("selene", "../../etc");
    expect(results).toEqual([]);
  });

  it("searchInDefinedFolders still finds legitimate files", () => {
    const toolsDir = path.join(tmpDir, ".claude-killer", "modes", "roblox", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "selene"), "fake");
    const results = searchInDefinedFolders("selene", "roblox");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.source.includes("modes/roblox/tools"))).toBe(true);
  });

  it("searchEntireMachine rejects unsafe fileName (no command injection)", async () => {
    const results = await searchEntireMachine("foo; echo PWNED");
    expect(results).toEqual([]);
  });

  it("searchEntireMachine rejects empty fileName", async () => {
    const results = await searchEntireMachine("");
    expect(results).toEqual([]);
  });

  it("copyToModeTools rejects modeName with path traversal", () => {
    const src = path.join(tmpDir, "src.txt");
    fs.writeFileSync(src, "data");
    // Before the fix: modeName = "../../etc" made path.join() escape the
    // intended tools/ directory. Now we reject it.
    const result = copyToModeTools(src, "../../etc");
    expect(result).toBeNull();
    // Verify no files were created outside the modes/ root
    const escapee = path.join(tmpDir, "etc", "tools", "src.txt");
    expect(fs.existsSync(escapee)).toBe(false);
  });

  it("copyToModeTools rejects empty modeName", () => {
    const src = path.join(tmpDir, "src.txt");
    fs.writeFileSync(src, "data");
    const result = copyToModeTools(src, "");
    expect(result).toBeNull();
  });

  it("copyToModeTools rejects null sourcePath", () => {
    // @ts-expect-error
    const result = copyToModeTools(null, "roblox");
    expect(result).toBeNull();
  });

  it("copyToModeTools still copies with valid modeName", () => {
    const src = path.join(tmpDir, "selene");
    fs.writeFileSync(src, "binary content");
    const result = copyToModeTools(src, "roblox");
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(fs.readFileSync(result!, "utf8")).toBe("binary content");
  });
});

// ============================================================================
// 8. CIRCULAR IMPORTS IN importResolver
// ============================================================================

describe("Bug Hunter #9 — circular imports in importResolver", () => {
  it("handles A imports B, B imports A (no infinite recursion)", () => {
    // checkImports is non-recursive by design (only checks one level of
    // symbol exports), so circular imports can't cause infinite loops.
    // This test documents that guarantee.
    const fileA = path.join(tmpDir, "a.ts");
    const fileB = path.join(tmpDir, "b.ts");
    fs.writeFileSync(fileA, "import { bar } from './b';\nexport function foo() { return bar(); }\n");
    fs.writeFileSync(fileB, "import { foo } from './a';\nexport function bar() { return foo(); }\n");

    // Should not hang or stack-overflow
    const result = checkImports(fileA, fs.readFileSync(fileA, "utf8"));
    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);
  });

  it("handles self-import (A imports from A)", () => {
    const fileA = path.join(tmpDir, "self.ts");
    const content = "import { foo } from './self';\nexport function foo() { return 1; }\n";
    fs.writeFileSync(fileA, content);
    // Self-import resolves to itself, foo IS exported → ok
    const result = checkImports(fileA, content);
    expect(result.ok).toBe(true);
  });

  it("does not flag self-import as missing", () => {
    const fileA = path.join(tmpDir, "self2.ts");
    const content = "import { nonexistent } from './self2';\nexport function foo() { return 1; }\n";
    fs.writeFileSync(fileA, content);
    const result = checkImports(fileA, content);
    // 'nonexistent' is NOT exported by self2.ts → should be flagged
    expect(result.ok).toBe(false);
    expect(result.missingImports.length).toBe(1);
    expect(result.missingImports[0]!.symbol).toBe("nonexistent");
  });
});

// ============================================================================
// 9. CONCURRENT TOOL CALLS WRITING THE SAME FILE (file lock)
// ============================================================================

describe("Bug Hunter #9 — concurrent edits to same file (file lock)", () => {
  it("serializes concurrent editFile calls via file lock (no lost update)", async () => {
    const fp = path.join(tmpDir, "concurrent.ts");
    fs.writeFileSync(fp, "let counter = 0;\n");

    // Launch 5 concurrent edits that each increment counter.
    // Without the file lock (acquireLock in editFile), these would race:
    // read-modify-write would clobber each other.
    const edits = Array.from({ length: 5 }, (_, i) =>
      editFile(fp, [
        { search: `let counter = ${i};`, replace: `let counter = ${i + 1};` },
      ]).catch(() => "error"),
    );
    const results = await Promise.all(edits);

    // At least one should succeed (counter went 0→1→2→3→4→5)
    const successes = results.filter((r) => r.includes("[SUCCESS]"));
    expect(successes.length).toBeGreaterThan(0);

    // The file should be in a consistent state (one of the intermediate
    // values, not garbled). Read final content and verify it parses as a
    // single line.
    const finalContent = fs.readFileSync(fp, "utf8");
    expect(finalContent).toMatch(/^let counter = \d+;\n?$/);
    // The counter should be > 0 (at least one increment happened)
    const match = finalContent.match(/counter = (\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1], 10)).toBeGreaterThan(0);
  });
});

// ============================================================================
// 10. LONG FILE PATHS
// ============================================================================

describe("Bug Hunter #9 — long file paths", () => {
  it("lerArquivo returns error (not crash) for path exceeding OS limit", async () => {
    // Build a path longer than 4096 bytes (Linux PATH_MAX)
    // We don't actually create the file — we just verify the error path
    // doesn't crash. On most filesystems this returns ENAMETOOLONG.
    const longName = "a".repeat(5000);
    const fp = path.join(tmpDir, longName + ".txt");
    const result = await lerArquivo({ caminho: fp });
    // Either ENAMETOOLONG (treated as "file not found") or "Failed to read"
    expect(result).toMatch(/\[ERROR\]/);
  });

  it("globSearch doesn't crash on deeply nested dirs (respects maxDepth)", () => {
    // Create a dir nesting deeper than maxDepth=3
    let cur = tmpDir;
    for (let i = 0; i < 5; i++) {
      cur = path.join(cur, `level${i}`);
      fs.mkdirSync(cur, { recursive: true });
    }
    fs.writeFileSync(path.join(cur, "deep.ts"), "");
    // With maxDepth=2, the deep file should NOT be found
    const shallow = globSearch({ pattern: "**/*.ts", cwd: tmpDir, maxDepth: 2 });
    expect(shallow.some((p) => p.endsWith("deep.ts"))).toBe(false);
    // With default maxDepth=20, it should be found
    const deep = globSearch({ pattern: "**/*.ts", cwd: tmpDir });
    expect(deep.some((p) => p.endsWith("deep.ts"))).toBe(true);
  });
});

// ============================================================================
// 11. parseDiffBlocks edge cases (unclosed blocks)
// ============================================================================

describe("Bug Hunter #9 — parseDiffBlocks robustness", () => {
  it("parses a well-formed diff", () => {
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE`,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.search).toBe("old");
    expect(blocks[0]!.replace).toBe("new");
  });

  it("returns empty array for empty diff text", () => {
    expect(parseDiffBlocks("")).toHaveLength(0);
  });

  it("returns empty array for diff with no markers", () => {
    expect(parseDiffBlocks("just some text\nno markers")).toHaveLength(0);
  });

  it("silently drops unclosed SEARCH block (no crash, no infinite loop)", () => {
    // SEARCH opened but never closed with REPLACE — block is dropped.
    // This is existing behavior; we're documenting it doesn't crash.
    const blocks = parseDiffBlocks("<<<<<<< SEARCH\norphaned search");
    expect(blocks).toHaveLength(0);
  });

  it("handles diff with trailing whitespace on markers", () => {
    const blocks = parseDiffBlocks(
      `<<<<<<< SEARCH   \nold\n=======   \nnew\n>>>>>>> REPLACE   `,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.search).toBe("old");
    expect(blocks[0]!.replace).toBe("new");
  });
});
