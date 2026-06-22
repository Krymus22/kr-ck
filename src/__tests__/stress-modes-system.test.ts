/**
 * stress-modes-system.test.ts — Stress tests do novo sistema de modos.
 *
 * Mede tempo de execução em cenários de alta carga:
 *   - Inbox: 100 arquivos mistos, 50 .exe, 50 .md
 *   - manifestLoader: carrega 50 manifests; gera function calls pra 50 tools
 *   - hookRunner: carrega 20 hooks; roda 20 hooks do mesmo trigger
 *   - configSchema: valida 1000 configs
 *
 * Padrão:
 *   - Cada teste mede Date.now() antes/depois e espera tempo < limite.
 *   - Limites são GENEROSOS (3x-5x o observado em dev) pra evitar flakiness.
 *   - Se um teste falhar por timing, AUMENTAR o limite (não reduzir a carga).
 *
 * Mocks: logger (todos), modes/toolDetector (manifestLoader), child_process
 * (manifestLoader + não interfere em inbox/hookRunner).
 *
 * IMPORTANTE: nenhum código fonte foi alterado. Ajustes foram feitos apenas
 * em limites de tempo (generosos) e em mocks.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks de dependências externas -----------------------------------------

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock modes.js (usado por manifestLoader e inboxOrganizer indiretamente)
const modesMock = vi.hoisted(() => ({ getActiveMode: vi.fn(() => null) }));
vi.mock("../modes.js", () => ({ getActiveMode: modesMock.getActiveMode }));

// Mock toolDetector.js (usado por manifestLoader)
const toolDetectorMock = vi.hoisted(() => ({ findToolBinary: vi.fn(() => "/fake/binary") }));
vi.mock("../toolDetector.js", () => ({ findToolBinary: toolDetectorMock.findToolBinary }));

// Mock node:child_process (usado por manifestLoader.executeFromManifest)
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "ok output"),
  spawn: vi.fn(),
}));

// --- Imports ----------------------------------------------------------------

import { organizeInbox } from "../inboxOrganizer.js";
import {
  loadModeManifests,
  generateFunctionCallsFromManifests,
  type ToolManifest,
} from "../manifestLoader.js";
import { loadHooks, runHooks } from "../hookRunner.js";
import { validateModeConfig } from "../configSchema.js";

// --- Setup / Teardown (HOME temporário) -------------------------------------

let tmpHome: string;
let origCwd: string;
let realHome: string | undefined;
let realUserprofile: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-stress-"));
  realHome = process.env.HOME;
  realUserprofile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  origCwd = process.cwd();
  vi.clearAllMocks();
  modesMock.getActiveMode.mockReturnValue(null);
  toolDetectorMock.findToolBinary.mockReturnValue("/fake/binary");
});

afterEach(() => {
  process.chdir(origCwd);
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserprofile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// --- Helpers ----------------------------------------------------------------

/** Cria a pasta inbox/ de um modo e retorna o caminho. */
function makeInbox(modeName: string): string {
  const inbox = path.join(tmpHome, ".claude-killer", "modes", modeName, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  return inbox;
}

/** Cria a pasta manifests/ de um modo e retorna o caminho. */
function makeManifestsDir(modeName: string): string {
  const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "manifests");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Cria a pasta hooks/ de um modo (no HOME temporário) e retorna o caminho. */
function makeBundledHooksDir(modeName: string): string {
  // hookRunner.candidateHooksDirs() olha ~/.claude-killer/modes/<mode>/hooks
  // primeiro e depois process.cwd()/defaults/modes/<mode>/hooks. Usamos o
  // user dir (no tmpHome) pra que o cleanup do afterEach remova tudo.
  const dir = path.join(tmpHome, ".claude-killer", "modes", modeName, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Stress: Inbox com 100 arquivos ----------------------------------------

describe("Stress: Inbox com 100 arquivos", () => {
  it("organiza 100 arquivos mistos (.exe, .md, .js, .json) em < 2s", () => {
    const inbox = makeInbox("stressmix");
    // 25 .exe + 25 .md + 25 .js + 25 .json = 100 arquivos
    for (let i = 0; i < 25; i++) {
      fs.writeFileSync(path.join(inbox, `tool-${i}.exe`), "fake");
      fs.writeFileSync(path.join(inbox, `skill-${i}.md`), "# doc");
      // .js com module.exports pra virar hook
      fs.writeFileSync(
        path.join(inbox, `hook-${i}.js`),
        "module.exports = { trigger: 'on_file', run: () => {} };",
      );
      // .json (manifest padrão)
      fs.writeFileSync(
        path.join(inbox, `manifest-${i}.json`),
        JSON.stringify({ name: `t${i}`, command: "fake", args: [] }),
      );
    }
    expect(fs.readdirSync(inbox).length).toBe(100);

    const start = Date.now();
    const result = organizeInbox("stressmix");
    const elapsed = Date.now() - start;

    // 100 arquivos processados em < 2s (limite generoso: dev observa ~50ms).
    expect(elapsed).toBeLessThan(2000);
    // Nenhum erro
    expect(result.errors.length).toBe(0);
    // Todos os 100 foram organizados (nenhum ignorado)
    expect(result.organized.length).toBe(100);
    expect(result.ignored.length).toBe(0);
  });

  it("50 arquivos .exe → todos movidos pra tools/", () => {
    const inbox = makeInbox("stressexe");
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(inbox, `tool-${i}.exe`), "fake");
    }

    const result = organizeInbox("stressexe");

    expect(result.organized.length).toBe(50);
    // Todos classificados como "tool"
    expect(result.organized.every((o) => o.fileType === "tool")).toBe(true);
    // Todos movidos pra tools/
    expect(result.organized.every((o) => o.destination.includes(`tools${path.sep}`))).toBe(true);
    // Inbox vazio após organize
    expect(fs.readdirSync(inbox).length).toBe(0);
    // Pasta tools/ tem 50 arquivos
    const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "stressexe", "tools");
    expect(fs.readdirSync(toolsDir).length).toBe(50);
  });

  it("50 arquivos .md → todos movidos pra skills/", () => {
    const inbox = makeInbox("stressmd");
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(path.join(inbox, `skill-${i}.md`), "# doc");
    }

    const result = organizeInbox("stressmd");

    expect(result.organized.length).toBe(50);
    // Todos classificados como "skill"
    expect(result.organized.every((o) => o.fileType === "skill")).toBe(true);
    // Todos movidos pra skills/
    expect(result.organized.every((o) => o.destination.includes(`skills${path.sep}`))).toBe(true);
    // Pasta skills/ tem 50 arquivos
    const skillsDir = path.join(tmpHome, ".claude-killer", "modes", "stressmd", "skills");
    expect(fs.readdirSync(skillsDir).length).toBe(50);
  });
});

