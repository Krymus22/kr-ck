/**
 * patternExtractor-extended.test.ts - Expansão de cobertura de src/patternExtractor.ts.
 *
 * Foca em cenários não cobertos por patternExtractor.test.ts:
 *   - PascalCase detection (classes / React components)
 *   - importStyle: relative, absolute, aliased
 *   - quoteStyle: single, double, backtick
 *   - Comment styles: # (Python), /* (block)
 *   - Indentation: tabs
 *   - Error handling: result-type, panic
 *   - Metadados (filesAnalyzed, rawSummary)
 *   - Múltiplas linguagens (TS, Python, Lua, Rust)
 *   - maxFiles limit
 *   - Empty file content
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./../logger.js", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

describe("patternExtractor (extended)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pattern-ext-"));
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- function / class declarations -> naming conventions -----------------

  it("detecta camelCase em arquivo TS com function declarations", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "fns.ts"),
      "function doSomething() {}\nfunction calculateTotal() {}\nconst myVar = 1;\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.namingConvention).toBe("camelCase");
    expect(p.filesAnalyzed).toBe(1);
  });

  it("detecta PascalCase em arquivo com class declarations (React components)", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    // Múltiplas classes PascalCase (>2 chars) superam camelCase
    fs.writeFileSync(
      path.join(tmpDir, "comp.tsx"),
      "class UserProfile {}\nclass InventoryService {}\nclass GameState {}\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.namingConvention).toBe("PascalCase");
  });

  it("diferencia camelCase vs PascalCase vs snake_case", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");

    // camelCase puro
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "const myVar = 1;\nconst anotherVar = 2;\n", "utf8");
    let p = extractPatterns(tmpDir);
    expect(p.namingConvention).toBe("camelCase");

    fs.rmSync(path.join(tmpDir, "a.ts"));

    // snake_case puro (Python)
    fs.writeFileSync(
      path.join(tmpDir, "a.py"),
      "my_variable = 1\ndef do_something():\n    pass\n",
      "utf8"
    );
    p = extractPatterns(tmpDir);
    expect(p.namingConvention).toBe("snake_case");

    fs.rmSync(path.join(tmpDir, "a.py"));

    // PascalCase puro
    fs.writeFileSync(
      path.join(tmpDir, "a.ts"),
      "class Foo {}\nclass Bar {}\nclass BazService {}\n",
      "utf8"
    );
    p = extractPatterns(tmpDir);
    expect(p.namingConvention).toBe("PascalCase");
  });

  // --- import statements ----------------------------------------------------

  it("detecta importStyle='relative' com imports ../ e ./", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "rel.ts"),
      "import { foo } from './foo';\nimport { bar } from '../bar';\nimport { baz } from './utils/baz';\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.importStyle).toBe("relative");
  });

  it("detecta importStyle='aliased' com imports @/", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "ali.ts"),
      "import { foo } from '@/utils/foo';\nimport { bar } from '@components/Bar';\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.importStyle).toBe("aliased");
  });

  it("detecta importStyle='absolute' com imports de pacotes npm", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "abs.ts"),
      "import { foo } from 'lodash';\nimport { bar } from 'react';\nimport { baz } from 'vitest';\nimport { qux } from 'fs';\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.importStyle).toBe("absolute");
  });

  // --- comentários ----------------------------------------------------------

  it("detecta commentStyle='#' em arquivo Python", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "cmt.py"),
      "# comentario python\nx = 1\n# outro comentario\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.commentStyle).toBe("#");
  });

  it("detecta commentStyle='/*' em arquivo com block comments", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "blk.ts"),
      "/* block comment */\nconst x = 1;\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.commentStyle).toBe("/*");
  });

  // --- strings / quotes -----------------------------------------------------

  it("detecta quoteStyle='double' com uso majoritário de aspas duplas", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "dq.ts"),
      'const a = "hello";\nconst b = "world";\nconst c = "foo";\nconst d = "bar";\nconst e = "baz";\nconst f = "qux";\n',
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.quoteStyle).toBe("double");
  });

  it("detecta quoteStyle='single' com uso majoritário de aspas simples", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "sq.ts"),
      "const a = 'hello';\nconst b = 'world';\nconst c = 'foo';\nconst d = 'bar';\nconst e = 'baz';\nconst f = 'qux';\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.quoteStyle).toBe("single");
  });

  it("detecta quoteStyle='backtick' com uso majoritário de template literals", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "bt.ts"),
      "const a = `hello`;\nconst b = `world`;\nconst c = `foo`;\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.quoteStyle).toBe("backtick");
  });

  // --- código vazio / edge cases -------------------------------------------

  it("lida com arquivo vazio (0 bytes) sem crashar", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "empty.ts"), "", "utf8");
    const p = extractPatterns(tmpDir);
    // Arquivo vazio: ainda assim filesAnalyzed=1, mas namingConvention=unknown
    expect(p.filesAnalyzed).toBe(1);
    expect(p.namingConvention).toBe("unknown");
    expect(p.errorHandling).toBe("unknown");
  });

  it("lida com diretório vazio (sem arquivos de código)", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    const p = extractPatterns(tmpDir);
    expect(p.filesAnalyzed).toBe(0);
    expect(p.rawSummary).toMatch(/No source files found/);
  });

  // --- metadados (filesAnalyzed, rawSummary) -------------------------------

  it("retorna filesAnalyzed e rawSummary populados", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "const x = 1;\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "b.ts"), "const y = 2;\n", "utf8");
    const p = extractPatterns(tmpDir);
    expect(p.filesAnalyzed).toBe(2);
    expect(p.rawSummary).toContain("Project Code Patterns");
    expect(p.rawSummary).toContain("Naming:");
    expect(p.rawSummary).toContain("Indentation:");
    expect(p.rawSummary).toContain("Quote style:");
    expect(p.rawSummary).toContain("from 2 files");
  });

  // --- múltiplas linguagens -------------------------------------------------

  it("funciona com múltiplas linguagens (TS, Python, Lua, Rust)", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "const x = 1;\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "b.py"), "x = 1\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "c.luau"), "local x = 1\n", "utf8");
    fs.writeFileSync(path.join(tmpDir, "d.rs"), "let x = 1;\n", "utf8");
    const p = extractPatterns(tmpDir);
    expect(p.filesAnalyzed).toBe(4);
  });

  it("detecta commentStyle='--' em arquivo Lua", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(path.join(tmpDir, "lua.luau"), "-- comentario lua\nlocal x = 1\n", "utf8");
    const p = extractPatterns(tmpDir);
    expect(p.commentStyle).toBe("--");
  });

  // --- error handling adicional --------------------------------------------

  it("detecta errorHandling='result-type' com Result<T,E> / ok,err pattern", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "res.ts"),
      "const result: Result<number, Error> = compute();\nconst [ok, err] = pcall(fn);\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.errorHandling).toBe("result-type");
  });

  it("detecta errorHandling='none' em código simples sem tratamento", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    // Arquivo > 100 chars sem try/catch/result/panic
    fs.writeFileSync(
      path.join(tmpDir, "none.ts"),
      "const x = 1;\nconst y = 2;\nconst z = x + y;\nconsole.log(z);\nconst a = 'hello world';\nconst b = 'foo bar baz qux quux';\nconst c = a + b;\nconst d = c.length;\nexport { x, y, z, a, b, c, d };\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.errorHandling).toBe("none");
  });

  // --- indentation adicional ------------------------------------------------

  it("detecta indentation='tabs' quando linhas começam com tab", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    fs.writeFileSync(
      path.join(tmpDir, "tabs.ts"),
      "function foo() {\n\treturn 1;\n}\nfunction bar() {\n\tconst x = 2;\n\treturn x;\n}\n",
      "utf8"
    );
    const p = extractPatterns(tmpDir);
    expect(p.indentation).toBe("tabs");
  });

  // --- maxFiles limit -------------------------------------------------------

  it("respeita maxFiles limit (para em N arquivos)", async () => {
    const { extractPatterns } = await import("./../patternExtractor.js");
    // Criar 5 arquivos
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `f${i}.ts`), "const x = 1;\n", "utf8");
    }
    const p = extractPatterns(tmpDir, 2);
    expect(p.filesAnalyzed).toBe(2);
  });

  // --- cache TTL ------------------------------------------------------------

  it("getPatternsCached atualiza quando cache expira (após clearPatternCache)", async () => {
    const { getPatternsCached, clearPatternCache } = await import(
      "./../patternExtractor.js"
    );
    clearPatternCache();
    fs.writeFileSync(path.join(tmpDir, "v1.ts"), "const x = 1;\n", "utf8");
    const p1 = getPatternsCached(tmpDir);
    expect(p1.filesAnalyzed).toBe(1);

    // Limpa cache — próxima chamada deve reler
    clearPatternCache();
    fs.unlinkSync(path.join(tmpDir, "v1.ts"));
    const p2 = getPatternsCached(tmpDir);
    expect(p2.filesAnalyzed).toBe(0);
  });
});
