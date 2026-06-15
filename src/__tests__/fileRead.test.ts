/**
 * fileRead.test.ts — Tests for advanced file reading module.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileAdvanced, readBinarySafe, getFileStats } from "../fileRead.js";

const TEST_DIR = path.join(process.cwd(), "__test_filedir__");
const TEST_FILE = path.join(TEST_DIR, "test.txt");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE, "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("readFileAdvanced", () => {
  it("should read entire file with line numbers", () => {
    const result = readFileAdvanced({ path: TEST_FILE });
    expect(result).toContain("1: line1");
    expect(result).toContain("10: line10");
  });

  it("should read with offset", () => {
    const result = readFileAdvanced({ path: TEST_FILE, offset: 3 });
    expect(result).toContain("3: line3");
    expect(result).not.toContain("1: line1");
  });

  it("should read with limit", () => {
    const result = readFileAdvanced({ path: TEST_FILE, offset: 1, limit: 3 });
    expect(result).toContain("1: line1");
    expect(result).toContain("3: line3");
    expect(result).not.toContain("4: line4");
  });

  it("should filter with grep regex", () => {
    const result = readFileAdvanced({ path: TEST_FILE, grep: "line[135]" });
    expect(result).toContain("line1");
    expect(result).toContain("line3");
    expect(result).toContain("line5");
  });

  it("should handle non-existent file", () => {
    const result = readFileAdvanced({ path: "/nonexistent/file.txt" });
    expect(result).toContain("[ERRO]");
  });

  it("should list directory contents", () => {
    const result = readFileAdvanced({ path: TEST_DIR });
    expect(result).toContain("[DIRETÓRIO");
    expect(result).toContain("test.txt");
  });

  it("should handle grep with context", () => {
    const result = readFileAdvanced({ path: TEST_FILE, grep: "line5", contextLines: 1 });
    expect(result).toContain("line4");
    expect(result).toContain("line5");
    expect(result).toContain("line6");
  });
});

describe("readBinarySafe", () => {
  it("should return content for text files", () => {
    const content = readBinarySafe(TEST_FILE);
    expect(content).toContain("line1");
  });

  it("should return null for binary files", () => {
    const binFile = path.join(TEST_DIR, "bin.dat");
    fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    const content = readBinarySafe(binFile);
    expect(content).toBeNull();
  });
});

describe("getFileStats", () => {
  it("should return file stats", () => {
    const stats = getFileStats(TEST_FILE);
    expect(stats).not.toBeNull();
    expect(stats!.lines).toBe(11); // 10 lines + trailing newline
    expect(stats!.size).toBeGreaterThan(0);
  });

  it("should return null for directories", () => {
    const stats = getFileStats(TEST_DIR);
    expect(stats).toBeNull();
  });

  it("should return null for non-existent files", () => {
    const stats = getFileStats("/nonexistent.txt");
    expect(stats).toBeNull();
  });
});
