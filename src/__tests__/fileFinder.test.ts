/**
 * fileFinder.test.ts — Testa a busca de arquivos em pastas definidas.
 *
 * Sprint 12: Cobertura para fileFinder.ts:
 *   - searchInDefinedFolders: encontra em modes/<mode>/tools/, em .rokit/bin/,
 *     retorna vazio quando não encontra, adiciona .exe no Windows,
 *     busca no PATH (which/where), não duplica resultados
 *   - copyToModeTools: copia arquivo pra tools/, cria pasta se não existe,
 *     não sobrescreve se já existe
 *
 * Usa um HOME temporário real. Mocka node:child_process para controlar a
 * saída de which/where (PATH search).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock logger
vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// Mock node:child_process para controlar PATH search (which/where)
// FIX-SEC Bug #4: the production code now uses execFileSync (shell:false)
// instead of execSync with a shell-quoted string. We expose a single shared
// mock function under both names so legacy tests that set
// `cpMock.execSync.mockReturnValue(...)` still control the PATH search.
const cpMock = vi.hoisted(() => {
  const shared = vi.fn(() => {
    // Default: comando falha (tool não está no PATH)
    throw new Error("mocked: not found in PATH");
  });
  return {
    execSync: shared,
    execFileSync: shared,
    spawn: vi.fn(),
  };
});
vi.mock("node:child_process", () => ({
  execSync: cpMock.execSync,
  execFileSync: cpMock.execFileSync,
  spawn: cpMock.spawn,
}));

import {
  searchInDefinedFolders,
  copyToModeTools,
} from "../fileFinder.js";

describe("fileFinder", () => {
  let tmpHome: string;
  let originalPlatform: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-filefinder-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    originalPlatform = process.platform;
    cpMock.execSync.mockReset();
    cpMock.execSync.mockImplementation(() => {
      throw new Error("mocked: not found in PATH");
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("searchInDefinedFolders", () => {
    it("encontra em modes/<mode>/tools/", () => {
      // Cria o arquivo na pasta tools/ do modo
      const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
      fs.mkdirSync(toolsDir, { recursive: true });
      fs.writeFileSync(path.join(toolsDir, "rojo"), "fake binary", "utf8");

      const results = searchInDefinedFolders("rojo", "roblox");
      expect(results.length).toBeGreaterThanOrEqual(1);
      const found = results.find((r) => r.source.includes("modes/roblox/tools"));
      expect(found).toBeDefined();
      expect(found!.path).toContain("rojo");
    });

    it("encontra em .rokit/bin/ (legacy)", () => {
      const rokitDir = path.join(tmpHome, ".rokit", "bin");
      fs.mkdirSync(rokitDir, { recursive: true });
      fs.writeFileSync(path.join(rokitDir, "selene"), "fake binary", "utf8");

      const results = searchInDefinedFolders("selene", null);
      const found = results.find((r) => r.source === ".rokit/bin");
      expect(found).toBeDefined();
      expect(found!.path).toContain(".rokit");
      expect(found!.path).toContain("selene");
    });

    it("retorna vazio quando não encontra em nenhuma pasta", () => {
      const results = searchInDefinedFolders("arquivo-que-nao-existe-zzz", "roblox");
      expect(results).toEqual([]);
    });

    it("adiciona .exe no Windows ao procurar", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      // Cria o arquivo com .exe
      const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
      fs.mkdirSync(toolsDir, { recursive: true });
      fs.writeFileSync(path.join(toolsDir, "rojo.exe"), "fake binary", "utf8");

      const results = searchInDefinedFolders("rojo", "roblox");
      const found = results.find((r) => r.path.endsWith("rojo.exe"));
      expect(found).toBeDefined();
    });

    it("busca no PATH (which/where) e adiciona resultado", () => {
      // Mock: `which foo` retorna /usr/bin/foo
      cpMock.execSync.mockReturnValue("/usr/bin/foo\n");
      const results = searchInDefinedFolders("foo", null);
      const pathResult = results.find((r) => r.source === "PATH");
      expect(pathResult).toBeDefined();
      expect(pathResult!.path).toBe("/usr/bin/foo");
    });

    it("não duplica resultados (mesmo path em pasta + PATH)", () => {
      // Cria arquivo em modes/roblox/tools/foo
      const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
      fs.mkdirSync(toolsDir, { recursive: true });
      const filePath = path.join(toolsDir, "foo");
      fs.writeFileSync(filePath, "fake", "utf8");
      // Mock: `which foo` retorna o MESMO path
      cpMock.execSync.mockReturnValue(filePath + "\n");

      const results = searchInDefinedFolders("foo", "roblox");
      // Não deve duplicar — apenas 1 entrada para o path
      const matching = results.filter((r) => r.path === filePath);
      expect(matching.length).toBe(1);
    });
  });

  describe("copyToModeTools", () => {
    it("copia arquivo pra tools/ do modo", () => {
      // Cria arquivo fonte
      const srcDir = path.join(tmpHome, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, "darklua");
      fs.writeFileSync(srcFile, "fake binary content", "utf8");

      const destPath = copyToModeTools(srcFile, "roblox");
      expect(destPath).not.toBeNull();
      expect(fs.existsSync(destPath!)).toBe(true);
      // Conteúdo deve ser igual ao original
      const content = fs.readFileSync(destPath!, "utf8");
      expect(content).toBe("fake binary content");
    });

    it("cria pasta tools/ se não existe", () => {
      // Garante que a pasta tools/ não existe
      const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
      expect(fs.existsSync(toolsDir)).toBe(false);

      // Cria arquivo fonte
      const srcFile = path.join(tmpHome, "darklua");
      fs.writeFileSync(srcFile, "fake", "utf8");

      copyToModeTools(srcFile, "roblox");
      expect(fs.existsSync(toolsDir)).toBe(true);
    });

    it("não sobrescreve se arquivo já existe em tools/", () => {
      // Pré-cria o arquivo destino com conteúdo "ORIGINAL"
      const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
      fs.mkdirSync(toolsDir, { recursive: true });
      const destFile = path.join(toolsDir, "darklua");
      fs.writeFileSync(destFile, "ORIGINAL", "utf8");

      // Cria arquivo fonte com MESMO basename ("darklua") num subdir diferente,
      // com conteúdo "NOVO"
      const srcDir = path.join(tmpHome, "src");
      fs.mkdirSync(srcDir, { recursive: true });
      const srcFile = path.join(srcDir, "darklua");
      fs.writeFileSync(srcFile, "NOVO", "utf8");

      const result = copyToModeTools(srcFile, "roblox");
      // Retorna o path mas NÃO copia (destino já existe)
      expect(result).toBe(destFile);
      // Conteúdo do destino deve permanecer ORIGINAL
      const content = fs.readFileSync(destFile, "utf8");
      expect(content).toBe("ORIGINAL");
    });
  });
});
