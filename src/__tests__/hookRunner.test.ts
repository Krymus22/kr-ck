/**
 * hookRunner.test.ts — Tests for the Sprint 8 Worker-Thread hook system.
 *
 * Coverage:
 *   1.  loadHooks() carrega hooks da pasta do modo
 *   2.  loadHooks() retorna vazio quando pasta não existe
 *   3.  loadHooks() ignora JSON inválido
 *   4.  loadHooksFromDir pula configs sem campos obrigatórios (name/file/trigger)
 *   5.  loadHooks(null) retorna []
 *   6.  runHooks() roda hooks com trigger correto
 *   7.  runHooks() não roda hooks com trigger diferente
 *   8.  runHooks() para no primeiro blocking
 *   9.  Hook timeout (worker terminado após short timeout)
 *   10. Hook que lança erro não trava o loop
 *   11. Hook retorna modifiedContent → repassado no resultado
 *   12. Hook retorna null → não faz nada (resultados vazios)
 *
 * Setup: mock os.homedir() and process.cwd() to a temp dir so loadHooks()
 * finds hooks at <tempCwd>/defaults/modes/<mode>/hooks/ and never collides
 * with the developer's real ~/.claude-killer directory.
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

// --- Test fixtures ----------------------------------------------------------

let tmpRoot: string;
let fakeHome: string;
let fakeCwd: string;
let realHome: string | undefined;
let realUserprofile: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hookrunner_"));
  fakeHome = path.join(tmpRoot, "home");
  fakeCwd = path.join(tmpRoot, "cwd");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeCwd, { recursive: true });

  // Save real env values so we can restore them in afterEach.
  realHome = process.env.HOME;
  realUserprofile = process.env.USERPROFILE;

  // Mock HOME / USERPROFILE so candidateHooksDirs() (which reads process.env
  // first, then os.homedir() as fallback) resolves inside the temp tree.
  // We avoid vi.spyOn(os, "homedir") because the `node:os` namespace import
  // is non-configurable in ESM — process.env is enough for our coverage.
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
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Create <cwd>/defaults/modes/<mode>/hooks/ and return its path. */
function makeBundledHooksDir(mode: string): string {
  const dir = path.join(fakeCwd, "defaults", "modes", mode, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create <home>/.claude-killer/modes/<mode>/hooks/ and return its path. */
function makeUserHooksDir(mode: string): string {
  const dir = path.join(fakeHome, ".claude-killer", "modes", mode, "hooks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(dir: string, file: string, obj: unknown): void {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj), "utf8");
}

function writeInvalidJson(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content, "utf8");
}

function writeHookJs(dir: string, file: string, code: string): void {
  fs.writeFileSync(path.join(dir, file), code, "utf8");
}

// --- 1-5: loadHooks / loadHooksFromDir -------------------------------------

describe("loadHooks", () => {
  it("1. carrega hooks da pasta bundled do modo", () => {
    const dir = makeBundledHooksDir("roblox");
    writeJson(dir, "auto-build.json", {
      name: "auto-build",
      file: "auto-build.js",
      trigger: "on_file",
      timeout: 30000,
    });
    writeJson(dir, "lint.json", {
      name: "lint",
      file: "lint.js",
      trigger: "before_write",
    });

    const hooks = loadHooks("roblox");
    expect(hooks).toHaveLength(2);
    const names = hooks.map((h) => h.name).sort();
    expect(names).toEqual(["auto-build", "lint"]);
    // Default timeout should be applied when not specified.
    const lint = hooks.find((h) => h.name === "lint")!;
    expect(lint.timeout).toBe(5000);
    // Explicit timeout preserved.
    const autoBuild = hooks.find((h) => h.name === "auto-build")!;
    expect(autoBuild.timeout).toBe(30000);
  });

  it("2. retorna vazio quando a pasta do modo não existe", () => {
    const hooks = loadHooks("this-mode-does-not-exist");
    expect(hooks).toEqual([]);
  });

  it("3. ignora JSON inválido sem lançar erro", () => {
    const dir = makeBundledHooksDir("broken");
    writeInvalidJson(dir, "broken.json", "{ this is not valid json");
    writeJson(dir, "good.json", {
      name: "good",
      file: "good.js",
      trigger: "on_file",
    });

    const hooks = loadHooks("broken");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.name).toBe("good");
  });

  it("4. loadHooksFromDir pula configs sem campos obrigatórios", () => {
    const dir = makeBundledHooksDir("partial");
    writeJson(dir, "no-name.json", { file: "a.js", trigger: "on_file" });
    writeJson(dir, "no-file.json", { name: "b", trigger: "on_file" });
    writeJson(dir, "no-trigger.json", { name: "c", file: "c.js" });
    writeJson(dir, "valid.json", {
      name: "valid",
      file: "valid.js",
      trigger: "always",
    });

    const hooks = loadHooksFromDir(dir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.name).toBe("valid");
    expect(hooks[0]!.trigger).toBe("always");
  });

  it("5. loadHooks(null) retorna array vazio sem acessar o filesystem", () => {
    expect(loadHooks(null)).toEqual([]);
  });

  it("5b. prefere diretório user (~/.claude-killer) sobre bundled (defaults/)", () => {
    const userDir = makeUserHooksDir("roblox");
    const bundledDir = makeBundledHooksDir("roblox");
    writeJson(userDir, "user-hook.json", {
      name: "user-hook",
      file: "user.js",
      trigger: "on_file",
    });
    writeJson(bundledDir, "bundled-hook.json", {
      name: "bundled-hook",
      file: "bundled.js",
      trigger: "on_file",
    });

    const hooks = loadHooks("roblox");
    // Should ONLY see user hooks (loadHooks returns from first dir with hooks)
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.name).toBe("user-hook");
  });

  it("5c. resolveHooksDir retorna string vazia para mode null", () => {
    expect(resolveHooksDir(null)).toBe("");
  });
});

