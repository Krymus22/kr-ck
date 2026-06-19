/**
 * clipboard-extended.test.ts — Casos edge / error / integração p/ clipboard.ts.
 * Foco: copy/paste com strings exóticas, fallbacks de plataforma, paths com espaços.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue(""),
}));

vi.mock("../logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  success: vi.fn(),
}));

import { execSync } from "node:child_process";
import { copyToClipboard, pasteFromClipboard, copyFileToClipboard } from "../clipboard.js";

let origPlatform: string;

beforeEach(() => {
  origPlatform = process.platform;
  vi.mocked(execSync).mockClear();
  vi.mocked(execSync).mockReturnValue("" as any);
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  vi.restoreAllMocks();
});

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

describe("clipboard.ts (extended) — copyToClipboard edge cases", () => {
  it("copia string vazia sem chamar cmd extra (darwin)", () => {
    setPlatform("darwin");
    expect(copyToClipboard("")).toBe(true);
    // pbcopy deve ter sido chamado com input=""
    const call = vi.mocked(execSync).mock.calls[0];
    expect(call?.[1]).toMatchObject({ input: "" });
  });

  it("escape de aspas duplas no Windows (replaceAll \" -> \"\")", () => {
    setPlatform("win32");
    const captured: string[] = [];
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      captured.push(cmd);
      return "";
    }) as any);
    expect(copyToClipboard('texto "com aspas"')).toBe(true);
    // Cada aspa dobra: 'texto "com aspas"' -> 'texto ""com aspas""'
    expect(captured[0]).toContain('Value \'texto ""com aspas""\'');
  });
});

describe("clipboard.ts (extended) — pasteFromClipboard edge cases", () => {
  it("preserva conteúdo multilinha vindo do pbpaste (darwin)", () => {
    setPlatform("darwin");
    vi.mocked(execSync).mockReturnValue("linha1\nlinha2\nlinha3\n" as any);
    // trim() remove só o \n final
    expect(pasteFromClipboard()).toBe("linha1\nlinha2\nlinha3");
  });

  it("faz trim de whitespace (leading+trailing) no linux (xclip)", () => {
    setPlatform("linux");
    vi.mocked(execSync).mockReturnValue("  payload com espaços   \n" as any);
    // trim() remove whitespace de ambos os lados
    expect(pasteFromClipboard()).toBe("payload com espaços");
  });
});

describe("clipboard.ts (extended) — platform detection", () => {
  it("plataforma desconhecida (ex: freebsd) cai no branch Linux (xclip/xsel)", () => {
    setPlatform("freebsd");
    expect(copyToClipboard("oi")).toBe(true);
    // Primeiro cmd tentado deve ser xclip
    expect(vi.mocked(execSync).mock.calls[0]?.[0]).toContain("xclip");
  });

  it("copyFileToClipboard no Windows usa Get-Item + Set-Clipboard", () => {
    setPlatform("win32");
    const cmds: string[] = [];
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      cmds.push(cmd);
      return "";
    }) as any);
    expect(copyFileToClipboard("C:/temp/file.png")).toBe(true);
    expect(cmds[0]).toContain("Get-Item");
    expect(cmds[0]).toContain("Set-Clipboard");
  });
});

describe("clipboard.ts (extended) — integrações e casos limítrofes", () => {
  it("texto unicode/emoji é repassado intacto ao pbcopy (darwin)", () => {
    setPlatform("darwin");
    const unicode = "olá 🌟 codificação ñ ç";
    expect(copyToClipboard(unicode)).toBe(true);
    expect(vi.mocked(execSync).mock.calls[0]?.[1]).toMatchObject({ input: unicode });
  });

  it("caminho com espaços no darwin usa aspas duplas no POSIX file e fallback cat | pbcopy", () => {
    setPlatform("darwin");
    const cmds: string[] = [];
    vi.mocked(execSync).mockImplementation(((cmd: string) => {
      cmds.push(cmd);
      return "";
    }) as any);
    const pathWithSpace = "/tmp/Minha Pasta/arq.png";
    expect(copyFileToClipboard(pathWithSpace)).toBe(true);
    // O comando deve conter o path entre aspas duplas e ter fallback cat | pbcopy
    expect(cmds[0]).toContain(`"${pathWithSpace}"`);
    expect(cmds[0]).toContain("cat");
    expect(cmds[0]).toContain("pbcopy");
  });
});
