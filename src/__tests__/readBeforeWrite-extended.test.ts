/**
 * readBeforeWrite-extended.test.ts — Cobertura adicional do módulo readBeforeWrite.
 *
 * Foca em:
 *   - enforceReadBeforeWrite (checkReadBeforeWrite): 3 casos
 *   - trackReads (recordRead com todos os READ_TOOLS): 2 casos
 *   - validateWrite (recordWrite com WRITE_TOOLS): 2 casos
 *   - edge cases: 1 caso
 *
 * Não duplica testes do arquivo readBeforeWrite.test.ts básico.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import * as logMock from "../logger.js";
import {
  recordRead,
  recordWrite,
  checkReadBeforeWrite,
  hasBeenRead,
  clearReadPaths,
  setReadBeforeWriteEnabled,
} from "../readBeforeWrite.js";

describe("readBeforeWrite-extended: enforceReadBeforeWrite (checkReadBeforeWrite)", () => {
  beforeEach(() => {
    clearReadPaths();
    setReadBeforeWriteEnabled(true);
  });

  it("bloqueia aplicar_diff quando args não traz caminho nenhum (allowed=true, path vazio)", () => {
    // Quando nenhum caminho é fornecido, a função retorna allowed=true (nada a checar).
    const r = checkReadBeforeWrite("aplicar_diff", {});
    expect(r.allowed).toBe(true);
    expect(r.message).toBeUndefined();
  });

  it("monta mensagem de erro em PT-BR com exemplo de uso para caminho não lido", () => {
    const r = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/never-seen-extended.ts" });
    expect(r.allowed).toBe(false);
    expect(r.message).toContain("READ-BEFORE-WRITE");
    expect(r.message).toContain("ler_arquivo");
    expect(r.message).toContain("Exemplo");
    // Confere que o caminho resolvido aparece
    expect(r.message).toContain("/tmp/never-seen-extended.ts");
  });

  it("multi-arquivos: trata requests como não-array retornando allowed=true", () => {
    // Se requests não é array (ex.: objeto inválido), não há nada a checar.
    const r = checkReadBeforeWrite("editar_multi_arquivos", { requests: "not-an-array" });
    expect(r.allowed).toBe(true);
  });
});

describe("readBeforeWrite-extended: trackReads (recordRead)", () => {
  beforeEach(() => {
    clearReadPaths();
    setReadBeforeWriteEnabled(true);
  });

  it("registra leitura para TODOS os READ_TOOLS suportados (ler_arquivo_avancado, buscar_texto, buscar_arquivos, git_diff, git_blame, git_show, parse_ast)", () => {
    const tools = [
      "ler_arquivo",
      "ler_arquivo_avancado",
      "buscar_texto",
      "buscar_arquivos",
      "git_diff",
      "git_blame",
      "git_show",
      "parse_ast",
    ];
    for (const t of tools) {
      const file = `/tmp/ext-${t}.ts`;
      recordRead(t, file);
      expect(hasBeenRead(file), `falhou para tool ${t}`).toBe(true);
    }
  });

  it("ignora chamadas de recordRead com tool não-listado (ex.: ferramenta customizada)", () => {
    recordRead("ferramenta_desconhecida", "/tmp/unknown-tool.ts");
    expect(hasBeenRead("/tmp/unknown-tool.ts")).toBe(false);
    // Mesmo que o caminho seja igual, ferramenta desconhecida não registra.
    recordRead("custom_tool", "/tmp/foo.ts");
    expect(hasBeenRead("/tmp/foo.ts")).toBe(false);
  });
});

describe("readBeforeWrite-extended: validateWrite (recordWrite)", () => {
  beforeEach(() => {
    clearReadPaths();
    setReadBeforeWriteEnabled(true);
  });

  it("recordWrite marca o caminho como lido para todos os WRITE_TOOLS (aplicar_diff, editar_arquivo, editar_multi_arquivos)", () => {
    const writeTools = ["aplicar_diff", "editar_arquivo", "editar_multi_arquivos"];
    for (const t of writeTools) {
      const file = `/tmp/ext-write-${t}.ts`;
      recordWrite(t, file);
      expect(hasBeenRead(file), `falhou para tool ${t}`).toBe(true);
      // E um checkReadBeforeWrite posterior deve permitir
      expect(checkReadBeforeWrite("aplicar_diff", { caminho: file }).allowed).toBe(true);
    }
  });

  it("recordWrite com tool desconhecido NÃO marca o caminho como lido", () => {
    recordWrite("ferramenta_nao_write", "/tmp/not-a-write-tool.ts");
    expect(hasBeenRead("/tmp/not-a-write-tool.ts")).toBe(false);
    // E um checkReadBeforeWrite posterior deve bloquear
    const r = checkReadBeforeWrite("aplicar_diff", { caminho: "/tmp/not-a-write-tool.ts" });
    expect(r.allowed).toBe(false);
  });
});

describe("readBeforeWrite-extended: edge cases", () => {
  beforeEach(() => {
    clearReadPaths();
    setReadBeforeWriteEnabled(true);
  });

  it("editar_multi_arquivos: quando requests é array vazio, retorna allowed=true e não chama log.warn", () => {
    const warnMock = logMock.warn as ReturnType<typeof vi.fn>;
    warnMock.mockClear();
    const r = checkReadBeforeWrite("editar_multi_arquivos", { requests: [] });
    expect(r.allowed).toBe(true);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
