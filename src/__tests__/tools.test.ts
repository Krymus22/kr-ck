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
    expect(result).toContain("[ERRO]");
    expect(result).toContain("não encontrado");
  });

  it("lists directory contents when path is directory", async () => {
    fs.writeFileSync(path.join(testDir, "a.txt"), "a");
    fs.mkdirSync(path.join(testDir, "subdir"));
    const result = await lerArquivo({ caminho: testDir });
    expect(result).toContain("[DIRETÓRIO:");
    expect(result).toContain("a.txt");
    expect(result).toContain("subdir/");
  });

  it("handles read errors gracefully", async () => {
    const badPath = path.join(testDir, "no_permission.txt");
    fs.writeFileSync(badPath, "data");
    // Try to read a path that will error
    const result = await lerArquivo({ caminho: "C:\\nonexistent\\path\\file.txt" });
    expect(result).toContain("[ERRO]");
  });
});

// ─── executarComando Tests ────────────────────────────────────────────────

import { executarComando } from "../tools.js";

describe("executarComando", () => {
  it("executes a simple command", async () => {
    const result = await executarComando({ comando: "echo hello" });
    expect(result).toContain("hello");
  });

  it("handles failing command", async () => {
    const result = await executarComando({ comando: "exit 1" });
    expect(result).toContain("[ERRO]");
    expect(result).toContain("Comando falhou");
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
    expect(result.toolMessage).toContain("SUCESSO");
  });

  it("returns error for no valid diff blocks", async () => {
    const filePath = path.join(testDir, "code2.ts");
    fs.writeFileSync(filePath, "content");
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: "no markers" });
    expect(result.written).toBe(false);
    expect(result.toolMessage).toContain("Nenhum bloco");
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
    expect(result.toolMessage).toContain("Bloco SEARCH não encontrado");
  });

  it("creates new file with empty search block", async () => {
    const filePath = path.join(testDir, "new.ts");
    const diff = `<<<<<<< SEARCH
=======
brand new file
>>>>>>> REPLACE`;
    const result = await aplicarDiff({ caminho: filePath, bloco_diff: diff });
    expect(result.written).toBe(true);
    expect(result.toolMessage).toContain("SUCESSO");
  });
});
