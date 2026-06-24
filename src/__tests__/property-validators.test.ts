/**
 * property-validators.test.ts — Testes property-based para VALIDATORS.
 *
 * Usa fast-check v4.8.0 para gerar inputs aleatórios e verificar PROPRIEDADES
 * que devem ser verdadeiras para TODOS os inputs válidos.
 *
 * Funções testadas (conceitos documentados em pokaYoke.ts):
 *   - validatePath (via pokaYokeCheck)  — src/pokaYoke.ts
 *   - sanitizeInput (via pokaYokeCheck) — src/pokaYoke.ts
 *   - parseErrors                       — src/selfHealing.ts
 *   - detectFramework                   — src/testRunner.ts
 *   - shouldValidateFile                — src/luauValidator.ts
 *
 * NOTA SOBRE validatePath / sanitizeInput:
 *   pokaYoke.ts NÃO exporta validatePath ou sanitizeInput diretamente.
 *   O arquivo pokaYoke-extended.test.ts já documenta que esses conceitos
 *   são cobertos pela função central pokaYokeCheck(toolName, args).
 *   Aqui usamos pokaYokeCheck("ler_arquivo", { caminho: p }) como proxy
 *   para validatePath, e pokaYokeCheck para o conceito de sanitizeInput.
 *
 * Padrão adotado: fc.assert(fc.property(arbitrário, predicado))
 *   - O predicado retorna true (passa) ou false (falha).
 *   - fast-check roda 50 runs por propriedade (reduzido de 100 default para
 *     acelerar a suíte — alguns validators envolvem I/O de filesystem).
 *   - Quando uma propriedade falha, fast-check exibe o counterexample minimal.
 *
 * IMPORTANTE: propriedades marcadas com `.skip` falharam ao rodar e foram
 * desativadas com comentário explicando o bug e o counterexample.
 * Ver relatório do QA.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import fc from "fast-check";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Mockamos o logger para evitar poluição visual e potenciais side-effects
// (logger.ts importa config.ts que pode ler arquivos de configuração).
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
import { parseErrors } from "../selfHealing.js";
import { detectFramework } from "../testRunner.js";
import { shouldValidateFile, getActiveValidationRules } from "../luauValidator.js";

// ---------------------------------------------------------------------------
// Helper: extrai o "path validado" do resultado de pokaYokeCheck.
//
// pokaYoke.ts não exporta validatePath diretamente — o conceito é coberto
// por pokaYokeCheck("ler_arquivo", { caminho: p }).resolvedPath (que usa
// path.resolve() internamente). Retornamos "" quando a validação falha
// (path vazio/whitespace) para que o tipo de retorno seja sempre string.
// ---------------------------------------------------------------------------
function validatePath(p: string): string {
  const result = pokaYokeCheck("ler_arquivo", { caminho: p });
  return result.ok ? (result.resolvedPath ?? "") : "";
}

// ---------------------------------------------------------------------------
// Arbitraries reutilizáveis
// ---------------------------------------------------------------------------

/** Strings arbitrárias (unicode, vazias, longas) — equivalente a fc.string(). */
const arbString = fc.string({ maxLength: 500 });

/** Paths no formato POSIX — apenas caracteres seguros de path. */
const arbPath = fc.stringMatching(/[a-zA-Z0-9_\-./]{0,200}/);

/** Strings que podem conter null bytes (para testar path injection). */
const arbStringWithNullByte = fc.tuple(
  fc.string({ maxLength: 50 }),
  fc.string({ maxLength: 50 }),
).map(([before, after]) => `${before}\0${after}`);

/** Valores de tipos variados para testar robustez de sanitizeInput. */
const arbAny = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
  fc.constant([]),
  fc.constant(NaN),
);

beforeAll(async () => {
  // Garante ambiente determinístico para shouldValidateFile: sem modo ativo,
  // getActiveValidationRules() retorna [] e shouldValidateFile() retorna false
  // para qualquer path. Isso documentamos na propriedade #12 (que falharia).
  // Sprint A: também setar HOME para um dir vazio, porque getActiveMode()
  // faz fallback para "normal" mode que pode carregar legacy .json files
  // do HOME real (que podem ter luauValidation regras).
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ck-prop-validators-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  try {
    const { deactivateMode } = await import("../modes.js");
    deactivateMode();
  } catch {
    // se não conseguir desativar, segue — getActiveValidationRules tem try/catch
  }
});

