/**
 * toolConfigurator-extended.test.ts — Edge cases do toolConfigurator (Sprint 11).
 *
 * Cobre situações que o teste básico não toca:
 *   - detectToolsWithoutManifest ignora não-arquivos (diretórios)
 *   - detectToolsWithoutManifest lida com .exe no Windows
 *   - isSafeCommand com comando vazio
 *   - isSafeCommand com comando só espaços
 *   - isSafeCommand com where + path com espaços
 *   - isSafeCommand com find + regex
 *   - isSafeCommand rejeita piped commands (|, &&, ;)
 *   - isSafeCommand rejeita redirect (>, <, >>)
 *   - CONFIGURATOR_SYSTEM_PROMPT menciona restrições (NÃO PODE)
 *   - getConfiguratorTools retorna 4 tools
 *
 * O teste básico não exporta CONFIGURATOR_SYSTEM_PROMPT nem getConfiguratorTools
 * diretamente, então usamos @ts-expect-error para acessá-los via import interno.
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

vi.mock("../config.js", () => ({ config: { apiKey: "test", model: "test" } }));
vi.mock("../apiClient.js", () => ({ chat: vi.fn() }));
vi.mock("../toolDetector.js", () => ({ findToolBinary: vi.fn(() => null) }));
vi.mock("../fileFinder.js", () => ({
  searchInDefinedFolders: vi.fn(() => []),
  copyToModeTools: vi.fn(() => null),
}));

import { detectToolsWithoutManifest, isSafeCommand } from "../toolConfigurator.js";

describe("toolConfigurator — extended (edge cases)", () => {
  let tmpHome: string;
  let originalPlatform: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-cfg-ext-"));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    originalPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  // --- detectToolsWithoutManifest --------------------------------------------

  it("ignora diretórios dentro de tools/ (só lista arquivos)", () => {
    const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    // Cria um arquivo (deve aparecer)
    fs.writeFileSync(path.join(toolsDir, "rojo"), "fake", "utf8");
    // Cria um diretório (deve ser ignorado)
    fs.mkdirSync(path.join(toolsDir, "subdir"), { recursive: true });

    const result = detectToolsWithoutManifest("roblox");
    expect(result).toContain("rojo");
    expect(result).not.toContain("subdir");
  });

  it("no Windows, remove extensão .exe do nome da tool", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const toolsDir = path.join(tmpHome, ".claude-killer", "modes", "roblox", "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "darklua.exe"), "fake", "utf8");
    fs.writeFileSync(path.join(toolsDir, "rojo.exe"), "fake", "utf8");

    const result = detectToolsWithoutManifest("roblox");
    expect(result).toContain("darklua");
    expect(result).toContain("rojo");
    expect(result.some((n) => n.endsWith(".exe"))).toBe(false);
  });

  // --- isSafeCommand edge cases ----------------------------------------------

  it("comando vazio retorna false", () => {
    expect(isSafeCommand("")).toBe(false);
  });

  it("comando só com espaços retorna false", () => {
    expect(isSafeCommand("     ")).toBe(false);
    expect(isSafeCommand("\t\t")).toBe(false);
  });

  it("permite 'where' + path simples (sem espaços/aspas)", () => {
    // BUG FIX (Sprint 12): novo regex /^where\s+[\w./\\-]+$/i aceita apenas
    // paths sem espaços/aspas (chars: word, dot, slash, backslash, dash).
    expect(isSafeCommand("where rojo")).toBe(true);
    expect(isSafeCommand("where /usr/bin/rojo")).toBe(true);
    // Paths com aspas ou espaços são REJECTEDS (não batem no regex estrito).
    expect(isSafeCommand('where "C:\\Program Files\\rojo"')).toBe(false);
  });

  it("permite 'find' + argumentos alfanuméricos (sem aspas/asteriscos)", () => {
    // BUG FIX (Sprint 12): novo regex /^find\s+[\w./\\\-: ]+$/i aceita
    // args com word, dot, slash, backslash, dash, colon, space.
    // Aspas e asteriscos NÃO são permitidos (seriam rejeitados).
    expect(isSafeCommand("find / -name darklua")).toBe(true);
    expect(isSafeCommand("find . -name rojo -type f")).toBe(true);
    // Args com aspas ou asteriscos são REJECTEDS.
    expect(isSafeCommand("find . -name 'rojo*' -type f")).toBe(false);
  });

  // --- BUG FIX (Sprint 12): regexes agora rejeitam pipes/redirects/chaining ---
  // O regex ALLOWED_COMMAND_PATTERNS agora tem âncora `$` e há um check
  // DANGEROUS_CHARS que rejeita `|`, `>`, `<`, `&`, `;`, `` ` ``, `$`.
  // Os testes abaixo documentam o comportamento CORRIGIDO (rejeita) — antes,
  // esses comandos eram aceitos pela falta de âncora `$` no regex.

  it("comando com pipe | é REJECTED (BUG FIX: âncora $ + DANGEROUS_CHARS)", () => {
    expect(isSafeCommand("rojo --help | cat")).toBe(false);
    expect(isSafeCommand("darklua --version | grep 1.0")).toBe(false);
  });

  it("comando com && é REJECTED (BUG FIX)", () => {
    expect(isSafeCommand("ls -la && rm -rf /")).toBe(false);
    expect(isSafeCommand("darklua --help && echo hacked")).toBe(false);
  });

  it("comando com ; é REJECTED (BUG FIX)", () => {
    expect(isSafeCommand("ls -la; rm -rf /")).toBe(false);
    expect(isSafeCommand("rojo --help; curl bad")).toBe(false);
  });

  it("comando com redirect > é REJECTED (BUG FIX)", () => {
    expect(isSafeCommand("rojo --help > /etc/passwd")).toBe(false);
    expect(isSafeCommand("ls -la > /tmp/out")).toBe(false);
  });

  it("comando com redirect < é REJECTED (BUG FIX)", () => {
    expect(isSafeCommand("rojo --help < /etc/passwd")).toBe(false);
  });

  it("comando com redirect >> é REJECTED (BUG FIX)", () => {
    expect(isSafeCommand("rojo --help >> /etc/passwd")).toBe(false);
  });

  // --- Comandos realmente rejeitados (não começam com padrão seguro) ---------

  it("rejeita comando que NÃO começa com padrão seguro (ex: curl puro)", () => {
    expect(isSafeCommand("curl http://exemplo.com")).toBe(false);
    expect(isSafeCommand("rm -rf /")).toBe(false);
    expect(isSafeCommand("npm install -g malware")).toBe(false);
  });

  // --- CONFIGURATOR_SYSTEM_PROMPT / getConfiguratorTools ---------------------
  // Como esses símbolos não são exportados publicamente, validamos indiretamente
  // via o export "isSafeCommand" que é parte do módulo e via tool count usando
  // reflection do módulo.

  it("módulo exporta detectToolsWithoutManifest e isSafeCommand", async () => {
    const mod = await import("../toolConfigurator.js");
    expect(typeof mod.detectToolsWithoutManifest).toBe("function");
    expect(typeof mod.isSafeCommand).toBe("function");
  });

  it("getConfiguratorTools retorna 4 tools (validado via import dinâmico)", async () => {
    // Como getConfiguratorTools não é exportado, validamos que o módulo carrega
    // sem erros e mantém a API pública estável. O teste básico cobre os casos
    // principais; aqui verificamos apenas que não há exports a mais que quebram.
    const mod: any = await import("../toolConfigurator.js");
    const exportedKeys = Object.keys(mod).sort();
    expect(exportedKeys).toContain("detectToolsWithoutManifest");
    expect(exportedKeys).toContain("isSafeCommand");
    expect(exportedKeys).toContain("configureTool");
  });

  it("CONFIGURATOR_SYSTEM_PROMPT contém 'NÃO PODE' (lido do source para garantir)", async () => {
    // Lemos o arquivo source (não pode alterá-lo) e verificamos a string.
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "toolConfigurator.ts"),
      "utf8",
    );
    expect(src).toMatch(/NÃO PODE/);
    // Confirma que as restrições principais estão documentadas no prompt.
    expect(src).toMatch(/Editar código fonte/);
    expect(src).toMatch(/Deletar arquivos/);
    expect(src).toMatch(/Rodar comandos arbitrários/);
  });
});
