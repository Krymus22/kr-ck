/**
 * diffPreview-extended.test.ts — Casos edge / error handling / integração para
 * diffPreview.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - computeUnifiedDiff (3 casos) — variações de entrada
 *   - formatDiff (renderColoredDiff) (2 casos)
 *   - colorizeLines (color ANSI por categoria) (2 casos)
 *   - edge cases (1 caso)
 */

import { describe, it, expect, vi } from "vitest";
import { computeUnifiedDiff, renderColoredDiff, previewAndApprove } from "../diffPreview.js";

// ─── computeUnifiedDiff ────────────────────────────────────────────────────
describe("computeUnifiedDiff (variações)", () => {
  it("gera cabeçalho com paths a/<file> e b/<file> para arquivo com caminho completo", () => {
    const diff = computeUnifiedDiff("a", "b", "src/path/file.ts");
    expect(diff).toContain("--- a/src/path/file.ts");
    expect(diff).toContain("+++ b/src/path/file.ts");
    expect(diff).toContain("@@");
  });

  it("insere apenas linhas novas quando 'after' adiciona conteúdo no MEIO", () => {
    const before = "linha1\nlinha3";
    const after = "linha1\nlinha2\nlinha3";
    const diff = computeUnifiedDiff(before, after, "mid.txt");
    expect(diff).toContain("+linha2");
    expect(diff).toContain(" linha1"); // context
    expect(diff).toContain(" linha3"); // context
  });

  it("gera diff vazio quando 'before' e 'after' diferem apenas por newline final", () => {
    // Before: "abc\n", Depois: "abc" — splitLines remove o \n final
    const diff = computeUnifiedDiff("abc\n", "abc", "trail.txt");
    expect(diff).toBe("");
  });
});

// ─── formatDiff (renderColoredDiff) ────────────────────────────────────────
describe("formatDiff — renderColoredDiff", () => {
  it("aplica cores ANSI distintas para linhas +, -, @@, ---/+++, e contexto", () => {
    const input =
      "--- a/f.txt\n" +
      "+++ b/f.txt\n" +
      "@@ -1,2 +1,2 @@\n" +
      " context\n" +
      "-removed\n" +
      "+added";
    const colored = renderColoredDiff(input);

    // Cada linha deve estar envolvida em código ANSI (\x1b[...m)
    const lines = colored.split("\n");
    expect(lines.length).toBe(6);
    for (const line of lines) {
      expect(line).toContain("\x1b[");
      expect(line).toContain("\x1b[0m");
    }

    // Linha "---" deve conter a cor vermelha (38;2;248;113;113 = #F87171)
    expect(lines[0]).toContain("38;2;248;113;113");
    // Linha "+++" deve conter a cor violeta (38;2;167;139;250 = #A78BFA)
    expect(lines[1]).toContain("38;2;167;139;250");
    // Linha "@@" deve conter a cor cyan (38;2;110;231;247 = #6EE7F7)
    expect(lines[2]).toContain("38;2;110;231;247");
    // Linha "+" deve conter a cor verde (38;2;52;211;153 = #34D399)
    expect(lines[5]).toContain("38;2;52;211;153");
    // Linha "-" deve conter a cor vermelha
    expect(lines[4]).toContain("38;2;248;113;113");
  });

  it("preserva conteúdo original de cada linha após aplicar cores", () => {
    const input = "+added line\n-removed line\n context line";
    const colored = renderColoredDiff(input);
    // Os textos devem estar presentes (sem o prefixo + / - / espaço em alguns casos,
    // mas o conteúdo da linha sim)
    expect(colored).toContain("added line");
    expect(colored).toContain("removed line");
    expect(colored).toContain("context line");
  });
});

// ─── colorizeLines (cores por tipo de linha) ──────────────────────────────
describe("colorizeLines — cores por categoria", () => {
  it("linha começando com '+++' recebe cor violeta (#A78BFA)", () => {
    const input = "+++ b/file.txt";
    const colored = renderColoredDiff(input);
    // Violet = 38;2;167;139;250
    expect(colored).toContain("38;2;167;139;250");
  });

  it("linha começando com '---' recebe cor vermelha (#F87171) — distinguindo de remoção", () => {
    const input = "--- a/file.txt";
    const colored = renderColoredDiff(input);
    // Red = 38;2;248;113;113 (mesma cor de remoção, mas com prefixo ---)
    expect(colored).toContain("38;2;248;113;113");
    expect(colored).toContain("--- a/file.txt");
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("previewAndApprove retorna true sem imprimir diff quando 'before' === 'after'", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await previewAndApprove("/tmp/igual.txt", "mesmo conteúdo", "mesmo conteúdo");
    expect(result).toBe(true);
    // Não deveria ter escrito nada no stderr (diff vazio -> silent approve)
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("computeUnifiedDiff com arquivo enorme (1000+ linhas alteradas) trunca com mensagem específica", () => {
    const before = Array(2000).fill("old").join("\n");
    const after = Array(2000).fill("new").join("\n");
    const diff = computeUnifiedDiff(before, after, "huge.txt");
    // Deve conter a mensagem de truncamento
    expect(diff).toContain("diff truncated for preview");
    // E NÃO deve conter todas as 2000 linhas alteradas
    const addCount = (diff.match(/^\+new/gm) ?? []).length;
    expect(addCount).toBeLessThan(2000);
  });

  it("renderColoredDiff com string vazia não quebra e retorna string sem conteúdo visível", () => {
    const colored = renderColoredDiff("");
    // split("\n") de "" retorna [""], então a função envolve a linha vazia em cor grey.
    // O resultado é apenas código ANSI sem texto visível.
    expect(typeof colored).toBe("string");
    expect(colored.replace(/\x1b\[[0-9;]*m/g, "")).toBe("");
  });
});
