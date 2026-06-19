/**
 * contentSearch-extended.test.ts — Cobertura adicional do módulo contentSearch.
 *
 * Foca em:
 *   - searchContent (grepSearch): 3 casos novos
 *   - regex search: 2 casos novos
 *   - case insensitive: 2 casos novos
 *   - edge cases: 1 caso
 *
 * Não duplica testes do arquivo contentSearch.test.ts básico.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { grepSearch } from "../contentSearch.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    readFileSync: (filePath: any, ...args: any[]) => {
      if (typeof filePath === "string" && filePath.includes("unreadable_ext")) {
        throw new Error("EACCES: permission denied");
      }
      return actual.readFileSync(filePath, ...args);
    },
  };
});

const TEST_DIR = path.join(process.cwd(), "__test_grepdir_ext__");

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_DIR, "sub"), { recursive: true });
  fs.writeFileSync(
    path.join(TEST_DIR, "tokens.ts"),
    "const foo = 1;\nexport function bar() {}\nconst foobar = 3;\nconst FooBar = 4;\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(TEST_DIR, "sub", "deep.ts"),
    "const helloWorld = 1;\nconst HelloWorld = 2;\n",
    "utf8"
  );
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("contentSearch-extended: searchContent (grepSearch)", () => {
  it("wholeWord=true corresponde apenas a palavra inteira (ignora 'foobar' ao buscar 'foo')", () => {
    const results = grepSearch({
      pattern: "foo",
      path: path.join(TEST_DIR, "tokens.ts"),
      wholeWord: true,
    });
    // Apenas a linha "const foo = 1;" deve corresponder (não "const foobar = 3;")
    expect(results.length).toBe(1);
    expect(results[0].content).toContain("const foo = 1;");
    expect(results[0].content).not.toContain("foobar");
  });

  it("ignore customizado exclui diretórios específicos da busca", () => {
    // Por padrão, busca em TEST_DIR encontra matches em tokens.ts e sub/deep.ts (se o padrão casar)
    const all = grepSearch({ pattern: "const", path: TEST_DIR });
    expect(all.length).toBeGreaterThan(0);

    // Com ignore=["sub"], os arquivos em sub/ são excluídos
    const noSub = grepSearch({ pattern: "const", path: TEST_DIR, ignore: ["sub"] });
    expect(noSub.every((r) => !r.file.includes("sub/"))).toBe(true);
  });

  it("retorna matches de todos os arquivos do diretório recursivamente por padrão", () => {
    const results = grepSearch({ pattern: "const", path: TEST_DIR });
    // Deve incluir matches em tokens.ts e sub/deep.ts
    const files = new Set(results.map((r) => r.file));
    expect(files.size).toBeGreaterThanOrEqual(2);
  });
});

describe("contentSearch-extended: regex search", () => {
  it("suporta padrão regex com curinga 'foo.*bar' para casar linhas que começam com foo e terminam com bar", () => {
    const results = grepSearch({
      pattern: "foo.*bar",
      path: path.join(TEST_DIR, "tokens.ts"),
    });
    // "const foobar = 3;" corresponde; "const foo = 1;" não (não tem 'bar' depois)
    // "export function bar() {}" não corresponde (não tem 'foo' antes)
    const contents = results.map((r) => r.content);
    expect(contents.some((c) => c.includes("foobar"))).toBe(true);
    expect(contents.some((c) => c === "const foo = 1;")).toBe(false);
  });

  it("suporta âncora ^ para casar apenas início de linha", () => {
    const results = grepSearch({
      pattern: "^const foo",
      path: path.join(TEST_DIR, "tokens.ts"),
    });
    // Apenas a linha "const foo = 1;" começa com "const foo"
    // ("const foobar = 3;" também começa com "const foo" — depends on interpretation)
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.content.startsWith("const foo"))).toBe(true);
  });
});

describe("contentSearch-extended: case insensitive", () => {
  it("padrão em minúsculas corresponde a conteúdo em CamelCase quando caseInsensitive=true", () => {
    const results = grepSearch({
      pattern: "helloworld",
      path: path.join(TEST_DIR, "sub", "deep.ts"),
      caseInsensitive: true,
    });
    // "const helloWorld = 1;" e "const HelloWorld = 2;" devem corresponder
    expect(results.length).toBe(2);
  });

  it("padrão em MAIÚSCULAS corresponde a conteúdo em minúsculas quando caseInsensitive=true", () => {
    const results = grepSearch({
      pattern: "CONST",
      path: path.join(TEST_DIR, "tokens.ts"),
      caseInsensitive: true,
    });
    // Todas as linhas "const ..." devem corresponder
    expect(results.length).toBeGreaterThanOrEqual(3);
  });
});

describe("contentSearch-extended: edge cases", () => {
  it("arquivos binários (com null byte) são silenciosamente ignorados", () => {
    const binaryFile = path.join(TEST_DIR, "binary.bin");
    // Cria arquivo com null byte no meio
    const buf = Buffer.from("SECRET\0SECRET2\n");
    fs.writeFileSync(binaryFile, buf);

    const results = grepSearch({ pattern: "SECRET", path: binaryFile });
    expect(results.length).toBe(0);

    fs.unlinkSync(binaryFile);
  });
});
