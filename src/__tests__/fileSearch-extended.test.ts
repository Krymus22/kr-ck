/**
 * fileSearch-extended.test.ts — Cobertura adicional do módulo fileSearch.
 *
 * Foca em:
 *   - globSearch (3 casos novos)
 *   - findFilesByExtension (2 casos novos)
 *   - findFilesByName (2 casos novos)
 *   - edge cases (1 caso)
 *
 * Não duplica testes do arquivo fileSearch.test.ts básico.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  globSearch,
  matchesGlob,
  findFilesByExtension,
  findFilesByName,
} from "../fileSearch.js";

const TEST_DIR = path.join(process.cwd(), "__test_globdir_ext__");

beforeAll(() => {
  fs.mkdirSync(path.join(TEST_DIR, "src", "components"), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, "src", "utils"), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, "docs"), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, "node_modules", "pkg"), { recursive: true });

  fs.writeFileSync(path.join(TEST_DIR, "index.ts"), "export {};", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "src", "app.ts"), "export {};", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "src", "components", "Button.tsx"), "export {};", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "src", "utils", "helper.ts"), "export {};", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "docs", "README.md"), "# Test", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "docs", "API.md"), "# API", "utf8");
  fs.writeFileSync(path.join(TEST_DIR, "node_modules", "pkg", "index.js"), "module.exports={}", "utf8");
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("fileSearch-extended: globSearch", () => {
  it("retorna caminhos relativos ao cwd informado (não absolutos)", () => {
    const results = globSearch({ pattern: "**/*.ts", cwd: TEST_DIR });
    expect(results.length).toBeGreaterThan(0);
    // Todos os resultados devem ser caminhos relativos (sem começo com /)
    for (const r of results) {
      expect(r.startsWith("/")).toBe(false);
      expect(path.isAbsolute(r)).toBe(false);
    }
  });

  it("respeita maxDepth limitando a profundidade da recursão", () => {
    // maxDepth=0 não desce em subdiretórios; só deve encontrar arquivos na raiz
    const results = globSearch({ pattern: "**/*.ts", cwd: TEST_DIR, maxDepth: 0 });
    expect(results).toContain("index.ts");
    expect(results.some((r) => r.startsWith("src/"))).toBe(false);
  });

  it("suporta padrão com subdiretório específico (ex.: 'src/*.ts')", () => {
    const results = globSearch({ pattern: "src/*.ts", cwd: TEST_DIR });
    expect(results).toContain("src/app.ts");
    // Não deve incluir arquivos em subdiretórios mais profundos (src/components/Button.tsx)
    expect(results.some((r) => r.includes("components/"))).toBe(false);
    expect(results.some((r) => r.includes("utils/"))).toBe(false);
  });
});

describe("fileSearch-extended: findFilesByExtension", () => {
  it("encontra arquivos .md no diretório docs", () => {
    const results = findFilesByExtension(".md", TEST_DIR);
    expect(results).toContain("docs/README.md");
    expect(results).toContain("docs/API.md");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("excludes node_modules por padrão ao buscar por extensão", () => {
    const results = findFilesByExtension(".js", TEST_DIR);
    // node_modules/pkg/index.js NÃO deve aparecer
    expect(results.some((r) => r.includes("node_modules"))).toBe(false);
    // Pode estar vazio se não há .js fora de node_modules
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("fileSearch-extended: findFilesByName", () => {
  it("encontra arquivo por nome exato em diretório aninhado", () => {
    const results = findFilesByName("Button.tsx", TEST_DIR);
    expect(results).toContain("src/components/Button.tsx");
    expect(results.length).toBe(1);
  });

  it("encontra múltiplos arquivos com mesmo nome em diretórios diferentes", () => {
    // Cria dois arquivos com o mesmo nome em pastas diferentes
    fs.mkdirSync(path.join(TEST_DIR, "a"), { recursive: true });
    fs.mkdirSync(path.join(TEST_DIR, "b"), { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, "a", "dup.ts"), "export {};", "utf8");
    fs.writeFileSync(path.join(TEST_DIR, "b", "dup.ts"), "export {};", "utf8");

    const results = findFilesByName("dup.ts", TEST_DIR);
    expect(results).toContain("a/dup.ts");
    expect(results).toContain("b/dup.ts");
    expect(results.length).toBe(2);
  });
});

describe("fileSearch-extended: edge cases", () => {
  it("matchesGlob normaliza separadores Windows (\\) para / antes de comparar", () => {
    // Caminho estilo Windows com barras invertidas
    expect(matchesGlob("src\\utils\\helper.ts", "src/**/helper.ts")).toBe(true);
    expect(matchesGlob("src\\app.ts", "*.ts")).toBe(false);
    expect(matchesGlob("src\\app.ts", "src/*.ts")).toBe(true);
  });
});