// --- 6-8: runHooks filtering and blocking ----------------------------------

describe("runHooks - filtering", () => {
  it("6. roda hooks com trigger correto", async () => {
    const dir = makeBundledHooksDir("test6");
    writeJson(dir, "a.json", {
      name: "a",
      file: "a.js",
      trigger: "on_file",
    });
    writeJson(dir, "b.json", {
      name: "b",
      file: "b.js",
      trigger: "before_write",
    });
    writeHookJs(dir, "a.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage({ warning: "a ran" });
    `);
    writeHookJs(dir, "b.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage({ warning: "b ran" });
    `);

    const results = await runHooks("on_file", { mode: "test6" }, "test6");
    // Only hook "a" matches "on_file" trigger
    expect(results).toHaveLength(1);
    expect(results[0]!.warning).toBe("a ran");
  });

  it("7. não roda hooks com trigger diferente", async () => {
    const dir = makeBundledHooksDir("test7");
    writeJson(dir, "only-before-write.json", {
      name: "only-before-write",
      file: "hook.js",
      trigger: "before_write",
    });
    writeHookJs(dir, "hook.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage({ warning: "should not run" });
    `);

    // Ask for on_file -> no hooks match
    const results = await runHooks("on_file", { mode: "test7" }, "test7");
    expect(results).toEqual([]);
  });

  it("8. para no primeiro blocking (não executa hooks subsequentes)", async () => {
    const dir = makeBundledHooksDir("test8");
    writeJson(dir, "first.json", {
      name: "first",
      file: "first.js",
      trigger: "before_write",
    });
    writeJson(dir, "second.json", {
      name: "second",
      file: "second.js",
      trigger: "before_write",
    });
    // The first hook signals blocking with a sentinel flag the second can flip.
    // We track execution by having the second hook write a side-effect file.
    const sentinel = path.join(tmpRoot, "second-ran.txt");
    writeHookJs(dir, "first.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage({ blocking: true, message: "blocked by first" });
    `);
    writeHookJs(dir, "second.js", `
      const { parentPort } = require("worker_threads");
      const fs = require("fs");
      fs.writeFileSync(${JSON.stringify(sentinel)}, "ran");
      parentPort.postMessage({ warning: "second ran" });
    `);

    const results = await runHooks("before_write", { mode: "test8" }, "test8");
    expect(results).toHaveLength(1);
    expect(results[0]!.blocking).toBe(true);
    expect(results[0]!.message).toBe("blocked by first");
    // Second hook should NOT have run
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it("8b. retorna [] quando mode é null", async () => {
    const results = await runHooks("on_file", {}, null);
    expect(results).toEqual([]);
  });
});

// --- 9-10: timeouts and errors ---------------------------------------------

describe("runHooks - timeouts and errors", () => {
  it("9. Hook timeout (worker terminado após short timeout) produz warning", async () => {
    const dir = makeBundledHooksDir("test9");
    writeJson(dir, "slow.json", {
      name: "slow",
      file: "slow.js",
      trigger: "always",
      timeout: 200, // 200ms — short for fast tests
    });
    // Hook never posts a message -> worker hangs until timeout.
    writeHookJs(dir, "slow.js", `
      const { parentPort } = require("worker_threads");
      // Intentionally do nothing (simulate an infinite loop / hang).
      // parentPort.postMessage is never called.
      setInterval(() => {}, 1000);
    `);

    const start = Date.now();
    const results = await runHooks("always", { mode: "test9" }, "test9");
    const elapsed = Date.now() - start;

    expect(results).toHaveLength(1);
    expect(results[0]!.warning).toMatch(/timed out after 200ms/);
    // Should have terminated the worker and returned close to the timeout.
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(2000);
  });

  it("10. Hook que lança erro não trava o loop (produz warning)", async () => {
    const dir = makeBundledHooksDir("test10");
    writeJson(dir, "throws.json", {
      name: "throws",
      file: "throws.js",
      trigger: "on_task",
    });
    // Hook throws an uncaught error.
    writeHookJs(dir, "throws.js", `
      throw new Error("hook boom");
    `);

    const results = await runHooks("on_task", { mode: "test10" }, "test10");
    expect(results).toHaveLength(1);
    expect(results[0]!.warning).toMatch(/hook boom/);
  });

  it("10b. Hook cujo arquivo .js não existe produz warning", async () => {
    const dir = makeBundledHooksDir("test10b");
    writeJson(dir, "missing.json", {
      name: "missing",
      file: "does-not-exist.js",
      trigger: "on_file",
    });

    const results = await runHooks("on_file", { mode: "test10b" }, "test10b");
    expect(results).toHaveLength(1);
    expect(results[0]!.warning).toMatch(/Hook file not found/);
  });
});

// --- 11-12: return values --------------------------------------------------

describe("runHooks - return values", () => {
  it("11. Hook retorna modifiedContent → repassado no resultado", async () => {
    const dir = makeBundledHooksDir("test11");
    writeJson(dir, "modify.json", {
      name: "modify",
      file: "modify.js",
      trigger: "before_write",
    });
    writeHookJs(dir, "modify.js", `
      const { parentPort, workerData } = require("worker_threads");
      const original = workerData.content || "";
      parentPort.postMessage({
        modifiedContent: original + " [modified by hook]",
        warning: "content was modified",
      });
    `);

    const results = await runHooks(
      "before_write",
      { content: "hello", filePath: "/tmp/x.txt", mode: "test11" },
      "test11",
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.modifiedContent).toBe("hello [modified by hook]");
    expect(results[0]!.warning).toBe("content was modified");
  });

  it("12. Hook retorna null (sem postMessage com payload) → não produz resultado", async () => {
    const dir = makeBundledHooksDir("test12");
    writeJson(dir, "noop.json", {
      name: "noop",
      file: "noop.js",
      trigger: "on_file",
    });
    // Hook explicitly posts null (e.g. file extension doesn't match).
    writeHookJs(dir, "noop.js", `
      const { parentPort } = require("worker_threads");
      parentPort.postMessage(null);
    `);

    const results = await runHooks("on_file", { mode: "test12" }, "test12");
    // null results are filtered out — empty array.
    expect(results).toEqual([]);
  });

  it("12b. Hook que termina sem postar mensagem → tratado como no-op", async () => {
    const dir = makeBundledHooksDir("test12b");
    writeJson(dir, "silent.json", {
      name: "silent",
      file: "silent.js",
      trigger: "on_file",
    });
    // Hook exits cleanly without posting any message.
    writeHookJs(dir, "silent.js", `
      const { parentPort } = require("worker_threads");
      // intentionally do nothing — just exit
    `);

    const results = await runHooks("on_file", { mode: "test12b" }, "test12b");
    expect(results).toEqual([]);
  });

  it("13. passa filePath, content e mode no workerData para o hook", async () => {
    const dir = makeBundledHooksDir("test13");
    writeJson(dir, "echo.json", {
      name: "echo",
      file: "echo.js",
      trigger: "before_write",
    });
    writeHookJs(dir, "echo.js", `
      const { parentPort, workerData } = require("worker_threads");
      parentPort.postMessage({
        message: "got " + workerData.filePath + " | " + workerData.content + " | " + workerData.mode,
      });
    `);

    const results = await runHooks(
      "before_write",
      { filePath: "/tmp/foo.luau", content: "body", mode: "test13" },
      "test13",
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.message).toBe("got /tmp/foo.luau | body | test13");
  });
});
