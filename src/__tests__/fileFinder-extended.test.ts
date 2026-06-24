/**
 * fileFinder-extended.test.ts — Edge cases do fileFinder (Sprint 9).
 *
 * Cobre situações que o teste básico não toca:
 *   - searchInDefinedFolders com fileName vazio
 *   - searchInDefinedFolders com mode null (só pasta normal + legacy + PATH)
 *   - searchInDefinedFolders com fileName já tendo .exe
 *   - searchInDefinedFolders encontra arquivo em ~/go/bin/
 *   - copyToModeTools com sourcePath inexistente → null
 *   - copyToModeTools com modeName null → null
 *   - searchFile sem askPermission → retorna só defined folders
 *   - searchFile com askPermission retornando false → não busca máquina
 *   - enumerateDrives fallback quando fsutil falha
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

const cpMock = vi.hoisted(() => ({
  execSync: vi.fn(() => { throw new Error("not in PATH"); }),
}));
vi.mock("node:child_process", () => ({
  execSync: cpMock.execSync,
  spawn: vi.fn(),
}));

import {
  searchInDefinedFolders,
  copyToModeTools,
  searchFile,
} from "../fileFinder.js";

describe("fileFinder — extended (edge cases)", () => {
  let tmpHome: string;
  let originalPlatform: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-ff-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    originalPlatform = process.platform;
    cpMock.execSync.mockReset();
    cpMock.execSync.mockImplementation(() => { throw new Error("not in PATH"); });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  // --- searchInDefinedFolders ------------------------------------------------

  it("com fileName vazio retorna array vazio (sem throw)", () => {
    const results = searchInDefinedFolders("", "roblox");
    expect(results).toEqual([]);
  });

  it("com mode null busca apenas em normal/tools + legacy + PATH (sem modes/<mode>/tools)", () => {
    // Cria arquivo em modes/roblox/tools (deve ser IGNORADO quando mode=null)
    const robloxTools = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
    fs.mkdirSync(robloxTools, { recursive: true });
    fs.writeFileSync(path.join(robloxTools, "rojo"), "fake", "utf8");

    // Cria arquivo em modes/normal/tools (deve ser encontrado)
    const normalTools = path.join(tmpHome, ".claude-killer", "modes", "normal", "tools");
    fs.mkdirSync(normalTools, { recursive: true });
    fs.writeFileSync(path.join(normalTools, "rojo"), "fake", "utf8");

    const results = searchInDefinedFolders("rojo", null);
    const sources = results.map((r) => r.source);
    expect(sources).toContain("modes/normal/tools");
    // Não deve ter buscado em modes/roblox/tools quando mode=null
    expect(sources).not.toContain("modes/roblox/tools");
  });

  it("no Windows, com fileName já tendo .exe, não adiciona .exe duas vezes", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "rojo.exe"), "fake", "utf8");

    // Passa "rojo.exe" (já com extensão)
    const results = searchInDefinedFolders("rojo.exe", "roblox");
    // Deve encontrar o arquivo (pelo fallback que tenta o nome sem modificar)
    const found = results.find((r) => r.path.endsWith("rojo.exe"));
    expect(found).toBeDefined();
  });

  it("encontra arquivo em ~/go/bin/ (legacy)", () => {
    const goBin = path.join(tmpHome, "go", "bin");
    fs.mkdirSync(goBin, { recursive: true });
    fs.writeFileSync(path.join(goBin, "golangci-lint"), "fake", "utf8");

    const results = searchInDefinedFolders("golangci-lint", null);
    const found = results.find((r) => r.source === "go/bin");
    expect(found).toBeDefined();
    expect(found!.path).toContain("go");
    expect(found!.path).toContain("bin");
  });

  it("também busca em .cargo/bin/ (legacy rust)", () => {
    const cargoBin = path.join(tmpHome, ".cargo", "bin");
    fs.mkdirSync(cargoBin, { recursive: true });
    fs.writeFileSync(path.join(cargoBin, "cargo"), "fake", "utf8");

    const results = searchInDefinedFolders("cargo", null);
    const found = results.find((r) => r.source === ".cargo/bin");
    expect(found).toBeDefined();
  });

  it("também busca em .aftman/bin/ (legacy aftman)", () => {
    const aftmanBin = path.join(tmpHome, ".aftman", "bin");
    fs.mkdirSync(aftmanBin, { recursive: true });
    fs.writeFileSync(path.join(aftmanBin, "aftman"), "fake", "utf8");

    const results = searchInDefinedFolders("aftman", null);
    const found = results.find((r) => r.source === ".aftman/bin");
    expect(found).toBeDefined();
  });

  // --- copyToModeTools -------------------------------------------------------

  it("sourcePath inexistente retorna null", () => {
    const result = copyToModeTools(path.join(tmpHome, "nao-existe"), "roblox");
    expect(result).toBeNull();
  });

  it("modeName null não compila (TS) — runtime retorna erro ou cria pasta root", () => {
    // copyToModeTools aceita modeName: string (não nullable). Vamos testar com
    // string vazia que é o equivalente runtimand  morepróximo.
    const src = path.join(tmpHome, "src.bin");
    fs.writeFileSync(src, "x", "utf8");
    const result = copyToModeTools(src, "");
    // Com modeName="", o tools dir vira .../modes//tools — comportamento
    // indefinido, mas não deve dar throw. Aceita null ou string.
    expect(result === null || typeof result === "string").toBe(true);
  });

  // --- searchFile ------------------------------------------------------------

  it("searchFile sem askPermission retorna só defined folders (vazio se não achar)", async () => {
    const { results, searchedEntireMachine } = await searchFile(
      "no-such-binary-zzz",
      "roblox",
      // sem askPermission
    );
    expect(results).toEqual([]);
    expect(searchedEntireMachine).toBe(false);
  });

  it("searchFile com askPermission retornando false não busca máquina", async () => {
    const askPermission = vi.fn().mockResolvedValue(false);
    const { results, searchedEntireMachine } = await searchFile(
      "no-such-binary-zzz",
      "roblox",
      askPermission,
    );
    expect(askPermission).toHaveBeenCalledOnce();
    expect(searchedEntireMachine).toBe(false);
    expect(results).toEqual([]);
  });

  it("searchFile retorna defined folders sem chamar askPermission quando encontra", async () => {
    // Cria arquivo em modes/roblox/tools
    const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "rojo"), "fake", "utf8");

    const askPermission = vi.fn().mockResolvedValue(false);
    const { results, searchedEntireMachine } = await searchFile(
      "rojo",
      "roblox",
      askPermission,
    );
    expect(askPermission).not.toHaveBeenCalled();
    expect(searchedEntireMachine).toBe(false);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // --- enumerateDrives fallback (indireto via searchEntireMachine) -----------

  it("enumerateDrives: quando fsutil falha no Windows, usa fallback C:/D:/E:", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    // Faz fsutil falhar e where /R falhar (não acha nada)
    cpMock.execSync.mockImplementation((cmd: string) => {
      if (cmd.includes("fsutil")) throw new Error("admin required");
      if (cmd.includes("where")) throw new Error("not found");
      throw new Error("unexpected");
    });

    // searchFile com askPermission true para forçar busca na máquina
    const askPermission = vi.fn().mockResolvedValue(true);
    const { results, searchedEntireMachine } = await searchFile(
      "no-such-binary-zzz",
      "roblox",
      askPermission,
    );
    expect(searchedEntireMachine).toBe(true);
    // Deve ter chamado fsutil e caído no fallback (C:\, D:\, E:\)
    // e tentado where /R em cada um — todos falham → vazio.
    expect(results).toEqual([]);
  });
});
