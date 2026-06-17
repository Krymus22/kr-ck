/** tddMode.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

describe("tddMode", () => {
  beforeEach(async () => {
    const { clearTDD } = await import("./../tddMode.js");
    clearTDD();
  });

  it("isTestable should return true for .ts", async () => {
    const { isTestable } = await import("./../tddMode.js");
    expect(isTestable("file.ts")).toBe(true);
    expect(isTestable("file.luau")).toBe(true);
    expect(isTestable("file.py")).toBe(true);
  });

  it("isTestable should return false for .txt", async () => {
    const { isTestable } = await import("./../tddMode.js");
    expect(isTestable("file.txt")).toBe(false);
    expect(isTestable("file.json")).toBe(false);
  });

  it("registerTDD should store spec", async () => {
    const { registerTDD, getTDD } = await import("./../tddMode.js");
    registerTDD("test.spec.ts", "impl.ts", "typescript", ["test 1", "test 2"]);
    expect(getTDD()).not.toBeNull();
    expect(getTDD()!.testFile).toBe("test.spec.ts");
    expect(getTDD()!.testCases.length).toBe(2);
  });

  it("hasTDD should return false initially", async () => {
    const { hasTDD } = await import("./../tddMode.js");
    expect(hasTDD()).toBe(false);
  });

  it("hasTDD should return true after register", async () => {
    const { registerTDD, hasTDD } = await import("./../tddMode.js");
    registerTDD("t.spec.ts", "i.ts", "typescript", []);
    expect(hasTDD()).toBe(true);
  });

  it("formatTDD should format all fields", async () => {
    const { registerTDD, formatTDD } = await import("./../tddMode.js");
    registerTDD("test.spec.ts", "impl.ts", "typescript", ["should return 0 for empty", "should handle nil"]);
    const result = formatTDD();
    expect(result).toContain("[TDD ACTIVE]");
    expect(result).toContain("test.spec.ts");
    expect(result).toContain("should return 0 for empty");
    expect(result).toContain("should handle nil");
  });

  it("testFileExists should check disk", async () => {
    const { registerTDD, testFileExists } = await import("./../tddMode.js");
    registerTDD("/nonexistent/file.spec.ts", "impl.ts", "typescript", []);
    expect(testFileExists()).toBe(false);
  });

  it("testFileExists should return true when file exists", async () => {
    const { registerTDD, testFileExists } = await import("./../tddMode.js");
    const tmpFile = path.join(os.tmpdir(), `tdd-test-${Date.now()}.spec.ts`);
    fs.writeFileSync(tmpFile, "test", "utf8");
    registerTDD(tmpFile, "impl.ts", "typescript", []);
    expect(testFileExists()).toBe(true);
    fs.unlinkSync(tmpFile);
  });

  it("getTestFilePath should generate __tests__ path", async () => {
    const { getTestFilePath } = await import("./../tddMode.js");
    const result = getTestFilePath("src/InventoryService.luau");
    expect(result).toContain("__tests__");
    expect(result).toContain("InventoryService.spec.luau");
  });

  it("clearTDD should remove spec", async () => {
    const { registerTDD, clearTDD, hasTDD } = await import("./../tddMode.js");
    registerTDD("t.spec.ts", "i.ts", "typescript", []);
    clearTDD();
    expect(hasTDD()).toBe(false);
  });
});
