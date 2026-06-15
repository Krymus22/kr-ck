/**
 * multiFileEdit.test.ts — Tests for multi-file atomic edit module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { multiFileEdit, type FileEditRequest } from "../multiFileEdit.js";

const TEST_DIR = path.join(process.cwd(), "__test_multiedit__");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, "a.ts"), "const a = 1;\n", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "b.ts"), "const b = 2;\n", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "c.ts"), "const c = 3;\n", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("multiFileEdit", () => {
  it("should edit multiple files atomically", () => {
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "a.ts"), edits: [{ search: "const a = 1;", replace: "const a = 10;" }] },
      { filePath: path.join(TEST_DIR, "b.ts"), edits: [{ search: "const b = 2;", replace: "const b = 20;" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    expect(result.filesEdited.length).toBe(2);
    expect(fs.readFileSync(path.join(TEST_DIR, "a.ts"), "utf8")).toContain("10");
    expect(fs.readFileSync(path.join(TEST_DIR, "b.ts"), "utf8")).toContain("20");
  });

  it("should rollback all files on failure", () => {
    const originalA = fs.readFileSync(path.join(TEST_DIR, "a.ts"), "utf8");
    const originalC = fs.readFileSync(path.join(TEST_DIR, "c.ts"), "utf8");

    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "a.ts"), edits: [{ search: "const a = 10;", replace: "const a = 100;" }] },
      { filePath: path.join(TEST_DIR, "c.ts"), edits: [{ search: "NONEXISTENT", replace: "fail" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // a.ts should be rolled back to original
    expect(fs.readFileSync(path.join(TEST_DIR, "a.ts"), "utf8")).toBe(originalA);
  });

  it("should handle createIfMissing", () => {
    const requests: FileEditRequest[] = [
      {
        filePath: path.join(TEST_DIR, "new.ts"),
        edits: [{ search: "", replace: "export const x = 1;" }],
        createIfMissing: true,
      },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(TEST_DIR, "new.ts"), "utf8")).toContain("export const x = 1;");
  });

  it("should fail for non-existent files without createIfMissing", () => {
    const requests: FileEditRequest[] = [
      { filePath: "/nonexistent/file.ts", edits: [{ search: "x", replace: "y" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.errors[0].error).toContain("not found");
  });

  it("should report all errors", () => {
    const requests: FileEditRequest[] = [
      { filePath: path.join(TEST_DIR, "a.ts"), edits: [{ search: "NONEXISTENT", replace: "x" }] },
      { filePath: path.join(TEST_DIR, "b.ts"), edits: [{ search: "ALSO_NONEXISTENT", replace: "y" }] },
    ];

    const result = multiFileEdit(requests);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(2);
  });
});
