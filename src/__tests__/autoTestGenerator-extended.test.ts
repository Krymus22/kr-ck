/**
 * autoTestGenerator-extended.test.ts — Cobertura adicional do módulo autoTestGenerator.
 *
 * Foca em:
 *   - generateTest (generateTestSuggestionForFile) (3 casos novos)
 *   - detectFramework (mapeamento ext->framework) (2 casos novos)
 *   - injectTest (controle de throttle) (2 casos novos)
 *   - edge cases (1 caso)
 *
 * Não duplica testes do arquivo autoTestGenerator.test.ts básico.
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

vi.mock("../effortLevels.js", () => ({
  shouldAutoGenerateTests: vi.fn().mockReturnValue(true),
}));

import {
  generateTestSuggestionForFile,
  resetAutoTestSuggestions,
} from "../autoTestGenerator.js";
import { shouldAutoGenerateTests } from "../effortLevels.js";

const mockedShouldGen = shouldAutoGenerateTests as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAutoTestSuggestions();
  mockedShouldGen.mockReturnValue(true);
});

describe("autoTestGenerator-extended: generateTest (generateTestSuggestionForFile)", () => {
  it("inclui o nome do arquivo original (basename) na mensagem de sugestão", () => {
    const result = generateTestSuggestionForFile("/projects/foo/bar/MyComponent.ts");
    expect(result).toContain("MyComponent.ts");
    expect(result).toContain("MyComponent.test.ts");
  });

  it("inclui o template inicial de import dentro do bloco de código", () => {
    const result = generateTestSuggestionForFile("/abs/path/foo.ts");
    expect(result).toContain("```");
    expect(result).toContain("import { describe, it, expect } from 'vitest';");
  });

  it("gera sugestão com nome de arquivo de teste no mesmo diretório do arquivo original", () => {
    const result = generateTestSuggestionForFile("/some/dir/service.ts");
    // O nome do arquivo de teste deve estar no mesmo diretório (sem trocar de pasta)
    expect(result).toContain("/some/dir/service.test.ts");
  });
});

describe("autoTestGenerator-extended: detectFramework (mapeamento extensão)", () => {
  it(".mjs mapeia para node:test (não jest/vitest)", () => {
    const result = generateTestSuggestionForFile("/abs/path/module.mjs");
    expect(result).toContain("node:test");
    expect(result).toContain("node:assert/strict");
    expect(result).not.toContain("jest");
    expect(result).not.toContain("vitest");
    // Nome do arquivo de teste segue convenção <base>.test.mjs
    expect(result).toContain("module.test.mjs");
  });

  it(".jsx mapeia para jest (não vitest) com template CommonJS", () => {
    const result = generateTestSuggestionForFile("/abs/path/Component.jsx");
    expect(result).toContain("jest");
    expect(result).toContain("require('jest')");
    expect(result).not.toContain("vitest");
    expect(result).toContain("Component.test.jsx");
  });
});

describe("autoTestGenerator-extended: injectTest (throttle)", () => {
  it("após resetAutoTestSuggestions, todas as chamadas subsequentes geram sugestão na mesma turn", () => {
    // Antes do reset, segunda chamada é throttled
    const first = generateTestSuggestionForFile("/abs/x.ts");
    expect(first).toContain("vitest");
    const second = generateTestSuggestionForFile("/abs/x.ts");
    expect(second).toBe("");

    // Após reset, sugestão volta a ser gerada
    resetAutoTestSuggestions();
    const after = generateTestSuggestionForFile("/abs/x.ts");
    expect(after).toContain("vitest");
  });

  it("arquivos diferentes na mesma turn geram sugestão independentemente (sem throttle cruzado)", () => {
    const a = generateTestSuggestionForFile("/abs/path/alpha.ts");
    const b = generateTestSuggestionForFile("/abs/path/beta.ts");
    const c = generateTestSuggestionForFile("/abs/path/gamma.ts");
    expect(a).toContain("alpha.test.ts");
    expect(b).toContain("beta.test.ts");
    expect(c).toContain("gamma.test.ts");
    // Segunda chamada de qualquer um retorna ""
    expect(generateTestSuggestionForFile("/abs/path/alpha.ts")).toBe("");
    expect(generateTestSuggestionForFile("/abs/path/beta.ts")).toBe("");
  });
});

describe("autoTestGenerator-extended: edge cases", () => {
  it("retorna string vazia para caminho sem extensão (ex.: Makefile, Dockerfile)", () => {
    expect(generateTestSuggestionForFile("/abs/path/Makefile")).toBe("");
    expect(generateTestSuggestionForFile("/abs/path/Dockerfile")).toBe("");
  });
});