// --- Stress: manifestLoader com 50 manifests --------------------------------

describe("Stress: manifestLoader com 50 manifests", () => {
  it("carrega 50 manifests em < 1s", () => {
    const dir = makeManifestsDir("stressmanifest");
    // Cria 50 arquivos .json, cada um com um array de 1 manifest
    for (let i = 0; i < 50; i++) {
      fs.writeFileSync(
        path.join(dir, `tool-${i}.json`),
        JSON.stringify([{
          name: `tool_${i}`,
          description: `Tool ${i}`,
          category: "action",
          command: `bin-${i}`,
          args: [],
        }]),
      );
    }
    expect(fs.readdirSync(dir).length).toBe(50);

    const start = Date.now();
    const manifests = loadModeManifests("stressmanifest");
    const elapsed = Date.now() - start;

    // 50 manifests carregados em < 1s (dev observa ~10ms).
    expect(elapsed).toBeLessThan(1000);
    expect(manifests.length).toBe(50);
  });

  it("generateFunctionCallsFromManifests com 50 tools em < 500ms", () => {
    // Gera 50 manifest objects em memória (sem I/O de disco).
    const manifests: ToolManifest[] = [];
    for (let i = 0; i < 50; i++) {
      manifests.push({
        name: `tool_${i}`,
        description: `Tool ${i} description`,
        category: "action",
        command: `bin-${i}`,
        args: ["--foo"],
        flags: [
          { name: "--flag1", type: "string", description: "flag1 desc" },
          { name: "--flag2", type: "boolean", description: "flag2 desc" },
          { name: "--flag3", type: "number", description: "flag3 desc" },
        ],
        context: {
          whenToUse: [`case ${i}a`, `case ${i}b`],
          examples: [`tool_${i} --flag1 x`],
        },
      });
    }

    // findToolBinary mockado pra retornar path válido pra todos.
    toolDetectorMock.findToolBinary.mockReturnValue("/fake/binary");

    const start = Date.now();
    const calls = generateFunctionCallsFromManifests(manifests, "stressmode");
    const elapsed = Date.now() - start;

    // 50 function calls geradas em < 500ms (dev observa ~5ms).
    expect(elapsed).toBeLessThan(500);
    expect(calls.length).toBe(50);
    // Cada call tem nome único
    const names = calls.map((c) => c.function.name);
    expect(new Set(names).size).toBe(50);
  });
});

