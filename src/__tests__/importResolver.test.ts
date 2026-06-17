/** importResolver.test.ts */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

describe("importResolver", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-"));
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it("should return ok when no imports", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const result = checkImports("test.ts", "const x = 1;\n");
    expect(result.ok).toBe(true);
  });

  it("should detect missing import file (TypeScript)", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const filePath = path.join(tmpDir, "main.ts");
    fs.writeFileSync(filePath, "import { foo } from './missing';\n", "utf8");
    const result = checkImports(filePath, "import { foo } from './missing';\n");
    expect(result.ok).toBe(false);
    expect(result.missingImports.length).toBe(1);
    expect(result.missingImports[0]!.symbol).toBe("foo");
  });

  it("should pass when import file exists and exports symbol", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const targetPath = path.join(tmpDir, "utils.ts");
    fs.writeFileSync(targetPath, "export function foo() { return 1; }\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { foo } from './utils';\n";
    fs.writeFileSync(filePath, content, "utf8");
    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
  });

  it("should detect missing exported symbol", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const targetPath = path.join(tmpDir, "utils.ts");
    fs.writeFileSync(targetPath, "export function bar() { return 1; }\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { foo } from './utils';\n";
    fs.writeFileSync(filePath, content, "utf8");
    const result = checkImports(filePath, content);
    expect(result.ok).toBe(false);
    expect(result.missingImports[0]!.symbol).toBe("foo");
    expect(result.missingImports[0]!.reason).toContain("not exported");
  });

  it("should skip external modules (node_modules)", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const result = checkImports("test.ts", "import React from 'react';\n");
    expect(result.ok).toBe(true);
  });

  it("should parse Luau require", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const filePath = path.join(tmpDir, "main.luau");
    const content = "local M = require(script.Parent.Utils)\n";
    const result = checkImports(filePath, content);
    // script.Parent.Utils is not a relative path, should skip
    expect(result.ok).toBe(true);
  });

  it("should parse Python imports", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const result = checkImports("main.py", "from utils import foo\n");
    // 'utils' is not relative, should skip
    expect(result.ok).toBe(true);
  });
});
