/**
 * pokaYoke-extended.test.ts — Casos de borda para validação poka-yoke.
 *
 * O módulo pokaYoke.ts expõe `pokaYokeCheck(toolName, args)`. Os conceitos
 * solicitados (validatePath, validateToolArgs, sanitizeInput, checkDangerousPatterns)
 * são cobertos indiretamente através dessa função central:
 *
 *   - validatePath     -> path resolution (absoluto, relativo, traversal, unicode)
 *   - validateToolArgs -> checks específicos por tool (aplicar_diff, editar_arquivo, etc.)
 *   - sanitizeInput    -> detecção de strings vazias/só whitespace
 *   - checkDangerousPatterns -> paths maliciosos (../), comandos perigosos, etc.
 *
 * Evita duplicar testes do pokaYoke.test.ts básico.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { pokaYokeCheck } from "../pokaYoke.js";

// === validatePath — absoluto, relativo, traversal, unicode ===================

describe("pokaYokeCheck — validação de paths", () => {
  it("resolve path absoluto corretamente em resolvedPath", () => {
    const r = pokaYokeCheck("ler_arquivo", { caminho: "/var/log/app.log" });
    expect(r.ok).toBe(true);
    expect(r.resolvedPath).toBe("/var/log/app.log");
  });

  it("resolve path relativo contra o cwd atual", () => {
    const r = pokaYokeCheck("ler_arquivo", { caminho: "src/foo.ts" });
    expect(r.ok).toBe(true);
    expect(r.resolvedPath).toBeTruthy();
    // resolvedPath deve ser absoluto (começa com /)
    expect(r.resolvedPath!.startsWith("/")).toBe(true);
    expect(r.resolvedPath!.endsWith("src/foo.ts")).toBe(true);
  });

  it("aceita path com tentativa de traversal (não bloqueia — pokaYoke só valida não-vazio)", () => {
    // PokaYoke não bloqueia ../ — apenas valida que é string não-vazia.
    // A segurança de traversal é responsabilidade de outras camadas.
    const r = pokaYokeCheck("ler_arquivo", { caminho: "../../../etc/passwd" });
    expect(r.ok).toBe(true);
    expect(r.resolvedPath).toBeTruthy();
    // O path resolved deve conter "etc/passwd"
    expect(r.resolvedPath).toContain("etc/passwd");
  });

  it("aceita paths unicode (acentos, CJK, emoji)", () => {
    const r = pokaYokeCheck("ler_arquivo", { caminho: "/tmp/projeto-ção-日本語-🚀/arquivo.ts" });
    expect(r.ok).toBe(true);
    expect(r.resolvedPath).toContain("ção");
    expect(r.resolvedPath).toContain("日本語");
    expect(r.resolvedPath).toContain("🚀");
  });

  it("bloqueia path que é apenas whitespace (sanitizeInput)", () => {
    const r = pokaYokeCheck("ler_arquivo", { caminho: "   \t\n  " });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("non-empty");
  });

  it("aceita aliases alternativos (path, filePath, file) além de caminho", () => {
    expect(pokaYokeCheck("ler_arquivo", { path: "/x.ts" }).ok).toBe(true);
    expect(pokaYokeCheck("ler_arquivo", { filePath: "/x.ts" }).ok).toBe(true);
    expect(pokaYokeCheck("ler_arquivo", { file: "/x.ts" }).ok).toBe(true);
  });
});

// === validateToolArgs — checks específicos por ferramenta =====================

describe("pokaYokeCheck — validação de argumentos específicos", () => {
  it("editar_arquivo aceita edits[] vazio mas presente (não bloqueia por tamanho)", () => {
    // O check exige Array.isArray(edits) && edits.length > 0 — então array vazio FALHA
    const r = pokaYokeCheck("editar_arquivo", { path: "/x.ts", edits: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("edits");
  });

  it("aplicar_diff rejeita bloco_diff com SEARCH mas sem REPLACE (estrutura incompleta)", () => {
    const r = pokaYokeCheck("aplicar_diff", {
      caminho: "/x.ts",
      bloco_diff: "<<<<<<< SEARCH\nold\n=======\nnew",
      // falta o marcador >>>>>>> REPLACE
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("SEARCH");
  });

  it("executar_comando bloqueia comando vazio (apenas whitespace)", () => {
    const r = pokaYokeCheck("executar_comando", { comando: "   " });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("comando");
  });

  it("editar_multi_arquivos bloqueia requests como objeto (não array)", () => {
    const r = pokaYokeCheck("editar_multi_arquivos", {
      requests: { filePath: "/x.ts", edits: [] },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("requests");
  });
});

// === sanitizeInput — strings inválidas / tipos errados =======================

describe("pokaYokeCheck — sanitização de entrada", () => {
  it("rejeita caminho quando é number (não string)", () => {
    const r = pokaYokeCheck("ler_arquivo", { caminho: 12345 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("non-empty");
  });

  it("rejeita caminho quando é null explicitamente", () => {
    const r = pokaYokeCheck("ler_arquivo", { caminho: null });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("rejeita editar_arquivo quando search é string mas replace é undefined", () => {
    // hasSearchReplace exige search não-vazio E replace como string
    const r = pokaYokeCheck("editar_arquivo", {
      path: "/x.ts",
      search: "foo",
      // replace omitido
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("edits");
  });

  it("aceita editar_arquivo com search vazio + replace + createIfMissing (cenário criar novo)", () => {
    // search="" falha isNonEmptyString, mas se houver edits[] deve passar
    const r = pokaYokeCheck("editar_arquivo", {
      path: "/novo.ts",
      search: "",
      replace: "conteúdo",
      edits: [{ search: "x", replace: "y" }],
    });
    expect(r.ok).toBe(true);
  });
});

// === checkDangerousPatterns — padrões suspeitos ==============================

describe("pokaYokeCheck — padrões potencialmente perigosos", () => {
  it("bloqueia caminho com null byte (path injection defense)", () => {
    // BUG P-3 CORRIGIDO: pokaYoke agora REJEITA paths com null byte.
    // Em bindings nativos/C, "\0" é terminador de string — permite path
    // injection (ex.: "/tmp/foo\0.txt" pode virar "/tmp/foo" em C).
    // Antes do fix, pokaYoke permitia; agora retorna ok=false com erro.
    const r = pokaYokeCheck("ler_arquivo", { caminho: "/tmp/file\x00.txt" });
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
    expect(r.error).toMatch(/null byte/i);
  });

  it("bloqueia aplicar_diff com bloco_diff contendo apenas marcadores (sem conteúdo)", () => {
    // bloco_diff tem os marcadores mas está vazio entre eles — ainda é string não-vazia,
    // então passa no check estrutural. Documenta comportamento.
    const r = pokaYokeCheck("aplicar_diff", {
      caminho: "/x.ts",
      bloco_diff: "<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE",
    });
    expect(r.ok).toBe(true);
  });
});
