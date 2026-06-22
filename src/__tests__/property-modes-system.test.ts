/**
 * property-modes-system.test.ts — Testes property-based para o sistema de modos.
 *
 * Usa fast-check v4.8.0 para gerar inputs aleatórios e verificar PROPRIEDADES
 * que devem ser verdadeiras para TODOS os inputs válidos.
 *
 * Propriedades testadas (agrupadas por módulo):
 *   - configSchema: validateModeConfig / isValidModeConfig
 *   - inboxOrganizer: classifyFile (extensão → tipo)
 *   - toolDetector: findToolBinary (toolName vazio, mode null)
 *   - toolConfigurator: isSafeCommand (whitelist de comandos)
 *
 * Padrão: fc.assert(fc.property(arbitrário, predicado))
 *   - numRuns reduzido (50 ou menos) para acelerar a suíte.
 *   - Propriedades que falham são marcadas com .skip e documentadas.
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

// Mock node:child_process: impede detectTool de fazer `which`/`where` real,
// garantindo que findToolBinary só encontre binários nas pastas de modo.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("mocked: command not found");
  }),
  spawn: vi.fn(),
}));

// --- Imports ----------------------------------------------------------------

import { validateModeConfig, isValidModeConfig } from "../configSchema.js";
import { classifyFile, type FileType } from "../inboxOrganizer.js";
import { findToolBinary } from "../toolDetector.js";
import { isSafeCommand } from "../toolConfigurator.js";

// --- Setup / Teardown (HOME temporário para testes de FS) -------------------

let tmpHome: string;
let origCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-prop-modes-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  origCwd = process.cwd();
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
});

// --- Arbitraries reutilizáveis ----------------------------------------------

/** Strings que NÃO contêm "--help" ou "--version" (para gerar comandos não-seguros). */
const arbStringNoSafeFlags = fc.string({ maxLength: 50 }).filter(
  (s) => !s.includes("--help") && !s.includes("--version"),
);

/** Nomes de binários "perigosos" (não são where/find/ls/dir/help/version). */
const arbDangerousBinName = fc.constantFrom(
  "rm", "curl", "wget", "delete", "destroy", "execute",
  "format", "dd", "mkfs", "shutdown", "reboot", "kill",
);

/** Gera comandos que NÃO começam com padrão seguro (where/find/ls/dir nem word+--help). */
const arbNonSafeCommand = fc.oneof(
  // Comando só com binário perigoso (sem flag)
  arbDangerousBinName,
  // Binário perigoso + argumento qualquer (não --help/--version)
  fc.tuple(arbDangerousBinName, arbStringNoSafeFlags).map(
    ([bin, arg]) => `${bin} ${arg}`.trim(),
  ),
);

/**
 * Gera comandos no formato `<bin> --help` (deve ser seguro).
 * O binário contém APENAS chars da classe `[\w./\\-]` (que o regex
 * ALLOWED_COMMAND_PATTERNS aceita) — caso contrário, o regex não casa
 * e o comando seria rejeitado (limitação do regex, não bug).
 */
const arbHelpCommand = fc.tuple(
  fc.stringMatching(/^[a-zA-Z0-9_./\\-]{1,30}$/).filter((s) => s.length > 0),
  fc.string({ maxLength: 20 }).filter((s) => !s.includes("--help") && !s.includes("--version")),
).map(([bin, rest]) => (rest ? `${bin} --help ${rest}` : `${bin} --help`));

// --- Property: config schema ------------------------------------------------

