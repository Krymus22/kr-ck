/**
 * configSchema-extended.test.ts — Edge cases do configSchema (Sprint 12).
 *
 * Cobre situações que o teste básico não toca:
 *   - config com effortLevel inválido (não é low/medium/high/max) → sem erro
 *     (schema não valida conteúdo de effortLevel)
 *   - config com isBase: true → válido
 *   - config com mcps array → válido
 *   - config com systemPrompt string vazia → válido
 *   - config com validators vazio [] → válido
 *   - config com hooks vazio [] → válido
 *   - config com tools contendo string não-tool → sem erro (não valida conteúdo)
 *   - config com type errado em name (number) → erro
 *   - config null → múltiplos erros
 *   - config undefined → múltiplos erros
 */

import { describe, it, expect } from "vitest";
import { validateModeConfig, isValidModeConfig } from "../configSchema.js";

describe("configSchema — extended (edge cases)", () => {
  const validConfig = {
    name: "roblox",
    label: "Roblox (External)",
    toolsDir: "tools",
    tools: ["tool:rojo_build"],
    skills: ["skill:profilestore"],
    validators: [
      { tool: "selene_lint", filePattern: "*.luau", blocking: true },
    ],
    hooks: [
      { name: "auto-build", file: "auto-build.js", trigger: "before_write" },
    ],
  };

  it("effortLevel inválido (não low/medium/high/max) NÃO gera erro (schema não valida conteúdo)", () => {
    const errors = validateModeConfig({ ...validConfig, effortLevel: "super-max" });
    expect(errors).toEqual([]);
  });

  it("config com isBase: true é válido", () => {
    const errors = validateModeConfig({ ...validConfig, isBase: true });
    expect(errors).toEqual([]);
  });

  it("config com mcps array é válido (não valida conteúdo)", () => {
    const errors = validateModeConfig({
      ...validConfig,
      mcps: [{ name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }],
    });
    expect(errors).toEqual([]);
  });

  it("config com systemPrompt string vazia é válido", () => {
    const errors = validateModeConfig({ ...validConfig, systemPrompt: "" });
    expect(errors).toEqual([]);
  });

  it("config com validators vazio [] é válido", () => {
    const errors = validateModeConfig({ ...validConfig, validators: [] });
    expect(errors).toEqual([]);
  });

  it("config com hooks vazio [] é válido", () => {
    const errors = validateModeConfig({ ...validConfig, hooks: [] });
    expect(errors).toEqual([]);
  });

  it("config com tools contendo string não-tool (sem prefixo tool:) NÃO gera erro (não valida conteúdo)", () => {
    const errors = validateModeConfig({ ...validConfig, tools: ["whatever-string"] });
    expect(errors).toEqual([]);
  });

  it("config com name number (não string) gera erro em 'name'", () => {
    const errors = validateModeConfig({ ...validConfig, name: 123 });
    expect(errors.some((e) => e.field === "name")).toBe(true);
    expect(isValidModeConfig({ ...validConfig, name: 123 })).toBe(false);
  });

  it("config null lança TypeError (não há guarda para null — chamada inválida)", () => {
    // O schema não valida null explicitamente — ao tentar acessar .name, lança.
    // Comportamento esperado: throw graceful (caller deve passar objeto).
    expect(() => validateModeConfig(null)).toThrow(TypeError);
  });

  it("config undefined lança TypeError (não há guarda para undefined)", () => {
    expect(() => validateModeConfig(undefined)).toThrow(TypeError);
  });

  it("config {} (objeto vazio) gera múltiplos erros sem throw", () => {
    const errors = validateModeConfig({});
    expect(errors.length).toBeGreaterThanOrEqual(2);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain("name");
    expect(fields).toContain("label");
  });

  it("config com label number gera erro em 'label'", () => {
    const errors = validateModeConfig({ ...validConfig, label: 42 });
    expect(errors.some((e) => e.field === "label")).toBe(true);
  });

  it("config com toolsDir number gera erro em 'toolsDir'", () => {
    const errors = validateModeConfig({ ...validConfig, toolsDir: 123 });
    expect(errors.some((e) => e.field === "toolsDir")).toBe(true);
  });

  it("config com skills não-array gera erro em 'skills'", () => {
    const errors = validateModeConfig({ ...validConfig, skills: "not-array" });
    expect(errors.some((e) => e.field === "skills")).toBe(true);
  });

  it("config com hooks contendo hook com trigger inválido gera erro", () => {
    const errors = validateModeConfig({
      ...validConfig,
      hooks: [{ name: "h", file: "h.js", trigger: "invalid" }],
    });
    expect(errors.some((e) => e.field === "hooks[0].trigger")).toBe(true);
  });

  it("config com validators contendo validator sem filePattern gera erro", () => {
    const errors = validateModeConfig({
      ...validConfig,
      validators: [{ tool: "x", blocking: true }],
    });
    expect(errors.some((e) => e.field === "validators[0].filePattern")).toBe(true);
  });
});
