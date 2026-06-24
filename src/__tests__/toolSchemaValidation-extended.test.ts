/**
 * toolSchemaValidation-extended.test.ts — Casos edge / error handling / integração
 * para toolSchemaValidation.ts que NÃO estão cobertos pelo teste básico.
 *
 * Foco:
 *   - validateToolCall (3 casos) — tipos não cobertos (number/boolean/array/object)
 *   - validateSchema (2 casos) — valida objetos aninhados com arrays
 *   - formatError (formatValidationErrors) (2 casos)
 *   - edge cases (1 caso)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  toolCall: vi.fn(),
  toolResult: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { validateToolCall, formatValidationErrors } from "../toolSchemaValidation.js";
import * as log from "../logger.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── validateToolCall: tipos adicionais ────────────────────────────────────
describe("validateToolCall — tipos adicionais (number/boolean/array/object)", () => {
  it("falha quando número é esperado mas recebe string/null/array", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "number" } },
    };
    // string em vez de number
    const r1 = validateToolCall("t", { count: "dez" }, schema);
    expect(r1.valid).toBe(false);
    expect(r1.errors[0]).toContain("number");

    // null em vez de number
    const r2 = validateToolCall("t", { count: null }, schema);
    expect(r2.valid).toBe(true); // null é tratado como "ausente"
    expect(r2.errors).toHaveLength(0);

    // array em vez de number
    const r3 = validateToolCall("t", { count: [1, 2] }, schema);
    expect(r3.valid).toBe(false);
    expect(r3.errors[0]).toContain("array");
  });

  it("falha quando boolean é esperado mas recebe string/number/object", () => {
    const schema = {
      type: "object",
      properties: { verbose: { type: "boolean" } },
    };
    expect(validateToolCall("t", { verbose: "true" }, schema).valid).toBe(false);
    expect(validateToolCall("t", { verbose: 1 }, schema).valid).toBe(false);
    expect(validateToolCall("t", { verbose: { yes: 1 } }, schema).valid).toBe(false);
    // válido
    expect(validateToolCall("t", { verbose: true }, schema).valid).toBe(true);
  });

  it("falha quando array é esperado mas recebe string/object/null", () => {
    const schema = {
      type: "object",
      properties: { items: { type: "array" } },
    };
    expect(validateToolCall("t", { items: "not-array" }, schema).valid).toBe(false);
    expect(validateToolCall("t", { items: { 0: "x" } }, schema).valid).toBe(false);
    expect(validateToolCall("t", { items: [1, 2, 3] }, schema).valid).toBe(true);
  });
});

// ─── validateSchema: objetos aninhados com arrays de objetos ───────────────
describe("validateSchema — objetos aninhados", () => {
  it("valida arrays de objetos (cada item deve validar suas propriedades)", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
          },
        },
      },
    };

    // Item com age inválido (string em vez de number)
    const r1 = validateToolCall("t", {
      users: [
        { name: "ana", age: 30 },
        { name: "bob", age: "trinta" },
      ],
    }, schema);
    expect(r1.valid).toBe(false);
    expect(r1.errors.some((e) => e.includes("users[1].age"))).toBe(true);
    expect(r1.errors.some((e) => e.includes("number"))).toBe(true);
  });

  it("valida objeto aninhado quando item do array não é objeto", () => {
    const schema = {
      type: "object",
      properties: {
        configs: {
          type: "array",
          items: {
            type: "object",
            properties: { key: { type: "string" } },
          },
        },
      },
    };
    // Item 1 é string (não objeto)
    const r = validateToolCall("t", { configs: ["not-object", { key: "ok" }] }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("configs[0]"))).toBe(true);
  });
});

// ─── formatError: formatValidationErrors ───────────────────────────────────
describe("formatError — formatValidationErrors", () => {
  it("formata lista vazia sem quebrar (mantém header e footer)", () => {
    const msg = formatValidationErrors("tool_x", []);
    expect(msg).toContain("[ERROR: SCHEMA VALIDATION]");
    expect(msg).toContain("tool_x");
    expect(msg).toContain("Fix the arguments");
    // Sem erros, não deve haver linhas "X ..."
    expect(msg).not.toContain("X ");
  });

  it("marca cada erro com 'X' e preserva a ordem informada", () => {
    const msg = formatValidationErrors("tool_y", ["err-A", "err-B", "err-C"]);
    const lines = msg.split("\n");
    expect(lines.some((l) => l.includes("X err-A"))).toBe(true);
    expect(lines.some((l) => l.includes("X err-B"))).toBe(true);
    expect(lines.some((l) => l.includes("X err-C"))).toBe(true);
    // A ordem deve ser preservada no texto
    const idxA = msg.indexOf("err-A");
    const idxB = msg.indexOf("err-B");
    const idxC = msg.indexOf("err-C");
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });
});

// ─── edge cases ────────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("validateToolCall chama log.warn quando há erros e NÃO chama quando tudo é válido", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };

    // Caso válido — não deve chamar warn
    validateToolCall("valid_tool", { name: "ok" }, schema);
    expect(log.warn).not.toHaveBeenCalled();

    // Caso inválido — deve chamar warn com mensagem contendo nome + quantidade
    validateToolCall("bad_tool", {}, schema);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const warnArg = log.warn.mock.calls[0]?.[0] as string;
    expect(warnArg).toContain("SCHEMA VALIDATION");
    expect(warnArg).toContain("bad_tool");
    expect(warnArg).toContain("1");
  });

  it("trata enum com valor não-string (não deve falhar, apenas validar tipo)", () => {
    const schema = {
      type: "object",
      properties: { level: { type: "string", enum: ["a", "b"] } },
    };
    // Passando número (tipo errado + não-string): a validação de tipo deve disparar primeiro
    const r = validateToolCall("t", { level: 42 }, schema);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toContain("string");
  });

  it("schema sem 'required' e sem 'properties' não gera erros", () => {
    const r = validateToolCall("noop_tool", { whatever: true }, { type: "object" });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});