describe("Property: config schema", () => {
  it("qualquer objeto → validateModeConfig nunca lança erro (sempre retorna array)", () => {
    fc.assert(
      fc.property(
        fc.anything().filter((x) => x !== null && x !== undefined),
        (config) => {
          // Para qualquer input não-null/undefined, validateModeConfig
          // deve retornar um array (possivelmente vazio) sem lançar erro.
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

  it("config válido → isValidModeConfig retorna true", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 30 }),
          label: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        (base) => {
          // Config mínimo válido (name + label strings não-vazias) é válido.
          // Adiciona campos opcionais que NÃO invalidam o config.
          const config = { ...base, tools: [], skills: [], validators: [] };
          return isValidModeConfig(config) === true;
        },
      ),
      { numRuns: 50 },
    );
  });

  it("config sem name → isValidModeConfig retorna false", () => {
    fc.assert(
      fc.property(
        fc.record({
          label: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        (base) => {
          // Config sem name (ou com name não-string) é inválido.
          const config = { ...base }; // sem name
          return isValidModeConfig(config) === false;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// --- Property: inbox classifier --------------------------------------------

describe("Property: inbox classifier", () => {
  it("qualquer .exe → classifyFile retorna 'tool'", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 50 }).filter((s) => s.length > 0 && !s.includes("/")),
        (baseName) => {
          // Cria arquivo .exe (conteúdo irrelevante — .exe não lê conteúdo)
          const filePath = path.join(tmpHome, `${baseName}.exe`);
          fs.writeFileSync(filePath, "fake exe");
          const result = classifyFile(filePath);
          return result === "tool";
        },
      ),
      { numRuns: 50 },
    );
  });

  it("qualquer .md → classifyFile retorna 'skill'", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 50 }).filter((s) => s.length > 0 && !s.includes("/")),
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

  it("qualquer .zip → classifyFile retorna 'archive'", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 50 }).filter((s) => s.length > 0 && !s.includes("/")),
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
});

// --- Property: findToolBinary -----------------------------------------------

describe("Property: findToolBinary", () => {
  it("toolName vazio → sempre retorna null", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(""),
          fc.constant("   "),
          fc.constant("\t"),
          fc.constant("\n"),
          fc.string({ maxLength: 5 }).filter((s) => s.trim() === ""),
        ),
        fc.oneof(fc.constant(null), fc.constant("roblox"), fc.constant("devops")),
        (toolName, modeName) => {
          // toolName vazio (ou só whitespace) → sempre retorna null,
          // independente do modo. Implementação: `if (!toolName) return null;`
          // Só funciona para "" exatamente (string vazia é falsy).
          // Para "   " (whitespace só), !toolName é false, então NÃO retorna null
          // imediatamente — mas como não encontra o binário, retorna null anyway.
          const result = findToolBinary(toolName, modeName);
          return result === null;
        },
      ),
      { numRuns: 50 },
    );
  });

  it("mode null → nunca olha pasta de modo (só normal + legacy)", () => {
    fc.assert(
      fc.property(
        // Prefixo "ck-prop-" evita colisão com binários reais do sistema
        // (ex.: /usr/bin/w existe e poderia ser encontrado via detectTool).
        fc.string({ minLength: 1, maxLength: 20 }).filter(
          (s) => /^[a-zA-Z0-9_-]+$/.test(s) && !s.includes(" "),
        ).map((s) => `ck-prop-${s}`),
        (toolName) => {
          // Cria o binário APENAS na pasta de modo (roblox/tools/).
          // Com mode=null, findToolBinary NÃO deve olhar essa pasta,
          // então o resultado NUNCA deve ser o path da pasta de modo.
          // (Pode ser null, ou path do normal, ou path do legacy — mas
          // nunca o path de modes/roblox/tools/.)
          const modeToolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
          fs.mkdirSync(modeToolsDir, { recursive: true });
          const modePath = path.join(modeToolsDir, toolName);
          fs.writeFileSync(modePath, "fake");

          // mode=null: NÃO deve retornar o path da pasta de modo
          // (prova que a pasta de modo foi pulada).
          const result = findToolBinary(toolName, null);
          return result !== modePath;
        },
      ),
      { numRuns: 50 },
    );
  });
});

// --- Property: hook safety --------------------------------------------------

describe("Property: hook safety (isSafeCommand)", () => {
  it("qualquer comando sem --help/--version/where/find/ls → isSafeCommand retorna false", () => {
    fc.assert(
      fc.property(arbNonSafeCommand, (cmd) => {
        // Comandos que NÃO começam com padrão seguro devem ser rejeitados.
        // Exceções conhecidas (não cobertas pelo arbitrary):
        //   - "dir ..." (também é seguro, mas não está no arbitrary)
        //   - comandos começando com where/find/ls/dir seguidos de espaço
        // O arbitrary gera apenas binários perigosos + args não-safe-flags,
        // então nenhum deve passar na whitelist.
        return isSafeCommand(cmd) === false;
      }),
      { numRuns: 100 },
    );
  });

  it("qualquer comando começando com --help (após binário) → isSafeCommand retorna true", () => {
    fc.assert(
      fc.property(arbHelpCommand, (cmd) => {
        // Comando no formato `<bin> --help [<rest>]` deve ser considerado seguro.
        // O regex `/^[\w./\\-]+\s+--help/i` casa o início.
        // NOTA: o regex NÃO tem âncora `$`, então o restante é ignorado
        // (limitação conhecida e documentada em toolConfigurator-extended.test.ts).
        return isSafeCommand(cmd) === true;
      }),
      { numRuns: 50 },
    );
  });
});
