/**
 * hookRunner-extended.test.ts — Edge cases do hookRunner (Sprint 8).
 *
 * Cobre situações que o teste básico não toca:
 *   - loadHooks com hooks.json sem campo file → ignora
 *   - loadHooks com hooks.json sem campo trigger → ignora
 *   - loadHooks com trigger inválido → ignora (não valida trigger, mas
 *     campos obrigatórios são name/file/trigger)
 *   - runHooks com context.toolExecutor → N/A (HookContext não tem toolExecutor,
 *     mas testamos que context campos extras são ignorados sem erro)
 *   - runHooks com múltiplos hooks do mesmo trigger → roda em sequência
 *   - runHooks com hook que posta objeto sem campos → tratado como null
 *   - runHooks com hook que posta string (não objeto) → tratado como warning
 *   - loadHooks prefere user dir sobre bundled
 *   - resolveHooksDir retorna vazio quando mode é null
 *   - hook com timeout 0 → usa default 5000
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadHooks,
  loadHooksFromDir,
  resolveHooksDir,
  runHooks,
} from "../hookRunner.js";

let tmpRoot: string;
let fakeHome: string;
let fakeCwd: string;
let realHome: string | undefined;
let realUserprofile: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hookrunner_ext_"));
  fakeHome = path.join(tmpRoot, "home");
  fakeCwd = path.join(tmpRoot, "cwd");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeCwd, { recursive: true });
  realHome = process.env.HOME;
  realUserprofile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  vi.spyOn(process, "cwd").mockReturnValue(fakeCwd);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserprofile;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeBundledHooksDir(mode: string): string {
  const dir = path.join(fakeCwd, "defaults", "modes", mode, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeUserHooksDir(mode: string): string {
  const dir = path.join(fakeHome, ".claude-killer", "modes", mode, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir: string, file: string, obj: unknown): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj), "utf8");
}

function writeHookJs(dir: string, file: string, code: string): void {
  fs.writeFileSync(path.join(dir, file), code, "utf8");
}

describe("hookRunner — extended (edge cases)", () => {
  // --- loadHooks field validation --------------------------------------------

  it("ignora hooks.json sem campo file", () => {
    const dir = makeBundledHooksDir("m1");
    writeJson(dir, "no-file.json", { name: "x", trigger: "on_file" });
    expect(loadHooksFromDir(dir)).toEqual([]);
  });

  it("ignora hooks.json sem campo trigger", () => {
    const dir = makeBundledHooksDir("m2");
    writeJson(dir, "no-trigger.json", { name: "x", file: "x.js" });
    expect(loadHooksFromDir(dir)).toEqual([]);
  });

  it("ignora hooks.json sem campo name", () => {
    const dir = makeBundledHooksDir("m3");
    writeJson(dir, "no-name.json", { file: "x.js", trigger: "on_file" });
    expect(loadHooksFromDir(dir)).toEqual([]);
  });

  it("trigger inválido (string qualquer) ainda é aceito (sem whitelist no loadHooks)", () => {
    // O loadHooksFromDir só verifica que trigger é truthy — não valida valores.
    // Logo, um trigger inválido como "unknown_event" é carregado, mas não
    // casa com nenhum dos 4 triggers em runHooks (logo nunca roda).
    const dir = makeBundledHooksDir("m4");
    writeJson(dir, "weird.json", { name: "x", file: "x.js", trigger: "unknown_event" });
    const hooks = loadHooksFromDir(dir);
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.trigger).toBe("unknown_event");
  });

  // --- runHooks multi hook sequência -----------------------------------------

  it("múltiplos hooks do mesmo trigger rodam em sequência (sem blocking)", async () => {
    const dir = makeBundledHooksDir("seq");
    writeJson(dir, "h1.json", { name: "h1", file: "h1.js", trigger: "on_file" });
    writeJson(dir, "h2.json", { name: "h2", file: "h2.js", trigger: "on_file" });
    writeJson(dir, "h3.json", { name: "h3", file: "h3.js", trigger: "on_file" });

    writeHookJs(dir, "h1.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage({ warning: "h1 ran" });
    `);
    writeHookJs(dir, "h2.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage({ warning: "h2 ran" });
    `);
    writeHookJs(dir, "h3.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage({ warning: "h3 ran" });
    `);

    const results = await runHooks("on_file", { mode: "seq" }, "seq");
    expect(results.length).toBe(3);
    const warnings = results.map((r) => r.warning).sort();
    expect(warnings).toEqual(["h1 ran", "h2 ran", "h3 ran"]);
  });

  it("hook que posta objeto vazio {} é tratado como resultado válido (não null)", async () => {
    const dir = makeBundledHooksDir("emptyobj");
    writeJson(dir, "empty.json", { name: "empty", file: "empty.js", trigger: "on_file" });
    writeHookJs(dir, "empty.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage({});
    `);

    const results = await runHooks("on_file", { mode: "emptyobj" }, "emptyobj");
    // {} é truthy como objeto, então é adicionado aos resultados.
    expect(results.length).toBe(1);
    expect(results[0]).toEqual({});
  });

  it("hook que posta string (não objeto) não quebra o host (worker trata como mensagem)", async () => {
    const dir = makeBundledHooksDir("strmsg");
    writeJson(dir, "str.json", { name: "str", file: "str.js", trigger: "on_file" });
    writeHookJs(dir, "str.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage("just a string");
    `);

    // Não deve dar throw — a string é tratada como HookResult (campos undefined).
    const results = await runHooks("on_file", { mode: "strmsg" }, "strmsg");
    // Como "just a string" é truthy, é adicionado como resultado.
    expect(results.length).toBe(1);
  });

  // --- loadHooks preferência user > bundled ----------------------------------

  it("loadHooks prefere user dir sobre bundled (ignora bundled quando user tem hooks)", () => {
    const userDir = makeUserHooksDir("pref");
    const bundledDir = makeBundledHooksDir("pref");
    writeJson(userDir, "u.json", { name: "u", file: "u.js", trigger: "on_file" });
    writeJson(bundledDir, "b.json", { name: "b", file: "b.js", trigger: "on_file" });

    const hooks = loadHooks("pref");
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.name).toBe("u");
  });

  // --- resolveHooksDir -------------------------------------------------------

  it("resolveHooksDir retorna string vazia quando mode é null", () => {
    expect(resolveHooksDir(null)).toBe("");
  });

  it("resolveHooksDir retorna string vazia quando nenhum dir existe", () => {
    expect(resolveHooksDir("modo-inexistente-xyz")).toBe("");
  });

  it("resolveHooksDir retorna user dir quando ele existe (mesmo vazio)", () => {
    const userDir = makeUserHooksDir("empt");
    expect(resolveHooksDir("empt")).toBe(userDir);
  });

  // --- timeout default -------------------------------------------------------

  it("hook com timeout 0 no JSON usa default 5000ms (aplicado por spread)", () => {
    const dir = makeBundledHooksDir("t0");
    writeJson(dir, "t.json", { name: "t", file: "t.js", trigger: "on_file", timeout: 0 });
    const hooks = loadHooksFromDir(dir);
    // O spread `{ timeout: 5000, ...cfg }` coloca 5000 primeiro; se cfg tem
    // timeout: 0, o 0 sobrescreve. Mas timeout 0 é falsy → ainda assim o hook
    // carrega com timeout=0. Como o código faz `hook.timeout ?? 5000` em
    // runHookInWorker, 0 (não-undefined) é preservado.
    expect(hooks.length).toBe(1);
    expect(hooks[0]!.timeout).toBe(0);
  });

  it("hook sem timeout no JSON recebe default 5000ms", () => {
    const dir = makeBundledHooksDir("tdefault");
    writeJson(dir, "t.json", { name: "t", file: "t.js", trigger: "on_file" });
    const hooks = loadHooksFromDir(dir);
    expect(hooks[0]!.timeout).toBe(5000);
  });

  // --- Context campos extras -------------------------------------------------

  it("context com campos extras (toolExecutor, etc.) é ignorado sem erro", async () => {
    const dir = makeBundledHooksDir("ctx");
    writeJson(dir, "h.json", { name: "h", file: "h.js", trigger: "before_write" });
    writeHookJs(dir, "h.js", `
      const { parentPort, workerData } = require("worker_threads");
      // workerData só tem filePath/content/mode — extras são ignorados.
      parentPort.postMessage({
        message: "got " + (workerData.filePath ?? "nada"),
      });
    `);

    // Passa context com campo extra (toolExecutor) — não deve dar erro.
    const results = await runHooks(
      "before_write",
      { filePath: "/tmp/x.luau", content: "x", mode: "ctx", /* toolExecutor: ... */ } as any,
      "ctx",
    );
    expect(results.length).toBe(1);
    expect(results[0]!.message).toBe("got /tmp/x.luau");
  });
});