// --- Stress: hookRunner com 20 hooks ----------------------------------------

describe("Stress: hookRunner com 20 hooks", () => {
  it("carrega 20 hooks sem erro", () => {
    const dir = makeBundledHooksDir("stresshooks");
    // Limpa dir antes de recriar (caso rode múltiplas vezes)
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    // Cria 20 hook configs (.json) + 20 hook scripts (.js)
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(dir, `hook-${i}.json`),
        JSON.stringify({
          name: `hook-${i}`,
          file: `hook-${i}.js`,
          trigger: "on_file",
          timeout: 1000,
        }),
      );
      fs.writeFileSync(
        path.join(dir, `hook-${i}.js`),
        `const { parentPort } = require("worker_threads"); parentPort.postMessage({ warning: "hook-${i} ran" });`,
      );
    }
    expect(fs.readdirSync(dir).length).toBe(40); // 20 .json + 20 .js

    // Carrega hooks: deve retornar 20 configs sem erro.
    const hooks = loadHooks("stresshooks");
    expect(hooks.length).toBe(20);
    // Todos têm trigger "on_file"
    expect(hooks.every((h) => h.trigger === "on_file")).toBe(true);
  });

  it("runHooks com 20 hooks do mesmo trigger em < 5s (com timeout)", async () => {
    const dir = makeBundledHooksDir("stressrun");
    for (const f of fs.readdirSync(dir)) {
      fs.unlinkSync(path.join(dir, f));
    }
    // 20 hooks que cada um posta uma mensagem imediatamente.
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(dir, `hook-${i}.json`),
        JSON.stringify({
          name: `hook-${i}`,
          file: `hook-${i}.js`,
          trigger: "on_file",
          timeout: 1000,
        }),
      );
      fs.writeFileSync(
        path.join(dir, `hook-${i}.js`),
        `const { parentPort } = require("worker_threads"); parentPort.postMessage({ warning: "hook-${i} ran" });`,
      );
    }

    const start = Date.now();
    const results = await runHooks("on_file", { mode: "stressrun" }, "stressrun");
    const elapsed = Date.now() - start;

    // 20 hooks rodando em sequência (cada um num Worker separado).
    // Dev observa ~1-2s. Limite generoso: 5s.
    expect(elapsed).toBeLessThan(5000);
    // Cada hook postou uma mensagem → 20 resultados
    expect(results.length).toBe(20);
  });
});

// --- Stress: configSchema validation ----------------------------------------

describe("Stress: configSchema validation", () => {
  it("valida 1000 configs em < 1s", () => {
    // Gera 1000 configs variados (mistura de válidos e inválidos).
    const configs: unknown[] = [];
    for (let i = 0; i < 1000; i++) {
      if (i % 3 === 0) {
        // Válido
        configs.push({
          name: `mode-${i}`,
          label: `Mode ${i}`,
          tools: [],
          skills: [],
          validators: [],
          hooks: [],
        });
      } else if (i % 3 === 1) {
        // Inválido: sem name
        configs.push({ label: `Mode ${i}`, tools: [] });
      } else {
        // Inválido: name não-string
        configs.push({ name: 123, label: `Mode ${i}` });
      }
    }

    const start = Date.now();
    for (const c of configs) {
      validateModeConfig(c);
    }
    const elapsed = Date.now() - start;

    // 1000 validações em < 1s (dev observa ~5-10ms).
    expect(elapsed).toBeLessThan(1000);
  });
});