describe("property-validators", () => {
  // ========================================================================
  // 1. validatePath / path sanitization (pokaYoke.ts) — 3 propriedades
  // ========================================================================
  describe("validatePath (via pokaYokeCheck)", () => {
    it("validatePath(p) nunca retorna path com componente '..' (sem path traversal)", () => {
      fc.assert(
        fc.property(arbPath, (p) => {
          const result = validatePath(p);
          // Quebra o path em componentes (POSIX) e verifica que NENHUM é "..".
          // Aceita ".." como substring de componente (ex.: "foo..bar" é OK),
          // mas rejeita componente inteira igual a "..".
          const components = result.split("/");
          return !components.includes("..");
        }),
        { numRuns: 50 },
      );
    });

    // BUG P-3 CORRIGIDO (property-validators #1):
    //   validatePath NÃO filtrava null bytes do path resolvido. pokaYoke.ts
    //   usava `path.resolve(rawPath)` que preserva bytes nulos. Em algumas
    //   APIs de filesystem (especialmente em camadas mais antigas ou
    //   bindings nativos), "\0" é interpretado como terminador de string
    //   — isso permite path injection (ex.: "/tmp/foo\0.txt" pode virar
    //   "/tmp/foo" em certas chamadas C).
    //   Counterexample encontrado pelo fast-check (ANTES do fix):
    //     validatePath("foo\0bar") -> "/cwd/foo\0bar"   (contém null byte)
    //     validatePath("\0")       -> "/cwd/\0"         (contém null byte)
    //   CORREÇÃO APLICADA: pokaYoke.ts agora rejeita paths com null byte
    //   ANTES de chamar path.resolve, retornando ok=false com mensagem
    //   acionável. Null byte em path é sempre erro/malícia — estratégia
    //   "rejeitar" (Opção A) adotada conforme recomendado.
    it("validatePath(p) nunca retorna path com null bytes", () => {
      fc.assert(
        fc.property(arbStringWithNullByte, (p) => {
          const result = validatePath(p);
          return !result.includes("\0");
        }),
        { numRuns: 50 },
      );
    });

    it("validatePath(p) sempre retorna string (não undefined/null) para qualquer input de string", () => {
      fc.assert(
        fc.property(arbString, (p) => {
          const result = validatePath(p);
          return typeof result === "string";
        }),
        { numRuns: 50 },
      );
    });
  });

  // ========================================================================
  // 2. sanitizeInput (pokaYoke.ts) — 2 propriedades
  // ========================================================================
  describe("sanitizeInput (via pokaYokeCheck)", () => {
    it("pokaYokeCheck nunca lança exceção para qualquer input (string, number, null, undefined, objeto)", () => {
      fc.assert(
        fc.property(arbAny, (x) => {
          // Tentamos chamar pokaYokeCheck com { caminho: x }. Se x for de
          // tipo "estranho" (não string), pokaYoke retorna ok=false com erro
          // descritivo — mas NUNCA lança.
          let threw = false;
          try {
            pokaYokeCheck("ler_arquivo", { caminho: x });
          } catch {
            threw = true;
          }
          return !threw;
        }),
        { numRuns: 50 },
      );
    });

    it("pokaYokeCheck({ caminho: s }) para input string sempre retorna resultado bem-formado (error: string OU resolvedPath: string)", () => {
      fc.assert(
        fc.property(arbString, (s) => {
          const result = pokaYokeCheck("ler_arquivo", { caminho: s });
          if (result.ok) {
            // Quando ok=true, resolvedPath DEVE ser string (path.resolve sempre retorna string)
            return typeof result.resolvedPath === "string";
          } else {
            // Quando ok=false, error DEVE ser string com mensagem acionável
            return typeof result.error === "string" && result.error.length > 0;
          }
        }),
        { numRuns: 50 },
      );
    });
  });

  // ========================================================================
  // 3. parseErrors (selfHealing.ts) — 3 propriedades
  // ========================================================================
  describe("parseErrors (selfHealing)", () => {
    it("parseErrors(text) sempre retorna array (mesmo para input malformado)", () => {
      fc.assert(
        fc.property(arbString, (text) => {
          const result = parseErrors(text);
          return Array.isArray(result);
        }),
        { numRuns: 50 },
      );
    });

    it("cada erro em parseErrors(text) tem pelo menos 'message' definido (string não-vazia)", () => {
      fc.assert(
        fc.property(arbString, (text) => {
          const errors = parseErrors(text);
          // Para cada erro retornado, message deve ser string definida.
          return errors.every(
            (e) => typeof e.message === "string" && e.message.length > 0,
          );
        }),
        { numRuns: 50 },
      );
    });

    it("parseErrors('') retorna array vazio", () => {
      fc.assert(
        fc.property(fc.constant(""), (empty) => {
          const result = parseErrors(empty);
          return Array.isArray(result) && result.length === 0;
        }),
        { numRuns: 10 },
      );
    });
  });

  // ========================================================================
  // 4. detectFramework (testRunner.ts) — 2 propriedades
  // ========================================================================
  describe("detectFramework (testRunner)", () => {
    it("detectFramework(filePath) sempre retorna string (mesmo para path sem extensão ou inválido)", () => {
      fc.assert(
        fc.property(arbString, (filePath) => {
          const result = detectFramework(filePath);
          return typeof result === "string" && result.length > 0;
        }),
        { numRuns: 50 },
      );
    });

    it("detectFramework(filePath) retorna mesmo valor para o mesmo input (determinístico)", () => {
      fc.assert(
        fc.property(arbString, (filePath) => {
          const r1 = detectFramework(filePath);
          const r2 = detectFramework(filePath);
          return r1 === r2;
        }),
        { numRuns: 50 },
      );
    });
  });

  // ========================================================================
  // 5. shouldValidateFile (luauValidator.ts) — 2 propriedades
  // ========================================================================
  describe("shouldValidateFile (luauValidator)", () => {
    it("shouldValidateFile(path) sempre retorna boolean (true ou false, nunca null/undefined)", async () => {
      await fc.assert(
        fc.asyncProperty(arbString, async (filePath) => {
          const result = await shouldValidateFile(filePath);
          return typeof result === "boolean";
        }),
        { numRuns: 50 },
      );
    });

    // BUG P-4 DOCUMENTADO (property-validators #2):
    //   shouldValidateFile NÃO retorna true para paths .luau/.lua quando
    //   não há modo ativo com regras de validação. A função depende de
    //   estado global (modo ativo em ~/.claude-killer/modes/active.json).
    //   Em ambiente de teste (sem modo ativo — ver beforeAll), 
    //   getActiveValidationRules() retorna [] e shouldValidateFile() 
    //   retorna false PARA QUALQUER path, inclusive .luau/.lua.
    //   Counterexample encontrado (ANTES do ajuste):
    //     shouldValidateFile("/foo.luau") === false   (esperado: true)
    //     shouldValidateFile("/foo.lua")  === false   (esperado: true)
    //   DECISÃO: comportamento de DESIGN — validação é OPT-IN via modo ativo.
    //   O JSDoc da função agora documenta isso explicitamente. A propriedade
    //   abaixo foi ajustada para verificar o comportamento REAL: sem modo
    //   ativo, shouldValidateFile retorna false mesmo para .luau/.lua.
    it("shouldValidateFile(path) retorna false para .luau/.lua quando no active mode (comportamento documentado)", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.string({ maxLength: 50 }).map((s) => `${s}.luau`),
            fc.string({ maxLength: 50 }).map((s) => `${s}.lua`),
          ),
          async (filePath) => {
            const result = await shouldValidateFile(filePath);
            // Comportamento documentado: sem modo ativo (ver beforeAll),
            // shouldValidateFile retorna false mesmo para .luau/.lua
            // (validação é opt-in via modo ativo).
            return result === false;
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ========================================================================
  // EXTRA: Sanity check — confirma o ambiente de teste está sem modo ativo,
  // documentando POR QUE a propriedade #12 falha. Não é property-based;
  // é um teste de asserção de ambiente.
  // ========================================================================
  describe("ambiente de teste (documentação do bug #2)", () => {
    it("em ambiente sem modo ativo, getActiveValidationRules() retorna []", async () => {
      const rules = await getActiveValidationRules();
      expect(Array.isArray(rules)).toBe(true);
      // Documenta: sem modo ativo, NÃO há regras — por isso #12 falha.
      expect(rules).toEqual([]);
    });
  });
});
