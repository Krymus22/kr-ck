/**
 * syntaxHighlight-extended.test.ts — Casos edge p/ syntaxHighlight.ts.
 * Foco: highlight de TS/Python/Lua, tokenize de strings/escapes, render com cores.
 */

import { describe, it, expect } from "vitest";
import { highlightSyntax, detectLanguageFromExt } from "../syntaxHighlight.js";

describe("syntaxHighlight (extended) — highlight por linguagem", () => {
  it("TypeScript: colore 'interface', 'extends' e string template", () => {
    const code = 'interface Foo extends Bar { x = `hello`; }';
    const out = highlightSyntax(code, "typescript");
    expect(out).toContain("\x1b[36m"); // cyan keywords (interface/extends)
    expect(out).toContain("\x1b[32m"); // green strings (template)
    expect(out).toContain("\x1b[0m");  // reset
  });

  it("Python: colore 'def', 'return' e comentário '#'", () => {
    const code = "def f():\n    return 1  # comment";
    const out = highlightSyntax(code, "python");
    expect(out).toContain("\x1b[36m"); // keywords
    expect(out).toContain("\x1b[90m"); // gray comment
    expect(out).toContain("\x1b[33m"); // yellow number 1
  });

  it("Lua não mapeado → cai no fallback TypeScript", () => {
    // 'local' não é keyword TS, mas 'function' é. Verifica fallback não explode.
    const code = "local function foo() return 1 end";
    const out = highlightSyntax(code, "lua");
    expect(typeof out).toBe("string");
    expect(out).toContain("function"); // palavra preservada
    expect(out).toContain("\x1b[36m"); // function ganhou cor cyan
  });
});

describe("syntaxHighlight (extended) — tokenize strings e escapes", () => {
  it("string com aspas duplas internas não é quebrada (escape \\\")", () => {
    const code = 'const s = "ele disse \\"oi\\"";';
    const out = highlightSyntax(code, "typescript");
    // String inteira ganha cor verde
    expect(out).toContain("\x1b[32m");
    expect(out).toContain("\x1b[0m");
  });

  it("números decimais e underscores são coloridos (1_000_000)", () => {
    const code = "const big = 1_000_000;";
    const out = highlightSyntax(code, "typescript");
    expect(out).toContain("\x1b[33m1_000_000\x1b[0m");
  });
});

describe("syntaxHighlight (extended) — render com cores", () => {
  it("function call colore o identificador imediatamente antes de '(' com magenta", () => {
    const code = "console.log(x);";
    const out = highlightSyntax(code, "typescript");
    // O regex colore o nome direto antes de '(' — aqui é 'log', não 'console'
    expect(out).toContain("\x1b[35mlog\x1b[0m(");
  });

  it("comentário single-line /* ... */ em uma linha é colorido por inteiro", () => {
    const code = "/* single line comment */\nconst x = 1;";
    const out = highlightSyntax(code, "typescript");
    // Comentário single-line ganha gray (\x1b[90m)
    expect(out).toContain("\x1b[90m/* single line comment */\x1b[0m");
    // Mantém a quebra de linha
    expect(out.split("\n").length).toBe(2);
  });
});

describe("syntaxHighlight (extended) — edge cases", () => {
  it("código sem keywords nem strings retorna o texto cru (somente com reset de function call se houver)", () => {
    const code = "12345";
    const out = highlightSyntax(code, "typescript");
    // Número ganha cor amarela
    expect(out).toContain("\x1b[33m");
    expect(out).toContain("12345");
  });
});

describe("detectLanguageFromExt (extended)", () => {
  it("extensões .mts/.mjs/.jsx mapeiam para typescript", () => {
    expect(detectLanguageFromExt(".mts")).toBe("typescript");
    expect(detectLanguageFromExt(".mjs")).toBe("typescript");
    expect(detectLanguageFromExt(".jsx")).toBe("typescript");
  });

  it(".pyw também mapeia para python; extensão unknown vira typescript", () => {
    expect(detectLanguageFromExt(".pyw")).toBe("python");
    expect(detectLanguageFromExt(".unknownext")).toBe("typescript");
  });
});
