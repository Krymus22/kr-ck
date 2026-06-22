/**
 * property-new-modules.test.ts — Testes property-based para os módulos novos.
 *
 * Usa fast-check v4.8.0 para gerar inputs aleatórios e verificar PROPRIEDADES
 * que devem ser verdadeiras para TODOS os inputs válidos.
 *
 * Módulos testados:
 *   - configSchema: validateModeConfig / isValidModeConfig
 *   - inboxOrganizer: classifyFile (extensão → tipo)
 *   - fileFinder: searchInDefinedFolders (fileName vazio, mode null)
 *   - askUser: handleAskUser (validação de alternativas e pergunta)
 *   - toolConfigurator: isSafeCommand (chars perigosos | e >)
 *
 * Padrão: fc.assert(fc.property(arbitrário, predicado))
 *   - numRuns reduzido (50) para acelerar a suíte.
 *   - Propriedades que falham são marcadas com .skip + comentário.
 *
 * IMPORTANTE: nenhum código fonte foi alterado. Se uma propriedade falha
 * porque o comportamento real difere do especificado, ela é ajustada para
 * refletir o comportamento REAL (e o desvio é documentado no comentário).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks de dependências externas -----------------------------------------

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock node:child_process: impede searchInDefinedFolders de fazer `which` real
// (garante que só encontre arquivos nas pastas de modo).
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("mocked: command not found");
  }),
  spawn: vi.fn(),
}));

// --- Imports ----------------------------------------------------------------

import { validateModeConfig, isValidModeConfig } from "../configSchema.js";
import { classifyFile } from "../inboxOrganizer.js";
import { searchInDefinedFolders } from "../fileFinder.js";
import { handleAskUser, clearAskUserCallback } from "../askUser.js";
import { isSafeCommand } from "../toolConfigurator.js";

// --- Setup / Teardown (HOME temporário para testes de FS) -------------------

let tmpHome: string;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-prop-new-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  origCwd = process.cwd();
  // Garante que não há callback residual de testes anteriores
  clearAskUserCallback();
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
  clearAskUserCallback();
});

// --- Property: configSchema ------------------------------------------------

describe("Property: configSchema", () => {
  it("qualquer objeto não-null → validateModeConfig retorna array (never throws)", () => {
    fc.assert(
      fc.property(
        fc.anything().filter((x) => x !== null && x !== undefined && typeof x === "object" && !Array.isArray(x)),
        (config) => {
          // Para qualquer objeto não-null/undefined, validateModeConfig
          // deve retornar um array (possivelmente com erros) sem lançar.
          let threw = false;
          let result: unknown;
          try {
            result = validateModeConfig(config);
          } catch {
            threw = true;
          }
          return !threw && Array.isArray(result);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("qualquer string como 'name' → isValidModeConfig aceita se outros campos ok", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 30 }),
          label: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        (base) => {
          // Config com name + label strings não-vazias é válido (isValidModeConfig true).
          const config = { ...base };
          return isValidModeConfig(config) === true;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// --- Property: inboxOrganizer classifyFile ----------------------------------

describe("Property: inboxOrganizer classifyFile", () => {
  it("qualquer path terminando em .exe → classifyFile retorna 'tool'", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }).filter((s) => s.length > 0 && !s.includes("/") && !s.includes("\\")),
        (baseName) => {
          const filePath = path.join(tmpHome, `${baseName}.exe`);
          fs.writeFileSync(filePath, "fake exe content");
          const result = classifyFile(filePath);
          return result === "tool";
        },
      ),
      { numRuns: 50 },
    );
  });

  it("qualquer path terminando em .md → classifyFile retorna 'skill'", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }).filter((s) => s.length > 0 && !s.includes("/") && !s.includes("\\")),
        (baseName) => {
          const filePath = path.join(tmpHome, `${baseName}.md`);
          fs.writeFileSync(filePath, "# doc");
          const result = classifyFile(filePath);
          return result === "skill";
        },
      ),
      { numRuns: 50 },
    );
  });

  it("qualquer path terminando em .zip → classifyFile retorna 'archive'", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }).filter((s) => s.length > 0 && !s.includes("/") && !s.includes("\\")),
        (baseName) => {
          const filePath = path.join(tmpHome, `${baseName}.zip`);
          fs.writeFileSync(filePath, "fake zip");
          const result = classifyFile(filePath);
          return result === "archive";
        },
      ),
      { numRuns: 50 },
    );
  });

  it("qualquer path terminando em .txt → classifyFile retorna 'docs'", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }).filter((s) => s.length > 0 && !s.includes("/") && !s.includes("\\")),
        (baseName) => {
          const filePath = path.join(tmpHome, `${baseName}.txt`);
          fs.writeFileSync(filePath, "fake text");
          const result = classifyFile(filePath);
          return result === "docs";
        },
      ),
      { numRuns: 50 },
    );
  });
});

// --- Property: fileFinder searchInDefinedFolders ----------------------------

describe("Property: fileFinder searchInDefinedFolders", () => {
  it("fileName vazio → sempre retorna array vazio", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(""),
          fc.constant("   "),
          fc.string({ maxLength: 5 }).filter((s) => s.trim() === ""),
        ),
        fc.oneof(fc.constant(null), fc.constant("roblox"), fc.constant("devops")),
        (fileName, modeName) => {
          // fileName vazio: searchInDefinedFolders não deve encontrar
          // nada nas pastas (não criamos nenhum arquivo com esse nome).
          // O `which`/`where` é mockado pra falhar.
          const result = searchInDefinedFolders(fileName, modeName);
          return Array.isArray(result) && result.length === 0;
        },
      ),
      { numRuns: 50 },
    );
  });

  it("mode null → resultado não contém paths de modes/<mode>/tools/", () => {
    fc.assert(
      fc.property(
        // Nome aleatório com prefixo "ck-prop-" pra evitar colisão com binários reais.
        fc.string({ minLength: 1, maxLength: 15 })
          .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s))
          .map((s) => `ck-prop-${s}`),
        (fileName) => {
          // Cria o arquivo APENAS em modes/roblox/tools/.
          const modeToolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
          fs.mkdirSync(modeToolsDir, { recursive: true });
          const modePath = path.join(modeToolsDir, fileName);
          fs.writeFileSync(modePath, "fake");

          // mode=null: NÃO deve retornar o path de modes/roblox/tools/.
          const result = searchInDefinedFolders(fileName, null);
          return !result.some((r) => r.path.includes(`modes${path.sep}roblox${path.sep}tools`));
        },
      ),
      { numRuns: 30 },
    );
  });
});

// --- Property: askUser handleAskUser ----------------------------------------

describe("Property: askUser handleAskUser", () => {
  it("alternativas com menos de 2 itens → sempre retorna [ERRO]", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          pergunta: fc.string({ minLength: 1, maxLength: 50 }),
          alternativas: fc.array(fc.string({ maxLength: 30 }), { maxLength: 1 }),
        }),
        async ({ pergunta, alternativas }) => {
          // Sem callback setado — mas a validação < 2 acontece ANTES do check
          // de permissão, então deve retornar [ERRO] independente disso.
          const result = await handleAskUser({ pergunta, alternativas });
          return /\[ERRO\]/.test(result.resultStr);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("alternativas com mais de 6 itens → sempre retorna [ERRO]", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          pergunta: fc.string({ minLength: 1, maxLength: 50 }),
          // 7 a 15 alternativas (todas > 6)
          alternativas: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 7, maxLength: 15 }),
        }),
        async ({ pergunta, alternativas }) => {
          const result = await handleAskUser({ pergunta, alternativas });
          return /\[ERRO\]/.test(result.resultStr);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("pergunta vazia → sempre retorna [ERRO]", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(""),
          fc.constant("   "),
          fc.string({ maxLength: 5 }).filter((s) => s.trim() === ""),
        ),
        fc.array(fc.string({ maxLength: 30 }), { minLength: 2, maxLength: 6 }),
        async (pergunta, alternativas) => {
          // pergunta vazia: handleAskUser converte pra "" via String(args.pergunta ?? "")
          // e retorna [ERRO] antes de validar alternativas.
          const result = await handleAskUser({ pergunta, alternativas });
          return /\[ERRO\]/.test(result.resultStr);
        },
      ),
      { numRuns: 30 },
    );
  });
});

// --- Property: toolConfigurator isSafeCommand -------------------------------

describe("Property: toolConfigurator isSafeCommand", () => {
  it("qualquer comando com | → isSafeCommand retorna false", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ maxLength: 30 }).filter((s) => !s.includes("|") && !/[;&<>`$]/.test(s)),
          fc.string({ maxLength: 30 }).filter((s) => !s.includes("|") && !/[;&<>`$]/.test(s)),
        ),
        ([prefix, suffix]) => {
          // Monta comando com pipe | no meio. Deve sempre ser rejeitado
          // (DANGEROUS_CHARS contém |).
          const cmd = `${prefix}|${suffix}`;
          return isSafeCommand(cmd) === false;
        },
      ),
      { numRuns: 50 },
    );
  });

  it("qualquer comando com > → isSafeCommand retorna false", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.string({ maxLength: 30 }).filter((s) => !s.includes(">") && !/[|;&<`$]/.test(s)),
          fc.string({ maxLength: 30 }).filter((s) => !s.includes(">") && !/[|;&<`$]/.test(s)),
        ),
        ([prefix, suffix]) => {
          // Monta comando com redirect > no meio. Deve sempre ser rejeitado.
          const cmd = `${prefix}>${suffix}`;
          return isSafeCommand(cmd) === false;
        },
      ),
      { numRuns: 50 },
    );
  });
});
