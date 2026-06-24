/**
 * fileEdit.test.ts — Tests for file editing module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyEdits, editFile, type EditOperation } from "../fileEdit.js";

const TEST_DIR = path.join(process.cwd(), "__test_editdir__");
const TEST_FILE = path.join(TEST_DIR, "edit_test.ts");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE, "const x = 1;\nconst y = 2;\nconst z = 3;\n", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("applyEdits", () => {
  it("should replace first occurrence", () => {
    const content = "hello world hello world";
    const result = applyEdits(content, [{ search: "hello", replace: "hi" }]);
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("hi world hello world");
  });

  it("should replace all occurrences", () => {
    const content = "hello world hello world";
    const result = applyEdits(content, [{ search: "hello", replace: "hi", all: true }]);
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(2);
    expect(result.content).toBe("hi world hi world");
  });

  it("should apply multiple edits sequentially", () => {
    const content = "aaa bbb ccc";
    const result = applyEdits(content, [
      { search: "aaa", replace: "111" },
      { search: "bbb", replace: "222" },
    ]);
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(2);
    expect(result.content).toBe("111 222 ccc");
  });

  it("should fail when SEARCH not found", () => {
    const content = "hello world";
    const result = applyEdits(content, [{ search: "nonexistent", replace: "x" }]);
    expect(result.success).toBe(false);
    expect(result.error).toContain("SEARCH not found");
  });

  it("should handle empty search gracefully", () => {
    const content = "hello";
    const result = applyEdits(content, [{ search: "", replace: "x" }]);
    expect(result.success).toBe(true);
    // Sprint C (BUG-V): empty search on non-empty file now appends (1 replacement)
    expect(result.replacements).toBe(1);
    expect(result.content).toBe("hello\nx");
  });
});

describe("editFile", () => {
  it("should edit file on disk", async () => {
    const testFile = path.join(TEST_DIR, "edit_disk.ts");
    fs.writeFileSync(testFile, "const a = 1;\n", "utf8");

    const result = await editFile(testFile, [{ search: "const a = 1;", replace: "const a = 2;" }]);
    expect(result).toContain("[SUCESSO]");

    const content = fs.readFileSync(testFile, "utf8");
    expect(content).toBe("const a = 2;\n");
  });

  it("should create file if createIfMissing", async () => {
    const newFile = path.join(TEST_DIR, "new_file.ts");
    const result = await editFile(newFile, [{ search: "", replace: "export {};" }], { createIfMissing: true });
    expect(result).toContain("[SUCESSO]");

    const content = fs.readFileSync(newFile, "utf8");
    expect(content).toContain("export {};");
  });

  it("should fail for non-existent file without createIfMissing", async () => {
    const result = await editFile("/nonexistent/file.ts", [{ search: "x", replace: "y" }]);
    expect(result).toContain("[ERRO]");
  });

  it("should create backup when backup option is set", async () => {
    const testFile = path.join(TEST_DIR, "backup_test.ts");
    fs.writeFileSync(testFile, "const backup = true;\n", "utf8");

    await editFile(testFile, [{ search: "const backup = true;", replace: "const backup = false;" }], { backup: true });

    const backupFile = testFile + ".bak";
    expect(fs.existsSync(backupFile)).toBe(true);
    expect(fs.readFileSync(backupFile, "utf8")).toBe("const backup = true;\n");
  });

  it("should return error when applyEdits fails", async () => {
    const testFile = path.join(TEST_DIR, "fail_edit.ts");
    fs.writeFileSync(testFile, "const a = 1;\n", "utf8");

    const result = await editFile(testFile, [{ search: "nonexistent string", replace: "x" }]);
    expect(result).toContain("[ERRO]");
    expect(result).toContain("Edição falhou");
  });
});
