/**
 * fileRead-extended.test.ts — Casos edge / integração p/ fileRead.ts.
 * Foco: readFile (3), readPartial (2), readLines (2), edge cases (1).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { readFileAdvanced, readBinarySafe, getFileStats } from "../fileRead.js";

const TEST_DIR = path.join(process.cwd(), "__test_fileext_dir__");
const TEST_FILE = path.join(TEST_DIR, "main.txt");
const CRLF_FILE = path.join(TEST_DIR, "crlf.txt");
const EMPTY_FILE = path.join(TEST_DIR, "empty.txt");
const NO_NEWLINE_FILE = path.join(TEST_DIR, "noeol.txt");

beforeAll(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(TEST_FILE, "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n", "utf8");
  fs.writeFileSync(CRLF_FILE, "row1\r\nrow2\r\nrow3\r\n", "utf8");
  fs.writeFileSync(EMPTY_FILE, "", "utf8");
  fs.writeFileSync(NO_NEWLINE_FILE, "single line no eol", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("fileRead (extended) — readFile casos", () => {
  it("arquivo com CRLF é particionado em linhas corretamente (\\r removido)", () => {
    const out = readFileAdvanced({ path: CRLF_FILE });
    expect(out).toContain("row1");
    expect(out).toContain("row3");
    // Não deve ter \r visível no output
    expect(out).not.toContain("\r");
  });

  it("offset maior que o número de linhas retorna string vazia", () => {
    const out = readFileAdvanced({ path: TEST_FILE, offset: 100 });
    expect(out).toBe("");
  });

  it("arquivo sem EOL final ainda retorna a última linha", () => {
    const out = readFileAdvanced({ path: NO_NEWLINE_FILE });
    expect(out).toContain("single line no eol");
  });
});

describe("fileRead (extended) — readPartial (offset+limit)", () => {
  it("offset=1 limit=1 retorna somente a linha 1", () => {
    const out = readFileAdvanced({ path: TEST_FILE, offset: 1, limit: 1 });
    expect(out).toContain("1: line1");
    expect(out).not.toContain("line2");
  });

  it("offset=8 limit=5 retorna apenas linhas 8-10 (clamp no fim do arquivo)", () => {
    const out = readFileAdvanced({ path: TEST_FILE, offset: 8, limit: 5 });
    expect(out).toContain("8: line8");
    expect(out).toContain("10: line10");
    expect(out).not.toContain("line7");
  });
});

describe("fileRead (extended) — readLines (grep+context)", () => {
  it("grep sem matches retorna string vazia", () => {
    const out = readFileAdvanced({ path: TEST_FILE, grep: "zzzNoMatch" });
    expect(out).toBe("");
  });

  it("contextLines=0 retorna apenas linhas que dão match (sem vizinhos)", () => {
    const out = readFileAdvanced({ path: TEST_FILE, grep: "line5", contextLines: 0 });
    expect(out).toContain("5: line5");
    expect(out).not.toContain("line4");
    expect(out).not.toContain("line6");
  });
});

describe("fileRead (extended) — edge cases", () => {
  it("arquivo vazio retorna uma linha com numeração mas conteúdo vazio", () => {
    const out = readFileAdvanced({ path: EMPTY_FILE });
    // split("\n") em "" retorna [""], então há 1 linha vazia numerada
    expect(out).toContain("1:");
    expect(out).not.toContain("line");
    // O conteúdo após o ": " está vazio
    expect(out.trim()).toBe("1:");
  });

  it("readBinarySafe retorna null para arquivo com null bytes", () => {
    const binFile = path.join(TEST_DIR, "bin.dat");
    fs.writeFileSync(binFile, Buffer.from([0x00, 0x01, 0x00]));
    expect(readBinarySafe(binFile)).toBeNull();
  });

  it("getFileStats retorna número correto de linhas para arquivo sem EOL final", () => {
    const stats = getFileStats(NO_NEWLINE_FILE);
    expect(stats).not.toBeNull();
    // "single line no eol".split("\n") → ["single line no eol"], length 1
    expect(stats!.lines).toBe(1);
  });
});
