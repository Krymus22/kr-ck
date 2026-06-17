/** progressiveContext.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("./../lspAst.js", () => ({
  parseFile: vi.fn().mockResolvedValue({
    language: "typescript",
    lineCount: 50,
    symbols: [
      { name: "foo", type: "function", line: 10 },
      { name: "bar", type: "function", line: 30 },
    ],
  }),
}));

describe("progressiveContext", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prog-ctx-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("readSymbolFromFile should return full file when no symbol specified", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\n", "utf8");
    const result = await readSymbolFromFile(filePath, null);
    expect(result.partial).toBe(false);
    expect(result.content).toContain("const x = 1");
  });

  it("readSymbolFromFile should extract specific function", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    // File has foo at line 10, bar at line 30 (from mock AST)
    // Write enough lines so the extraction works
    const lines = ["import { something } from 'lib';", ""];
    for (let i = 3; i <= 45; i++) {
      if (i === 10) lines.push("function foo() {");
      else if (i === 12) lines.push("  return 1;");
      else if (i === 13) lines.push("}");
      else if (i === 30) lines.push("function bar() {");
      else if (i === 32) lines.push("  return 2;");
      else if (i === 33) lines.push("}");
      else lines.push(`// line ${i}`);
    }
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
    const result = await readSymbolFromFile(filePath, "foo");
    expect(result.partial).toBe(true);
    expect(result.symbolName).toBe("foo");
    expect(result.savingsPercent).toBeGreaterThan(0);
  });

  it("readSymbolFromFile should fall back to full read when symbol not found", async () => {
    const { readSymbolFromFile } = await import("./../progressiveContext.js");
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, "const x = 1;\n", "utf8");
    const result = await readSymbolFromFile(filePath, "nonexistent");
    expect(result.partial).toBe(false);
    expect(result.symbolName).toBeNull();
  });

  it("detectSymbolRequest should detect 'function X from file'", async () => {
    const { detectSymbolRequest } = await import("./../progressiveContext.js");
    const result = detectSymbolRequest("read function GetCoins from InventoryService.luau");
    expect(result).not.toBeNull();
    expect(result!.symbolName).toBe("GetCoins");
    expect(result!.filePath).toBe("InventoryService.luau");
  });

  it("detectSymbolRequest should detect 'função X de file' (PT)", async () => {
    const { detectSymbolRequest } = await import("./../progressiveContext.js");
    const result = detectSymbolRequest("ler a função GetCoins de InventoryService.luau");
    expect(result).not.toBeNull();
    expect(result!.symbolName).toBe("GetCoins");
  });

  it("detectSymbolRequest should return null for generic messages", async () => {
    const { detectSymbolRequest } = await import("./../progressiveContext.js");
    expect(detectSymbolRequest("fix the bug")).toBeNull();
    expect(detectSymbolRequest("")).toBeNull();
  });
});
