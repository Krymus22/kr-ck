/**
 * effortLevels-extended.test.ts — Cobertura adicional do módulo effortLevels.
 *
 * Foca em:
 *   - setEffortLevel (3 casos novos)
 *   - getEffortLabel (2 casos novos)
 *   - getEffortConfig (combinação de flags should*) (2 casos novos)
 *   - edge cases (1 caso)
 *
 * Não duplica testes do arquivo effortLevels.test.ts básico.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import {
  getEffortLevel,
  setEffortLevel,
  getEffortLabel,
  shouldAutoGenerateTests,
  shouldUseSubAgents,
  shouldUseIntelligentCompaction,
  getEffortPromptSnippet,
  type EffortLevel,
} from "../effortLevels.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.CLAUDE_KILLER_EFFORT;
  delete process.env.CLAUDE_KILLER_EFFORT_STORED;
  setEffortLevel("medium");
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("effortLevels-extended: setEffortLevel", () => {
  it("faz round-trip low -> max -> low mantendo estado correto", () => {
    expect(setEffortLevel("low")).toBe(true);
    expect(getEffortLevel()).toBe("low");
    expect(setEffortLevel("max")).toBe(true);
    expect(getEffortLevel()).toBe("max");
    expect(setEffortLevel("low")).toBe(true);
    expect(getEffortLevel()).toBe("low");
  });

  it("persiste valor em process.env.CLAUDE_KILLER_EFFORT_STORED quando localStorage não está disponível", () => {
    // Em ambiente node (test), typeof localStorage === 'undefined'
    expect(typeof localStorage).toBe("undefined");
    setEffortLevel("high");
    expect(process.env.CLAUDE_KILLER_EFFORT_STORED).toBe("high");
  });

  it("retorna boolean (true para válido, false para inválido) sem lançar erro", () => {
    const valid: EffortLevel[] = ["low", "medium", "high", "max"];
    for (const lvl of valid) {
      const result = setEffortLevel(lvl);
      expect(typeof result).toBe("boolean");
      expect(result).toBe(true);
    }
    const invalid = "turbo" as unknown as EffortLevel;
    const result = setEffortLevel(invalid);
    expect(typeof result).toBe("boolean");
    expect(result).toBe(false);
  });
});

describe("effortLevels-extended: getEffortLabel", () => {
  it("cada label contém o nome do nível em CAIXA ALTA seguido de um atalho de tecla", () => {
    const expectations: Record<EffortLevel, string> = {
      low: "LOW !",
      medium: "MEDIUM G",
      high: "HIGH Q",
      max: "MAX B",
    };
    for (const lvl of Object.keys(expectations) as EffortLevel[]) {
      setEffortLevel(lvl);
      expect(getEffortLabel()).toBe(expectations[lvl]);
    }
  });

  it("label muda imediatamente após setEffortLevel sem necessidade de reload", () => {
    setEffortLevel("low");
    expect(getEffortLabel()).toContain("LOW");
    setEffortLevel("max");
    expect(getEffortLabel()).toContain("MAX");
    setEffortLevel("high");
    expect(getEffortLabel()).toContain("HIGH");
  });
});

describe("effortLevels-extended: getEffortConfig (combinação de flags should*)", () => {
  it("no nível low, todas as flags (autoTest, subAgents, intelligentCompaction) são false", () => {
    setEffortLevel("low");
    expect(shouldAutoGenerateTests()).toBe(false);
    expect(shouldUseSubAgents()).toBe(false);
    expect(shouldUseIntelligentCompaction()).toBe(false);
  });

  it("no nível high, todas as flags são true e getEffortPromptSnippet contém 'CADA escrita'", () => {
    setEffortLevel("high");
    expect(shouldAutoGenerateTests()).toBe(true);
    expect(shouldUseSubAgents()).toBe(true);
    expect(shouldUseIntelligentCompaction()).toBe(true);
    // High effort específico: instrução de pensar antes de CADA escrita
    const snippet = getEffortPromptSnippet();
    expect(snippet).toContain("CADA escrita");
  });
});

describe("effortLevels-extended: edge cases", () => {
  it("setEffortLevel com string vazia retorna false e mantém o nível atual", () => {
    setEffortLevel("high");
    const result = setEffortLevel("" as EffortLevel);
    expect(result).toBe(false);
    // Nível permanece 'high' (não foi alterado)
    expect(getEffortLevel()).toBe("high");
  });
});
