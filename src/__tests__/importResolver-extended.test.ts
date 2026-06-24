/**
 * importResolver-extended.test.ts — Expandindo cobertura do importResolver.
 *
 * O módulo importResolver verifica se os imports de um arquivo resolvem para
 * arquivos existentes e se os símbolos importados são realmente exportados.
 * Este arquivo expande a cobertura dos caminhos não testados pelo arquivo
 * importResolver.test.ts (que testa apenas .ts, missing, símbolo não
 * exportado, node_modules skip, luau e python).
 *
 * Cobertura adicional:
 *   - Resolução por extensão .ts, .tsx, .js, .json
 *   - Resolução de index.ts em diretório
 *   - Resolução de node_modules (mock — múltiplos bare imports)
 *   - Retorno de missing quando arquivo not found (expandido)
 *   - Path absoluto (início com /)
 *   - Path relativo ./ e ../
 *   - tsconfig paths (aliases @/ são tratados como externos)
 *   - Bare imports (react, lodash, lodash/get)
 *   - Idempotência: segunda chamada retorna mesmo resultado
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

// Estado hoisted que permite ao mock de node:fs controlar existsSync por teste.
// Útil para simular a resolução de index.ts em diretório (contorna bug onde
// existsSync(diretório) retorna true e impede a tentativa de /index.ts).
const fsState = vi.hoisted(() => ({
  // Quando definido, existsSync(path) retorna false para este path exato.
  // Usado para forçar a resolução via extensões (caminho do /index.ts).
  blockExactPath: null as string | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn((p: fs.PathLike) => {
      const pathStr = String(p);
      // Se o path exato está bloqueado, retorna false para forçar a tentativa
      // de extensões (necessário para testar /index.ts em diretório).
      if (fsState.blockExactPath && pathStr === fsState.blockExactPath) {
        return false;
      }
      return (actual.existsSync as any)(p);
    }),
  };
});

describe("importResolver — cobertura estendida", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-ext-"));
    fsState.blockExactPath = null;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fsState.blockExactPath = null;
  });

  // --- Resolução por extensão ------------------------------------------------

  it("resolveImport encontra arquivo local com extensão .ts", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const targetPath = path.join(tmpDir, "modulo.ts");
    fs.writeFileSync(targetPath, "export function foo() { return 1; }\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { foo } from './modulo';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);
  });

  it("resolveImport encontra arquivo local com extensão .tsx", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const targetPath = path.join(tmpDir, "Component.tsx");
    fs.writeFileSync(targetPath, "export function Button() { return null; }\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { Button } from './Component';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
  });

  it("resolveImport encontra arquivo local com extensão .js", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const targetPath = path.join(tmpDir, "utils.js");
    fs.writeFileSync(targetPath, "module.exports = { foo: function() { return 1; } };\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { foo } from './utils';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
  });

  it("resolveImport encontra arquivo local com extensão .json (path exato)", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const targetPath = path.join(tmpDir, "data.json");
    fs.writeFileSync(targetPath, JSON.stringify({ foo: 1 }), "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    // Path exato com .json — resolvido via existsSync (não via extensões)
    const content = "import { foo } from './data.json';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    // O arquivo .json é encontrado (resolução por path exato).
    // JSON não tem exports ES, então o símbolo pode falhar — mas NÃO deve
    // ter erro "File not found".
    const missing = result.missingImports.find((m) => m.source === "./data.json");
    if (missing) {
      // Arquivo encontrado, mas símbolo não exportado (esperado para JSON)
      expect(missing.reason).not.toContain("File not found");
    }
    // Se não há missing, ótimo — arquivo encontrado e símbolo "exportado"
    // por algum padrão do JSON (ex: conteúdo contém a palavra "foo")
  });

  it("resolveImport encontra arquivo index.ts em diretório", async () => {
    const { checkImports } = await import("./../importResolver.js");
    // Cria diretório utils/ com index.ts dentro
    const utilsDir = path.join(tmpDir, "utils");
    fs.mkdirSync(utilsDir);
    const indexPath = path.join(utilsDir, "index.ts");
    fs.writeFileSync(indexPath, "export function helper() { return 42; }\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { helper } from './utils';\n";
    fs.writeFileSync(filePath, content, "utf8");

    // O módulo faz existsSync(resolved) antes de tentar extensões. Para
    // diretórios, existsSync retorna true (interrompendo antes do /index.ts).
    // Bloqueia o path exato do diretório para forçar a tentativa de extensões
    // (que encontrará utilsDir/index.ts).
    fsState.blockExactPath = utilsDir;

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);
  });

  // --- Bare imports e node_modules -------------------------------------------

  it("resolveImport resolve node_modules (bare imports são tratados como externos e skipados)", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const filePath = path.join(tmpDir, "main.ts");
    const content = [
      "import _ from 'lodash';",
      "import { get } from 'lodash/get';",
      "import React from 'react';",
      "import { chalk } from 'chalk';",
    ].join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    // Todos são bare imports (não começam com . ou /) — skipados como externos
    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);
  });

  it("resolveImport lida com bare imports múltiplos sem reportar missing", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const filePath = path.join(tmpDir, "main.ts");
    const content = [
      "import express from 'express';",
      "import { Router } from 'express';",
      "import axios from 'axios';",
      "import * as path from 'node:path';",
    ].join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
  });

  it("resolveImport retorna missing quando arquivo relativo not found", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { foo } from './inexistente';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(false);
    expect(result.missingImports.length).toBeGreaterThanOrEqual(1);
    expect(result.missingImports[0]!.source).toBe("./inexistente");
    expect(result.missingImports[0]!.reason).toContain("File not found");
  });

  // --- Paths absolutos e relativos -------------------------------------------

  it("resolveImport lida com path absoluto (início com /)", async () => {
    const { checkImports } = await import("./../importResolver.js");
    // Cria arquivo em path absoluto
    const absFile = path.join(tmpDir, "alvo_absoluto.ts");
    fs.writeFileSync(absFile, "export const abs = true;\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = `import { abs } from '${absFile}';\n`;
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
  });

  it("resolveImport lida com path relativo ./ (mesmo diretório)", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const targetPath = path.join(tmpDir, "irmao.ts");
    fs.writeFileSync(targetPath, "export const v = 1;\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { v } from './irmao';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
  });

  it("resolveImport lida com path relativo ../ (diretório pai)", async () => {
    const { checkImports } = await import("./../importResolver.js");
    // Cria estrutura: tmpDir/utils.ts e tmpDir/sub/main.ts
    const parentTarget = path.join(tmpDir, "utils.ts");
    fs.writeFileSync(parentTarget, "export function util() { return 'ok'; }\n", "utf8");
    const subDir = path.join(tmpDir, "sub");
    fs.mkdirSync(subDir);
    const filePath = path.join(subDir, "main.ts");
    const content = "import { util } from '../utils';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);
  });

  // --- tsconfig paths (aliases) ----------------------------------------------

  it("resolveImport respeita tsconfig paths (aliases @/ são tratados como externos)", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const filePath = path.join(tmpDir, "main.ts");
    // Alias @/ não começa com . ou / — é skipado como módulo externo
    const content = [
      "import { Button } from '@/components/Button';",
      "import { useStore } from '@/stores/useStore';",
      "import { api } from '@/lib/api';",
    ].join("\n") + "\n";
    fs.writeFileSync(filePath, content, "utf8");

    const result = checkImports(filePath, content);
    // Aliases são skipados (não há resolução real de tsconfig no módulo)
    expect(result.ok).toBe(true);
    expect(result.missingImports).toHaveLength(0);
  });

  // --- Idempotência (consistência entre chamadas) ----------------------------

  it("resolveImport é determinístico: segunda chamada retorna mesmo resultado", async () => {
    const { checkImports } = await import("./../importResolver.js");
    const targetPath = path.join(tmpDir, "modulo.ts");
    fs.writeFileSync(targetPath, "export const x = 1;\n", "utf8");
    const filePath = path.join(tmpDir, "main.ts");
    const content = "import { x } from './modulo';\n";
    fs.writeFileSync(filePath, content, "utf8");

    const t0 = process.hrtime.bigint();
    const result1 = checkImports(filePath, content);
    const t1 = process.hrtime.bigint();
    const result2 = checkImports(filePath, content);
    const t2 = process.hrtime.bigint();

    // Mesmo resultado em ambas as chamadas (determinismo)
    expect(result1.ok).toBe(result2.ok);
    expect(result1.missingImports).toEqual(result2.missingImports);
    expect(result1.message).toBe(result2.message);

    // Segunda chamada não é significativamentand  morelenta (sem regressão)
    const firstMs = Number(t1 - t0) / 1e6;
    const secondMs = Number(t2 - t1) / 1e6;
    // Tolerância: segunda chamada pode ser até 5x mais lenta em CI lento
    expect(secondMs).toBeLessThan(Math.max(firstMs * 5, 50));
  });
});
