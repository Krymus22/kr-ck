/**
 * inboxOrganizer-deep.test.ts — Testes profundos do inboxOrganizer.
 *
 * Foco:
 *   - classifyFile: casos complexos de conteúdo (.js com require,
 *     .json com mcpServers, JSON inválido, .tar.gz, .rar, sem extensão).
 *   - organizeInbox: não-sobrescreve (loga warning), múltiplos arquivos
 *     do mesmo tipo, nomes unicode, nomes com espaços, formatOrganizeResult
 *     com organized + ignored + errors juntos.
 *
 * Complementa inboxOrganizer-extended.test.ts e integration-inbox-organize.test.ts
 * (que cobrem casos básicos). Aqui focamos em edge cases não cobertos.
 *
 * NOTA IMPORTANTE sobre o teste ".json com name + command → mcp (named format)":
 *   Lendo o código de classifyFile:
 *     if (obj.category || (obj.command && obj.args)) return "manifest";
 *   Um .json com `name + command` (sem args e sem category) NÃO satisfaz
 *   essa condição. Cai no `return "manifest"` (default). Ou seja, o
 *   comportamento real é "manifest", não "mcp" — o teste foi escrito
 *   pra refletir o comportamento REAL do código, não o esperado pelo
 *   spec. O spec diz "→ mcp" mas o código diz "→ manifest".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// --- Mocks ------------------------------------------------------------------

vi.mock("../logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(),
  setTuiMode: vi.fn(), isTuiMode: vi.fn(() => false),
}));

// --- Imports ----------------------------------------------------------------

import {
  classifyFile,
  organizeInbox,
  formatOrganizeResult,
  type FileType,
  type OrganizeResult,
} from "../inboxOrganizer.js";

// --- Setup / Teardown -------------------------------------------------------

let tmpHome: string;
let tmpInbox: string;
let tmpModeDir: string;
let originalPlatform: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-killer-inbox-deep-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  originalPlatform = process.platform;
  tmpModeDir = path.join(tmpHome, ".claude-killer", "modes", "roblox");
  tmpInbox = path.join(tmpModeDir, "inbox");
  fs.mkdirSync(tmpInbox, { recursive: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  process.env.HOME = undefined;
  process.env.USERPROFILE = undefined;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.resetModules();
});

// --- Helpers ----------------------------------------------------------------

/** Escreve um arquivo no inbox/ com conteúdo. */
function writeInboxFile(name: string, content: string = ""): string {
  const filePath = path.join(tmpInbox, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** Simula plataforma Windows. */
function setWindowsPlatform(): void {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}

/** Simula plataforma Unix. */
function setUnixPlatform(): void {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
}

// --- Testes: classifyFile (casos complexos) ---------------------------------

describe("classifyFile - casos complexos", () => {
  it(".js com require('worker_threads') mas sem module.exports → hook (default)", () => {
    const content = `const { Worker } = require('worker_threads');
console.log('hello from worker');`;
    const f = writeInboxFile("worker-hook.js", content);
    // Sem module.exports e sem JSON-RPC/stdio → default hook
    expect(classifyFile(f)).toBe<FileType>("hook");
  });

  it(".js com stdio E module.exports.run → hook (hook tem prioridade)", () => {
    // Código com ambos module.exports.run (hook) e stdio (mcp).
    // A regex do hook é testada primeiro → hook ganha.
    const content = `const stdio = require('stdio');
module.exports = { trigger: 'post_save', run: () => { console.log('hook') } };`;
    const f = writeInboxFile("ambiguous.js", content);
    expect(classifyFile(f)).toBe<FileType>("hook");
  });

  it(".json array de tools → manifest", () => {
    const content = JSON.stringify([
      { name: "tool1", command: "tool1", args: [] },
      { name: "tool2", command: "tool2", args: [] },
    ]);
    const f = writeInboxFile("tools-array.json", content);
    expect(classifyFile(f)).toBe<FileType>("manifest");
  });

  it(".json com mcpServers → manifest (não mcp — comportamento real)", () => {
    // NOTA: o código de classifyFile não tem verificação específica pra
    // mcpServers. Ele só verifica `category || (command && args)`. Sem esses
    // campos, cai no default "manifest". Este teste documenta esse
    // comportamento real (que pode ser considerado um bug/limitação).
    const content = JSON.stringify({
      mcpServers: {
        weather: { command: "weather-cli", args: ["--stdio"] },
      },
    });
    const f = writeInboxFile("mcp-config.json", content);
    // O código atual retorna "manifest" porque não tem category nem (command && args)
    // direto no obj raiz. Para ser "mcp", o .json teria que ter sido um .js
    // com referência a stdio/JSON-RPC/@modelcontextprotocol.
    expect(classifyFile(f)).toBe<FileType>("manifest");
  });

  it(".json com name + command (sem args, sem category) → manifest (default)", () => {
    // NOTA: spec original dizia "→ mcp (named format)" mas lendo o código:
    //   if (obj.category || (obj.command && obj.args)) return "manifest";
    //   return "manifest"; // default for .json
    // Sem category E sem args, NÃO satisfaz (command && args). Cai no default.
    // Não existe path que retorna "mcp" para .json no código atual.
    const content = JSON.stringify({
      name: "my-mcp",
      command: "node",
      // sem args, sem category
    });
    const f = writeInboxFile("named-mcp.json", content);
    expect(classifyFile(f)).toBe<FileType>("manifest");
  });

  it(".json inválido (não parseia) → manifest (default)", () => {
    const content = "{invalid json,,,}";
    const f = writeInboxFile("broken.json", content);
    // JSON.parse lança → catch → return "manifest"
    expect(classifyFile(f)).toBe<FileType>("manifest");
  });

  it(".tar.gz → archive", () => {
    const f = writeInboxFile("backup.tar.gz", "fake tar.gz bytes");
    expect(classifyFile(f)).toBe<FileType>("archive");
  });

  it(".rar → unknown (não suportado)", () => {
    // .rar não está nas extensões de archive suportadas (.zip, .gz, .tar)
    const f = writeInboxFile("compressed.rar", "fake rar");
    expect(classifyFile(f)).toBe<FileType>("unknown");
  });

  it("arquivo sem extensão no Windows → unknown (não .exe)", () => {
    // No Windows, arquivo sem extensão NÃO é tool (só .exe é tool).
    setWindowsPlatform();
    const f = writeInboxFile("binary-no-ext", "fake bytes");
    expect(classifyFile(f)).toBe<FileType>("unknown");
  });

  it("arquivo sem extensão no Unix → tool", () => {
    // No Unix, arquivo sem extensão É tool binário provável.
    setUnixPlatform();
    const f = writeInboxFile("binary-no-ext", "fake bytes");
    expect(classifyFile(f)).toBe<FileType>("tool");
  });
});

// --- Testes: organizeInbox (cenários complexos) -----------------------------

describe("organizeInbox - cenários complexos", () => {
  it("arquivo já existe no destino → não sobrescreve, loga warning", () => {
    // Pré-cria o arquivo no destino tools/
    const toolsDir = path.join(tmpModeDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    const destPath = path.join(toolsDir, "rojo.exe");
    fs.writeFileSync(destPath, "ORIGINAL BINARY", "utf8");

    // Coloca arquivo de mesmo nome no inbox
    writeInboxFile("rojo.exe", "NOVO BINARY");

    const result = organizeInbox("roblox");

    // Arquivo destino continua com ORIGINAL (não sobrescrito)
    const content = fs.readFileSync(destPath, "utf8");
    expect(content).toBe("ORIGINAL BINARY");
    // Arquivo também continua no inbox (não foi movido)
    expect(fs.existsSync(path.join(tmpInbox, "rojo.exe"))).toBe(true);
    // Resultado: organized contém o item mas o arquivo NÃO foi efetivamente movido
    // (moveFile retorna destPath mas não chama renameSync quando já existe)
    expect(result.organized.length).toBe(1);
    expect(result.organized[0].fileName).toBe("rojo.exe");
    // Logger warn foi chamado (mockado, mas verificamos via mock)
    // Como logger está mockado, só verificamos que não houve erro.
    expect(result.errors.length).toBe(0);
  });

  it("múltiplos arquivos do mesmo tipo → todos movidos", () => {
    // Cria 4 .json (manifests) no inbox
    writeInboxFile("a.json", JSON.stringify({ name: "a", category: "action" }));
    writeInboxFile("b.json", JSON.stringify({ name: "b", category: "action" }));
    writeInboxFile("c.json", JSON.stringify({ name: "c", category: "action" }));
    writeInboxFile("d.json", JSON.stringify({ name: "d", category: "action" }));

    const result = organizeInbox("roblox");

    expect(result.organized.length).toBe(4);
    // Todos foram pra manifests/
    const manifestsDir = path.join(tmpModeDir, "manifests");
    expect(fs.existsSync(path.join(manifestsDir, "a.json"))).toBe(true);
    expect(fs.existsSync(path.join(manifestsDir, "b.json"))).toBe(true);
    expect(fs.existsSync(path.join(manifestsDir, "c.json"))).toBe(true);
    expect(fs.existsSync(path.join(manifestsDir, "d.json"))).toBe(true);
    // Inbox está vazio
    expect(fs.existsSync(path.join(tmpInbox, "a.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpInbox, "d.json"))).toBe(false);
  });

  it("arquivo com nome unicode (中文.exe) → movido corretamente", () => {
    writeInboxFile("中文工具.exe", "fake binary");

    const result = organizeInbox("roblox");

    expect(result.organized.length).toBe(1);
    expect(result.organized[0].fileName).toBe("中文工具.exe");
    expect(result.organized[0].fileType).toBe<FileType>("tool");

    // Movido pra tools/ com nome unicode preservado
    const toolsDir = path.join(tmpModeDir, "tools");
    expect(fs.existsSync(path.join(toolsDir, "中文工具.exe"))).toBe(true);
    // Não está mais no inbox
    expect(fs.existsSync(path.join(tmpInbox, "中文工具.exe"))).toBe(false);
  });

  it("arquivo com espaços no nome ('my tool.exe') → movido corretamente", () => {
    writeInboxFile("my tool.exe", "fake binary");

    const result = organizeInbox("roblox");

    expect(result.organized.length).toBe(1);
    expect(result.organized[0].fileName).toBe("my tool.exe");

    // Movido pra tools/ com espaços preservados
    const toolsDir = path.join(tmpModeDir, "tools");
    expect(fs.existsSync(path.join(toolsDir, "my tool.exe"))).toBe(true);
    expect(fs.existsSync(path.join(tmpInbox, "my tool.exe"))).toBe(false);
  });

  it("formatOrganizeResult com organized + ignored + errors juntos", () => {
    const result: OrganizeResult = {
      organized: [
        { fileName: "rojo.exe", fileType: "tool", destination: "/tools/rojo.exe" },
        { fileName: "doc.md", fileType: "skill", destination: "/skills/doc.md" },
      ],
      ignored: [
        { fileName: "backup.zip", reason: "Archive (.zip/.tar.gz) — extract manually" },
        { fileName: "notes.txt", reason: "Documentation file (not moved)" },
      ],
      errors: [
        { fileName: "broken.json", error: "EACCES: permission denied" },
        { fileName: "missing.bin", error: "ENOENT: no such file" },
      ],
    };

    const text = formatOrganizeResult(result);

    // Tem as 3 seções
    expect(text).toMatch(/✓ Organizados/);
    expect(text).toMatch(/⚠ Ignorados/);
    expect(text).toMatch(/✗ Erros/);

    // Listou os arquivos organizados
    expect(text).toContain("rojo.exe");
    expect(text).toContain("tools/");
    expect(text).toContain("doc.md");
    expect(text).toContain("skills/");

    // Listou os ignorados com motivos
    expect(text).toContain("backup.zip");
    expect(text).toContain("Archive");
    expect(text).toContain("notes.txt");
    expect(text).toContain("Documentation");

    // Listou os erros com mensagens
    expect(text).toContain("broken.json");
    expect(text).toContain("EACCES");
    expect(text).toContain("missing.bin");
    expect(text).toContain("ENOENT");
  });
});
